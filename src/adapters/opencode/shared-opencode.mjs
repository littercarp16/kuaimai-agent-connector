import {resolve} from 'node:path';
import{publicToolInfo,publicToolResult}from'../../tools/tool-public.mjs';
import{createDetailStore,detailPolicy,makeToolDetail}from'../../tools/tool-details.mjs';
import{normalizeUploads,readWorkspaceReference,workspacePath,FILE_LIMITS}from'../../tools/prompt-files.mjs';
import{publicQuestion,questionAnswer}from'../../session/shared-state.mjs';

// V2 form endpoints declare these auth/validation rejections before applying an answer/cancel.
// The SDK preserves their _tag; timeouts/transport failures and undeclared 5xx are ClientError instead.
const FORM_NOT_APPLIED=new Set(['UnauthorizedError','InvalidRequestError','FormInvalidAnswerError']);

export function sharedOpenCode({current,health,directory}) {
  const bound=new Map(),scope=resolve(directory),details=createDetailStore();
  const options=signal=>({signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  const inside=info=>info?.location?.directory&&resolve(info.location.directory)===scope&&!info.time?.archived;
  async function ready(){if(!current())await health();if(!current())throw Error('OpenCode未就绪');return current().client;}
  function get(id){const item=bound.get(id);if(!item)throw Error('尚未授权绑定此会话');return item;}
  function assertContext(id,context){if(get(id)!==context)throw Error('原生会话绑定上下文已变化，未返回旧连接内容');}
  function questionFromForm(form,id){
    if(form?.sessionID!==id||!Array.isArray(form.fields)||!form.fields.length||form.fields.some(f=>!['string','multiselect'].includes(f.type)||f.hidden||f.when?.length||f.format==='password'))return null;
    return publicQuestion({id:form.id,sessionId:id,title:form.title,questions:form.fields.map(f=>({key:f.key,header:f.title||'问题',question:f.description||f.title||form.title,options:f.options||[],multiple:f.type==='multiselect',custom:f.custom===true||f.type==='string'&&!f.options?.length,required:f.required===true,minItems:f.minItems,maxItems:f.maxItems}))},id);
  }
  async function listQuestions(id){const context=get(id),c=context.client;if(!inside(await c.session.get({sessionID:id},options())))throw Error('会话已离开工作区');const forms=c.session.form?.list?await c.session.form.list({sessionID:id},options()):[];if(get(id)!==context||!inside(await c.session.get({sessionID:id},options())))throw Error('问题所属会话已变化');const result=[];let bytes=0;for(const form of forms){const q=questionFromForm(form,id);if(!q)continue;const size=Buffer.byteLength(JSON.stringify(q));if(result.length>=16||bytes+size>256000)break;bytes+=size;result.push(q);}return result;}
  async function settleNativeQuestion(id,questionId,answers,{reject=false,assertCurrent=()=>{},signal}={}){
    let submitted=false;try{
    const context=get(id),c=context.client,check=()=>{assertCurrent();if(signal?.aborted||get(id)!==context)throw Error('问题所属绑定已变化');};check();
    if(typeof questionId!=='string'||!/^[\w:.-]{1,140}$/.test(questionId)||!c.session.form?.list||!c.session.form?.get||!c.session.form?.reply||!c.session.form?.cancel)throw Error('原生问题接口不可用');
    if(!inside(await c.session.get({sessionID:id},options(signal))))throw Error('会话已离开工作区');check();
    const pending=await c.session.form.list({sessionID:id},options(signal));check();const source=pending.find(f=>f.id===questionId&&f.sessionID===id),q=questionFromForm(source,id);if(!q)throw Error('当前会话没有此待答问题');
    const detail=await c.session.form.get({sessionID:id,formID:questionId},options(signal));check();if(detail.sessionID!==id||detail.id!==questionId||detail.state?.status!=='pending'||JSON.stringify(questionFromForm(detail,id))!==JSON.stringify(q))throw Error('原生问题已结束或内容已变化');
    const answer=reject?null:questionAnswer(q,answers);
    if(!inside(await c.session.get({sessionID:id},options(signal))))throw Error('提交前会话已离开工作区');check();
    submitted=true;if(reject)await c.session.form.cancel({sessionID:id,formID:questionId},options(signal));else await c.session.form.reply({sessionID:id,formID:questionId,answer},options(signal));check();return{questionId,status:reject?'rejected':'answered'};
    }catch(error){if((!submitted||FORM_NOT_APPLIED.has(error?._tag))&&error&&typeof error==='object'&&!error.code)error.code='QUESTION_NOT_SUBMITTED';throw error;}
  }
  const replyQuestion=(id,questionId,answers,opts)=>settleNativeQuestion(id,questionId,answers,opts);
  const rejectQuestion=(id,questionId,opts)=>settleNativeQuestion(id,questionId,null,{...opts,reject:true});
  async function listSessions(){const c=await ready(),pages=await Promise.all([scope,scope+'/'].map(directory=>c.session.list({directory,order:'desc',limit:20},options())));const sessions=new Map();for(const page of pages)for(const info of page.data)if(inside(info))sessions.set(info.id,info);return[...sessions.values()].sort((a,b)=>b.time.updated-a.time.updated).slice(0,20).map(s=>({id:s.id,title:String(s.title||'未命名会话').slice(0,100),updated:s.time.updated}));}
  async function bindSession(id){
    if(typeof id!=='string'||!/^ses[A-Za-z0-9_-]{1,120}$/.test(id))throw Error('会话ID无效');
    const c=await ready(),info=await c.session.get({sessionID:id},options());if(!inside(info))throw Error('只能绑定当前工作区的有效会话');
    const previous=bound.get(id);bound.set(id,{client:c,contexts:previous?.contexts||new Map()});return{id:info.id,title:String(info.title||'未命名会话').slice(0,100),directory:scope};
  }
  function rememberTool(sessionId,{id,name,input,content,error,status,historical=false}){
    const contexts=get(sessionId).contexts,old=contexts.get(id),policy=input===undefined?old?.policy||detailPolicy(name):detailPolicy(name,input);name=name||old?.name||'';
    contexts.set(id,{name,policy});while(contexts.size>100)contexts.delete(contexts.keys().next().value);
    const previous=details.get(sessionId,id),value=makeToolDetail({toolId:id,name,input,content,error,status,policy,previous});
    if(historical&&previous&&['completed','failed'].includes(previous.status)){value.status=previous.status;value.result=previous.result;}
    details.put(sessionId,id,value);return value;
  }
  async function readShared(id){
    const context=get(id),c=context.client,info=await c.session.get({sessionID:id},options());assertContext(id,context);if(!inside(info))throw Error('绑定会话已经离开工作区');
    const [response,active,inbox]=await Promise.all([c.message.list({sessionID:id,limit:40,order:'desc'},options()),c.session.active?c.session.active(options()):{},c.session.inbox?.list?c.session.inbox.list({sessionID:id},options()):[]]);
    assertContext(id,context);if(!inside(await c.session.get({sessionID:id},options())))throw Error('读取期间会话已离开工作区');assertContext(id,context);
    const messages=[],tools=[],activities=[],timeline=[];
    const timing=part=>({historical:true,...(Number.isFinite(part.time?.created)?{startedAt:part.time.created}:{}),...(Number.isFinite(part.time?.completed)&&Number.isFinite(part.time?.created)?{durationMs:Math.max(0,part.time.completed-part.time.created)}:{})});
    for(const m of [...response.data].reverse()){
      if(m.type==='user'){messages.push({id:m.id,role:'user',text:String(m.text||'').slice(0,14000),files:(m.files||[]).slice(0,5).map(f=>({name:String(f.name||'附件').slice(0,180),mime:String(f.mime||'').slice(0,70)}))});timeline.push({id:m.id,kind:'message'});}
      if(m.type==='assistant'){
        const segments=m.content.map((part,ordinal)=>({part,ordinal})).filter(x=>x.part.type==='text').map(({part,ordinal})=>({ordinal,text:part.text.slice(0,100000)}));
        messages.push({id:m.id,role:'assistant',text:segments.map(p=>p.text).join('\n'),segments});
        let textOrdered=false;for(const[ordinal,part]of m.content.entries()){
          if(part.type==='text'&&part.text&&!textOrdered){timeline.push({id:m.id,kind:'message'});textOrdered=true;}
          if(part.type==='tool'){const name=String(part.name).slice(0,70),skill=name==='skill'&&(part.state?.input?.id||part.state?.input?.name),status=part.state.status==='completed'?'completed':['error','failed'].includes(part.state.status)?'failed':'running';tools.push({id:part.id,name,status:part.state.status});rememberTool(id,{id:part.id,name,input:part.state.input,content:part.state.content,error:part.state.error,status,historical:true});const a={id:'tool:'+part.id,messageId:m.id,kind:name==='skill'?'skill':'tool',toolName:name,hasDetails:true,label:typeof skill==='string'&&/^[\w-]{1,80}$/.test(skill)?'技能 · '+skill:'调用 '+name,status,...publicToolInfo(name,part.state?.input),...(['completed','error','failed'].includes(part.state.status)?publicToolResult(name,{error:part.state.error}):{}),...timing(part)};activities.push(a);timeline.push({id:a.id,kind:'activity'});}
          if(part.type==='reasoning'){const a={id:'thinking:'+m.id+':'+ordinal,messageId:m.id,kind:'thinking',label:'思考状态',status:part.time?.completed||m.time?.completed||!active?.[id]?'completed':'running',...timing(part)};activities.push(a);timeline.push({id:a.id,kind:'activity'});}
        }
      }
    }
    const pending=inbox.filter(item=>item.type==='user');for(const item of pending)if(!messages.some(m=>m.id===item.id)){messages.push({id:item.id,role:'user',text:String(item.payload?.text||'').slice(0,14000),files:(item.payload?.files||[]).slice(0,5).map(f=>({name:String(f.name||'附件').slice(0,180),mime:String(f.mime||'').slice(0,70)}))});timeline.push({id:item.id,kind:'message'});}
    const questions=await listQuestions(id);assertContext(id,context);
    return{questions,messages,timeline:timeline.slice(-140),activities:activities.slice(-60),tools:tools.slice(-30),status:active?.[id]?'running':pending.length?'queued':info.outcome==='failed'?'failed':info.outcome==='interrupted'?'interrupted':info.outcome==='succeeded'?'completed':'idle',model:info.model?`${info.model.providerID}/${info.model.id}`:null};
  }
  async function sendShared(id,text,{requestId,signal,uploads=[],references=[]}={}){
    const c=get(id).client;if(signal?.aborted)throw Object.assign(Error('尚未提交'),{code:'NOT_SUBMITTED'});
    const info=await c.session.get({sessionID:id},options(signal));if(!inside(info))throw Error('会话已离开工作区');
    if(!Array.isArray(references)||uploads.length+references.length>FILE_LIMITS.count||new Set(references).size!==references.length)throw Error('附件/引用数量或格式无效');const files=normalizeUploads(uploads);for(const path of references)files.push(await readWorkspaceReference(scope,path));if(files.reduce((n,f)=>n+Buffer.from(f.uri.split(',')[1],'base64').length,0)>FILE_LIMITS.total)throw Error('附件合计不能超过6MiB');
    if(!inside(await c.session.get({sessionID:id},options(signal))))throw Error('文件读取期间会话已离开工作区');if(signal?.aborted)throw Object.assign(Error('尚未提交'),{code:'NOT_SUBMITTED'});
    return c.session.prompt({sessionID:id,id:'msg_km_'+requestId.replaceAll('-',''),text,...(files.length?{files}:{}),delivery:'queue',metadata:{source:'kmmdtable',requestId}},options(signal));
  }
  async function searchWorkspaceFiles(id,query=''){const c=get(id).client;if(typeof query!=='string'||query.length>120||/[\x00-\x1f]/.test(query))throw Error('搜索文本无效');if(!inside(await c.session.get({sessionID:id},options())))throw Error('会话已离开工作区');if(!c.file?.find)throw Error('当前服务未提供文件搜索');const result=await c.file.find({location:{directory:scope},query,type:'file',limit:30},options());const files=[];for(const entry of (result.data||[]).slice(0,30))if(entry.type==='file')try{const f=await workspacePath(scope,entry.path);files.push({path:f.rel});}catch{}if(!inside(await c.session.get({sessionID:id},options())))throw Error('搜索期间会话已离开工作区');return files;}
  async function createSharedSession(id){const c=get(id).client,info=await c.session.get({sessionID:id},options());if(!inside(info))throw Error('会话已离开工作区');const created=await c.session.create({title:'快麦 · 新会话',location:{directory:scope},...(info.agent?{agent:info.agent}:{}),...(info.model?{model:info.model}:{}),permissions:Array.isArray(info.permissions)?info.permissions:[],...(info.metadata?.kmAgentChannel?{metadata:{kmAgentChannel:info.metadata.kmAgentChannel}}:{})},options());if(!inside(created))throw Error('新会话范围未确认');return{id:created.id,title:created.title||'快麦 · 新会话',directory:scope};}
  async function installBridge(id,key,value){const c=get(id).client;await c.session.instructions.entry.put({sessionID:id,key,value},options());}
  async function removeBridge(id,key){const c=get(id).client;if(c.session.instructions?.entry?.remove)await c.session.instructions.entry.remove({sessionID:id,key},options());}
  async function readToolDetail(id,toolId){
    const context=get(id),c=context.client;if(!inside(await c.session.get({sessionID:id},options())))throw Error('会话已离开工作区');assertContext(id,context);let value=details.get(id,toolId);if(!value){await readShared(id);assertContext(id,context);value=details.get(id,toolId);}if(!inside(await c.session.get({sessionID:id},options())))throw Error('读取期间会话已离开工作区');assertContext(id,context);return value;
  }
  function watch(id,onEvent,onState=()=>{}){
    const context=get(id),c=context.client,control=new AbortController(),toolNames=context.contexts;let resolveReady,rejectReady;
    const started=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
    const timer=setTimeout(()=>{rejectReady(Error('OpenCode事件流未就绪'));control.abort();},5000);timer.unref?.();
    void(async()=>{
      try{
        for await(const event of c.event.subscribe({signal:control.signal})){
          if(control.signal.aborted)break;
          if(event.type==='server.connected'){clearTimeout(timer);resolveReady();onState('connected');continue;}
          if(['form.created','form.replied','form.cancelled'].includes(event.type)){
            if(event.location?.directory&&resolve(event.location.directory)!==scope)continue;
            if(event.type==='form.created'){const question=questionFromForm(event.data?.form,id);if(question)onEvent({id:event.id,type:event.type,created:event.created,data:{sessionID:id,question}});}
            else if(event.data?.sessionID===id)onEvent({id:event.id,type:event.type,created:event.created,data:{sessionID:id,id:event.data.id}});
            continue;
          }
          if(event.type?.startsWith('permission.'))continue;
          if(event.data?.sessionID!==id||event.type==='session.reasoning.delta')continue;
          if(event.type==='session.moved'){control.abort();onState('disconnected');break;}
          // Only allowlisted display summaries; never forward raw input/results or reasoning text.
          const d=event.data,data={sessionID:id};
          for(const key of ['assistantMessageID','inboxID','ordinal','id','name'])if(d[key]!==undefined)data[key]=d[key];
          if(event.type==='session.tool.input.started'){toolNames.set(d.id,{name:d.name,policy:detailPolicy(d.name)});if(toolNames.size>100)toolNames.delete(toolNames.keys().next().value);}
          if(event.type==='session.tool.called'&&toolNames.get(d.id)?.name==='skill'){const skill=d.input?.id||d.input?.name;if(typeof skill==='string'&&/^[\w-]{1,80}$/.test(skill))data.publicSkill=skill;}
          if(event.type==='session.tool.called'){const name=toolNames.get(d.id)?.name||'';rememberTool(id,{id:d.id,name,input:d.input,status:'running'});data.publicTool={...publicToolInfo(name,d.input),hasDetails:true};}
          if(event.type==='session.tool.success'||event.type==='session.tool.failed'){const failed=event.type==='session.tool.failed',name=toolNames.get(d.id)?.name||'',error=failed?d.error:undefined;rememberTool(id,{id:d.id,name,content:d.content,error,status:failed?'failed':'completed'});data.publicResult={...publicToolResult(name,{error}),hasDetails:true};}
          if(event.type==='session.text.delta')data.delta=d.delta;
          if(event.type==='session.text.ended')data.text=d.text;
          if(event.type==='session.inbox.enqueued'&&d.item?.type==='user')data.item={type:'user',payload:{text:d.item.payload.text,files:(d.item.payload.files||[]).slice(0,5).map(f=>({name:String(f.name||'附件').slice(0,180),mime:String(f.mime||'').slice(0,70)}))},delivery:d.item.delivery};
          onEvent({id:event.id,type:event.type,created:event.created,data});
        }
        if(!control.signal.aborted)throw Error('事件流已关闭');
      }catch{if(!control.signal.aborted){rejectReady(Error('事件流不可达'));onState('disconnected');}}
      finally{clearTimeout(timer);}
    })();
    return{ready:started,close(){control.abort();clearTimeout(timer);rejectReady(Error('订阅已取消'));}};
  }
  async function interruptShared(id){return get(id).client.session.interrupt({sessionID:id,resume:false},options());}
  return{listSessions,bindSession,readShared,readToolDetail,listQuestions,replyQuestion,rejectQuestion,sendShared,searchWorkspaceFiles,createSharedSession,installBridge,removeBridge,watch,interruptShared};
}

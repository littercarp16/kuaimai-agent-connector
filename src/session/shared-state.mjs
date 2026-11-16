import '../protocol/model.js';
import {createHash} from 'node:crypto';
import{PROTOCOL,COMMANDS}from'../protocol/protocol.mjs';
import{redactText}from'../tools/display-safety.mjs';
const M=globalThis.KmAgentModel;
const TERMINALS={'session.execution.succeeded':'completed','session.execution.failed':'failed','session.execution.interrupted':'interrupted'};
const clamp=(value,max=14000)=>String(value??'').slice(0,max);
const fileMeta=files=>Array.isArray(files)?files.slice(0,5).map((f,i)=>({name:clamp(f?.name||'附件'+(i+1),180),mime:clamp(f?.mime||'',70)})):[];

// Questions are public user-facing text, not tool input or private reasoning. Copy only this contract.
const questionText=value=>redactText(value,false,{complete:true});
export function publicQuestion(input,sessionId){
  if(!input||input.sessionId!==sessionId||typeof input.id!=='string'||!/^[\w:.-]{1,140}$/.test(input.id)||!Array.isArray(input.questions)||!input.questions.length||input.questions.length>32)return null;
  const questions=[],keys=new Set();
  for(const q of input.questions){
    if(!q||typeof q.key!=='string'||!q.key||q.key.length>200||keys.has(q.key)||['__proto__','prototype','constructor'].includes(q.key)||!Array.isArray(q.options)||q.options.length>100)return null;keys.add(q.key);
    const options=[],values=new Set();for(const o of q.options){if(typeof o?.value!=='string'||o.value.length>4000||questionText(o.value)!==o.value||values.has(o.value))return null;values.add(o.value);options.push({value:o.value,label:questionText(o.label??o.value),description:questionText(o.description)});}
    questions.push({key:q.key,header:questionText(q.header||'问题'),question:questionText(q.question),options,multiple:q.multiple===true,custom:q.custom===true,required:q.required===true,...(Number.isSafeInteger(q.minItems)&&q.minItems>=0?{minItems:q.minItems}:{}),...(Number.isSafeInteger(q.maxItems)&&q.maxItems>=0?{maxItems:q.maxItems}:{})});
  }
  const value={id:input.id,sessionId,title:questionText(input.title||'请回答问题'),questions};return Buffer.byteLength(JSON.stringify(value))<=192000?value:null;
}
export function questionAnswer(question,answers){
  if(!Array.isArray(answers)||answers.length!==question.questions.length)throw Object.assign(Error('请完整回答所有问题'),{code:'QUESTION_INVALID_ANSWER'});
  const answer=Object.create(null);for(const[index,field]of question.questions.entries()){const values=answers[index];if(!Array.isArray(values)||values.some(v=>typeof v!=='string'||!v.trim()||v.length>8000)||new Set(values).size!==values.length||!field.multiple&&values.length>1||field.required&&!values.length||field.minItems!==undefined&&values.length<field.minItems||field.maxItems!==undefined&&values.length>field.maxItems||!field.custom&&values.some(v=>!field.options.some(o=>o.value===v)))throw Object.assign(Error('问题答案格式或选项无效'),{code:'QUESTION_INVALID_ANSWER'});if(field.multiple)answer[field.key]=[...values];else if(values.length)answer[field.key]=values[0];}return answer;
}
export function publicApproval(input,sessionId){
 if(!input||input.sessionId!==sessionId||!['command','fileChange'].includes(input.kind)||![input.id,input.turnId,input.itemId].every(v=>typeof v==='string'&&/^[\w:.-]{1,140}$/.test(v))||!Array.isArray(input.decisions)||!input.decisions.length||input.decisions.some(v=>!['accept','decline','cancel'].includes(v)))return null;
 const value={id:input.id,sessionId,turnId:input.turnId,itemId:input.itemId,kind:input.kind,title:questionText(input.title||'原生审批'),description:questionText(input.description||''),command:questionText(input.command||''),cwd:questionText(input.cwd||''),decisions:[...new Set(input.decisions)]};return Buffer.byteLength(JSON.stringify(value))<=16000?value:null;
}

/** A data-only projection of ONE explicitly bound session. Never feeds events back as prompts. */
export function createProjection(sessionId) {
  const value={id:'shared:'+sessionId,mode:'shared',status:'idle',messages:[],questions:[],approvals:[],tools:[],steps:[],activities:[],timeline:[],ui:{actions:[],deliveries:[],action:null,work:null},plan:null,artifacts:[],warnings:[],error:null,startedAt:0,focusArtifactId:null};
  const messages=new Map(),parts=new Map(),tools=new Map(),seen=new Set(),uiSeen=new Set(),sections=new Map(),inputs=new Set(),blocks=new Set();
  const remember=(set,id)=>{if(!id)return true;if(set.has(id))return false;set.add(id);if(set.size>4096)set.delete(set.values().next().value);return true;};
  const activities=new Map();
  const questions=new Map(),settledQuestions=new Set();
  function putQuestion(input){const q=publicQuestion(input,sessionId);if(!q||settledQuestions.has(q.id))return false;const next=new Map(questions);next.set(q.id,q);if(next.size>16||Buffer.byteLength(JSON.stringify([...next.values()]))>256000)return false;questions.set(q.id,q);value.questions=[...questions.values()];return true;}
  function settleQuestion(id){if(typeof id!=='string')return false;remember(settledQuestions,id);questions.delete(id);value.questions=[...questions.values()];return true;}
  function clearQuestions(){questions.clear();value.questions=[];}
  const approvals=new Map(),settledApprovals=new Set();
  function putApproval(input){const a=publicApproval(input,sessionId);if(!a||settledApprovals.has(a.id))return false;if(!approvals.has(a.id)&&approvals.size>=16)return false;approvals.set(a.id,a);value.approvals=[...approvals.values()];return true;}
  function settleApproval(id){if(typeof id!=='string')return false;remember(settledApprovals,id);approvals.delete(id);value.approvals=[...approvals.values()];return true;}
  function clearApprovals(){approvals.clear();value.approvals=[];}
  function order(id,kind){if(!value.timeline.some(x=>x.id===id&&x.kind===kind))value.timeline.push({id,kind});value.timeline=value.timeline.slice(-140);}
  function activity(a){
    if(!/^[\w:.-]{1,140}$/.test(a.id)||!['thinking','skill','tool','phase','permission'].includes(a.kind)||!['running','completed','failed','waiting'].includes(a.status)||typeof a.label!=='string'||!a.label.trim()||a.label.length>120)throw Error('活动格式无效');
    const old=activities.get(a.id),time=Date.now(),startedAt=old?.startedAt||(Number.isFinite(a.startedAt)?a.startedAt:time),historical=a.historical===true;
    const duration=historical?(Number.isFinite(a.durationMs)&&a.durationMs>=0?a.durationMs:undefined):Math.max(0,time-startedAt);
    const publicSummary=a.visibility==='public'?clamp(a.publicSummary,400):old?.visibility==='public'?old.publicSummary:'';
    const publicSummarySource=a.publicSummarySource||old?.publicSummarySource||'agent-public-summary';
    activities.set(a.id,{id:a.id,messageId:clamp(a.messageId??old?.messageId,120),kind:a.kind,status:a.status,historical,label:a.kind==='thinking'?'思考':a.label,toolName:a.kind==='thinking'?'':clamp(a.toolName??old?.toolName,70),summary:a.kind==='thinking'?'':clamp(a.summary??old?.summary,500),errorSummary:a.kind==='thinking'?'':clamp(a.errorSummary??old?.errorSummary,160),detail:a.kind==='thinking'?'':clamp(a.detail??old?.detail,400),hasDetails:a.kind!=='thinking'&&(a.hasDetails===true||old?.hasDetails===true),...(publicSummary?{visibility:'public',publicSummary,publicSummarySource:['assistant-public-text','tool-action','agent-public-summary'].includes(publicSummarySource)?publicSummarySource:'agent-public-summary'}:{}),startedAt,...(['completed','failed'].includes(a.status)&&duration!==undefined?{durationMs:duration}:{})});
    order(a.id,'activity');while(activities.size>70)activities.delete(activities.keys().next().value);value.activities=[...activities.values()];
  }
  function attachPublicContext(messageId,text,source){if(!messageId||!text?.trim())return;const priority={'tool-action':1,'assistant-public-text':2,'agent-public-summary':3};for(const a of activities.values())if(a.kind==='thinking'&&a.messageId===messageId&&(!a.publicSummary||(priority[a.publicSummarySource]||0)<=priority[source]))activity({...a,visibility:'public',publicSummary:text.trim().slice(0,400),publicSummarySource:source});}
  function message(id,role){if(!messages.has(id)){messages.set(id,{id,role,text:''});order(id,'message');}while(messages.size>60){const removed=messages.keys().next().value;messages.delete(removed);for(const[key,part]of parts)if(part.id===removed)parts.delete(key);}return messages.get(id);}
  function refresh(){const publicMessages=[...messages.values()].map(m=>({id:m.id,role:m.role,text:clamp(m.role==='assistant'?M.parseOutput(m.text).text:m.text,14000),...(m.files?.length?{files:m.files}:{})})).filter(m=>m.text||m.files?.length).slice(-40);let bytes=0;const recent=[];for(const m of publicMessages.reverse()){const size=Buffer.byteLength(JSON.stringify(m));if(bytes+size>120000)break;bytes+=size;recent.unshift(m);}value.messages=recent;value.tools=[...tools.values()].slice(-30);}
  function block(raw){const json=JSON.stringify(raw);if(Buffer.byteLength(json)>64000)throw Error('成果过大，请拆分为独立组件');const parsed=M.parseOutput('```kmmdtable\n'+json+'\n```');if(parsed.warnings.length||(raw.type==='artifact'&&!parsed.artifacts.length)||(raw.type==='plan'&&!parsed.plan))throw Error('结构化预览未通过校验');return parsed;}
  function putArtifact(artifact){if(Buffer.byteLength(JSON.stringify(artifact))>64000)throw Error('成果过大，请分块或减少预览样本');const next=[...value.artifacts],index=next.findIndex(a=>a.id===artifact.id);if(index<0)next.push(artifact);else next[index]=artifact;const bounded=next.slice(-12);if(Buffer.byteLength(JSON.stringify(bounded))>256000)throw Error('成果超过快照字节预算');value.artifacts=bounded;}
  function parseMessage(text,id){let index=0;for(const match of text.matchAll(/```kmmdtable\s*\r?\n[\s\S]*?```/g)){const parsed=M.parseOutput(match[0]),key=id+':'+(index++)+':'+createHash('sha256').update(JSON.stringify({plan:parsed.plan,artifacts:parsed.artifacts})).digest('hex');if(blocks.has(key))continue;if(parsed.warnings.length){value.warnings=parsed.warnings.slice(-5);continue;}try{if(parsed.plan)value.plan=parsed.plan;for(const artifact of parsed.artifacts){putArtifact(artifact);sections.delete(artifact.id);}remember(blocks,key);}catch{value.warnings=['一项成果超过预览字节预算，未显示；请分块或缩减样本。'];}}}
  function step(input){if(typeof input.id!=='string'||!/^[\w:.-]{1,140}$/.test(input.id)||typeof input.label!=='string'||!input.label.trim()||input.label.length>100||!['running','completed','failed','waiting'].includes(input.status))throw Error('步骤格式不符合约定');const item={id:input.id,label:input.label,status:input.status,detail:clamp(input.detail,400)};const index=value.steps.findIndex(x=>x.id===item.id);if(index<0)value.steps.push(item);else value.steps[index]=item;value.steps=value.steps.slice(-30);}
  function accept(event,{deferText=false}={}){
    if(event?.data?.sessionID!==sessionId||(!event.type?.startsWith('session.')&&!['form.created','form.replied','form.cancelled'].includes(event.type))||event.type==='session.reasoning.delta'||event.type.includes('tool.input.delta'))return false;
    if(!remember(seen,event.id))return false;
    const d=event.data;
    if(event.type==='session.approval.created')return putApproval(d.approval);
    if(event.type==='session.approval.resolved')return settleApproval(d.id);
    if(event.type==='form.created')return putQuestion(d.question);
    if(event.type==='form.replied'||event.type==='form.cancelled')return settleQuestion(d.id);
    if(event.type==='session.reasoning.started'||event.type==='session.reasoning.ended'){activity({id:'thinking:'+d.assistantMessageID+':'+d.ordinal,messageId:d.assistantMessageID,kind:'thinking',status:event.type.endsWith('started')?'running':'completed',label:'思考',...(event.type.endsWith('started')&&Number.isFinite(event.created)?{startedAt:event.created}:{})});return true;}
    if(event.type==='session.text.delta'&&deferText)return true;
    if(event.type==='session.inbox.enqueued'&&d.item?.type==='user') {if(!remember(inputs,d.inboxID))return false;const m=message(d.inboxID,'user');m.text=clamp(d.item.payload?.text,4000);m.files=fileMeta(d.item.payload?.files);if(['idle','completed','interrupted','failed'].includes(value.status))value.status='queued';}
    else if(event.type==='session.execution.started'){value.status='running';value.error=null;value.startedAt=event.created||Date.now();}
    else if(TERMINALS[event.type]){value.status=TERMINALS[event.type];if(value.status==='failed')value.error='OpenCode本轮执行失败，请查看本地原因。';for(const a of activities.values())if(a.status==='running')activity({...a,status:value.status==='completed'?'completed':'failed'});}
    else if(event.type==='session.text.started'){
      if(!d.assistantMessageID||!Number.isSafeInteger(d.ordinal))return false;parts.set(d.assistantMessageID+':'+d.ordinal,{id:d.assistantMessageID,ordinal:d.ordinal,text:''});
    }else if(['session.text.delta','session.text.updated','session.text.ended'].includes(event.type)){
      const id=d.assistantMessageID;if(!id||!Number.isSafeInteger(d.ordinal))return false;
      const key=id+':'+d.ordinal;
      parts.set(key,{id,ordinal:d.ordinal,text:clamp(event.type==='session.text.delta'?(parts.get(key)?.text||'')+(d.delta||''):d.text,180000)});
      message(id,'assistant').text=[...parts.values()].filter(p=>p.id===id).sort((a,b)=>a.ordinal-b.ordinal).map(p=>p.text).join('\n').slice(0,180000);
      parseMessage(messages.get(id).text,id);
      const publicText=M.parseOutput(messages.get(id).text).text;if(event.type==='session.text.ended'||publicText.length>=24)attachPublicContext(id,publicText.split(/\n\s*\n/)[0],'assistant-public-text');
    }else if(event.type==='session.tool.input.started'){
      tools.set(d.id,{id:d.id,name:clamp(d.name,70),status:'running'});step({id:'tool:'+d.id,label:'调用 '+clamp(d.name,70),status:'running'});
      activity({id:'tool:'+d.id,messageId:d.assistantMessageID,kind:d.name==='skill'?'skill':'tool',toolName:clamp(d.name,70),label:'调用 '+clamp(d.name,70),status:'running',...(Number.isFinite(event.created)?{startedAt:event.created}:{})});
    }else if(event.type==='session.tool.called'){
      if(!tools.has(d.id))tools.set(d.id,{id:d.id,name:'本地工具',status:'running'});
      if(d.publicTool)activity({...activities.get('tool:'+d.id),id:'tool:'+d.id,kind:activities.get('tool:'+d.id)?.kind||'tool',toolName:tools.get(d.id)?.name,label:activities.get('tool:'+d.id)?.label||'调用本地工具',...d.publicTool,status:'running'});
      if(d.publicTool?.summary)attachPublicContext(d.assistantMessageID||activities.get('tool:'+d.id)?.messageId,`${tools.get(d.id)?.name||'工具'}：${d.publicTool.summary}`,'tool-action');
      if(/^[\w-]{1,80}$/.test(d.publicSkill||''))activity({id:'tool:'+d.id,kind:'skill',label:'技能 · '+d.publicSkill,status:'running'});
    }else if(event.type==='session.tool.success'||event.type==='session.tool.failed'){
      const item=tools.get(d.id)||{id:d.id,name:'本地工具'};item.status=event.type.endsWith('success')?'completed':'failed';tools.set(d.id,item);step({id:'tool:'+d.id,label:'调用 '+item.name,status:item.status});
      activity({...activities.get('tool:'+d.id),...d.publicResult,historical:false,id:'tool:'+d.id,kind:activities.get('tool:'+d.id)?.kind||'tool',label:activities.get('tool:'+d.id)?.label||'调用 '+item.name,status:item.status});
    }else return false;
    refresh();return true;
  }
  function publish(event){
    if(!event||typeof event.id!=='string'||event.id.length>100||typeof event.type!=='string'||!event.payload||Array.isArray(event.payload))throw Error('UI事件格式无效');
    if(uiSeen.has(event.id))return false;
    if(event.protocol&&event.protocol!==PROTOCOL)throw Error('协议版本不支持');if(event.sessionId&&event.sessionId!==sessionId)throw Error('会话作用域不匹配');if(!COMMANDS[event.type])throw Error('不支持此UI动作');
    const p=event.payload;
    const requireArtifact=()=>{const a=value.artifacts.find(a=>a.id===p.artifactId);if(!a)throw Error('成果不存在');return a;};
    const action=(type,extra={})=>{const a={eventId:event.id,type,...extra};value.ui.action=a;value.ui.actions=[...value.ui.actions,a].slice(-20);};
    if(event.type==='resource.create'){if(value.artifacts.some(a=>a.id===p.id))throw Error('资源ID已存在，请使用编辑');const artifact=block({...p,type:'artifact',buildState:'building',...(p.kind==='table'?{columns:p.columns||['字段'],rows:[]}:{}),...(p.kind==='page'?{metrics:[],sections:[]}:{} )}).artifacts[0];putArtifact(artifact);value.focusArtifactId=p.id;value.ui.work={artifactId:p.id,status:'waiting',label:'等待Agent生成页面内容'};action('resource.edit',{artifactId:p.id});}
    else if(event.type==='resource.open'||event.type==='resource.edit'){requireArtifact();value.focusArtifactId=p.artifactId;action(event.type,{artifactId:p.artifactId});}
    else if(event.type==='panel.open'){if(!['side','workspace'].includes(p.mode))throw Error('界面模式不支持');action(event.type,{mode:p.mode});}
    else if(event.type==='panel.close')action(event.type);
    else if(event.type==='work.status'){requireArtifact();if(!['running','waiting','completed','failed'].includes(p.status)||typeof p.label!=='string'||p.label.length>120)throw Error('工作状态无效');value.ui.work={artifactId:p.artifactId,status:p.status,label:p.label};}
    else if(event.type==='activity.updated')activity(p);
    else if(event.type==='plan.updated'){value.plan=block({...p,type:'plan'}).plan;}
    else if(event.type==='artifact.updated'){putArtifact(block({...p,buildState:p.buildState||'building',type:'artifact'}).artifacts[0]);sections.delete(p.id);}
    else if(event.type==='artifact.ready'){const artifact=value.artifacts.find(a=>a.id===p.artifactId);if(!artifact)throw Error('成果不存在');putArtifact({...artifact,buildState:'ready'});}
    else if(event.type==='step.updated'){step(p);activity({...p,kind:'phase'});}
    else if(event.type==='artifact.focus'){if(!value.artifacts.some(a=>a.id===p.artifactId))throw Error('尚无可聚焦成果');value.focusArtifactId=p.artifactId;}
    else if(event.type==='page.section.updated'){
      const artifact=value.artifacts.find(a=>a.id===p.artifactId);if(!artifact||!['page','dashboard'].includes(artifact.kind))throw Error('先创建页面或仪表盘预览');
      if(!/^[\w-]{1,64}$/.test(p.section?.id))throw Error('区块ID无效');
      const ids=[...(sections.get(artifact.id)||Array(artifact.sections.length).fill(null))],index=ids.indexOf(p.section.id),next=[...artifact.sections];
      const section={title:p.section.title,text:p.section.text};if(index<0){ids.push(p.section.id);next.push(section);}else next[index]=section;
      const checked=block({...artifact,type:'artifact',sections:next}).artifacts[0];sections.set(artifact.id,ids);putArtifact(checked);
    }else if(event.type==='table.rows.append'){
      const artifact=value.artifacts.find(a=>a.id===p.artifactId);if(!artifact||artifact.kind!=='table'||!Array.isArray(p.rows))throw Error('先创建表格预览');putArtifact(block({...artifact,type:'artifact',rows:[...artifact.rows,...p.rows]}).artifacts[0]);
    }else if(event.type==='run.note'){
      if(typeof p.text!=='string'||!p.text.trim()||p.text.length>3000)throw Error('说明文字无效');message('note:'+event.id,'assistant').text=p.text;
    }else throw Error('不支持此UI动作');
    remember(uiSeen,event.id);value.ui.deliveries=[...value.ui.deliveries,{eventId:event.id,type:event.type,targetId:event.type.startsWith('artifact.')&&p.id?p.id:p.artifactId||(['resource.create'].includes(event.type)?p.id:null)}].slice(-30);refresh();return true;
  }
  function hydrate(snapshot){
    clearQuestions();for(const q of snapshot.questions||[])putQuestion(q);
    clearApprovals();for(const a of snapshot.approvals||[])putApproval(a);
    for(const m of snapshot.messages||[]){const target=message(m.id,m.role);target.text=clamp(m.text,180000);if(m.role==='user'){target.files=fileMeta(m.files);remember(inputs,m.id);}if(m.role==='assistant'){for(const part of m.segments||[{ordinal:0,text:m.text}])parts.set(m.id+':'+part.ordinal,{id:m.id,...part});parseMessage(m.text,m.id);}}
    for(const tool of snapshot.tools||[])tools.set(tool.id,tool);
    for(const a of snapshot.activities||[])if(!activities.has(a.id))activity(a);
    for(const m of snapshot.messages||[])if(m.role==='assistant')attachPublicContext(m.id,M.parseOutput(m.text).text.split(/\n\s*\n/)[0],'assistant-public-text');
    for(const a of snapshot.activities||[])if(['tool','skill'].includes(a.kind)&&a.summary)attachPublicContext(a.messageId,`${a.toolName||'工具'}：${a.summary}`,'tool-action');
    if(snapshot.timeline?.length){const keys=new Set(snapshot.timeline.map(x=>x.kind+':'+x.id));value.timeline=[...snapshot.timeline,...value.timeline.filter(x=>!keys.has(x.kind+':'+x.id))].slice(-140);}
    value.status=snapshot.status||'idle';value.model=snapshot.model||null;refresh();
  }
  function reconcileText(snapshot,keys){for(const m of snapshot.messages||[]){if(m.role!=='assistant')continue;let updated=false;for(const part of m.segments||[{ordinal:0,text:m.text}])if(keys.has(m.id+':'+part.ordinal)){parts.set(m.id+':'+part.ordinal,{id:m.id,...part,text:clamp(part.text,180000)});updated=true;}if(updated){const target=message(m.id,'assistant');target.text=[...parts.values()].filter(p=>p.id===m.id).sort((a,b)=>a.ordinal-b.ordinal).map(p=>p.text).join('\n').slice(0,180000);parseMessage(target.text,m.id);}}refresh();}
  return {value,accept,publish,hydrate,reconcileText,settleQuestion,clearQuestions,settleApproval,clearApprovals};
}

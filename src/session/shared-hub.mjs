import {createHash} from 'node:crypto';
import {createProjection,questionAnswer} from './shared-state.mjs';

export function createSharedHub({adapter,session,onChange,instructionKey,instruction}) {
  const projection=createProjection(session.id),members=new Set(),requests=new Map(),questionRequests=new Map(),approvalRequests=new Map();
  let watcher=null,retry=null,closed=false,flushTimer=null,transport='connecting',epoch=0,installation=null,closing=null,textTimer=null,textBusy=false,textDirty=false;
  const deferredText=new Set(),partKey=event=>event.data?.assistantMessageID+':'+event.data?.ordinal;
  function flush(){clearTimeout(flushTimer);flushTimer=null;if(!closed)onChange();}
  function changed(immediate=false){if(immediate){flush();return;}if(!flushTimer){flushTimer=setTimeout(flush,35);flushTimer.unref?.();}}
  async function connect(){
    const mine=++epoch;clearTimeout(retry);watcher?.close();watcher=null;transport='connecting';deferredText.clear();let booting=true;const buffered=[];
    await adapter.bindSession(session.id);
    if(closed||mine!==epoch)throw Error('绑定已取消');
    watcher=adapter.watch(session.id,event=>{
      if(closed||mine!==epoch)return;
      if(['session.moved','session.deleted'].includes(event.type)){disconnected(mine);return;}
      if(booting){if(buffered.length>=2048){disconnected(mine);return;}buffered.push(event);return;}
      live(event,mine);
    },state=>{if(state==='disconnected')disconnected(mine);});
    await watcher.ready;
    const snapshot=await adapter.readShared(session.id);
    if(closed||mine!==epoch)throw Error('初始化期间事件连接或会话范围已变化');
    projection.hydrate(snapshot);
    const started=new Set(buffered.filter(e=>e.type==='session.text.started').map(partKey)),ended=new Set(buffered.filter(e=>e.type==='session.text.ended').map(partKey));
    for(const event of buffered){const key=partKey(event);if(event.type==='session.text.delta'&&!started.has(key)&&!ended.has(key)){deferredText.add(key);projection.accept(event,{deferText:true});}else projection.accept(event);}
    booting=false;
    transport='connected';changed(true);
    if(deferredText.size)scheduleText(mine);
  }
  function disconnected(mine){if(closed||mine!==epoch)return;++epoch;watcher?.close();transport='disconnected';projection.clearQuestions();projection.clearApprovals();clearTimeout(textTimer);projection.value.error='原生事件通道或会话范围发生变化，正在核验；不重新提交需求。';projection.value.status='unknown';changed(true);clearTimeout(retry);retry=setTimeout(()=>{void adapter.health().then(connect).catch(scheduleRetry);},2000);retry.unref?.();}
  function live(event,mine){const key=partKey(event);if(event.type==='session.text.delta'&&deferredText.has(key)){if(projection.accept(event,{deferText:true}))scheduleText(mine);return;}if(['session.text.started','session.text.ended'].includes(event.type))deferredText.delete(key);if(projection.accept(event))changed(event.type.startsWith('session.execution.'));}
  function scheduleText(mine){textDirty=true;if(textTimer||textBusy)return;textTimer=setTimeout(async()=>{textTimer=null;if(closed||mine!==epoch||!deferredText.size)return;textBusy=true;textDirty=false;try{const snapshot=await adapter.readShared(session.id);if(!closed&&mine===epoch){projection.reconcileText(snapshot,new Set(deferredText));changed();}}catch{disconnected(mine);}finally{textBusy=false;if(textDirty&&!closed&&mine===epoch)scheduleText(mine);}},75);textTimer.unref?.();}
  function scheduleRetry(){if(closed)return;transport='disconnected';changed(true);retry=setTimeout(()=>{void adapter.health().then(connect).catch(scheduleRetry);},5000);retry.unref?.();}
  async function start(){await connect();if(!closed&&adapter.installBridge){installation=Promise.resolve(adapter.installBridge(session.id,instructionKey,instruction));await installation;}}
  async function submit(owner,input,{assertCurrent=()=>{}}={}){
    const mine=epoch,check=()=>{assertCurrent();if(closed||transport!=='connected'||epoch!==mine||!members.has(owner))throw Error('需求所属原生连接或授权已变化');};check();
    const signature=createHash('sha256').update(JSON.stringify({text:input.text,pageContext:input.pageContext||null,uploads:input.uploads||[],references:input.references||[]})).digest('hex'),previous=requests.get(input.requestId);
    if(previous){if(previous.signature!==signature)throw Error('相同请求ID不能用于不同需求');return previous.promise;}
    const controller=new AbortController(),record={signature,controller,owner,promise:null};
    record.promise=(async()=>{try{
      const receipt=await adapter.sendShared(session.id,input.text,{requestId:input.requestId,signal:controller.signal,assertCurrent:check,...(input.pageContext?{pageContext:input.pageContext}:{}),uploads:input.uploads||[],references:input.references||[]});check();
      const confirmation=receipt.accepted===true&&receipt.delivery==='accepted'?{accepted:true,delivery:'accepted',...(receipt.nativeEcho===true?{clientMessageId:receipt.id,nativeTurnId:receipt.nativeTurnId}:{})}:{};
      if(closed)return {runId:projection.value.id,messageId:receipt.id,...confirmation};
      // An acknowledgment can carry a correlation ID distinct from the native
      // message ID. For those sources, the event or history supplies the echo.
      if(receipt.nativeEcho!==true)projection.accept({id:'receipt:'+receipt.id,type:'session.inbox.enqueued',data:{sessionID:session.id,inboxID:receipt.id,item:{type:'user',payload:{text:typeof receipt.payload?.text==='string'?receipt.payload.text:input.text,files:receipt.payload?.files||[...(input.uploads||[]).map(x=>({name:x.name,mime:x.mime})),...(input.references||[]).map(name=>({name}))]},delivery:'queue'}}});changed(true);
      return{runId:projection.value.id,messageId:receipt.id,...confirmation};
    }catch(error){if(error?.code==='NOT_SUBMITTED'&&requests.get(input.requestId)===record)requests.delete(input.requestId);throw error;}})();
    requests.set(input.requestId,record);while(requests.size>100)requests.delete(requests.keys().next().value);
    return record.promise;
  }
  async function answerQuestion(owner,input,{reject=false,assertCurrent=()=>{}}={}){
    const mine=epoch,check=()=>{assertCurrent();if(closed||transport!=='connected'||epoch!==mine||!members.has(owner))throw Error('问题所属连接已变化，未确认提交');};check();
    const method=reject?adapter.rejectQuestion:adapter.replyQuestion;if(typeof method!=='function')throw Error('该适配器不支持原生问题');
    const signature=createHash('sha256').update(JSON.stringify({reject,answers:reject?null:input.answers})).digest('hex'),previous=questionRequests.get(input.questionId);
    if(previous){if(previous.signature!==signature)throw Error('此问题已经提交其他回答或拒绝请求');return previous.promise;}
    const question=projection.value.questions.find(q=>q.id===input.questionId&&q.sessionId===session.id);if(!question)throw Error('当前会话没有此待答问题');if(!reject)questionAnswer(question,input.answers);
    const controller=new AbortController(),record={signature,owner,controller,promise:null};
    questionRequests.set(input.questionId,record);
    record.promise=(async()=>{try{const opts={signal:controller.signal,assertCurrent:check};if(reject)await method(session.id,input.questionId,opts);else await method(session.id,input.questionId,input.answers,opts);check();projection.settleQuestion(input.questionId);changed(true);return{questionId:input.questionId,status:reject?'rejected':'answered'};}catch(error){if((['QUESTION_INVALID_ANSWER','QUESTION_NOT_SUBMITTED'].includes(error?.code)||error?._tag==='FormInvalidAnswerError')&&questionRequests.get(input.questionId)===record)questionRequests.delete(input.questionId);throw error;}})();
    while(questionRequests.size>100)questionRequests.delete(questionRequests.keys().next().value);return record.promise;
  }
  async function answerApproval(owner,input,{assertCurrent=()=>{}}={}){
    const mine=epoch,check=()=>{assertCurrent();if(closed||transport!=='connected'||epoch!==mine||!members.has(owner))throw Error('审批所属连接已变化');};check();if(typeof adapter.respondApproval!=='function')throw Error('该来源不支持原生审批');
    const previous=approvalRequests.get(input.approvalId);if(previous){if(previous.decision!==input.decision)throw Error('此审批已有不同答复');return previous.promise;}
    const approval=projection.value.approvals.find(a=>a.id===input.approvalId&&a.sessionId===session.id);if(!approval||!approval.decisions.includes(input.decision))throw Error('当前会话没有此待审批项');
    const controller=new AbortController(),record={decision:input.decision,owner,controller,promise:null};approvalRequests.set(input.approvalId,record);
    record.promise=(async()=>{try{const result=await adapter.respondApproval(session.id,input.approvalId,input.decision,{signal:controller.signal,assertCurrent:check});check();if(result?.status!=='resolved')throw Error('原生审批结果未知');projection.settleApproval(input.approvalId);changed(true);return{approvalId:input.approvalId,status:'resolved'};}catch(error){if(error?.code==='APPROVAL_NOT_SUBMITTED'&&approvalRequests.get(input.approvalId)===record)approvalRequests.delete(input.approvalId);throw error;}})();while(approvalRequests.size>100)approvalRequests.delete(approvalRequests.keys().next().value);return record.promise;
  }
  function cancelControl(owner){for(const record of [...requests.values(),...questionRequests.values(),...approvalRequests.values()])if(record.owner===owner)record.controller.abort();}
  function remove(owner){members.delete(owner);cancelControl(owner);}
  async function stop(){if(closed||transport!=='connected')throw Error('原生事件连接未就绪，停止结果不可确认');const mine=epoch,receipt=await adapter.interruptShared(session.id);if(closed||epoch!==mine||transport!=='connected')throw Error('停止确认所属原生连接已变化，未改变当前投影');if(receipt.interrupted){projection.value.status='interrupted';changed(true);}return receipt;}
  function publish(event){if(closed||!members.size)throw Error('此会话尚未被网页授权订阅');const applied=projection.publish(event);if(applied)changed(true);return{applied,cursor:projection.value.messages.length};}
  function close(){if(closing)return closing;closed=true;++epoch;clearTimeout(retry);clearTimeout(flushTimer);clearTimeout(textTimer);watcher?.close();projection.clearQuestions();projection.clearApprovals();for(const record of [...requests.values(),...questionRequests.values(),...approvalRequests.values()])record.controller.abort();closing=(async()=>{if(installation)await installation.catch(()=>{});if(adapter.removeBridge)await adapter.removeBridge(session.id,instructionKey).catch(()=>{});})();return closing;}
  return{adapter,session,projection,members,start,submit,answerQuestion,answerApproval,cancelControl,remove,stop,publish,close,get transport(){return transport;},get transportEpoch(){return epoch;}};
}

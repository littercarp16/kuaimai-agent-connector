import{resolve,basename}from'node:path';import{shellTokens}from'../../tools/tool-public.mjs';
import{nextSourceOrder}from'../../session/source-order.mjs';
export function isRelevantEvent(event,toolName=''){
 const d=event?.data||{};
 if(event?.type==='session.inbox.enqueued'&&d.item?.type==='user')return /\blingtong-cli\b|绫通\s*(?:CLI|命令行)/i.test(String(d.item.payload?.text||'').slice(0,12000));
 if(event?.type!=='session.tool.called'||!['shell','bash'].includes(toolName))return false;
 const command=String(d.input?.command||d.input?.cmd||'');let first=true;
 for(const token of shellTokens(command.includes('<<')?command.split('\n')[0]:command)){const word=token.value;if(token.operator){first=true;continue;}if(first&&(/^[A-Za-z_]\w*=/.test(word)||['env','command','exec'].includes(word)))continue;if(first&&basename(word)==='lingtong-cli')return true;first=false;}
 return false;
}
export function createSessionDiscovery({current,health,directory,channel=null}){
 const scope=resolve(directory);
 function watchRelevantSessions(onCandidate,onState=()=>{}){
   const control=new AbortController(),names=new Map(),seen=new Set(),intents=new Map();let resolveReady,rejectReady;
  const ready=new Promise((r,j)=>{resolveReady=r;rejectReady=j;}),timer=setTimeout(()=>{rejectReady(Error('会话发现通道未就绪'));control.abort();},5000);timer.unref?.();
  void(async()=>{try{
   if(!current())await health();const client=current()?.client;if(!client)throw Error('OpenCode未就绪');
   for await(const event of client.event.subscribe({signal:control.signal})){
    if(control.signal.aborted)break;if(event.type==='server.connected'){clearTimeout(timer);resolveReady();onState('connected');continue;}
    const d=event.data||{},key=d.sessionID+':'+d.id;
    if(event.type==='session.tool.input.started'){names.set(key,String(d.name||''));if(names.size>300)names.delete(names.keys().next().value);continue;}
     if(!d.sessionID)continue;
     if(seen.has(event.id))continue;
     if(event.type==='session.inbox.enqueued'&&d.item?.type==='user'){intents.set(d.sessionID,{observedOrder:nextSourceOrder(),observedAt:Date.now(),pending:false,announced:false});if(intents.size>512)intents.delete(intents.keys().next().value);}
     if(!isRelevantEvent(event,names.get(key)||'')){if(event.type==='session.inbox.enqueued'){seen.add(event.id);if(seen.size>512)seen.delete(seen.values().next().value);}continue;}
     seen.add(event.id);if(seen.size>512)seen.delete(seen.values().next().value);
     if(!intents.has(d.sessionID)){intents.set(d.sessionID,{observedOrder:nextSourceOrder(),observedAt:Date.now(),pending:false,announced:false});if(intents.size>512)intents.delete(intents.keys().next().value);}
     const intent=intents.get(d.sessionID);if(intent.pending||intent.announced)continue;intent.pending=true;
    // Slow scope checks never block the shared native event source; late results are discarded.
    void client.session.get({sessionID:d.sessionID},{signal:AbortSignal.any([control.signal,AbortSignal.timeout(5000)])}).then(info=>{
      if(control.signal.aborted||intents.get(d.sessionID)!==intent||info.id!==d.sessionID||!info.location?.directory||resolve(info.location.directory)!==scope||info.parentID||info.time?.archived||(info.metadata?.kmAgentChannel||null)!==channel)return;
      intent.announced=true;onCandidate({id:info.id,title:String(info.title||'绫通操作会话').slice(0,100),reason:event.type==='session.tool.called'?'command':'prompt',observedOrder:intent.observedOrder,observedAt:intent.observedAt});
     }).catch(()=>{}).finally(()=>{intent.pending=false;});
   }
   if(!control.signal.aborted)throw Error('会话发现通道已关闭');
  }catch{if(!control.signal.aborted){rejectReady(Error('会话发现暂不可用'));onState('disconnected');}}finally{clearTimeout(timer);}})();
  return{ready,close(){control.abort();clearTimeout(timer);rejectReady(Error('发现已停止'));}};
 }
 return{watchRelevantSessions};
}

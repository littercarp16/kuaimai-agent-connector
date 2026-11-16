const BUSY=new Set(['queued','running','stopping','unknown']);
import{nextSourceOrder}from'./source-order.mjs';
export function createFollowManager({adapter,autoTrust,clients,bind,push,now=Date.now,enableMultiAgentFollow=false,workBuddy=false,canSwitch=()=>true}){
 const nativeSupported=typeof adapter.watchRelevantSessions==='function',supported=nativeSupported||enableMultiAgentFollow&&workBuddy;let watcher=null,retry=null,closed=false,epoch=0,status='idle',starting=null;
 const authorized=c=>c.active&&c.expires>=now()&&c.follow?.authorized;
  function init(c,trusted=false){const allowed=supported&&(trusted||enableMultiAgentFollow);c.follow={authorized:allowed,enabled:allowed&&autoTrust?.followSessions!==false,pending:[],switching:false,epoch:0,error:'',lastSwitch:null,...(enableMultiAgentFollow?{latestOrder:0}:{})};}
  function hold(c,target,ownBinding=false){if(c.bindingBusy&&!ownBinding)return'binding';if(!enableMultiAgentFollow)return BUSY.has(c.hub?.projection.value.status)?'running':'';if(c.writesBusy||c.newSessionBusy)return'submitting';if(c.hub?.projection.value.questions?.length)return'questions';if(c.hub?.projection.value.approvals?.length)return'approvals';if(BUSY.has(c.run?.status))return'isolated-running';if(target&&!canSwitch(c,target))return'subscription-limit';return'';}
 const view=c=>({supported,mode:c.follow?.enabled?'follow':'pinned',discovery:status,pending:c.follow?.pending||[],switching:c.follow?.switching||false,error:c.follow?.error||'',lastSwitch:c.follow?.lastSwitch||null,...(enableMultiAgentFollow?{holdReason:hold(c,c.follow?.pending.at(-1))}: {})});
 async function drain(c){const state=c.follow;if(!state?.enabled||!authorized(c)||state.switching||!state.pending.length||hold(c,state.pending.at(-1)))return;
  const target=enableMultiAgentFollow?state.pending.pop():state.pending.shift(),mine=++state.epoch;if(enableMultiAgentFollow)state.pending=[];state.switching=true;state.error='';push(c);
  try{await bind(c,{sessionId:target.id,allowControl:false},{isCurrent:()=>authorized(c)&&state.enabled&&state.epoch===mine&&!hold(c,target,true)});if(authorized(c)&&state.epoch===mine)state.lastSwitch={...target,at:now()};}
  catch{if(authorized(c)&&state.epoch===mine){if(hold(c,target)){state.pending=[target,...state.pending.filter(x=>x.id!==target.id)].slice(0,5);state.error='';}else state.error='新会话暂不能接入，原会话保留；不会重发任务。';}}
  finally{state.switching=false;if(authorized(c)){push(c);void drain(c);}}
 }
 function offer(candidate,onlyClient=null){if(closed||!/^ses[\w-]{1,120}$/.test(candidate?.id||''))return;
  const provider=candidate.provider||adapter.descriptor?.id||'opencode';if(provider==='workbuddy'&&(!enableMultiAgentFollow||!workBuddy))return;
   const observedOrder=Number.isSafeInteger(candidate.observedOrder)&&candidate.observedOrder>0?candidate.observedOrder:nextSourceOrder();
   const jobs=[];for(const c of onlyClient?[onlyClient]:clients())if(authorized(c)){const state=c.follow;if(enableMultiAgentFollow){if(observedOrder<=state.latestOrder)continue;state.latestOrder=observedOrder;}if(c.hub?.session.id===candidate.id){if(enableMultiAgentFollow){++state.epoch;state.pending=[];push(c);}continue;}if(enableMultiAgentFollow&&state.switching)++state.epoch;state.pending=state.pending.filter(x=>x.id!==candidate.id);state.pending.push({id:candidate.id,title:String(candidate.title||'绫通操作会话').slice(0,100),reason:provider==='workbuddy'?(candidate.reason==='cached-task'?'cached-task':'task-open'):candidate.reason==='command'?'command':'prompt',at:candidate.observedAt??candidate.createdAt??now(),...(enableMultiAgentFollow?{provider,...(candidate.status?{status:candidate.status}:{})}:{})});state.pending=state.pending.slice(-5);push(c);jobs.push(drain(c));}return Promise.all(jobs);
 }
 function fail(mine){if(closed||mine!==epoch)return;++epoch;watcher?.close();watcher=null;status='offline';for(const c of clients())if(authorized(c))push(c);clearTimeout(retry);retry=setTimeout(()=>{void ensure();},2000);retry.unref?.();}
 async function ensure(){if(closed||!nativeSupported||![...clients()].some(authorized))return;if(watcher)return starting;const mine=++epoch;status='connecting';watcher=adapter.watchRelevantSessions(candidate=>offer(candidate),state=>{if(mine!==epoch||closed)return;if(state==='disconnected')fail(mine);else{status='connected';for(const c of clients())if(authorized(c))push(c);}});starting=watcher.ready;
  try{await starting;if(mine===epoch&&!closed)status='connected';}catch{fail(mine);}finally{if(mine===epoch)starting=null;}
 }
 function reconcile(){if(![...clients()].some(authorized)){++epoch;clearTimeout(retry);watcher?.close();watcher=null;status='idle';}else void ensure();}
 function set(c,enabled){if(!supported)throw Error('当前适配器不支持原生会话发现');c.follow.authorized=true;c.follow.enabled=enabled;++c.follow.epoch;c.follow.error='';reconcile();push(c);if(enabled)void drain(c);}
 function pin(c){if(c.follow){c.follow.enabled=false;++c.follow.epoch;}}
 function close(){closed=true;++epoch;clearTimeout(retry);watcher?.close();watcher=null;}
 return{supported,init,view,ensure,reconcile,set,pin,close,offer,drain,tick:c=>{void drain(c);}};
}

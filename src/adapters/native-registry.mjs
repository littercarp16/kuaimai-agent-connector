/* Native provider routing, not a second agent runner. A hub keeps its exact
 * provider adapter; only discovery and metadata lists are combined here. */
export function nativeCapabilities(adapter,agent={ready:true}){
 const c={pageContext:false,newSession:typeof adapter.createSharedSession==='function',workspaceFiles:typeof adapter.searchWorkspaceFiles==='function',attachments:typeof adapter.sendShared==='function',nativeQuestions:typeof adapter.listQuestions==='function'&&typeof adapter.replyQuestion==='function'&&typeof adapter.rejectQuestion==='function',nativeApprovals:typeof adapter.listApprovals==='function'&&typeof adapter.respondApproval==='function',followSessions:typeof adapter.watchRelevantSessions==='function',toolDetails:true,toolDetailFetch:typeof adapter.readToolDetail==='function',uiCommands:true,uiReceipts:true,demo:typeof adapter.createSession==='function',submitPrompt:agent.ready===true&&(typeof adapter.sendShared==='function'||typeof adapter.send==='function'),sharedSession:typeof adapter.bindSession==='function',nativeEvents:typeof adapter.watch==='function',cancelRun:typeof adapter.interruptShared==='function'||typeof adapter.interrupt==='function',previewArtifacts:true,businessWrite:false};
 for(const[k,v]of Object.entries(adapter.capabilities||{}))if(Object.hasOwn(c,k)&&typeof v==='boolean')c[k]=v;
 if(agent.ready!==true)c.submitPrompt=false;return c;
}
const unavailable=()=>({ready:false,version:null,message:'该原生来源暂不可用；未启动或重启客户端。'});
export function createNativeRegistry({primary,additional=[]}={}){
 if(!primary?.health||!Array.isArray(additional))throw Error('需要明确原生主适配器');const entries=[primary,...additional],providers=new Map(),health=new Map(),watchers=new Set();let closed=false;
 const provider=a=>a.descriptor?.id||'opencode';
 for(const a of entries){const id=provider(a);if(!/^[a-z][a-z0-9-]{0,39}$/.test(id)||!a?.health||providers.has(id)||id==='workbuddy')throw Error('原生适配器来源重复或无效');providers.set(id,a);}
 function forSession(id){
  if(typeof id!=='string'||!/^ses[\w-]{1,120}$/.test(id))throw Error('原生会话标识无效');
  if(id.startsWith('ses_wb_'))throw Error('WorkBuddy不是原生适配器来源');
  if(id.startsWith('ses_codex_')){const a=providers.get('codex');if(!a||!/^ses_codex_[a-f0-9]{32}$/.test(id))throw Error('Codex来源未知或尚未安装适配器');return a;}
  if(id.startsWith('ses_qwen_')){const a=providers.get('qwen');if(!a||!/^ses_qwen_[a-f0-9]{32}$/.test(id))throw Error('千问办公来源未知或尚未启用');return a;}
  if(provider(primary)==='codex')throw Error('未知原生来源，不回退Codex');return primary;
 }
 async function healthFor(a){if(closed)return unavailable();try{const raw=await a.health(),value={ready:raw?.ready===true,version:typeof raw?.version==='string'?raw.version:null,message:String(raw?.message||'').slice(0,180)};if(!closed)health.set(a,value);return value;}catch{const value=unavailable();if(!closed)health.set(a,value);return value;}}
 const agentFor=a=>health.get(a)||unavailable();
 let lastSources=[];
 async function listSources(){
  lastSources=await Promise.all(entries.map(async a=>{const agent=await healthFor(a),id=provider(a);let sessions=[],status=agent.ready?'available':'unavailable';
   if(agent.ready&&a.listSessions){try{const result=await a.listSessions();if(!Array.isArray(result))throw Error();sessions=result.filter(s=>{try{return forSession(s.id)===a;}catch{return false;}}).slice(0,100).map(s=>({...s,provider:id,adapter:a.descriptor||{id,status:'native'},capabilities:nativeCapabilities(a,agent)}));}catch{status='unavailable';}}
   return{provider:id,status,adapter:a.descriptor||{id,status:'native'},agent,capabilities:nativeCapabilities(a,status==='available'?agent:{...agent,ready:false}),sessions,...(status==='unavailable'?{message:'原生来源列表暂不可用，未将失败表示为空列表成功。'}:{})};}));return lastSources.map(({sessions,...s})=>s);
 }
 const registry={...primary,descriptor:primary.descriptor||{id:provider(primary),status:'native'},forSession,agentFor,healthFor,sourceDiagnostics:()=>lastSources.map(({sessions,...s})=>s),async health(){return healthFor(primary);},async listSessions(){await listSources();return lastSources.flatMap(s=>s.sessions);},listSources,async close(){if(closed)return;closed=true;for(const w of [...watchers])w.close();await Promise.all(entries.map(a=>Promise.resolve().then(()=>a.close?.()).catch(()=>{})));}};
 if(entries.some(a=>typeof a.bindSession==='function'))registry.bindSession=async id=>{const source=forSession(id);if(typeof source.bindSession!=='function')throw Error('该来源不支持共享绑定');return source.bindSession(id);};
 const discoverable=entries.filter(a=>typeof a.watchRelevantSessions==='function');
 if(discoverable.length)registry.watchRelevantSessions=(offer,onState=()=>{})=>{
  let stopped=false;const states=new Map(),sources=new Map(),timers=new Map();
  const connected=()=>[...states.values()].some(x=>x==='connected');
  const allDisconnected=()=>states.size===discoverable.length&&[...states.values()].every(v=>v==='disconnected');
  const set=(a,state)=>{if(stopped)return;states.set(a,state);if(state==='connected')onState('connected');else if(state==='disconnected'&&!connected()&&allDisconnected())queueMicrotask(()=>{if(!stopped&&allDisconnected())onState('disconnected');});};
  async function start(a){if(stopped)return;clearTimeout(timers.get(a));sources.get(a)?.close();set(a,'connecting');
   try{const w=a.watchRelevantSessions(c=>{if(stopped)return;try{if(forSession(c.id)!==a)return;}catch{return;}offer({...c,provider:provider(a)});},state=>{set(a,state);if(state==='disconnected'&&!stopped){clearTimeout(timers.get(a));const timer=setTimeout(()=>{void start(a).catch(()=>{});},2000);timer.unref?.();timers.set(a,timer);}});sources.set(a,w);await w.ready;if(stopped){w.close();return;}set(a,'connected');}
   catch(error){set(a,'disconnected');if(!stopped){clearTimeout(timers.get(a));const timer=setTimeout(()=>{void start(a).catch(()=>{});},2000);timer.unref?.();timers.set(a,timer);}throw error;}
  }
  const result={ready:Promise.any(discoverable.map(a=>start(a))),close(){if(stopped)return;stopped=true;for(const timer of timers.values())clearTimeout(timer);for(const w of sources.values())w.close();watchers.delete(result);}};watchers.add(result);return result;
 };
 return registry;
}

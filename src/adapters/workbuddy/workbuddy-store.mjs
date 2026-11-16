import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {createProjection} from '../../session/shared-state.mjs';
import {redactText} from '../../tools/display-safety.mjs';
import {PROTOCOL,COMMANDS} from '../../protocol/protocol.mjs';
import{nextSourceOrder}from'../../session/source-order.mjs';

export const WORKBUDDY_ADAPTER=Object.freeze({id:'workbuddy',status:'publish-only',receiveMessages:false,sendPrompt:false,nativeActivities:false,publishUI:true});
export const WORKBUDDY_CAPABILITIES=Object.freeze({newSession:false,workspaceFiles:false,attachments:false,nativeQuestions:false,followSessions:false,toolDetails:false,toolDetailFetch:false,submitPrompt:false,nativeEvents:false,cancelRun:false,publishUI:true,sharedSession:true,uiCommands:true,uiReceipts:true,previewArtifacts:true,businessWrite:false,demo:false});
export class WorkBuddyFailure extends Error{constructor(status,message,code){super(message);this.status=status;this.code=code;}}
const fail=(status,message,code)=>{throw new WorkBuddyFailure(status,message,code);};
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&timingSafeEqual(x,y);};
const text=value=>redactText(value,false,{complete:true});
const fields=(value,allowed)=>{if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))fail(400,'WorkBuddy 公开数据字段不符合约定');};
const sanitize=(value,redact=text)=>Array.isArray(value)?value.map(v=>sanitize(v,redact)):object(value)?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,redact)])):typeof value==='string'?redact(value):value;
const PAYLOADS={
  'resource.create':['id','kind','name','description','appearance','columns'],
  'resource.open':['artifactId'],'resource.edit':['artifactId'],'panel.open':['mode'],'panel.close':[],
  'work.status':['artifactId','status','label'],
  'activity.updated':['id','kind','label','status','detail','visibility','publicSummary'],
  'plan.updated':['title','items'],'step.updated':['id','label','status','detail'],
  'artifact.updated':['id','kind','name','description','appearance','document','interactions','metrics','chart','sections','columns','rows','code','buildState'],
  'page.section.updated':['artifactId','section'],'table.rows.append':['artifactId','rows'],
  'artifact.focus':['artifactId'],'artifact.ready':['artifactId'],'run.note':['text']
};
function checkedEvent(event,taskId,redact=text){
  if(Buffer.byteLength(JSON.stringify(event)??'')>=19000)fail(413,'WorkBuddy UI事件必须小于19KB');
  fields(event,['protocol','id','type','payload','sessionId']);
  if(event.protocol!==PROTOCOL||typeof event.id!=='string'||!/^[\w:.-]{1,100}$/.test(event.id)||typeof event.type!=='string'||!Object.hasOwn(COMMANDS,event.type)||event.sessionId!==undefined&&event.sessionId!==taskId)fail(400,'WorkBuddy UI事件协议或作用域无效');
  const p=event.payload;fields(p,PAYLOADS[event.type]);
  for(const key of ['id','artifactId','kind','name','description','label','status','detail','visibility','publicSummary','code','buildState','text','title','mode'])if(Object.hasOwn(p,key)&&typeof p[key]!=='string')fail(400,'WorkBuddy 公开文本或标识须为字符串');
  if(event.type==='activity.updated'&&p.kind!=='phase')fail(400,'WorkBuddy 仅可上报公开phase，不提供原生工具或思考镜像');
  if(p.buildState!==undefined&&p.buildState!=='building')fail(400,'WorkBuddy 成果须显式发送artifact.ready');
  for(const [key,allowed] of [['appearance',['theme','accent','layout','density']],['document',['html','css']],['interactions',['search','sort']],['chart',['type','labels','values']],['section',['id','title','text']]])if(p[key]!==undefined)fields(p[key],allowed);
  for(const [key,allowed] of [['items',['id','kind','name']],['metrics',['label','value','hint']],['sections',['title','text']]])if(p[key]!==undefined){if(!Array.isArray(p[key]))fail(400,'WorkBuddy 公开列表无效');for(const item of p[key])fields(item,allowed);}
  if(p.items?.some(item=>typeof item.id!=='string'))fail(400,'WorkBuddy 计划标识须为字符串');
  const safe=sanitize(event,redact),q=safe.payload,identities=[[event.id,safe.id],[p.id,q.id],[p.artifactId,q.artifactId],[p.section?.id,q.section?.id],...(p.items||[]).map((item,i)=>[item.id,q.items[i].id])];
  if(identities.some(([raw,filtered])=>typeof raw==='string'&&raw!==filtered))fail(400,'WorkBuddy 公开标识含敏感内容，请改用非敏感标识；不会静默改写ID');
  return{safe,signature:digest(canonical(event)),bytes:Buffer.byteLength(JSON.stringify(event))};
}

/** Process-local collaboration IDs, never WorkBuddy native session identities. Tokens stay in this closure. */
export function createWorkBuddyStore({instanceId,publisherKey,now=Date.now,onChange=()=>{},onOpen=()=>{},workspaceId=null,leaseMs=90000,taskTTL=24*3600e3,maxTasks=16,maxEvents=512,maxTaskBytes=1024*1024}={}){
  for(const [value,max] of [[leaseMs,3600e3],[taskTTL,7*24*3600e3],[maxTasks,64],[maxEvents,4096],[maxTaskBytes,4*1024*1024]])if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('WorkBuddy 内存或租约限制无效');
  const tasks=new Map(),opens=new Map(),expired=new Map();let closed=false;
  function publicText(value){let result=text(value);for(const secret of [publisherKey,...[...tasks.values()].map(t=>t.openReceipt.taskToken)])if(typeof secret==='string'&&secret.length>=8)result=result.split(secret).join('[凭据已隐藏]');return result;}
  const changed=()=>{if(!closed)onChange();};
  function session(task){return{id:task.id,title:task.title,provider:'workbuddy',mode:'workbuddy-publish',status:task.projection.value.status,createdAt:task.createdAt,updatedAt:task.lastSeen,adapter:WORKBUDDY_ADAPTER,capabilities:WORKBUDDY_CAPABILITIES,source:{kind:'mcp-publish',label:'WorkBuddy 协作上报（非原生镜像）',nativeSession:false,workspaceId:task.workspaceId,taskId:task.id}};}
  function touch(task){const was=task.transport;task.lastSeen=now();task.transport='connected';if(task.projection.value.status==='unknown'&&!task.finished){task.projection.value.status='running';task.projection.value.error=null;}return was!=='connected';}
  function scope(input,token){
    if(closed)fail(410,'WorkBuddy 协作连接已关闭');sweep();
    if(input.instanceId!==instanceId)fail(409,'WorkBuddy 连接器实例已变化，请在本机核验，不会自动新建任务');
    const task=tasks.get(input.taskId),proof=task||expired.get(input.taskId);
    if(!proof||typeof token!=='string'||!same(digest(token),proof.tokenHash))fail(403,'WorkBuddy 任务授权无效');
    if(!task)fail(410,'WorkBuddy 协作任务已过期，不会自动重建');return task;
  }
  function sweep(){
    let dirty=false;
    for(const task of tasks.values()){
      if(now()-task.createdAt>=taskTTL){task.transport='disconnected';task.projection.value.status='unknown';task.projection.value.error='WorkBuddy 协作缓存已过期；不能据此判断原客户端是否停止。';expired.set(task.id,{tokenHash:task.tokenHash});tasks.delete(task.id);dirty=true;}
      else if(task.transport==='connected'&&now()-task.lastSeen>=leaseMs){task.transport='disconnected';if(!task.finished){task.projection.value.status='unknown';task.projection.value.error='WorkBuddy 协作连接中断，执行结果未知；不代表 WorkBuddy 已停止。';}dirty=true;}
    }
    if(dirty)changed();
  }
  function open(input,{observedOrder}={}){
    if(closed)fail(410,'WorkBuddy 协作连接已关闭');sweep();
    fields(input,['requestId','title','workspaceId']);
    if(!uuid(input.requestId)||typeof input.title!=='string'||!input.title.trim()||input.title.length>70||typeof input.workspaceId!=='string'||!input.workspaceId.trim()||input.workspaceId.length>128)fail(400,'WorkBuddy 任务标题、工作区或请求标识无效');
    if(workspaceId!==null&&input.workspaceId!==workspaceId)fail(403,'WorkBuddy 工作区未被本机连接器授权');
    const signature=digest(canonical(input)),previous=opens.get(input.requestId);
    if(previous){if(signature!==previous.signature)fail(409,'WorkBuddy 相同请求标识不能用于不同任务');const task=tasks.get(previous.taskId);if(!task)fail(410,'WorkBuddy 原协作任务已过期，不会自动重建');return{...task.openReceipt};}
    if(tasks.size>=maxTasks||opens.size>=256)fail(409,'WorkBuddy 协作任务数已达本机内存上限');
    const id='ses_wb_'+randomUUID().replaceAll('-',''),token=randomBytes(32).toString('base64url'),projection=createProjection(id);
    projection.value.mode='workbuddy';projection.value.provider='workbuddy';projection.value.status='running';projection.value.startedAt=now();
    const task={id,title:publicText(input.title),workspaceId:publicText(input.workspaceId),tokenHash:digest(token),projection,createdAt:now(),observedOrder:Number.isSafeInteger(observedOrder)&&observedOrder>0?observedOrder:nextSourceOrder(),lastSeen:now(),transport:'connected',receiptMap:new Map(),events:new Map(),building:new Set(),bytes:0,finished:null};
    task.openReceipt={instanceId,taskId:id,title:task.title,taskToken:token,status:'running'};
    const members=new Set(),pending=new Set();
    task.hub={get session(){return session(task);},projection,members,pending,receipts:task.receiptMap,starting:Promise.resolve(),start:async()=>{},remove:owner=>members.delete(owner),close:async()=>{},publish:()=>fail(403,'WorkBuddy 事件只接受该任务专属发布授权'),get transport(){return task.transport;},get transportEpoch(){return 0;}};
    tasks.set(id,task);opens.set(input.requestId,{signature,taskId:id});onOpen({...session(task),observedOrder:task.observedOrder});changed();return{...task.openReceipt};
  }
  function publish(input,token){
    fields(input,['instanceId','taskId','event']);const task=scope(input,token),checked=checkedEvent(input.event,task.id,publicText),previous=task.events.get(input.event.id);
    if(previous){if(previous!==checked.signature)fail(409,'WorkBuddy 相同事件标识的内容存在冲突');const resumed=touch(task);if(resumed)changed();return{instanceId,taskId:task.id,accepted:true,eventId:input.event.id,delivery:task.receiptMap.get(input.event.id).status};}
    if(task.finished)fail(409,'WorkBuddy 协作任务已结束，不接受新的UI事件');
    if(task.events.size>=maxEvents||task.bytes+checked.bytes>maxTaskBytes)fail(409,'WorkBuddy 协作事件已达本机内存上限，请缩减或开始明确的新任务');
    const deliveries=task.projection.value.ui.deliveries;
    try{task.projection.publish(checked.safe);}catch{fail(400,'WorkBuddy UI事件未通过公开预览校验');}
    // Native sessions keep a rolling live window. WB may publish before any browser exists,
    // so retain every accepted delivery ID within the explicit per-task event budget.
    const delivery=task.projection.value.ui.deliveries.at(-1);
    if(checked.safe.type==='run.note')delivery.displayRef={kind:'message',id:'note:'+checked.safe.id};
    if(['activity.updated','step.updated'].includes(checked.safe.type))delivery.displayRef={kind:'activity',id:checked.safe.payload.id};
    task.projection.value.ui.deliveries=[...deliveries,delivery];
    if(['resource.create','artifact.updated'].includes(checked.safe.type))task.building.add(checked.safe.payload.id);
    if(checked.safe.type==='artifact.ready'){task.building.delete(checked.safe.payload.artifactId);if(task.projection.value.ui.work?.artifactId===checked.safe.payload.artifactId)task.projection.value.ui.work={artifactId:checked.safe.payload.artifactId,status:'completed',label:'成果预览已就绪'};}
    task.events.set(input.event.id,checked.signature);task.bytes+=checked.bytes;task.receiptMap.set(input.event.id,{eventId:input.event.id,status:'accepted',clients:[]});touch(task);changed();return{instanceId,taskId:task.id,accepted:true,eventId:input.event.id,delivery:'accepted'};
  }
  function receipt(input,token){fields(input,['instanceId','taskId','eventId']);const task=scope(input,token);if(typeof input.eventId!=='string'||!/^[\w:.-]{1,100}$/.test(input.eventId))fail(400,'WorkBuddy 回执标识无效');const result=task.receiptMap.get(input.eventId)||{eventId:input.eventId,status:'unknown'};return{instanceId,taskId:task.id,...result,...(result.clients?{clients:result.clients.map(c=>({...c,detail:publicText(c.detail||'')}))}:{}),delivery:result.status};}
  function heartbeat(input,token){fields(input,['instanceId','taskId']);const task=scope(input,token);touch(task);changed();return{instanceId,taskId:task.id,status:task.projection.value.status,transport:task.transport};}
  function finish(input,token){
    fields(input,['instanceId','taskId','requestId','status','note']);const task=scope(input,token);
    if(!uuid(input.requestId)||!['completed','failed'].includes(input.status)||input.note!==undefined&&(typeof input.note!=='string'||input.note.length>1000))fail(400,'WorkBuddy 完成状态或公开说明无效');
    const signature=digest(canonical(input));
    if(task.finished){if(task.finished.requestId!==input.requestId||task.finished.signature!==signature)fail(409,'WorkBuddy 任务已提交不同的完成状态');return{...task.finished.receipt};}
    if(input.status==='completed'&&(task.building.size||task.projection.value.artifacts.some(a=>a.buildState!=='ready')))fail(409,'WorkBuddy 存在构建中的成果，请先明确上报ready或失败','WORKBUDDY_NOT_READY');
    if(input.note?.trim()){const deliveries=task.projection.value.ui.deliveries;task.projection.publish({protocol:PROTOCOL,id:'finish:'+input.requestId,type:'run.note',payload:{text:publicText(input.note)}});task.projection.value.ui.deliveries=deliveries;}
    touch(task);task.projection.value.status=input.status;task.projection.value.error=input.status==='failed'?publicText(input.note||'WorkBuddy 协作方上报失败；非原生执行状态镜像。'):null;
    const receipt={instanceId,taskId:task.id,status:input.status,accepted:true};task.finished={signature,requestId:input.requestId,receipt};changed();return{...receipt};
  }
  function close(){closed=true;tasks.clear();opens.clear();expired.clear();}
  return{open,publish,receipt,heartbeat,finish,sweep,close,has:id=>tasks.has(id),hub:id=>tasks.get(id)?.hub,list:()=>[...tasks.values()].map(session),incoming:()=>[...tasks.values()].sort((a,b)=>b.observedOrder-a.observedOrder).map(task=>({id:task.id,title:task.title,provider:'workbuddy',status:task.projection.value.status,createdAt:task.createdAt,updatedAt:task.lastSeen,observedOrder:task.observedOrder}))};
}

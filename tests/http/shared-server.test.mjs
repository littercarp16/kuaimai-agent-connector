import{test}from'node:test';import assert from'node:assert/strict';import{once}from'node:events';import{createConnector}from'../../src/http/server.mjs';
export function sharedFixture(){let emit,state;const sent=[];return{sent,emit:e=>emit?.(e),state:s=>state?.(s),adapter:{health:async()=>({ready:true,version:'2.0.30'}),listSessions:async()=>[{id:'ses_current',title:'本地工作会话'}],bindSession:async id=>{if(id!=='ses_current')throw Error('不在工作区');return{id,title:'本地工作会话'};},readShared:async()=>({status:'idle',messages:[],tools:[]}),watch:(id,onEvent,onState)=>{emit=onEvent;state=onState;queueMicrotask(()=>onState('connected'));return{ready:Promise.resolve(),close(){}};},installBridge:async()=>{},removeBridge:async()=>{},sendShared:async(id,text,{requestId})=>{sent.push({id,text,requestId});return{id:'msg_km_'+requestId.replaceAll('-','')};},interruptShared:async()=>({interrupted:true})}};}
const waitFor=async fn=>{const end=Date.now()+3000;while(!(await fn())){if(Date.now()>end)throw Error('等待业务条件超时');await new Promise(r=>setTimeout(r,10));}};
async function setup(t,adapter,now){const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,now,allowedOrigins:[origin],pairCode:'123456',publisherKey:'local-publisher-security-test'});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const base=`http://127.0.0.1:${bridge.server.address().port}`;const req=(path,body,token)=>fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const token=(await(await req('/v1/pair',{code:'123456'})).json()).data.token;return{req,token};}
test('已有会话绑定后两端共享：本地消息广播、网页只提交一次、UI部分成果即时可见',async t=>{
 const f=sharedFixture(),origin='http://127.0.0.1:4173',bridge=createConnector({adapter:f.adapter,allowedOrigins:[origin],pairCode:'123456',publisherKey:'local-publisher-test'});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());
 const base=`http://127.0.0.1:${bridge.server.address().port}`;
 const req=(path,body,token,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:body?JSON.stringify(body):undefined});
 const token=(await(await req('/v1/pair',{code:'123456'})).json()).data.token;
 assert.equal((await req('/v1/sessions',null,token)).status,200,'必须提供工作区会话绑定入口');
 assert.equal((await req('/v1/bind',{sessionId:'ses_current',allowControl:true},token)).status,200);
 const input={requestId:crypto.randomUUID(),text:'网页输入'};
 assert.equal((await req('/v1/run',input,token)).status,202);await req('/v1/run',input,token);assert.equal(f.sent.length,1);
 f.emit({id:'local-input',type:'session.inbox.enqueued',data:{sessionID:'ses_current',inboxID:'msg_native',item:{type:'user',payload:{text:'本地输入'},delivery:'queue'}}});
 f.emit({id:'start',type:'session.execution.started',data:{sessionID:'ses_current'}});
 f.emit({id:'delta1',type:'session.text.delta',data:{sessionID:'ses_current',assistantMessageID:'msg_ai',ordinal:0,delta:'正在读取'}});
 const read=async()=>(await(await req('/v1/snapshot',null,token)).json()).data;
 assert.equal((await read()).run.status,'running');assert.match(JSON.stringify((await read()).run.messages),/本地输入|正在读取/);assert.equal(f.sent.length,1,'本地消息观察不能触发重复prompt');
 const publish=body=>fetch(base+'/v1/local/publish',{method:'POST',headers:{'X-Km-Agent':'1','X-Km-Publisher':'local-publisher-test','Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await publish({sessionId:'ses_current',event:{id:'page1',type:'artifact.updated',payload:{id:'report',kind:'page',name:'销售报告',metrics:[],sections:[]}}})).status,200);
 assert.equal((await read()).run.artifacts[0].name,'销售报告');assert.equal((await read()).run.status,'running');
 assert.equal((await publish({sessionId:'ses_other',event:{id:'no',type:'run.note',payload:{text:'不应广播'}}})).status,404);
 const bad=await req('/v1/local/publish',{sessionId:'ses_current',event:{}},token);assert.equal(bad.status,403,'网页认证不能冒充本地发布凭据');
});
test('配对租约过期后取消共享订阅，不继续观察本地会话',async t=>{
 let now=1000,closed=0;const f=sharedFixture();f.adapter.watch=()=>({ready:Promise.resolve(),close(){closed++;}});
 const{req,token}=await setup(t,f.adapter,()=>now);await req('/v1/bind',{sessionId:'ses_current',allowControl:false},token);now+=9*3600e3;await req('/v1/health');
 await waitFor(()=>closed>0);assert.equal((await req('/v1/snapshot',null,token)).status,401);
});
test('初始化订阅读取尚未完成时撤销授权，关闭订阅且迟到结果不安装说明',async t=>{
 let release,reading=false,watched=0,closed=0,installed=0;const f=sharedFixture();f.adapter.readShared=()=>{reading=true;return new Promise(r=>{release=r;});};f.adapter.watch=()=>{watched++;return{ready:Promise.resolve(),close(){closed++;}};};f.adapter.installBridge=async()=>{installed++;};
 const{req,token}=await setup(t,f.adapter);const pending=req('/v1/bind',{sessionId:'ses_current',allowControl:true},token);await waitFor(()=>reading);
 await req('/v1/disconnect',{},token);release({status:'idle',messages:[]});await pending;assert.equal(watched,1,'必须先建立事件覆盖再读取快照');assert.ok(closed>0);assert.equal(installed,0);
});
test('发送等待健康检查期间更换绑定，不能把A的输入发送给B',async t=>{
 let now=1000,hold=false,release;const f=sharedFixture();f.adapter.bindSession=async id=>({id,title:id});f.adapter.health=async()=>hold?new Promise(r=>{release=r;}):({ready:true});
 const{req,token}=await setup(t,f.adapter,()=>now);await req('/v1/bind',{sessionId:'ses_a',allowControl:true},token);now+=6000;hold=true;
 const sending=req('/v1/run',{requestId:crypto.randomUUID(),text:'仅发送给A'},token);await waitFor(()=>release);await req('/v1/bind',{sessionId:'ses_b',allowControl:true},token);release({ready:true});
 assert.equal((await sending).status,409);assert.equal(f.sent.length,0);
});

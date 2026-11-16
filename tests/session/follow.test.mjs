import{test}from'node:test';import assert from'node:assert/strict';import{once}from'node:events';import{createConnector}from'../../src/http/server.mjs';
const until=async fn=>{const end=Date.now()+2500;while(!(await fn())){if(Date.now()>end)throw Error('等待路由条件超时');await new Promise(r=>setTimeout(r,5));}};
async function setup(t){const watchers=new Map();let offer,discoveryClosed=0;const adapter={health:async()=>({ready:true}),bindSession:async id=>({id,title:'会话'+id}),readShared:async()=>({status:'idle',messages:[]}),watch:(id,e)=>{watchers.set(id,e);return{ready:Promise.resolve(),close(){watchers.delete(id);}};},watchRelevantSessions:fn=>{offer=fn;return{ready:Promise.resolve(),close(){discoveryClosed++;}};},installBridge:async()=>{},removeBridge:async()=>{}};
 const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,allowedOrigins:[origin],autoTrust:{origin,sessionId:'ses_seed',allowControl:true}});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const base=`http://127.0.0.1:${bridge.server.address().port}`;
 const request=async(path,body,token)=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return{status:response.status,...await response.json()};};const connected=await request('/v1/handshake',{}),token=connected.data.token;
 return{adapter,token,request,read:async()=>(await request('/v1/snapshot',null,token)).data,offer:c=>{assert.equal(typeof offer,'function','必须启动相关会话发现');offer(c);},emit:(id,type)=>watchers.get(id)?.({id:crypto.randomUUID(),type,data:{sessionID:id}}),closed:()=>discoveryClosed};}
test('同工作区相关新会话自动接入，不继承旧会话控制授权、不重复提交任务',async t=>{
 const f=await setup(t);f.offer({id:'ses_new',title:'绫通查询',reason:'prompt'});await until(async()=>(await f.read()).sessionId==='ses_new');const state=await f.read();assert.equal(state.binding.canControl,false);assert.equal(state.routing.mode,'follow');
});
test('运行中不来回抢占，新会话排队，原任务结束后接入',async t=>{
 const f=await setup(t);f.emit('ses_seed','session.execution.started');f.offer({id:'ses_new',title:'新查询',reason:'command'});await until(async()=>(await f.read()).routing?.pending?.length===1);assert.equal((await f.read()).sessionId,'ses_seed');f.emit('ses_seed','session.execution.succeeded');await until(async()=>(await f.read()).sessionId==='ses_new');
});
test('锁定当前会话不自动切换，恢复跟随后才接入候选',async t=>{
 const f=await setup(t);assert.equal((await f.request('/v1/follow',{enabled:false},f.token)).status,200);f.offer({id:'ses_new',title:'新查询',reason:'prompt'});await until(async()=>(await f.read()).routing?.pending?.length===1);assert.equal((await f.read()).sessionId,'ses_seed');await f.request('/v1/follow',{enabled:true},f.token);await until(async()=>(await f.read()).sessionId==='ses_new');
});
test('候选核验失败或用户在切换初始化中锁定，原会话保持可用',async t=>{
 const f=await setup(t);let release,reading=false;f.adapter.readShared=async id=>{if(id==='ses_new'){reading=true;await new Promise(r=>{release=r;});}return{status:'idle',messages:[]};};f.offer({id:'ses_new',title:'迟到查询',reason:'prompt'});await until(()=>reading);await f.request('/v1/follow',{enabled:false},f.token);release();await until(async()=>(await f.read()).routing.mode==='pinned'&&!(await f.read()).routing.switching);assert.equal((await f.read()).sessionId,'ses_seed');assert.equal((await f.read()).binding.transport,'connected');
});
test('撤销最后一个浏览器授权后停止会话发现',async t=>{
 const f=await setup(t);await f.request('/v1/disconnect',{},f.token);await until(()=>f.closed()>0);
});
test('候选初始化期间原会话开始执行，提交切换前再次检查并保留候选排队',async t=>{
 const f=await setup(t);let release,reading=false;f.adapter.readShared=async id=>{if(id==='ses_new'&&!reading){reading=true;await new Promise(r=>{release=r;});}return{status:'idle',messages:[]};};f.offer({id:'ses_new',title:'新查询',reason:'prompt'});await until(()=>reading);f.emit('ses_seed','session.execution.started');release();await until(async()=>!(await f.read()).routing.switching);assert.equal((await f.read()).sessionId,'ses_seed');assert.equal((await f.read()).routing.pending[0]?.id,'ses_new');f.emit('ses_seed','session.execution.succeeded');await until(async()=>(await f.read()).sessionId==='ses_new');
});

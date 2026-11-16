import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createOpenCodeAdapter } from '../../src/adapters/opencode/opencode.mjs';

const module = await import('../../src/http/server.mjs').catch(error=>{if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;return {};});
const origin='http://127.0.0.1:4173';
async function setup(t, adapter) {
  assert.equal(typeof module.createConnector, 'function', '需要实现独立本机连接器');
  const connector=module.createConnector({adapter,allowedOrigins:[origin],pairCode:'123456'});
  connector.server.listen(0,'127.0.0.1');await once(connector.server,'listening');
  t.after(()=>connector.close());
  const base=`http://127.0.0.1:${connector.server.address().port}`;
  const request=(path,options={})=>fetch(base+path,{...options,headers:{Origin:origin,'Content-Type':'application/json','X-Km-Agent':'1',...options.headers}});
  const pair=async()=>{const res=await request('/v1/pair',{method:'POST',body:JSON.stringify({code:'123456'})});assert.equal(res.status,200);return (await res.json()).data.token;};
  return {connector,base,request,pair};
}
const unavailable={health:async()=>({ready:false,version:null,message:'OpenCode 未启动'})};
const waitFor=async condition=>{const deadline=Date.now()+3000;while(!(await condition())){if(Date.now()>deadline)throw Error('等待业务条件超时');await new Promise(r=>setTimeout(r,10));}};

test('仅信任精确Origin与Host，健康响应不泄漏配对码或平台凭据',async t=>{
  const {request,base}=await setup(t,unavailable);
  const res=await request('/v1/health'),text=await res.text();assert.equal(res.status,200);assert.match(text,/kuaimai-agent-connector/);assert.doesNotMatch(text,/123456|token|secret/i);
  assert.equal((await fetch(base+'/v1/health',{headers:{Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(base+'/v1/health',{headers:{Origin:'null'}})).status,403);
  assert.equal((await fetch(base+'/v1/health')).status,403);
  assert.equal((await request('/v1/snapshot')).status,401);
});
test('配对码需本地知晓、单次使用；token不跨Origin，撤销后失效',async t=>{
  const {request}=await setup(t,unavailable);
  assert.equal((await request('/v1/pair',{method:'POST',body:'{"code":"000000"}'})).status,403);
  const token=await (await request('/v1/pair',{method:'POST',body:'{"code":"123456"}'})).json();
  const headers={Authorization:`Bearer ${token.data.token}`};
  assert.equal((await request('/v1/pair',{method:'POST',body:'{"code":"123456"}'})).status,403);
  assert.equal((await request('/v1/snapshot',{headers})).status,200);
  assert.equal((await request('/v1/disconnect',{method:'POST',headers,body:'{}'})).status,200);
  assert.equal((await request('/v1/snapshot',{headers})).status,401);
});
test('未就绪不调用模型，未知路径/命令/任意请求字段被拒绝',async t=>{
  const {request,pair}=await setup(t,unavailable),token=await pair(),headers={Authorization:`Bearer ${token}`};
  assert.equal((await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'建立商品表'})})).status,503);
  assert.equal((await request('/v1/exec',{method:'POST',headers,body:'{"command":"rm -rf /"}'})).status,404);
  assert.equal((await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x',directory:'/etc'})})).status,400);
});
test('显式演示经真实连接器推进预览，不写平台，重复requestId不重复启动',async t=>{
  const {request,pair}=await setup(t,unavailable),token=await pair(),headers={Authorization:`Bearer ${token}`};
  const body=JSON.stringify({requestId:crypto.randomUUID()});
  const a=await request('/v1/demo',{method:'POST',headers,body}),b=await request('/v1/demo',{method:'POST',headers,body});
  assert.equal(a.status,202);assert.equal(b.status,202);assert.equal((await a.json()).data.runId,(await b.json()).data.runId);
  const snapshot=(await(await request('/v1/snapshot',{headers})).json()).data;
  assert.equal(snapshot.run.mode,'demo');assert.equal(snapshot.run.status,'running');assert.equal(snapshot.run.artifacts.length,0);
  assert.equal((await request('/v1/stop',{method:'POST',headers,body:'{}'})).status,200);
  const stopped=(await(await request('/v1/snapshot',{headers})).json()).data;
  assert.equal(stopped.run.status,'interrupted');
});
test('真实执行路径只投影专用会话文本和预览，重复请求不再次调用Agent',async t=>{
  let sends=0;
  const block='```kmmdtable\n'+JSON.stringify({type:'artifact',id:'x',kind:'table',name:'只读预览',columns:['编码'],rows:[['SKU-1']]})+'\n```';
  const adapter={health:async()=>({ready:true,version:'2.0.30'}),createSession:async()=> 'ses_owned',send:async()=>{sends++;},read:async()=>({status:'completed',messages:[{id:'m',text:'已生成预览\n'+block}],tools:[]}),interrupt:async()=>({interrupted:true})};
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`},body=JSON.stringify({requestId:crypto.randomUUID(),text:'做一个预览'});
  assert.equal((await request('/v1/run',{method:'POST',headers,body})).status,202);
  let snapshot;await waitFor(async()=>{snapshot=(await(await request('/v1/snapshot',{headers})).json()).data;return snapshot.run.status==='completed';});
  assert.equal(snapshot.sessionId,'ses_owned');assert.equal(snapshot.run.status,'completed');assert.equal(snapshot.run.artifacts[0].name,'只读预览');
  assert.equal((await request('/v1/run',{method:'POST',headers,body})).status,202);assert.equal(sends,1);
});
test('停止发生在会话创建中时，不再提交需求',async t=>{
  let resolveCreate,sends=0,started=false;
  const adapter={health:async()=>({ready:true}),createSession:()=>{started=true;return new Promise(r=>{resolveCreate=r;});},send:async()=>{sends++;},interrupt:async()=>({interrupted:true})};
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`};
  await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x'})});await waitFor(()=>started);
  await request('/v1/stop',{method:'POST',headers,body:'{}'});resolveCreate('ses_owned');
  await new Promise(r=>setImmediate(r));assert.equal(sends,0);
});
test('撤销授权立即使token失效，不等待上游停止请求完成',async t=>{
  let release,stopping=false;
  const adapter={health:async()=>({ready:true}),createSession:async()=> 'ses_owned',send:async()=>{},read:async()=>({status:'running',messages:[]}),interrupt:()=>{stopping=true;return new Promise(r=>{release=r;});}};
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`};
  await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x'})});
  const disconnect=request('/v1/disconnect',{method:'POST',headers,body:'{}'});await waitFor(()=>stopping);
  const status=(await request('/v1/snapshot',{headers})).status;release({interrupted:true});await disconnect;
  assert.equal(status,401);
});
test('旧会话创建响应迟到，不覆盖新执行的会话，也不中断错会话',async t=>{
  const creates=[],stopped=[];
  const adapter={health:async()=>({ready:true}),createSession:()=>new Promise(r=>creates.push(r)),send:async()=>{},read:async()=>({status:'running',messages:[]}),interrupt:async id=>{stopped.push(id);return{interrupted:true};}};
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`};
  const start=()=>request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x'})});
  await start();await waitFor(()=>creates.length===1);await request('/v1/stop',{method:'POST',headers,body:'{}'});await request('/v1/reset',{method:'POST',headers,body:'{}'});
  await start();await waitFor(()=>creates.length===2);creates[1]('ses_new');await waitFor(async()=>(await(await request('/v1/snapshot',{headers})).json()).data.sessionId==='ses_new');
  creates[0]('ses_old');await new Promise(r=>setImmediate(r));
  assert.equal((await(await request('/v1/snapshot',{headers})).json()).data.sessionId,'ses_new');
  await request('/v1/stop',{method:'POST',headers,body:'{}'});assert.equal(stopped.at(-1),'ses_new');
});
test('双来源和双客户端的token/SSE事件相互隔离',{timeout:5000},async t=>{
  const origin2='http://127.0.0.1:4174';let nextCode;
  const connector=module.createConnector({adapter:unavailable,allowedOrigins:[origin,origin2],pairCode:'123456',onPairCode:value=>{nextCode=value;}});
  connector.server.listen(0,'127.0.0.1');await once(connector.server,'listening');t.after(()=>connector.close());
  const base=`http://127.0.0.1:${connector.server.address().port}`;
  const request=(path,o,token,body)=>fetch(base+path,{method:body?'POST':'GET',headers:{Origin:o,'Content-Type':'application/json','X-Km-Agent':'1',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const a=(await(await request('/v1/pair',origin,null,{code:'123456'})).json()).data.token;
  const b=(await(await request('/v1/pair',origin2,null,{code:nextCode})).json()).data.token;
  assert.equal((await request('/v1/events',origin2,a)).status,401);assert.equal((await request('/v1/snapshot',origin,b)).status,401);
  const streamA=await request('/v1/events',origin,a),streamB=await request('/v1/events',origin2,b),readerA=streamA.body.getReader(),readerB=streamB.body.getReader();
  const snapshots=reader=>{let buffer='';const decoder=new TextDecoder();return async()=>{while(true){const boundary=buffer.indexOf('\n\n');if(boundary!==-1){const frame=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const line=frame.split('\n').find(x=>x.startsWith('data: '));if(line)return JSON.parse(line.slice(6));continue;}const part=await reader.read();if(part.done)throw Error('SSE在标记前关闭');buffer+=decoder.decode(part.value,{stream:true});}};};
  const readA=snapshots(readerA),readB=snapshots(readerB);
  assert.equal((await readB()).run,null);await readA();
  const started=(await(await request('/v1/demo',origin,a,{requestId:crypto.randomUUID()})).json()).data;
  assert.equal((await readA()).run.id,started.runId);
  const marker=(await(await request('/v1/reset',origin2,b,{})).json()).data;
  let receivedMarker=false;
  for(let i=0;i<10;i++){const frame=await readB();assert.notEqual(frame.run?.id,started.runId,'B的SSE不得收到A的执行');assert.equal(frame.run,null);if(frame.revision===marker.revision){receivedMarker=true;break;}}
  assert.equal(receivedMarker,true,'必须消费到A开始之后的B专属快照标记');
  assert.equal((await(await request('/v1/snapshot',origin2,b)).json()).data.run,null);
  await readerA.cancel();await readerB.cancel();
});
test('HTTP撤销贯穿到OpenCode预检边界，解除等待后不再发模型请求',async t=>{
  let release,prompts=0;
  const native={server:{info:async()=>({version:'2.0.30'})},session:{create:async()=>({id:'ses_owned'}),get:()=>new Promise(r=>{release=r;}),prompt:async()=>{prompts++;},interrupt:async()=>({interrupted:true})}};
  const adapter=createOpenCodeAdapter({discover:async()=>({url:'http://127.0.0.1:4096'}),makeClient:()=>native,headers:()=>({}),directory:'/fixed'});
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`};
  await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x'})});await waitFor(()=>release);
  await request('/v1/disconnect',{method:'POST',headers,body:'{}'});release({time:{}});await new Promise(r=>setImmediate(r));
  assert.equal(prompts,0);
});
test('已确认未提交的取消，不被迟到的中断回执覆盖为未知',async t=>{
  let releaseSend,releaseInterrupt;
  const adapter={health:async()=>({ready:true}),createSession:async()=> 'ses_owned',send:()=>new Promise((resolve,reject)=>{releaseSend=()=>reject(Object.assign(Error('取消于提交前'),{code:'NOT_SUBMITTED'}));}),interrupt:()=>new Promise(resolve=>{releaseInterrupt=resolve;})};
  const {request,pair}=await setup(t,adapter),token=await pair(),headers={Authorization:`Bearer ${token}`};
  await request('/v1/run',{method:'POST',headers,body:JSON.stringify({requestId:crypto.randomUUID(),text:'x'})});await waitFor(()=>releaseSend);
  const stopping=request('/v1/stop',{method:'POST',headers,body:'{}'});await waitFor(()=>releaseInterrupt);
  releaseSend();await waitFor(async()=>(await(await request('/v1/snapshot',{headers})).json()).data.run.status==='interrupted');
  releaseInterrupt({interrupted:false});await stopping;
  assert.equal((await(await request('/v1/snapshot',{headers})).json()).data.run.status,'interrupted');
  assert.equal((await request('/v1/reset',{method:'POST',headers,body:'{}'})).status,200,'确认未提交后应能新建会话');
});

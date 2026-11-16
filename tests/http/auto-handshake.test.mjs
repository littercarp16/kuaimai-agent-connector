import{test}from'node:test';import assert from'node:assert/strict';import{once}from'node:events';import{createConnector}from'../../src/http/server.mjs';
const adapter={health:async()=>({ready:true}),bindSession:async id=>({id,title:'受信会话'}),readShared:async()=>({status:'idle',messages:[]}),watch:()=>({ready:Promise.resolve(),close(){}})};
test('本机显式受信来源自动握手并绑定既定会话；无Origin/陌生站点不能拿授权',async t=>{
 const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,allowedOrigins:[origin],autoTrust:{origin,sessionId:'ses_trusted',allowControl:false}});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const url=`http://127.0.0.1:${bridge.server.address().port}`;
 const req=(origin,body={})=>fetch(url+'/v1/handshake',{method:'POST',headers:{...(origin?{Origin:origin}:{}),'X-Km-Agent':'1','Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await req('https://evil.example')).status,403);assert.equal((await req()).status,403);
 const result=await(await req(origin)).json();assert.equal(result.ok,true);assert.equal(result.data.snapshot.binding.id,'ses_trusted');assert.equal(result.data.snapshot.binding.canControl,false);assert.ok(result.data.token);assert.doesNotMatch(JSON.stringify(result.data.snapshot),new RegExp(result.data.token));
 assert.equal((await req(origin,{sessionId:'ses_other'})).status,400,'浏览器不能替换本机授权会话');
});
test('没有本机受信配置就不开放自动握手，保留高级手动配对',async t=>{
 const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,allowedOrigins:[origin]});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const r=await fetch(`http://127.0.0.1:${bridge.server.address().port}/v1/handshake`,{method:'POST',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json'},body:'{}'});assert.equal(r.status,403);
});

test('multiple allowed origins advertise their own handshake mode and cannot share pairing credentials', async t => {
  const primary = 'http://127.0.0.1:4173', extra = 'http://local.lt.com:8251';
  const bridge = createConnector({ adapter, allowedOrigins: [primary, extra], autoTrust: { origin: primary }, pairCode: '654321' });
  bridge.server.listen(0, '127.0.0.1'); await once(bridge.server, 'listening'); t.after(() => bridge.close());
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  const req = (origin, path, body, token) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'X-Km-Agent': '1', 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  assert.equal((await (await req(primary, '/v1/health')).json()).data.capabilities.autoHandshake, true);
  assert.equal((await (await req(extra, '/v1/health')).json()).data.capabilities.autoHandshake, false);
  assert.equal((await req(extra, '/v1/handshake', {})).status, 403);
  assert.equal((await req('http://local.lt.com:8252', '/v1/health')).status, 403);
  const response = await req(extra, '/v1/pair', { code: '654321' }); assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal((await req(extra, '/v1/snapshot', undefined, data.token)).status, 200);
  assert.equal((await req(primary, '/v1/snapshot', undefined, data.token)).status, 401);
  assert.equal((await req(primary, '/v1/handshake', {})).status, 200);
});

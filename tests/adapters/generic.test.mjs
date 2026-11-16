import{test}from'node:test';import assert from'node:assert/strict';import{once}from'node:events';import{createGenericAdapter}from'../../src/adapters/generic.mjs';import{createConnector}from'../../src/http/server.mjs';
test('通用适配器实际可握手并发布UI；明确不声称厂商原生双向能力',async t=>{
 const origin='http://127.0.0.1:4173',adapter=createGenericAdapter('ses_codex_test'),bridge=createConnector({adapter,allowedOrigins:[origin],autoTrust:{origin,sessionId:'ses_codex_test',allowControl:false},publisherKey:'generic-publisher-test-key'});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const base=`http://127.0.0.1:${bridge.server.address().port}`,headers={Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json'};
 const health=(await(await fetch(base+'/v1/health',{headers})).json()).data;assert.equal(health.capabilities.submitPrompt,false);assert.equal(health.adapter.status,'publish-only');
 const session=(await(await fetch(base+'/v1/handshake',{method:'POST',headers,body:'{}'})).json()).data;
 const event={protocol:'km-agent/1',id:'generic-create',type:'resource.create',payload:{id:'sales',kind:'page',name:'通用Agent销售页'}};
 const receipt=await(await fetch(base+'/v1/local/publish',{method:'POST',headers:{'X-Km-Agent':'1','X-Km-Publisher':'generic-publisher-test-key','Content-Type':'application/json'},body:JSON.stringify({sessionId:'ses_codex_test',event})})).json();assert.equal(receipt.data.accepted,true);assert.equal(receipt.data.delivery,'accepted');
 const snapshot=(await(await fetch(base+'/v1/snapshot',{headers:{...headers,Authorization:'Bearer '+session.token}})).json()).data;assert.equal(snapshot.run.artifacts[0].name,'通用Agent销售页');assert.equal(snapshot.binding.canControl,false);assert.equal(typeof adapter.sendShared,'undefined');
 await assert.rejects(()=>adapter.bindSession('ses_other'),/未授权/);
});

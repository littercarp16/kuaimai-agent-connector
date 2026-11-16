import{test}from'node:test';import assert from'node:assert/strict';
const api=await import('../../../src/adapters/opencode/session-discovery.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
test('发现判定只看真实用户意图或命令，不因文档/echo/私有推理关键词触发',()=>{
 assert.equal(typeof api.isRelevantEvent,'function');const ev=(type,data)=>({type,data:{sessionID:'ses_new',...data}});
 assert.equal(api.isRelevantEvent(ev('session.inbox.enqueued',{item:{type:'user',payload:{text:'请用lingtong-cli查询商品表'}}})),true);
 assert.equal(api.isRelevantEvent(ev('session.tool.called',{input:{command:'lingtong-cli --profile kmmdtable-app1 table list'}}),'shell'),true);
 assert.equal(api.isRelevantEvent(ev('session.tool.called',{input:{command:'echo "lingtong-cli table list"'}}),'shell'),false);
 for(const symbol of ['|',';','&'])assert.equal(api.isRelevantEvent(ev('session.tool.called',{input:{command:`echo '${symbol}' lingtong-cli table list`}}),'shell'),false);
 assert.equal(api.isRelevantEvent(ev('session.tool.called',{input:{path:'docs/lingtong-cli.md'}}),'read'),false);
 assert.equal(api.isRelevantEvent(ev('session.reasoning.delta',{delta:'lingtong-cli'})),false);
 assert.equal(api.isRelevantEvent(ev('session.inbox.enqueued',{item:{type:'user',payload:{text:'写一首诗'}}})),false);
});
test('发现器核验当前工作区与顶层会话，关闭后迟到核验不广播',async()=>{
 assert.equal(typeof api.createSessionDiscovery,'function');let push,release;const queue=[],events={subscribe:async function*({signal}){yield{type:'server.connected'};while(!signal.aborted){const e=await new Promise(r=>{push=r;});if(e)yield e;}}};
 const client={event:events,session:{get:async({sessionID})=>{if(sessionID==='ses_late')await new Promise(r=>{release=r;});return{id:sessionID,title:'发现测试',location:{directory:sessionID==='ses_other'?'/other':'/workspace'},parentID:sessionID==='ses_child'?'ses_parent':undefined,metadata:sessionID==='ses_test_channel'?{kmAgentChannel:'isolated-check'}:{},time:{}};}}};
 const seen=[],discovery=api.createSessionDiscovery({current:()=>({client}),health:async()=>{},directory:'/workspace'}),watcher=discovery.watchRelevantSessions(c=>seen.push(c));await watcher.ready;
 const event=id=>({id:crypto.randomUUID(),type:'session.inbox.enqueued',data:{sessionID:id,item:{type:'user',payload:{text:'用lingtong-cli查表'}}}});
 for(const id of ['ses_other','ses_child','ses_test_channel','ses_good']){while(!push)await new Promise(r=>setImmediate(r));const fn=push;push=null;fn(event(id));await new Promise(r=>setImmediate(r));}
 const deadline=Date.now()+2000;while(!seen.length&&Date.now()<deadline)await new Promise(r=>setTimeout(r,5));assert.deepEqual(seen.map(c=>c.id),['ses_good']);
 while(!push)await new Promise(r=>setImmediate(r));push(event('ses_late'));while(!release)await new Promise(r=>setImmediate(r));watcher.close();release();await new Promise(r=>setImmediate(r));assert.deepEqual(seen.map(c=>c.id),['ses_good']);
});

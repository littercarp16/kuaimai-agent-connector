import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fixture, THREAD, OTHER, SESSION } from '../../fixtures/codex-fixture.mjs';

test('agent 模式从所有项目按最近活动请求 10 条主会话，不读取历史或扫描工作区', async t => {
 const f = await fixture(t, { sessionScope: 'agent', directory: '/nonexistent/configured-workspace' });
 const threads = Array.from({length:15},(_,i)=>({...f.thread,id:`019a47b0-1234-7123-8123-${String(i).padStart(12,'0')}`,cwd:i%2?path.join(f.directory,'child'):f.directory,updatedAt:100-i}));
 f.handlers.set('thread/list',params=>({data:threads.slice(0,params.limit),nextCursor:'more'}));
 const sessions=await f.adapter.listSessions();assert.equal(sessions.length,10);assert.deepEqual(sessions.map(s=>s.updatedAt),[100,99,98,97,96,95,94,93,92,91]);
 assert.equal(new Set(sessions.map(s=>s.directory)).size,2);
 assert.deepEqual(f.calls.map(c=>c.method),['thread/list','project/list']);
 assert.deepEqual(f.calls[0].params,{limit:10,archived:false,useStateDbOnly:true,currentAccountOnly:true,sortKey:'updated_at',sortDirection:'desc',sourceKinds:['cli','vscode','exec','appServer']});
});
test('agent 模式绑定所选会话自身目录，目录变化后使原绑定失效',async t=>{
 const f=await fixture(t,{sessionScope:'agent',directory:'/unused/project'});
 f.thread.cwd=path.join(f.directory,'child');const bound=await f.bind();assert.equal(bound.directory,f.thread.cwd);
 f.thread.cwd=f.directory;await assert.rejects(f.adapter.readShared(SESSION),{code:'CODEX_SCOPE_CHANGED'});
});
test('agent 模式跳过子代理/归档，按页补足；重复游标和读取错误不伪装为空列表',async t=>{
 const f=await fixture(t,{sessionScope:'agent'});let n=0;
 f.handlers.set('thread/list',()=>++n===1?{data:[{...f.thread,parentThreadId:OTHER},{...f.thread,archived:true}],nextCursor:'page2'}:{data:[f.thread],nextCursor:null});
 assert.deepEqual((await f.adapter.listSessions()).map(s=>s.nativeThreadId),[THREAD]);assert.equal(n,2);
 f.handlers.set('thread/list',()=>({data:[],nextCursor:'cycle'}));await assert.rejects(f.adapter.listSessions(),{code:'CODEX_READ_FAILED'});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { addProjectNames } from '../../../src/adapters/codex/codex-projects.mjs';
import { fixture } from '../../fixtures/codex-fixture.mjs';
const projects = [
  { id: 'parent', name: '桌面项目', roots: [{path:'/workspace'}] },
  { id: 'app', name: '绫通应用', roots: [{path:'/workspace/lingtong-app-view'}] },
  { id: 'other', name: '自定义项目名称', roots: [{path:'/other/root'}] },
];
test('显式项目归属优先；旧会话匹配最具体的登记根目录；普通会话不猜名称', async()=>{
 const sessions=[{directory:'/workspace/lingtong-app-view',projectId:'other'},{directory:'/workspace/lingtong-app-view/src'},{directory:'/workspace/lingtong-app-view-other'},{directory:'/Users/admin'},{directory:'/workspace/lingtong-app-view',projectId:'deleted'}];
 const result=await addProjectNames(sessions,projects,async p=>p);
 assert.deepEqual(result.map(s=>s.projectName),['自定义项目名称','绫通应用','桌面项目',undefined,undefined]);
 assert.equal(sessions[1].projectName,undefined);
});
test('目录别名可匹配，同一根目录登记多个项目时不误标',async()=>{
 const result=await addProjectNames([{directory:'/alias'}],projects,async p=>p==='/alias'?'/workspace/lingtong-app-view':p);assert.equal(result[0].projectName,'绫通应用');
 const ambiguous=await addProjectNames([{directory:'/workspace/lingtong-app-view'}],[...projects,{id:'duplicate',name:'另一个项目',roots:[{path:'/workspace/lingtong-app-view'}]}],async p=>p);assert.equal(ambiguous[0].projectName,undefined);
});
test('真实适配器组合项目目录元数据；项目接口不可用仍保留会话列表',async t=>{
 const f=await fixture(t,{sessionScope:'agent'});f.handlers.set('project/list',()=>({data:[{id:'project',name:'实际项目名',roots:[{path:f.directory}]}],nextCursor:null}));
 let sessions=await f.adapter.listSessions();assert.equal(sessions[0].projectName,'实际项目名');
 f.handlers.set('project/list',()=>{throw Error('unsupported')});sessions=await f.adapter.listSessions();assert.equal(sessions.length,1);assert.equal(sessions[0].projectName,undefined);
});

import{test}from'node:test';import assert from'node:assert/strict';import{createProjection}from'../../src/session/shared-state.mjs';
const envelope=(id,type,payload)=>({protocol:'km-agent/1',id,type,payload});
test('标准创建指令原子建立未保存资源并产生导航动作；重复ID不重复创建',()=>{
 const p=createProjection('ses_test');const e=envelope('create','resource.create',{id:'new-report',kind:'page',name:'新报表',appearance:{theme:'ink',accent:'#d1f36a',layout:'editorial'}});
 assert.equal(p.publish(e),true);assert.equal(p.value.artifacts[0].buildState,'building');assert.equal(p.value.artifacts[0].appearance.theme,'ink');assert.equal(p.value.ui.action.type,'resource.edit');assert.equal(p.value.ui.action.artifactId,'new-report');assert.equal(p.publish(e),false);
 p.publish(envelope('work','work.status',{artifactId:'new-report',status:'running',label:'正在设计指标布局'}));assert.equal(p.value.ui.work.label,'正在设计指标布局');
 assert.throws(()=>p.publish(envelope('invalid','resource.edit',{artifactId:'does-not-exist'})),/不存在/);
 assert.throws(()=>p.publish({...e,id:'unsupported',protocol:'km-agent/99'}),/版本/);
});
test('标准工具/技能/思考是活动时间线，不转发私有推理与原始参数',()=>{
 const p=createProjection('ses_test');const native=(type,data)=>p.accept({id:crypto.randomUUID(),type,data:{sessionID:'ses_test',...data}});
 native('session.reasoning.started',{assistantMessageID:'msg_a',ordinal:0});native('session.reasoning.delta',{delta:'PRIVATE REASONING'});
 native('session.tool.input.started',{assistantMessageID:'msg_a',id:'t1',name:'skill'});native('session.tool.called',{id:'t1',publicSkill:'lingtong-table',input:{token:'secret'}});native('session.tool.success',{id:'t1',content:[{text:'RAW OUTPUT'}]});native('session.reasoning.ended',{assistantMessageID:'msg_a',ordinal:0,text:'PRIVATE REASONING'});
 assert.ok(p.value.activities.some(a=>a.kind==='thinking'&&a.status==='completed'));assert.ok(p.value.activities.some(a=>a.kind==='skill'&&a.label.includes('lingtong-table')));assert.doesNotMatch(JSON.stringify(p.value),/PRIVATE REASONING|secret|RAW OUTPUT/);
 p.publish(envelope('phase','activity.updated',{id:'public-phase',kind:'phase',label:'校验销售口径',status:'running',detail:'正在检查样本与汇总范围'}));assert.ok(p.value.timeline.some(x=>x.id==='public-phase'&&x.kind==='activity'));
});
test('成果外观和独立文档可随需求变化，不能把不受信内容放进宿主',()=>{
 const p=createProjection('ses_test');p.publish(envelope('custom','artifact.updated',{id:'custom',kind:'page',name:'客户自定义',appearance:{theme:'forest',accent:'#147d64'},document:{html:'<h1>品牌销售报告</h1>',css:'h1{font-size:48px}'} }));
 assert.equal(p.value.artifacts[0].document.html,'<h1>品牌销售报告</h1>');assert.equal(p.value.artifacts[0].appearance.theme,'forest');
 assert.throws(()=>p.publish(envelope('css','artifact.updated',{id:'bad',kind:'page',name:'错误',appearance:{accent:'red;position:fixed'}})),/校验/);
});
test('拒绝活动格式时整个步骤投影不应部分写入',()=>{
 const p=createProjection('ses_test'),before=JSON.stringify(p.value);assert.throws(()=>p.publish(envelope('bad','step.updated',{id:'bad id',label:'无效步骤',status:'running'})),/格式/);assert.equal(JSON.stringify(p.value),before);
});
test('恢复历史活动遵守原时间线，不把未知耗时虚构为0秒',()=>{
 const p=createProjection('ses_test');p.hydrate({status:'idle',messages:[{id:'msg_a',role:'assistant',text:'公开回复'}],activities:[{id:'tool:h',kind:'tool',label:'调用查询',status:'completed',historical:true}],timeline:[{id:'tool:h',kind:'activity'},{id:'msg_a',kind:'message'}]});assert.deepEqual(p.value.timeline.map(x=>x.id),['tool:h','msg_a']);assert.equal(p.value.activities[0].durationMs,undefined);
});

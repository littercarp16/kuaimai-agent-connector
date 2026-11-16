import {test} from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../../src/session/shared-state.mjs').catch(e=>{if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;return{};});
const event=(type,data,id=crypto.randomUUID())=>({id,type,created:Date.now(),data:{sessionID:'ses_bound',...data}});
test('原生文字delta在终态前多次出现，不需要完整JSON',()=>{
  assert.equal(typeof api.createProjection,'function','需要原生事件投影器');const p=api.createProjection('ses_bound');
  p.accept(event('session.execution.started',{}));p.accept(event('session.text.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'正在读取'}));
  assert.equal(p.value.status,'running');assert.equal(p.value.messages[0].text,'正在读取');
  p.accept(event('session.text.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'订单字段。'}));assert.equal(p.value.messages[0].text,'正在读取订单字段。');
});
test('本地输入只投影一次，不重发；忽略其他会话及私有推理/工具参数',()=>{
  assert.equal(typeof api.createProjection,'function');const p=api.createProjection('ses_bound'),e=event('session.inbox.enqueued',{inboxID:'msg_user',item:{type:'user',payload:{text:'分析订单',files:[],agents:[],skills:[]},delivery:'queue'}});
  p.accept(e);p.accept(e);p.accept({...event('session.text.delta',{assistantMessageID:'m',ordinal:0,delta:'其他会话'}),data:{sessionID:'ses_other',assistantMessageID:'m',delta:'其他会话'}});
  p.accept(event('session.reasoning.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'private thought'}));p.accept(event('session.tool.called',{id:'tool',input:{secret:'sensitive'}}));
  assert.equal(p.value.messages.filter(x=>x.role==='user').length,1);assert.doesNotMatch(JSON.stringify(p.value),/private thought|sensitive|其他会话/);
});
test('逐块页面更新、真实工具步骤和焦点在运行中可见，预览不等于落库',()=>{
  assert.equal(typeof api.createProjection,'function');const p=api.createProjection('ses_bound');
  p.accept(event('session.execution.started',{}));
  p.publish({id:'e1',type:'plan.updated',payload:{title:'销售分析',items:[{id:'report',kind:'page',name:'销售主题分析'}]}});
  p.publish({id:'e2',type:'artifact.updated',payload:{id:'report',kind:'page',name:'销售主题分析',metrics:[{label:'样本行',value:'200'}],sections:[]}});
  p.publish({id:'e3',type:'page.section.updated',payload:{artifactId:'report',section:{id:'source',title:'数据范围',text:'仅样本，不是全量'}}});
  p.publish({id:'e4',type:'artifact.focus',payload:{artifactId:'report'}});
  assert.equal(p.value.status,'running');assert.equal(p.value.artifacts[0].sections.length,1);assert.equal(p.value.focusArtifactId,'report');
  assert.throws(()=>p.publish({id:'bad',type:'execute.javascript',payload:{code:'alert(1)'}}),/不支持/);
});
test('公开快照有UTF8字节预算，过大成果拒绝且不破坏已有预览',()=>{
 const p=api.createProjection('ses_bound');for(let i=0;i<40;i++)p.accept(event('session.text.ended',{assistantMessageID:'msg_'+i,ordinal:0,text:'说明'.repeat(9000)}));
 assert.ok(Buffer.byteLength(JSON.stringify(p.value.messages))<130000,'聊天快照不能无限变大');
 p.publish({id:'safe',type:'artifact.updated',payload:{id:'table',kind:'table',name:'原成果',columns:['列'],rows:[['原值']]}});
 assert.throws(()=>p.publish({id:'huge',type:'artifact.updated',payload:{id:'table',kind:'table',name:'过大成果',columns:Array.from({length:16},(_,i)=>'列'+i),rows:Array.from({length:50},()=>Array(16).fill('中'.repeat(500)))}}),/过大|预算/);
 assert.equal(p.value.artifacts[0].name,'原成果');
});
test('部分页面与预览完成分开，不因出现一个指标就把资源标成完成',()=>{
 const p=api.createProjection('ses_bound');p.publish({id:'part',type:'artifact.updated',payload:{id:'report',kind:'page',name:'报告',metrics:[{label:'指标',value:'1'}],sections:[]}});
 assert.equal(globalThis.KmAgentModel.buildItems(p.value)[0].state,'partial');p.publish({id:'ready',type:'artifact.ready',payload:{artifactId:'report'}});assert.equal(globalThis.KmAgentModel.buildItems(p.value)[0].state,'preview');
});
test('静态区块A后追加并更新带ID的B，不能覆盖A或留下旧B',()=>{
 const p=api.createProjection('ses_bound');p.publish({id:'base',type:'artifact.updated',payload:{id:'page',kind:'page',name:'页面',metrics:[],sections:[{title:'A',text:'保留A'}]}});
 p.publish({id:'b1',type:'page.section.updated',payload:{artifactId:'page',section:{id:'b',title:'B',text:'旧B'}}});p.publish({id:'b2',type:'page.section.updated',payload:{artifactId:'page',section:{id:'b',title:'B',text:'新B'}}});
 assert.deepEqual(p.value.artifacts[0].sections,[{title:'A',text:'保留A'},{title:'B',text:'新B'}]);
});
test('旧原生协议块只应用一次，后续文字与快照不得抹掉新的发布区块',()=>{
 const p=api.createProjection('ses_bound'),text='```kmmdtable\n'+JSON.stringify({type:'artifact',id:'page',kind:'page',name:'页面',metrics:[],sections:[]})+'\n```';
 p.accept(event('session.text.ended',{assistantMessageID:'msg_a',ordinal:0,text}));p.publish({id:'new',type:'page.section.updated',payload:{artifactId:'page',section:{id:'new',title:'新结论',text:'应保留'}}});
 p.accept(event('session.text.delta',{assistantMessageID:'msg_a',ordinal:0,delta:'继续补充说明'}));assert.equal(p.value.artifacts[0].sections[0]?.title,'新结论');
 p.hydrate({status:'running',messages:[{id:'msg_a',role:'assistant',text}]});assert.equal(p.value.artifacts[0].sections[0]?.title,'新结论');
 const formatted='```kmmdtable\n'+JSON.stringify({type:'artifact',id:'page',kind:'page',name:'页面',metrics:[],sections:[]},null,2)+'\n```';p.hydrate({status:'running',messages:[{id:'msg_a',role:'assistant',text:formatted}]});assert.equal(p.value.artifacts[0].sections[0]?.title,'新结论','规范化内容相同也不能重放旧成果');
});

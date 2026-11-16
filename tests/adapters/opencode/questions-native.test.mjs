import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {OpenCode} from '@opencode/client';
import {sharedOpenCode} from '../../../src/adapters/opencode/shared-opencode.mjs';
import {createProjection} from '../../../src/session/shared-state.mjs';
import {createSharedHub} from '../../../src/session/shared-hub.mjs';

const form=(sessionID='ses_a',id='form_one')=>({id,sessionID,title:'请确认方案',metadata:{private:'NEVER_FORWARD_METADATA'},fields:[{key:'choice',type:'string',title:'单选',description:'这是一段完整普通问题。'.repeat(90),required:true,custom:true,options:[{value:'a',label:'方案甲',description:'说明甲'},{value:'b',label:'方案乙'}]},{key:'many',type:'multiselect',title:'多选',description:'请选择需要的功能',required:true,custom:true,options:[{value:'x',label:'功能甲'},{value:'y',label:'功能乙'}]}]});
const tick=()=>new Promise(r=>setImmediate(r));
const until=async fn=>{const end=Date.now()+3500;while(!fn()){if(Date.now()>end)throw Error('条件等待超时');await new Promise(r=>setTimeout(r,10));}};
async function native(t){
  let forms=[form()],scope='/workspace',holdGet=null;const calls=[],events=[],waiters=[];
  const server=http.createServer(async(req,res)=>{const path=new URL(req.url,'http://fixture').pathname;calls.push({method:req.method,path});
    res.setHeader('Content-Type','application/json');
    if(path==='/api/session/ses_a'){if(holdGet){const hold=holdGet;holdGet=null;await hold;}return res.end(JSON.stringify({data:{id:'ses_a',location:{directory:scope},time:{}}}));}
    if(path==='/api/session/ses_a/form'&&req.method==='GET')return res.end(JSON.stringify({data:forms}));
    if(path==='/api/session/ses_a/form/form_one'&&req.method==='GET')return res.end(JSON.stringify({data:{...forms[0],state:{status:'pending'}}}));
    if(path==='/api/session/ses_a/form/form_one/reply'&&req.method==='POST'){let text='';for await(const c of req)text+=c;calls.at(-1).body=JSON.parse(text);forms=[];res.writeHead(204);return res.end();}
    if(path==='/api/session/ses_a/form/form_one'&&req.method==='DELETE'){forms=[];res.writeHead(204);return res.end();}
    if(path==='/api/session/ses_a/message')return res.end(JSON.stringify({data:[]}));
    if(path==='/api/session/active')return res.end(JSON.stringify({data:{}}));
    if(path==='/api/session/ses_a/inbox')return res.end(JSON.stringify({data:[]}));
    res.writeHead(404);res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const client=OpenCode.make({baseUrl:`http://127.0.0.1:${server.address().port}`});
  client.event={subscribe:async function*({signal}){yield{type:'server.connected'};while(!signal.aborted){if(!events.length)await new Promise(r=>{waiters.push(r);signal.addEventListener('abort',r,{once:true});});while(events.length&&!signal.aborted)yield events.shift();}}};
  const adapter=sharedOpenCode({current:()=>({client}),health:async()=>({ready:true}),directory:'/workspace'});await adapter.bindSession('ses_a');
  return{adapter,calls,client,setForms:f=>{forms=f;},move:()=>{scope='/other';},hold:promise=>{holdGet=promise;},emit:event=>{events.push(event);waiters.splice(0).forEach(r=>r());}};
}

test('V2 SDK lists native forms and replies with field-keyed answer, never prompt/permission',async t=>{
  const f=await native(t);assert.equal(typeof f.adapter.listQuestions,'function','缺少原生待答问题API');
  const list=await f.adapter.listQuestions('ses_a');assert.equal(list.length,1);assert.equal(list[0].questions[0].question,form().fields[0].description);assert.equal(list[0].questions[1].multiple,true);assert.doesNotMatch(JSON.stringify(list),/NEVER_FORWARD_METADATA/);
  await f.adapter.replyQuestion('ses_a','form_one',[['a'],['x','自定义功能']]);
  assert.deepEqual(f.calls.find(x=>x.method==='POST')?.body,{answer:{choice:'a',many:['x','自定义功能']}});assert.equal(f.calls.some(x=>/prompt|permission/.test(x.path)),false);
  assert.deepEqual(await f.adapter.listQuestions('ses_a'),[]);
});

test('native cancel is DELETE form; absent/cross-session/invalid answers never invoke mutation',async t=>{
  const f=await native(t);assert.equal(typeof f.adapter.rejectQuestion,'function','缺少原生拒绝API');
  await assert.rejects(()=>f.adapter.replyQuestion('ses_a','form_one',[['a','b'],['x']]));
  await assert.rejects(()=>f.adapter.replyQuestion('ses_a','form_missing',[['a'],['x']]));
  f.setForms([form('ses_other')]);assert.deepEqual(await f.adapter.listQuestions('ses_a'),[]);await assert.rejects(()=>f.adapter.rejectQuestion('ses_a','form_one'));
  f.setForms([form()]);await f.adapter.rejectQuestion('ses_a','form_one');assert.equal(f.calls.filter(x=>x.method==='DELETE').length,1);assert.equal(f.calls.some(x=>x.method==='POST'),false);
});

test('revocation or workspace move during native validation blocks the real reply',async t=>{
  const f=await native(t);assert.equal(typeof f.adapter.replyQuestion,'function');
  let release,valid=true;f.hold(new Promise(r=>{release=r;}));const before=f.calls.length;
  const sending=f.adapter.replyQuestion('ses_a','form_one',[['a'],['x']],{assertCurrent(){if(!valid)throw Error('绑定已变化');}});
  await until(()=>f.calls.length>before);valid=false;release();await assert.rejects(()=>sending,error=>/绑定/.test(error.message)&&error.code==='QUESTION_NOT_SUBMITTED');assert.equal(f.calls.some(x=>x.method==='POST'),false);
  f.move();await assert.rejects(()=>f.adapter.replyQuestion('ses_a','form_one',[['a'],['x']]));assert.equal(f.calls.some(x=>x.method==='POST'),false);
});

test('native form events are scoped, allowlisted and never carry replied answers or permission raw',async t=>{
  const f=await native(t),seen=[];const watch=f.adapter.watch('ses_a',e=>seen.push(e));await watch.ready;t.after(()=>watch.close());
  f.emit({id:'other',type:'form.created',data:{form:form('ses_other')}});f.emit({id:'create',type:'form.created',data:{form:form()}});f.emit({id:'permission',type:'permission.asked',data:{sessionID:'ses_a',private:'PERMISSION_RAW'}});f.emit({id:'reply',type:'form.replied',data:{sessionID:'ses_a',id:'form_one',answer:{choice:'ANSWER_PRIVATE'}}});
  await until(()=>seen.some(e=>e.type==='form.replied'));assert.equal(seen.filter(e=>e.type==='form.created').length,1);assert.equal(seen.find(e=>e.type==='form.created').data.question.id,'form_one');assert.doesNotMatch(JSON.stringify(seen),/NEVER_FORWARD_METADATA|PERMISSION_RAW|ANSWER_PRIVATE/);
});

test('projection restores pending questions, deduplicates events and does not resurrect settled IDs',()=>{
  const p=createProjection('ses_a'),question={id:'form_one',sessionId:'ses_a',title:'问题',questions:[{key:'x',header:'问题',question:'完整问题',options:[],multiple:false,custom:true,required:true}]};
  assert.deepEqual(p.value.questions,[],'快照缺少questions数组');p.hydrate({questions:[question],status:'running'});assert.equal(p.value.questions.length,1);
  const create={id:'e1',type:'form.created',data:{sessionID:'ses_a',question}};p.accept(create);p.accept(create);assert.equal(p.value.questions.length,1);
  p.accept({id:'e2',type:'form.replied',data:{sessionID:'ses_a',id:'form_one'}});p.accept({...create,id:'late'});assert.equal(p.value.questions.length,0);
  p.hydrate({questions:[],status:'idle'});assert.equal(p.value.questions.length,0);
});

test('hub buffers form settlement over initial snapshot and disconnect clears stale controls',async()=>{
  let emit,state;const question={id:'form_one',sessionId:'ses_a',title:'问题',questions:[{key:'x',header:'问题',question:'完整问题',options:[],multiple:false,custom:true,required:true}]};
  const adapter={bindSession:async()=>{},health:async()=>({ready:true}),watch:(id,e,s)=>{emit=e;state=s;return{ready:Promise.resolve(),close(){}};},readShared:async()=>{emit({id:'settled',type:'form.cancelled',data:{sessionID:'ses_a',id:'form_one'}});return{status:'running',questions:[question],messages:[]};}};
  const hub=createSharedHub({adapter,session:{id:'ses_a'},onChange(){}});await hub.start();assert.deepEqual(hub.projection.value.questions,[]);hub.projection.value.questions=[question];state('disconnected');assert.deepEqual(hub.projection.value.questions,[]);await hub.close();await tick();
});

test('reconnect resync restores a still-pending form and removes forms settled while offline',async()=>{
  let emit,state,reads=0;const question={id:'frm_restore',sessionId:'ses_a',title:'恢复问题',questions:[{key:'x',header:'问题',question:'完整问题',options:[],multiple:false,custom:true,required:true}]};
  const adapter={bindSession:async()=>{},health:async()=>({ready:true}),watch:(id,e,s)=>{emit=e;state=s;return{ready:Promise.resolve(),close(){}};},readShared:async()=>{reads++;return{status:'running',messages:[],questions:reads===1?[question,{...question,id:'frm_settled_offline'}]:[question]};}};
  const hub=createSharedHub({adapter,session:{id:'ses_a'},onChange(){}});await hub.start();assert.equal(hub.projection.value.questions.length,2);const oldEmit=emit;state('disconnected');assert.deepEqual(hub.projection.value.questions,[]);oldEmit({id:'late-old',type:'form.created',data:{sessionID:'ses_a',question:{...question,id:'frm_old_stream'}}});assert.deepEqual(hub.projection.value.questions,[]);
  await until(()=>reads===2&&hub.transport==='connected');assert.deepEqual(hub.projection.value.questions.map(q=>q.id),['frm_restore']);emit({id:'cancel',type:'form.cancelled',data:{sessionID:'ses_a',id:'frm_restore'}});assert.deepEqual(hub.projection.value.questions,[]);await hub.close();
});

test('native question public text is complete but credentials, hidden fields and global forms never broadcast',async t=>{
  const f=await native(t);f.setForms([{...form(),title:'完整普通问题 api_key=DO_NOT_DISPLAY',metadata:{reasoning:'PRIVATE_REASONING'},fields:form().fields},form('global','frm_global'),{...form('ses_a','frm_hidden'),fields:[{type:'string',key:'api_key',hidden:true,default:'HIDDEN_DEFAULT'}]}]);
  const result=await f.adapter.listQuestions('ses_a');assert.equal(result.length,1);assert.equal(result[0].questions[0].question,form().fields[0].description);assert.doesNotMatch(JSON.stringify(result),/DO_NOT_DISPLAY|PRIVATE_REASONING|HIDDEN_DEFAULT|frm_global/);
});

test('question text redacts quoted credentials and URL userinfo without forwarding secret option values',async t=>{
  const f=await native(t),source=form();source.fields[0].description='普通问题 {"api_key":"QUOTED_CREDENTIAL"} redis://alice:URL_CREDENTIAL@localhost/db';f.setForms([source]);const result=await f.adapter.listQuestions('ses_a');assert.equal(result.length,1);assert.match(result[0].questions[0].question,/普通问题/);assert.doesNotMatch(JSON.stringify(result),/QUOTED_CREDENTIAL|URL_CREDENTIAL/);
  source.fields[0].options[0].value='api_key=OPTION_CREDENTIAL';f.setForms([source]);assert.deepEqual(await f.adapter.listQuestions('ses_a'),[]);
});

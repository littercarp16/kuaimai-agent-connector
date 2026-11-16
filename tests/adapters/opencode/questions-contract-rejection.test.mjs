import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {OpenCode} from '@opencode/client';
import {sharedOpenCode} from '../../../src/adapters/opencode/shared-opencode.mjs';
import {createSharedHub} from '../../../src/session/shared-hub.mjs';

const form={id:'frm_review',sessionID:'ses_review',title:'确认方案',fields:[{key:'choice',type:'string',title:'方案',description:'请选择方案',required:true,custom:true,options:[{value:'a',label:'甲'},{value:'b',label:'乙'}]}]};
async function fixture(t,rejection){
  let mutations=0,pending=true;const calls=[];
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://fixture').pathname;res.setHeader('Content-Type','application/json');
    if(path==='/api/session/ses_review')return res.end(JSON.stringify({data:{id:'ses_review',location:{directory:'/workspace'},time:{}}}));
    if(path==='/api/session/ses_review/form'&&req.method==='GET')return res.end(JSON.stringify({data:pending?[form]:[]}));
    if(path==='/api/session/ses_review/form/frm_review'&&req.method==='GET')return res.end(JSON.stringify({data:{...form,state:{status:pending?'pending':'answered'}}}));
    if((path.endsWith('/frm_review/reply')&&req.method==='POST')||(path.endsWith('/frm_review')&&req.method==='DELETE')){
      let body='';for await(const part of req)body+=part;calls.push({method:req.method,body:body?JSON.parse(body):null});mutations++;
      if(mutations===1){if(rejection.timeout)return;if(rejection.transport){req.socket.destroy();return;}res.writeHead(rejection.status);res.end(JSON.stringify(rejection.body));return;}
      pending=false;res.writeHead(204);res.end();return;
    }
    res.writeHead(404);res.end('{}');
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();return new Promise(r=>server.close(r));});
  const client=OpenCode.make({baseUrl:`http://127.0.0.1:${server.address().port}`,fetch:(url,init)=>fetch(url,{...init,...(rejection.timeout&&['POST','DELETE'].includes(init.method)?{signal:AbortSignal.any([init.signal,AbortSignal.timeout(40)])}:{})})}),adapter=sharedOpenCode({current:()=>({client}),health:async()=>({ready:true}),directory:'/workspace'});
  await adapter.bindSession('ses_review');
  const question=(await adapter.listQuestions('ses_review'))[0];
  const hub=createSharedHub({adapter:{...adapter,installBridge:undefined,removeBridge:undefined,watch:()=>({ready:Promise.resolve(),close(){}}),readShared:async()=>({status:'running',messages:[],questions:[question]})},session:{id:'ses_review'},onChange(){}});await hub.start();const owner={};hub.members.add(owner);t.after(()=>hub.close());
  return{client,adapter,hub,owner,calls,mutations:()=>mutations,pending:()=>pending};
}

test('RED finding 3: SDK 401 UnauthorizedError retains native pending but must permit an explicit corrected answer',async t=>{
  const f=await fixture(t,{status:401,body:{_tag:'UnauthorizedError',message:'fixture credentials rejected'}});
  await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['a']]}),error=>error._tag==='UnauthorizedError');
  assert.equal(f.mutations(),1,'没有自动重试');assert.equal(f.pending(),true);assert.equal(f.hub.projection.value.questions.length,1);
  const result=await f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['b']]});assert.equal(result.status,'answered');assert.equal(f.mutations(),2);assert.deepEqual(f.calls[1].body,{answer:{choice:'b'}});
});

test('real SDK exposes declared 400/401 _tag without status/code; only contract rejections may unblock explicit cancel',async t=>{
  for(const [status,tag]of [[401,'UnauthorizedError'],[400,'InvalidRequestError'],[400,'FormInvalidAnswerError']])await t.test(tag,async t=>{
    const f=await fixture(t,{status,body:{_tag:tag,message:'fixture contract rejection',id:'frm_review'}});
    await assert.rejects(()=>f.client.session.form.reply({sessionID:'ses_review',formID:'frm_review',answer:{choice:'a'}}),error=>error._tag===tag&&error.name===tag&&error.code===undefined&&error.status===undefined);
    assert.equal(f.pending(),true);assert.equal(f.mutations(),1);
  });
  for(const tag of ['UnauthorizedError','InvalidRequestError','FormInvalidAnswerError'])await t.test('explicit cancel after '+tag,async t=>{
    const f=await fixture(t,{status:tag==='UnauthorizedError'?401:400,body:{_tag:tag,message:'fixture rejection',id:'frm_review'}});
    await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['a']]}));assert.equal(f.mutations(),1);
    assert.equal((await f.hub.answerQuestion(f.owner,{questionId:'frm_review'},{reject:true})).status,'rejected');assert.deepEqual(f.calls.map(c=>c.method),['POST','DELETE']);
  });
});

test('timeout/transport/unknown 500/malformed 401 and already-settled failures stay deduplicated with no retry',async t=>{
  const cases=[{status:500,body:{_tag:'UnauthorizedError',message:'a 500 body cannot impersonate declared auth rejection'}},{status:500,body:{_tag:'UnknownError',message:'fixture internal failure'}},{status:401,body:{message:'untyped error'}},{status:409,body:{_tag:'FormAlreadySettledError',id:'frm_review',message:'already answered'}},{transport:true},{timeout:true}];
  for(const rejection of cases)await t.test(JSON.stringify(rejection),async t=>{
    const f=await fixture(t,rejection);await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['a']]}));
    await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['a']]}));await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review',answers:[['b']]}));await assert.rejects(()=>f.hub.answerQuestion(f.owner,{questionId:'frm_review'},{reject:true}));assert.equal(f.mutations(),1);
  });
});

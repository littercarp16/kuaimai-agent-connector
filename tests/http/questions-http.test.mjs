import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createConnector} from '../../src/http/server.mjs';

const question=sessionId=>({id:'frm_pending',sessionId,title:'请确认方案',questions:[{key:'q0',header:'选择',question:'完整普通问题？',options:[{value:'a',label:'甲',description:'方案说明'},{value:'b',label:'乙',description:''}],multiple:false,custom:true,required:true}]});
const until=async fn=>{const end=Date.now()+3000;while(!await fn()){if(Date.now()>end)throw Error('等待条件超时');await new Promise(r=>setTimeout(r,10));}};
async function fixture(t,{native=true}={}){
  let now=1000,hold=null,entered=0;const emitted=new Map(),states=new Map(),calls=[];
  const adapter={health:async()=>({ready:true,version:'2.0.30'}),bindSession:async id=>({id,title:id}),readShared:async id=>({messages:[],questions:native?[question(id)]:[],status:'running'}),watch:(id,emit,state)=>{emitted.set(id,emit);states.set(id,state);return{ready:Promise.resolve(),close(){}};}};
  if(native)Object.assign(adapter,{listQuestions:async id=>[question(id)],replyQuestion:async(id,qid,answers,opts)=>{entered++;if(hold)await hold;opts.assertCurrent();calls.push({kind:'reply',id,qid,answers});return{questionId:qid,status:'answered'};},rejectQuestion:async(id,qid,opts)=>{entered++;if(hold)await hold;opts.assertCurrent();calls.push({kind:'reject',id,qid});return{questionId:qid,status:'rejected'};}});
  const origin='http://127.0.0.1:4173',bridge=createConnector({adapter,now:()=>now,allowedOrigins:[origin],pairCode:'123456',publisherKey:'question-test-local-publisher'});bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const req=(path,data,token,extra={})=>fetch(base+path,{method:data?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...extra},body:data?JSON.stringify(data):undefined});
  const paired=await(await req('/v1/pair',{code:'123456'})).json(),token=paired.data.token;const bind=async(sessionId='ses_a',allowControl=true)=>(await req('/v1/bind',{sessionId,allowControl},token));await bind();
  const read=async()=>(await(await req('/v1/snapshot',null,token)).json()).data;
  const input={instanceId:bridge.instanceId,sessionId:'ses_a',questionId:'frm_pending',answers:[['a']]};
  return{bridge,adapter,token,req,read,bind,input,calls,states,publish:event=>fetch(base+'/v1/local/publish',{method:'POST',headers:{'Content-Type':'application/json','X-Km-Agent':'1','X-Km-Publisher':'question-test-local-publisher'},body:JSON.stringify({sessionId:'ses_a',event})}),emit:(id,event)=>emitted.get(id)?.(event),hold:()=>{let release;hold=new Promise(r=>{release=r;});return release;},entered:()=>entered,expire:()=>{now+=9*3600e3;}};
}

test('authenticated question list and reply use the native pending request, never a chat message',async t=>{
  const f=await fixture(t);assert.equal((await f.read()).capabilities.nativeQuestions,true);const list=await f.req('/v1/questions',null,f.token);assert.equal(list.status,200);assert.equal((await list.json()).data.questions[0].id,'frm_pending');
  const response=await f.req('/v1/question/reply',f.input,f.token);assert.equal(response.status,200);assert.deepEqual((await response.json()).data,{questionId:'frm_pending',status:'answered'});assert.equal(f.calls.length,1);assert.deepEqual((await f.read()).run.questions,[]);assert.deepEqual((await f.read()).run.messages,[]);
});

test('question reply is once-only across concurrent requests and conflicting selections are rejected',async t=>{
  const f=await fixture(t),release=f.hold();const first=f.req('/v1/question/reply',f.input,f.token);await until(()=>f.entered()===1);const second=f.req('/v1/question/reply',f.input,f.token);await new Promise(r=>setImmediate(r));release();assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal(f.calls.length,1);
  assert.equal((await f.req('/v1/question/reply',{...f.input,answers:[['b']]},f.token)).status,409);assert.equal(f.calls.length,1);
  const reject={...f.input};delete reject.answers;assert.equal((await f.req('/v1/question/reject',reject,f.token)).status,409);
});

test('question reply requires control, Origin authorization, current instance/session and valid request',async t=>{
  const f=await fixture(t);assert.equal((await f.req('/v1/question/reply',f.input)).status,401);assert.equal((await f.req('/v1/question/reply',f.input,f.token,{Origin:'http://untrusted.example'})).status,403);
  for(const extra of [{instanceId:'old-instance'},{sessionId:'ses_other'},{questionId:'frm_other'},{answers:'a'},{answers:[['a','b']]}])assert.ok([400,404,409].includes((await f.req('/v1/question/reply',{...f.input,...extra},f.token)).status));
  await f.bind('ses_a',false);assert.equal((await f.req('/v1/question/reply',f.input,f.token)).status,403);assert.equal(f.calls.length,0);
});

test('switch binding or revoke/expire while native validation awaits blocks mutation and late result',async t=>{
  for(const mode of ['switch','revoke','expire']){const f=await fixture(t),release=f.hold(),pending=f.req('/v1/question/reply',f.input,f.token);await until(()=>f.entered()===1);
    if(mode==='switch')await f.bind('ses_b');else if(mode==='revoke')await f.req('/v1/disconnect',{},f.token);else{f.expire();await f.req('/v1/health');}
    release();assert.ok([401,409].includes((await pending).status),mode);assert.equal(f.calls.length,0,mode);}
});

test('native reject cancels only the question; disconnected/generic adapters cannot fake support',async t=>{
  const f=await fixture(t),reject={...f.input};delete reject.answers;assert.equal((await f.req('/v1/question/reject',reject,f.token)).status,200);assert.equal(f.calls[0].kind,'reject');assert.deepEqual((await f.read()).run.messages,[]);
  const g=await fixture(t,{native:false});assert.equal((await g.read()).capabilities.nativeQuestions,false);assert.equal((await g.req('/v1/question/reply',g.input,g.token)).status,409);
  const h=await fixture(t);h.states.get('ses_a')('disconnected');assert.equal((await h.req('/v1/question/reply',h.input,h.token)).status,409);assert.deepEqual((await h.read()).run.questions,[]);
});

test('SSE sends controlled question fields and local publishers cannot inject native questions',async t=>{
  const f=await fixture(t),abort=new AbortController();t.after(()=>abort.abort());const response=await fetch(`http://127.0.0.1:${f.bridge.server.address().port}/v1/events`,{headers:{Origin:'http://127.0.0.1:4173',Authorization:'Bearer '+f.token},signal:abort.signal});const reader=response.body.getReader();const first=await reader.read();assert.match(Buffer.from(first.value).toString(),/frm_pending/);
  f.emit('ses_a',{id:'q2',type:'form.created',data:{sessionID:'ses_a',question:{...question('ses_a'),id:'frm_second',raw:'NEVER_FORWARD_RAW',metadata:{secret:'NEVER_FORWARD_METADATA'}}}});const second=await reader.read();assert.match(Buffer.from(second.value).toString(),/frm_second/);assert.doesNotMatch(Buffer.from(second.value).toString(),/NEVER_FORWARD/);abort.abort();
  assert.equal((await f.publish({id:'spoof-question',type:'form.created',payload:{question:question('ses_a')}})).status,400);
});

test('already submitted native answer cannot publish a late success into a different binding',async t=>{
  const f=await fixture(t);let release,submitted=false;f.adapter.replyQuestion=async()=>{submitted=true;await new Promise(r=>{release=r;});};const response=f.req('/v1/question/reply',f.input,f.token);await until(()=>submitted);await f.bind('ses_b');release();assert.equal((await response).status,409);const snapshot=await f.read();assert.equal(snapshot.sessionId,'ses_b');assert.equal(snapshot.run.questions[0].sessionId,'ses_b');
});

test('a definitely-not-submitted native validation failure can be corrected without a stuck dedup record',async t=>{
  const f=await fixture(t);let attempts=0;f.adapter.replyQuestion=async()=>{if(++attempts===1)throw Object.assign(Error('提交前连接失效'),{code:'QUESTION_NOT_SUBMITTED'});return{questionId:'frm_pending',status:'answered'};};
  assert.equal((await f.req('/v1/question/reply',f.input,f.token)).status,409);assert.equal((await f.req('/v1/question/reply',f.input,f.token)).status,200);assert.equal(attempts,2);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQwenDesktopManager, createQwenDesktopRuntime, QwenDesktopFailure } from '../../src/runtime/qwen-desktop.mjs';
import { randomUUID } from 'node:crypto';
const done = async manager => { while(manager.status().state==='running') await new Promise(r=>setTimeout(r,5)); return manager.status(); };
function fixture({available=false,running=true,authenticated=true,...overrides}={}) {
  const calls=[];let time=0;
  const runtime={check:async()=>{calls.push('check');},inspect:async()=>({available,authenticated,instanceId:'native'}),isRunning:async()=>running,
    quit:async()=>{calls.push('quit');running=false;},open:async()=>{calls.push('open');available=true;running=true;},...overrides};
  const manager=createQwenDesktopManager({runtime,now:()=>time,sleep:async ms=>{time+=ms;},quitWaitMs:20,readyWaitMs:30,pollMs:10});
  return{manager,calls,runtime,reset:()=>{available=false;time+=40000;},done:()=>done(manager)};
}
test('running Qwen without HTTP exits fully before flag launch; simultaneous requests share one operation',async()=>{
 const f=fixture();const a=f.manager.ensure();const b=f.manager.ensure();assert.equal(a.id,b.id);assert.deepEqual(f.calls,[]);
 const result=await f.done();assert.equal(result.state,'completed');assert.equal(result.action,'restart');assert.deepEqual(f.calls,['check','quit','open']);
 f.manager.ensure();assert.equal((await f.done()).action,'reuse');assert.equal(f.calls.filter(x=>x==='quit').length,1);
 f.reset();f.manager.ensure();assert.equal((await f.done()).action,'restart');assert.equal(f.calls.filter(x=>x==='quit').length,2,'reusing bridge still checks native HTTP');
});
test('healthy HTTP and logged-out HTTP both reuse; a stopped app only starts',async()=>{
 for(const authenticated of [true,false]){const f=fixture({available:true,authenticated});f.manager.ensure();const r=await f.done();assert.equal(r.action,'reuse');assert.equal(r.authenticated,authenticated);assert.ok(!f.calls.includes('quit'));assert.ok(!f.calls.includes('open'));}
 const f=fixture({running:false});f.manager.ensure();assert.equal((await f.done()).action,'start');assert.deepEqual(f.calls,['check','open']);
});
test('quit refusal and timeout cannot force-kill or open duplicate app; preparation failure stays visible',async()=>{
 for(const quit of [async()=>{throw Error('private details');},async()=>{}]){const f=fixture({quit});f.manager.ensure();const result=await f.done();assert.equal(result.state,'failed');assert.ok(!f.calls.includes('open'));assert.doesNotMatch(result.message,/private/);}
 const f=fixture({open:async()=>{}});f.manager.ensure();assert.match((await f.done()).message,/HTTP 接口未就绪/);
});
test('invalid instance/interface and authorization cancellation do not quit; request retries are idempotent',async()=>{
 const f=fixture({inspect:async()=>{throw new QwenDesktopFailure(409,'接口不兼容');}});f.manager.ensure();assert.equal((await f.done()).state,'failed');assert.ok(!f.calls.includes('quit'));
 const g=fixture();let allowed=true;g.manager.ensure({assertAllowed:()=>{if(!allowed)throw Error('revoked');}});allowed=false;await g.done();assert.deepEqual(g.calls,[]);
 const h=fixture();const id=randomUUID();h.manager.ensure({requestId:id});await h.done();assert.equal(h.manager.ensure({requestId:id}).state,'completed');assert.equal(h.calls.filter(x=>x==='quit').length,1);
});
test('runtime uses fixed app/flag and only matches current-user Qwen main process',async()=>{
 const calls=[];const runtime=createQwenDesktopRuntime({uid:501,run:async(file,args)=>{calls.push([file,args]);return{stdout:'501 18 /Applications/QwenWorkCN.app/Contents/MacOS/QwenWorkCN\n502 19 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n'};}});
 assert.equal(await runtime.isRunning(),true);await runtime.quit();await runtime.open();
 assert.deepEqual(calls[2],['/usr/bin/open',['-a','/Applications/QwenWorkCN.app','--env','QWENWORK_DESKTOP_CONTROL_ENABLED=1']]);
 assert.ok(calls.every(([,args])=>!args.join(' ').includes('kill')));
});
test('missing endpoint is recoverable, while protocol/permission failure is not; HTTP login is distinct',async()=>{
 const missing=createQwenDesktopRuntime({connect:async()=>{throw Object.assign(Error(),{code:'ENOENT'});}});assert.equal((await missing.inspect()).available,false);
 const denied=createQwenDesktopRuntime({connect:async()=>{throw Object.assign(Error(),{code:'EACCES'});}});await assert.rejects(denied.inspect(),/校验失败/);
 const loggedOut=createQwenDesktopRuntime({connect:async()=>({instance:'i',call:async()=>({protocol:'qwenwork.desktop.v1',authenticated:false,features:{session_history:true,task_events:true,task_execution:true}})})});assert.equal((await loggedOut.inspect()).authenticated,false);
});

test('once normal quit succeeds, losing the initiating page cannot leave Qwen closed',async()=>{
 let allowed=true,running=true;const calls=[];let available=false;
 const manager=createQwenDesktopManager({runtime:{check:async()=>{},inspect:async()=>({available,authenticated:true}),isRunning:async()=>running,quit:async()=>{running=false;allowed=false;calls.push('quit')},open:async()=>{calls.push('open');available=true;running=true}}});
 manager.ensure({assertAllowed:()=>{if(!allowed)throw Error('page closed')}});
 assert.equal((await done(manager)).state,'completed');assert.deepEqual(calls,['quit','open']);
});

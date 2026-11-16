import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {request as httpRequest} from 'node:http';
import {createConnector} from '../../../src/http/server.mjs';

const origin='http://127.0.0.1:4173',key='workbuddy-local-fixture-publisher';
const event=(type,payload,id=randomUUID())=>({protocol:'km-agent/1',id,type,payload});
const uuid=()=>randomUUID();
async function fixture(t,options={}){
  let emit,offer,pairCode='123456';const calls=[],bindings=[];
  const adapter={descriptor:{id:'opencode',status:'native'},health:async()=>({ready:true,version:'2.0.30'}),
    listSessions:async()=>[{id:'ses_native',title:'原生任务'}],bindSession:async id=>{calls.push(['bind',id]);if(id!=='ses_native')throw Error('not native');return{id,title:'原生任务'};},
    readShared:async()=>({status:'idle',messages:[],tools:[]}),watch:(id,onEvent)=>{emit=onEvent;return{ready:Promise.resolve(),close(){calls.push(['close',id]);}};},
    watchRelevantSessions:callback=>{offer=callback;return{ready:Promise.resolve(),close(){}};},
    installBridge:async()=>{},removeBridge:async()=>{},sendShared:async()=>{calls.push(['send']);return{id:'msg_sent'};},interruptShared:async()=>{calls.push(['stop']);return{interrupted:true};},
    createSharedSession:async()=>{calls.push(['new']);return{id:'ses_new'};},searchWorkspaceFiles:async()=>{calls.push(['files']);return[];},
    listQuestions:async()=>[],replyQuestion:async()=>{calls.push(['reply']);},rejectQuestion:async()=>{calls.push(['reject']);},readToolDetail:async()=>{calls.push(['detail']);}};
  const bridge=createConnector({adapter,allowedOrigins:[origin],pairCode:'123456',publisherKey:key,enableWorkBuddy:true,onPairCode:value=>{pairCode=value;},onBindings:value=>bindings.push(value),...options});
  bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const web=(path,body,token)=>fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const local=(action,body,token,headers={})=>fetch(base+'/v1/local/workbuddy/tasks/'+action,{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json',...(action==='open'?{'X-Km-Publisher':key}:{'X-Km-Task-Token':token}),...headers},body:JSON.stringify(body)});
  const pair=await(await web('/v1/pair',{code:'123456'})).json();assert.equal(pair.ok,true);const token=pair.data.token;
  const snapshot=async()=>(await(await web('/v1/snapshot',null,token)).json()).data;
  const open=async(title='WB 协作任务')=>{const response=await local('open',{requestId:uuid(),title,workspaceId:'design-fixture'});assert.equal(response.status,200);return(await response.json()).data;};
  const scope=task=>({instanceId:task.instanceId,taskId:task.taskId});
  const pairAgain=async()=>(await(await web('/v1/pair',{code:pairCode})).json()).data.token;
  return{bridge,adapter,base,web,local,token,snapshot,open,scope,calls,bindings,pairAgain,emit:e=>emit?.(e),offer:e=>offer?.(e)};
}

test('WB unbound events are cached, manually bound, and only a real bound UI ack becomes applied',async t=>{
  const f=await fixture(t),task=await f.open();assert.match(task.taskId,/^ses_wb_[a-f0-9]{32}$/);assert.equal(task.instanceId,f.bridge.instanceId);assert.equal(task.status,'running');assert.ok(task.taskToken);
  const create=event('resource.create',{id:'report',kind:'page',name:'协作成果'}),body={...f.scope(task),event:create};
  const accepted=await(await f.local('publish',body,task.taskToken)).json();assert.equal(accepted.ok,true);assert.equal(accepted.data.delivery,'accepted');assert.notEqual(accepted.data.applied,true,'projection acceptance must not claim UI application');
  assert.equal((await f.snapshot()).binding,null);assert.equal((await f.snapshot()).incomingSources[0].id,task.taskId);
  assert.equal((await f.web('/v1/ui/ack',{sessionId:task.taskId,eventId:create.id,status:'applied'},f.token)).status,409);
  const bound=await(await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token)).json();assert.equal(bound.ok,true);
  assert.equal(bound.data.binding.provider,'workbuddy');assert.equal(bound.data.adapter.id,'workbuddy');assert.equal(bound.data.adapter.status,'publish-only');assert.equal(bound.data.run.mode,'workbuddy');assert.equal(bound.data.run.artifacts[0].buildState,'building');assert.equal(bound.data.binding.source.nativeSession,false);
  for(const name of ['newSession','workspaceFiles','attachments','nativeQuestions','followSessions','toolDetailFetch','submitPrompt','nativeEvents','cancelRun'])assert.equal(bound.data.capabilities[name],false,name);
  assert.equal(bound.data.capabilities.publishUI,true);assert.equal(bound.data.binding.canControl,false);assert.equal(f.calls.length,0,'WB binding never invokes the native adapter');
  assert.equal((await f.web('/v1/ui/ack',{sessionId:task.taskId,eventId:create.id,status:'applied',detail:'已渲染'},f.token)).status,200);
  assert.equal((await(await f.local('receipt',{...f.scope(task),eventId:create.id},task.taskToken)).json()).data.status,'applied');
  await f.web('/v1/unbind',{},f.token);await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);assert.equal((await f.snapshot()).run.artifacts.length,1,'last observer leaving must not discard WB projection');
  const visible=JSON.stringify({snapshot:await f.snapshot(),bindings:f.bindings});assert.ok(!visible.includes(task.taskToken));assert.ok(!visible.includes(key));
});

test('WB candidates coexist with native follow without replacing the active OpenCode hub; health stays primary',async t=>{
  const f=await fixture(t,{autoTrust:{origin,sessionId:'ses_native',allowControl:true,followSessions:true}});
  await f.web('/v1/bind',{sessionId:'ses_native',allowControl:true},f.token);await f.web('/v1/follow',{enabled:true},f.token);
  f.emit({id:'native-running',type:'session.execution.started',data:{sessionID:'ses_native'}});
  const task=await f.open('WB 业务标题不得进入health');await f.local('publish',{...f.scope(task),event:event('run.note',{text:'协作上报'})},task.taskToken);
  assert.equal((await f.snapshot()).binding.id,'ses_native');assert.equal((await f.snapshot()).binding.canControl,true);assert.equal((await f.snapshot()).adapter.id,'opencode');
  const health=await(await f.web('/v1/health')).json();assert.equal(health.data.adapter.id,'opencode');assert.equal(health.data.capabilities.workbuddyPublish,true);assert.ok(!JSON.stringify(health).includes(task.title));assert.ok(!JSON.stringify(health).includes(task.taskId));
  const listed=await(await f.web('/v1/sources',null,f.token)).json();assert.equal(listed.data.sessions.length,2);assert.equal(listed.data.sources[0].status,'available');
  f.adapter.listSessions=async()=>{throw Error('secret native details');};const offline=await(await f.web('/v1/sources',null,f.token)).json();assert.equal(offline.ok,true);assert.equal(offline.data.sources[0].status,'unavailable');assert.deepEqual(offline.data.sessions.map(s=>s.id),[task.taskId]);assert.ok(!JSON.stringify(offline).includes('secret native details'));
  assert.equal((await f.web('/v1/bind',{sessionId:task.taskId,allowControl:true},f.token)).status,403);assert.equal((await f.snapshot()).binding.id,'ses_native');assert.equal((await f.snapshot()).routing.mode,'follow','a rejected WorkBuddy control request must not pin the native follow setting');
});

test('WB registration and task operations enforce host/origin/json and scoped tokens, never global or browser authority',async t=>{
  const f=await fixture(t),a=await f.open(),b=await f.open(),payload={...f.scope(a),event:event('run.note',{text:'安全公开文字'})};
  assert.equal((await f.snapshot()).incomingSources[0].id,b.taskId,'候选默认最新任务，不能把新任务导回旧完成任务');
  for(const wrong of [key,f.token,b.taskToken,'invalid'])assert.equal((await f.local('publish',payload,wrong)).status,403);
  for(const action of ['receipt','heartbeat','finish'])for(const wrong of [key,f.token,b.taskToken])assert.equal((await f.local(action,{...f.scope(a),...(action==='receipt'?{eventId:'missing'}:action==='finish'?{requestId:uuid(),status:'failed'}:{})},wrong)).status,403,action);
  assert.equal((await f.local('publish',payload,a.taskToken,{Origin:origin})).status,403);
  const wrongHost=await new Promise((resolve,reject)=>{const req=httpRequest(f.base+'/v1/local/workbuddy/tasks/publish',{method:'POST',headers:{Host:'localhost:'+f.bridge.server.address().port,'Content-Type':'application/json','X-Km-Agent':'1','X-Km-Task-Token':a.taskToken}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify(payload));});assert.equal(wrongHost,403);
  assert.equal((await f.local('publish',payload,a.taskToken,{'Content-Type':'text/plain'})).status,415);
  assert.equal((await f.local('publish',payload,a.taskToken,{'X-Km-Agent':'0'})).status,415);
  assert.equal((await f.local('heartbeat',{...f.scope(a),instanceId:uuid()},a.taskToken)).status,409);
  assert.equal((await f.local('open',{requestId:uuid(),title:'wrong',workspaceId:'x'},null,{'X-Km-Publisher':a.taskToken})).status,403);
  await f.web('/v1/bind',{sessionId:a.taskId,allowControl:false},f.token);
  const legacy=await fetch(f.base+'/v1/local/publish',{method:'POST',headers:{'Content-Type':'application/json','X-Km-Agent':'1','X-Km-Publisher':key},body:JSON.stringify({sessionId:a.taskId,event:payload.event})});assert.equal(legacy.status,403);
  for(const [path,body] of [['/v1/run',{requestId:uuid(),text:'禁止发prompt'}],['/v1/stop',{}],['/v1/session/new',{sessionId:a.taskId,requestId:uuid()}],['/v1/files/search',{sessionId:a.taskId,query:'x'}],['/v1/question/reply',{instanceId:a.instanceId,sessionId:a.taskId,questionId:'form',answers:[]}],['/v1/question/reject',{instanceId:a.instanceId,sessionId:a.taskId,questionId:'form'}],['/v1/tool/detail',{sessionId:a.taskId,toolId:'tool'}]])assert.ok((await f.web(path,body,f.token)).status>=400,path);
  assert.ok((await f.web('/v1/questions',null,f.token)).status>=400);assert.equal(f.calls.length,0);
});

test('WB open/event/finish request IDs are idempotent and reject changed content; completed never silently readies an artifact',async t=>{
  const f=await fixture(t),input={requestId:uuid(),title:'幂等任务',workspaceId:'fixture'};
  const a=await(await f.local('open',input)).json(),b=await(await f.local('open',input)).json();assert.equal(a.ok,true);assert.deepEqual(a,b);const task=a.data;
  assert.equal((await f.local('open',{...input,title:'冲突'})).status,409);
  const first=event('resource.create',{id:'page',kind:'page',name:'页面'}),publish=e=>f.local('publish',{...f.scope(task),event:e},task.taskToken);
  assert.equal((await publish(first)).status,200);assert.equal((await publish(first)).status,200);assert.equal((await publish({...first,payload:{...first.payload,name:'冲突'}})).status,409);
  const finish={...f.scope(task),requestId:uuid(),status:'completed'};assert.equal((await f.local('finish',finish,task.taskToken)).status,409);
  await publish(event('artifact.ready',{artifactId:'page'}));const done=await f.local('finish',finish,task.taskToken);assert.equal(done.status,200);assert.equal((await f.local('finish',finish,task.taskToken)).status,200);
  assert.equal((await f.local('finish',{...finish,status:'failed'},task.taskToken)).status,409);assert.equal((await publish(event('run.note',{text:'迟到事件'}))).status,409);
  await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);assert.equal((await f.snapshot()).run.status,'completed');assert.equal((await f.snapshot()).run.artifacts[0].buildState,'ready');
});

test('WB public payloads redact secrets/private blocks but preserve normal HTML/CSS/URLs; only phase activities are allowed',async t=>{
  const f=await fixture(t),task=await f.open('password=title-secret 公开任务'),publish=e=>f.local('publish',{...f.scope(task),event:e},task.taskToken);
  const html='<main><h1>公开页面</h1><a href="https://example.test/report?q=normal">报表</a></main>',css='main { color: #234567; }';
  assert.equal((await publish(event('artifact.updated',{id:'p',kind:'page',name:'页面',document:{html,css}}))).status,200);
  assert.equal((await publish(event('run.note',{text:'公开说明 password=payload-secret <analysis>private-block-value</analysis> https://example.test/path?q=normal&token=url-secret'}))).status,200);
  for(const kind of ['tool','skill','thinking','permission'])assert.equal((await publish(event('activity.updated',{id:'a-'+kind,kind,label:'伪原生',status:'running'}))).status,400);
  assert.equal((await publish(event('activity.updated',{id:'phase',kind:'phase',label:'公开阶段',status:'running',detail:'正在整理'}))).status,200);
  assert.equal((await publish({...event('run.note',{text:'no'}),metadata:{arbitrary:'no'}})).status,400);
  assert.equal((await publish(event('run.note',{text:'no',metadata:{arbitrary:'no'}}))).status,400);
  assert.equal((await publish(event('form.created',{id:'native-question'}))).status,400);
  for(const type of ['constructor','toString','__proto__'])assert.equal((await publish(event(type,{text:'未知指令'}))).status,400);
  assert.equal((await publish(event('artifact.updated',{id:'ready-bypass',kind:'page',name:'禁止隐式就绪',buildState:'ready'}))).status,400);
  assert.equal((await publish(event('run.note',{text:'x'.repeat(20000)}))).status,413);
  await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);const snapshot=await f.snapshot(),text=JSON.stringify(snapshot);assert.equal(snapshot.run.artifacts[0].document.html,html);assert.equal(snapshot.run.artifacts[0].document.css,css);assert.ok(text.includes('https://example.test/path?q=normal'));for(const secret of ['title-secret','payload-secret','private-block-value','url-secret'])assert.ok(!text.includes(secret),secret);
});

test('WB lease expiry is unknown/disconnected, heartbeat resumes same task, failure is terminal, and TTL bounds retention',async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,workBuddyOptions:{leaseMs:100,taskTTL:1000,maxTasks:2,maxEvents:2,maxTaskBytes:50000}}),task=await f.open();
  await f.local('publish',{...f.scope(task),event:event('resource.create',{id:'unfinished',kind:'page',name:'未完成'})},task.taskToken);await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);
  now+=101;let s=await f.snapshot();assert.equal(s.binding.transport,'disconnected');assert.equal(s.run.status,'unknown');assert.match(s.run.error,/执行结果未知/);assert.match(s.run.error,/不代表/);
  assert.equal((await f.local('heartbeat',f.scope(task),task.taskToken)).status,200);s=await f.snapshot();assert.equal(s.binding.transport,'connected');assert.equal(s.run.status,'running');assert.equal(s.run.artifacts[0].buildState,'building');
  assert.equal((await f.local('finish',{...f.scope(task),requestId:uuid(),status:'failed',note:'公开失败 password=failure-secret'},task.taskToken)).status,200);s=await f.snapshot();assert.equal(s.run.status,'failed');assert.equal(s.run.artifacts[0].buildState,'building');assert.ok(!JSON.stringify(s).includes('failure-secret'));
  await f.open();assert.equal((await f.local('open',{requestId:uuid(),title:'超限',workspaceId:'x'})).status,409);
  now+=1001;assert.equal((await f.local('heartbeat',f.scope(task),task.taskToken)).status,410);assert.equal((await f.snapshot()).incomingSources.length,0);assert.equal((await f.snapshot()).binding.transport,'disconnected');
});

test('WB bounded event history rejects overflow without losing accepted events, default option stays disabled',async t=>{
  const f=await fixture(t,{workBuddyOptions:{maxEvents:1}}),task=await f.open(),first=event('run.note',{text:'保留事件'});
  assert.equal((await f.local('publish',{...f.scope(task),event:first},task.taskToken)).status,200);assert.equal((await f.local('publish',{...f.scope(task),event:event('run.note',{text:'溢出'})},task.taskToken)).status,409);assert.equal((await f.local('publish',{...f.scope(task),event:first},task.taskToken)).status,200);
  const disabled=await fixture(t,{enableWorkBuddy:false});assert.equal((await disabled.local('open',{requestId:uuid(),title:'禁用',workspaceId:'x'})).status,404);
  const main=await readFile(new URL('../../../src/cli/main.mjs',import.meta.url),'utf8');assert.match(main,/enableWorkBuddy\s*:\s*true/,'main exposes WB publishing even without an OpenCode primary');
});

test('WB retains all bounded delivery IDs for first binding and exposes receipt delivery for the MCP contract',async t=>{
  const f=await fixture(t),task=await f.open(),events=Array.from({length:35},(_,i)=>event('run.note',{text:'公开阶段'+i},'cached-'+i));
  await f.web('/v1/disconnect',{},f.token);
  for(const e of events)assert.equal((await f.local('publish',{...f.scope(task),event:e},task.taskToken)).status,200,'no webpage client is required to accept a task event');
  const cached=await(await f.local('receipt',{...f.scope(task),eventId:events[0].id},task.taskToken)).json();assert.equal(cached.data.delivery,'accepted');assert.equal(cached.data.instanceId,task.instanceId);assert.equal(cached.data.taskId,task.taskId);
  const token=await f.pairAgain();assert.equal((await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},token)).status,200);const snapshot=(await(await f.web('/v1/snapshot',null,token)).json()).data;assert.equal(snapshot.run.ui.deliveries.length,35);assert.equal(snapshot.run.status,'running');assert.equal((await f.web('/v1/ui/ack',{sessionId:task.taskId,eventId:events[0].id,status:'applied'},token)).status,200);
});

test('WB cached delivery replay exceeds the native projection rolling window without losing receipt correlation',async t=>{
  const f=await fixture(t),task=await f.open();for(let i=0;i<35;i++)assert.equal((await f.local('publish',{...f.scope(task),event:event('run.note',{text:'步骤'+i},'history-'+i)},task.taskToken)).status,200);
  await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);assert.equal((await f.snapshot()).run.ui.deliveries.length,35);
  assert.equal((await f.web('/v1/ui/ack',{sessionId:task.taskId,eventId:'history-0',status:'applied'},f.token)).status,200);const received=await(await f.local('receipt',{...f.scope(task),eventId:'history-0'},task.taskToken)).json();assert.equal(received.data.delivery,'applied');
});

test('WB byte budget and expired open idempotency reject safely without mutating the existing projection',async t=>{
  let now=1000;const f=await fixture(t,{now:()=>now,workBuddyOptions:{taskTTL:1000,maxTaskBytes:200}}),input={requestId:uuid(),title:'受限任务',workspaceId:'fixture'},task=(await(await f.local('open',input)).json()).data;
  assert.equal((await f.local('publish',{...f.scope(task),event:event('run.note',{text:'x'.repeat(150)})},task.taskToken)).status,409);
  await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);assert.equal((await f.snapshot()).run.messages.length,0);
  now+=1001;assert.equal((await f.local('open',input)).status,410);assert.equal((await f.local('open',{...input,title:'conflict'})).status,409);
});

test('WB identity fields are typed, not coerced by the legacy projection validators',async t=>{
  const f=await fixture(t),task=await f.open();
  for(const e of [event('resource.create',{id:123,kind:'page',name:'非法数字ID'}),event('artifact.updated',{id:456,kind:'page',name:'非法数字ID'}),event('plan.updated',{title:'计划',items:[{id:789,kind:'page',name:'非法数字ID'}]}),event('activity.updated',{id:123,kind:'phase',label:'非法数字ID',status:'running'}),event('activity.updated',{id:'bad',kind:'phase',label:'非法对象',status:'running',detail:{arbitrary:'no'}})])assert.equal((await f.local('publish',{...f.scope(task),event:e},task.taskToken)).status,400);
  await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);assert.equal((await f.snapshot()).run.artifacts.length,0);assert.equal((await f.snapshot()).run.plan,null);
});

test('WB known publisher/task credentials are hidden even when copied as bare public text',async t=>{const f=await fixture(t),task=await f.open(key);await f.local('publish',{...f.scope(task),event:event('run.note',{text:'公开说明 '+key+' '+task.taskToken})},task.taskToken);assert.equal((await f.local('publish',{...f.scope(task),event:event('run.note',{text:'不应使用秘密作为ID'},task.taskToken)},task.taskToken)).status,400,'敏感标识须拒绝，而非静默改写成相同占位ID');await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);const snapshot=JSON.stringify(await f.snapshot());assert.ok(!snapshot.includes(key),'不得广播已知发布密钥，即使没有key=前缀');assert.ok(!snapshot.includes(task.taskToken),'不得广播当前任务裸票据');});

test('WB finish still rejects an unfinished artifact outside the native 12-artifact preview window',async t=>{
  const f=await fixture(t),task=await f.open(),publish=e=>f.local('publish',{...f.scope(task),event:e},task.taskToken);
  for(let i=0;i<13;i++){assert.equal((await publish(event('artifact.updated',{id:'page-'+i,kind:'page',name:'页面'+i}))).status,200);if(i>0)assert.equal((await publish(event('artifact.ready',{artifactId:'page-'+i}))).status,200);}
  assert.equal((await f.local('finish',{...f.scope(task),requestId:uuid(),status:'completed'},task.taskToken)).status,409);
});

test('WB incoming metadata is pushed over the authenticated SSE stream without selecting its task',async t=>{
  const f=await fixture(t);await f.web('/v1/bind',{sessionId:'ses_native',allowControl:false},f.token);
  const controller=new AbortController();t.after(()=>controller.abort());const stream=await fetch(f.base+'/v1/events',{headers:{Origin:origin,Authorization:'Bearer '+f.token},signal:controller.signal}),reader=stream.body.getReader(),decoder=new TextDecoder();
  let pending='';const next=async()=>{for(;;){const end=pending.indexOf('\n\n');if(end>=0){const block=pending.slice(0,end);pending=pending.slice(end+2);const raw=block.split('\n').find(line=>line.startsWith('data: '));if(raw)return JSON.parse(raw.slice(6));}const chunk=await reader.read();if(chunk.done)throw Error('SSE fixture ended');pending+=decoder.decode(chunk.value,{stream:true});}};
  const initial=await next();assert.equal(initial.binding.id,'ses_native');const task=await f.open();let notified=await next();assert.equal(notified.incomingSources[0].id,task.taskId);assert.equal(notified.binding.id,'ses_native');
  await f.local('finish',{...f.scope(task),requestId:uuid(),status:'failed'},task.taskToken);notified=await next();assert.equal(notified.incomingSources[0].status,'failed');assert.equal(notified.binding.id,'ses_native');assert.ok(!JSON.stringify(notified).includes(task.taskToken));await reader.cancel();
});

test('WB late UI ack is rejected after source binding changes, without modifying the stored receipt',async t=>{
  const f=await fixture(t),task=await f.open(),e=event('panel.open',{mode:'side'});await f.local('publish',{...f.scope(task),event:e},task.taskToken);await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);
  const payload=JSON.stringify({sessionId:task.taskId,eventId:e.id,status:'applied'});let held;
  const delayed=new Promise((resolve,reject)=>{held=httpRequest(f.base+'/v1/ui/ack',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+f.token,'Content-Type':'application/json','X-Km-Agent':'1','Content-Length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});held.on('error',reject);held.write(payload.slice(0,20));});
  await f.web('/v1/bind',{sessionId:'ses_native',allowControl:false},f.token);held.end(payload.slice(20));assert.equal(await delayed,409);const receipt=await(await f.local('receipt',{...f.scope(task),eventId:e.id},task.taskToken)).json();assert.equal(receipt.data.delivery,'accepted');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {createConnector} from '../../src/http/server.mjs';
import {createNativeRegistry} from '../../src/adapters/native-registry.mjs';
import {nextSourceOrder} from '../../src/session/source-order.mjs';

const origin='http://127.0.0.1:4173',key='multi-agent-test-publisher',workspaceId='ws_authorized';
const until=async fn=>{const deadline=Date.now()+2000;while(!await fn()){if(Date.now()>deadline)throw Error('routing condition timed out');await new Promise(r=>setTimeout(r,25));}};
const event=(type,payload)=>({protocol:'km-agent/1',id:randomUUID(),type,payload});
const question=id=>({id:'frm_pending',sessionId:id,title:'确认',questions:[{key:'q',header:'选择',question:'选择？',options:[{value:'a',label:'甲'}],required:true,multiple:false,custom:false}]});
async function fixture(t,options={}){
  let offer,now=1000;const watchers=new Map(),calls=[],bindings=[];
  const adapter={descriptor:{id:'opencode',status:'native'},health:async()=>({ready:true}),listSessions:async()=>[{id:'ses_seed',title:'原生'}],
    bindSession:async id=>{calls.push(['bind',id]);if(!id.startsWith('ses_')||id==='ses_foreign')throw Error('workspace mismatch');return{id,title:id};},readShared:async()=>({status:'running',messages:[],questions:[]}),
    watch:(id,emit)=>{watchers.set(id,emit);return{ready:Promise.resolve(),close(){calls.push(['close',id]);watchers.delete(id);}};},
    watchRelevantSessions:fn=>{offer=fn;return{ready:Promise.resolve(),close(){calls.push(['discovery-close']);}};},
    sendShared:async()=>{calls.push(['send']);return{id:'msg_sent'};},interruptShared:async()=>{calls.push(['interrupt']);return{interrupted:true};},
    listQuestions:async()=>[],replyQuestion:async()=>{},rejectQuestion:async()=>{}};
  if(options.noNative){delete adapter.watchRelevantSessions;delete adapter.bindSession;delete adapter.watch;delete adapter.readShared;}
  const bridge=createConnector({adapter,allowedOrigins:[origin],publisherKey:key,enableWorkBuddy:true,enableMultiAgentFollow:true,workBuddyOptions:{workspaceId},autoTrust:{origin,sessionId:'ses_seed',allowControl:true},onBindings:value=>bindings.push(value),now:()=>now,...options});
  bridge.server.listen(0,'127.0.0.1');await once(bridge.server,'listening');t.after(()=>bridge.close());
  const base=`http://127.0.0.1:${bridge.server.address().port}`;
  const web=async(path,body,token)=>{const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Origin:origin,'X-Km-Agent':'1','Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return{status:r.status,...await r.json()};};
  const local=async(action,body,token)=>{const r=await fetch(base+'/v1/local/workbuddy/tasks/'+action,{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json',...(action==='open'?{'X-Km-Publisher':key}:{'X-Km-Task-Token':token})},body:JSON.stringify(body)});return{status:r.status,...await r.json()};};
  const handshake=()=>web('/v1/handshake',{}),connected=await handshake();assert.equal(connected.status,200);const token=connected.data.token;
  const read=async()=>(await web('/v1/snapshot',null,token)).data;
  const open=async(title='WB新任务')=>{const r=await local('open',{requestId:randomUUID(),title,workspaceId});assert.equal(r.status,200);return r.data;};
  const nativePublish=async(id,e)=>{const r=await fetch(base+'/v1/local/publish',{method:'POST',headers:{'X-Km-Agent':'1','Content-Type':'application/json','X-Km-Publisher':key},body:JSON.stringify({sessionId:id,event:e})});return{status:r.status,...await r.json()};};
  return{adapter,bridge,base,web,local,token,read,open,calls,bindings,watchers,handshake,nativePublish,offer:c=>offer(c),advance:ms=>{now+=ms;},expire:()=>{now+=9*3600e3;},emit:(id,type,data={})=>watchers.get(id)?.({id:randomUUID(),type,data:{sessionID:id,...data}}),scope:t=>({instanceId:t.instanceId,taskId:t.taskId})};
}

test('manual page selection stays unbound when native sessions or MCP tasks appear', async t => {
  const f = await fixture(t, { projectIndependentSessions: true, autoTrust: { origin } });
  await f.open();
  await f.offer({ id: 'ses_other', provider: 'opencode', title: '另一条会话' });
  const snapshot = await f.read();
  assert.equal(snapshot.binding, null);
  assert.equal(snapshot.routing.mode, 'pinned');
  assert.deepEqual(f.calls.filter(([action]) => action === 'bind'), []);
});

for (const provider of ['codex', 'qwen']) test(provider + ' creates once for concurrent confirmations and rejects replay for another Agent', async t => {
  const creations = [], sends = [];
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  function native(id) {
    const session = { id: 'ses_' + id + '_' + 'a'.repeat(32), provider: id, title: '网页协作' };
    return {
      descriptor: { id, status: 'native' }, health: async () => ({ ready: true }), listSessions: async () => [],
      async createSharedSession(_parent, { assertCurrent }) {
        assertCurrent(); creations.push(id); started(); await pending; return session;
      },
      bindSession: async sessionId => { assert.equal(sessionId, session.id); return session; },
      watch: () => ({ ready: Promise.resolve(), close() {} }),
      readShared: async () => ({ status: 'completed', messages: [] }), sendShared: async () => { sends.push(id); },
    };
  }
  const adapter = createNativeRegistry({ primary: native('codex'), additional: [native('qwen')] });
  const f = await fixture(t, { adapter, autoTrust: { origin }, projectIndependentSessions: true });
  const base = { provider, instanceId: (await f.read()).instanceId, requestId: randomUUID(), allowControl: true };
  const create = patch => f.web('/v1/session/new', { ...base, ...patch }, f.token);
  assert.equal((await create({ allowControl: false })).status, 409);
  assert.equal((await create({ instanceId: 'obsolete' })).status, 409);
  assert.deepEqual(creations, []);
  const first = create({});
  await entered;
  const second = create({});
  try {
    assert.equal((await create({ requestId: randomUUID() })).status, 409);
    assert.equal((await create({ provider: provider === 'codex' ? 'qwen' : 'codex' })).status, 409);
  } finally { release(); }
  const [a, b, replay] = await Promise.all([first, second, create({})]);
  for (const result of [a, b, replay]) {
    assert.equal(result.status, 200);
    assert.equal(result.data.createdSessionId, a.data.binding.id);
    assert.equal(result.data.binding.canControl, true);
  }
  assert.deepEqual(creations, [provider]); assert.deepEqual(sends, []);
});

test('新建独立会话不受原绑定会话仍在运行或待核验状态阻塞', async t => {
  let seq = 0;
  const codex = {
    descriptor: { id: 'codex', status: 'native' },
    capabilities: { send: true, newSession: true, submitPrompt: true },
    health: async () => ({ ready: true }),
    listSessions: async () => [{ id: 'ses_codex_' + '1'.repeat(32), title: 'running-old' }],
    createSharedSession: async () => ({ id: 'ses_codex_' + String(++seq + 1).repeat(32).slice(0, 32), title: 'new-session' }),
    bindSession: async id => ({ id, title: id, provider: 'codex' }),
    readShared: async id => ({ status: id.endsWith('1') ? 'running' : 'idle', messages: [] }),
    watch: () => ({ ready: Promise.resolve(), close() {} }),
    sendShared: async () => ({ id: 'msg' }),
  };
  const adapter = createNativeRegistry({ primary: codex });
  const f = await fixture(t, { adapter, autoTrust: { origin }, projectIndependentSessions: true });
  const oldId = 'ses_codex_' + '1'.repeat(32);
  assert.equal((await f.web('/v1/bind', { sessionId: oldId, allowControl: true }, f.token)).status, 200);
  assert.equal((await f.read()).run.status, 'running');
  const created = await f.web('/v1/session/new', {
    provider: 'codex',
    instanceId: (await f.read()).instanceId,
    requestId: randomUUID(),
    allowControl: true,
  }, f.token);
  assert.equal(created.status, 200);
  assert.notEqual(created.data.createdSessionId, oldId);
  assert.equal(created.data.binding.id, created.data.createdSessionId);
});

test('WorkBuddy distinguishes joining login, recovering a specific attempt and legacy clients', async t => {
  const options = [], attemptId = randomUUID();
  const manager = {
    status: () => ({ phase: 'authenticating', loginAttemptId: attemptId }),
    authenticate(allowed, value) { allowed(); options.push(value); },
  };
  const f = await fixture(t, { workBuddyServeManager: manager, projectIndependentSessions: true, autoTrust: { origin } });
  const base = { provider: 'workbuddy', instanceId: (await f.read()).instanceId };
  const send = body => f.web('/v1/session/new', { ...base, ...body }, f.token);
  assert.equal((await send({ operation: 'ensureLogin' })).status, 202);
  assert.equal((await send({ operation: 'reopenLogin', requestId: attemptId })).status, 202);
  assert.equal((await send({ operation: 'authenticate' })).status, 202);
  assert.deepEqual(options, [{ reopen: false, attemptId: undefined }, { reopen: true, attemptId }, { reopen: true, attemptId: undefined }]);
  assert.equal((await send({ operation: 'reopenLogin' })).status, 400);
  assert.equal((await send({ operation: 'ensureLogin', requestId: attemptId })).status, 400);
});

test('WorkBuddy CLI preparation and login leave the page unbound, and creation can retry after login', async t => {
  let phase = 'idle', loginAttempts = 0, creations = 0;
  const manager = {
    status: () => ({ phase }),
    ensure({ assertAllowed }) { assertAllowed(); phase = 'ready'; return { phase }; },
    authenticate(assertAllowed) { assertAllowed(); loginAttempts++; phase = 'authenticating'; },
    async createAndBind(bind) {
      if (!creations++) throw Object.assign(Error('login required'), { code: 'WORKBUDDY_AUTH_REQUIRED' });
      const session = { id: 'ses_cli_test' };
      await bind(session);
      return session;
    },
  };
  const f = await fixture(t, { workBuddyServeManager: manager, projectIndependentSessions: true, autoTrust: { origin } });
  const base = { provider: 'workbuddy', instanceId: (await f.read()).instanceId };
  const command = body => f.web('/v1/session/new', body, f.token);
  assert.equal((await command(base)).status, 202);
  assert.equal((await command({ ...base, operation: 'authenticate', instanceId: 'stale' })).status, 409);
  assert.equal((await command({ ...base, operation: 'authenticate' })).data.phase, 'authenticating');
  assert.equal((await f.read()).binding, null);
  phase = 'ready';
  const create = { ...base, requestId: randomUUID(), allowControl: false };
  assert.equal((await command(create)).status, 428);
  assert.equal(loginAttempts, 2);
  phase = 'ready';
  const result = await command(create);
  assert.equal(result.status, 200);
  assert.equal(result.data.createdSessionId, result.data.binding.id);
  assert.equal(result.data.binding.canControl, false);
  assert.equal((await command(create)).data.createdSessionId, result.data.createdSessionId);
  assert.equal(creations, 2);
  assert.equal((await command({ ...create, allowControl: true })).status, 409);
});

test('new WB task automatically selects during native running; old publisher survives and SSE contains only selected projection',async t=>{
  const f=await fixture(t),abort=new AbortController();t.after(()=>abort.abort());
  const stream=await fetch(f.base+'/v1/events',{headers:{Origin:origin,Authorization:'Bearer '+f.token},signal:abort.signal}),reader=stream.body.getReader(),decoder=new TextDecoder();let buffer='';
  const next=async()=>{for(;;){const end=buffer.indexOf('\n\n');if(end>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=block.split('\n').find(x=>x.startsWith('data: '));if(line)return JSON.parse(line.slice(6));}const chunk=await reader.read();if(chunk.done)throw Error('ended');buffer+=decoder.decode(chunk.value,{stream:true});}};
  await next();const task=await f.open();await until(async()=>(await f.read()).sessionId===task.taskId);
  const published=await f.nativePublish('ses_seed',event('run.note',{text:'BACKGROUND_NATIVE_CONTENT'}));assert.equal(published.status,200);assert.equal(published.data.accepted,true);
  const s=await f.read();assert.equal(s.binding.canControl,false);assert.equal(s.routing.mode,'follow');assert.equal(s.routing.lastSwitch.provider,'workbuddy');assert.equal(s.routing.lastSwitch.reason,'task-open');assert.equal(s.capabilities.multiAgentFollow,true);assert.doesNotMatch(JSON.stringify(s),/BACKGROUND_NATIVE_CONTENT/);assert.ok(f.watchers.has('ses_seed'));assert.ok(f.bindings.at(-1).some(x=>x.id==='ses_seed'));assert.equal(f.calls.filter(x=>['send','interrupt'].includes(x[0])).length,0);
  let selected;do{selected=await next();}while(selected.sessionId!==task.taskId);assert.doesNotMatch(JSON.stringify(selected),/BACKGROUND_NATIVE_CONTENT/);await reader.cancel();
  await f.web('/v1/bind',{sessionId:'ses_seed',allowControl:false},f.token);assert.match(JSON.stringify((await f.read()).run),/BACKGROUND_NATIVE_CONTENT/);
});

test('pin blocks new opens, follow resumes latest candidate, heartbeat/publish/idempotent open never switch back',async t=>{
  const f=await fixture(t);await f.web('/v1/bind',{sessionId:'ses_seed',allowControl:true},f.token);
  const a=await f.open('older'),b=await f.open('latest');assert.equal((await f.read()).sessionId,'ses_seed');
  const pending=(await f.read()).routing.pending;assert.equal(pending.at(-1)?.provider,'workbuddy');assert.equal(pending.at(-1)?.reason,'task-open');
  await f.web('/v1/follow',{enabled:true},f.token);await until(async()=>(await f.read()).sessionId===b.taskId);
  await f.local('heartbeat',f.scope(a),a.taskToken);await f.local('publish',{...f.scope(a),event:event('run.note',{text:'old incremental'})},a.taskToken);assert.equal((await f.read()).sessionId,b.taskId);
  const c=await f.open();await until(async()=>(await f.read()).sessionId===c.taskId);assert.equal((await f.web('/v1/follow',{enabled:true},f.token)).status,200,'follow is available while WB is selected');
  assert.equal((await f.web('/v1/run',{requestId:randomUUID(),text:'never send'},f.token)).status,403);
});

test('pending native Questions hold latest candidate until settled, without waiting for execution idle',async t=>{
  const f=await fixture(t);f.emit('ses_seed','form.created',{question:question('ses_seed')});await until(async()=>(await f.read()).run.questions.length===1);
  const task=await f.open();assert.equal((await f.read()).sessionId,'ses_seed');assert.equal((await f.read()).routing.pending[0]?.provider,'workbuddy');
  f.emit('ses_seed','form.cancelled',{id:'frm_pending'});await until(async()=>(await f.read()).sessionId===task.taskId);
});

test('submission in flight holds automatic selection and drains on completion',async t=>{
  const f=await fixture(t);let release,entered=false;f.adapter.sendShared=async()=>{entered=true;await new Promise(r=>{release=r;});return{id:'msg_held'};};
  const submit=f.web('/v1/run',{requestId:randomUUID(),text:'fixture only',sessionId:'ses_seed'},f.token);await until(()=>entered);const task=await f.open();assert.equal((await f.read()).sessionId,'ses_seed');release();assert.equal((await submit).status,202);await until(async()=>(await f.read()).sessionId===task.taskId);
});

test('latest candidate wins across native/WB offers while initialization is pending, no transient stale selection',async t=>{
  const f=await fixture(t);let release,entered=false;f.adapter.readShared=async id=>{if(id==='ses_slow'){entered=true;await new Promise(r=>{release=r;});}return{status:'running',messages:[]};};
  f.offer({id:'ses_slow',reason:'prompt',title:'slow'});await until(()=>entered);const task=await f.open();release();await until(async()=>(await f.read()).sessionId===task.taskId);assert.equal(f.watchers.has('ses_slow'),false);assert.equal((await f.read()).routing.pending.length,0);
});

test('origin-only handshake performs no native binding and follows real WB without native discovery support',async t=>{
  const f=await fixture(t,{autoTrust:{origin},noNative:true});const first=await f.read();assert.equal(first.binding,null);assert.equal(first.sessionId,null);assert.equal(first.routing.mode,'follow');assert.deepEqual(f.calls,[]);
  const task=await f.open();await until(async()=>(await f.read()).sessionId===task.taskId);assert.deepEqual(f.calls,[]);assert.equal((await f.read()).binding.source.nativeSession,false);
});

test('first handshake seeds only latest real WB cache, explicit pin remains empty and workspace mismatch is rejected',async t=>{
  const f=await fixture(t,{autoTrust:{origin}});await f.web('/v1/disconnect',{},f.token);await f.open('old cache');const newest=await f.open('latest cache');
  const reconnected=await f.handshake();assert.equal(reconnected.data.snapshot.sessionId,newest.taskId);assert.equal(reconnected.data.snapshot.binding.provider,'workbuddy');assert.deepEqual(f.calls.filter(x=>x[0]==='bind'),[]);
  assert.equal((await f.local('open',{requestId:randomUUID(),title:'foreign',workspaceId:'unknown_workspace'})).status,403);
  const pinned=await fixture(t,{autoTrust:{origin,followSessions:false}});await pinned.open();assert.equal((await pinned.handshake()).data.snapshot.binding,null);
});

test('bounded subscriptions never evict busy native sources; completion frees oldest and disconnect releases all',async t=>{
  const f=await fixture(t);for(let i=1;i<8;i++){f.offer({id:'ses_busy'+i,reason:'prompt'});await until(async()=>(await f.read()).sessionId==='ses_busy'+i);}
  assert.equal(f.watchers.size,8);const task=await f.open();assert.equal((await f.read()).sessionId,'ses_busy7');assert.ok((await f.read()).routing.pending.some(x=>x.id===task.taskId));assert.equal(f.watchers.size,8);
  f.emit('ses_seed','session.execution.succeeded');await until(async()=>(await f.read()).sessionId===task.taskId);assert.equal(f.watchers.has('ses_seed'),false);assert.equal(f.watchers.size,7);assert.equal(f.calls.filter(x=>x[0]==='interrupt').length,0);
  await f.web('/v1/disconnect',{},f.token);await until(()=>f.watchers.size===0);
});

test('lease expiry releases all retained subscriptions and late candidate initialization cannot attach',async t=>{
  const f=await fixture(t);f.offer({id:'ses_second',reason:'command'});await until(async()=>(await f.read()).sessionId==='ses_second');let release,entered=false;
  f.adapter.readShared=async id=>{if(id==='ses_late'){entered=true;await new Promise(r=>{release=r;});}return{status:'running',messages:[]};};f.offer({id:'ses_late',reason:'prompt'});await until(()=>entered);f.expire();await f.web('/v1/health');release();await until(()=>f.watchers.size===0);
});

test('late ack from retained native source is rejected after selection changed',async t=>{
  const f=await fixture(t),e=event('panel.open',{mode:'side'});await f.nativePublish('ses_seed',e);
  const payload=JSON.stringify({sessionId:'ses_seed',eventId:e.id,status:'applied'});let held;
  const response=new Promise((resolve,reject)=>{held=httpRequest(f.base+'/v1/ui/ack',{method:'POST',headers:{Origin:origin,Authorization:'Bearer '+f.token,'Content-Type':'application/json','X-Km-Agent':'1','Content-Length':Buffer.byteLength(payload)}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});held.on('error',reject);held.write(payload.slice(0,15));});
  const task=await f.open();await until(async()=>(await f.read()).sessionId===task.taskId);held.end(payload.slice(15));assert.equal(await response,409);
});

test('native-only sources endpoint remains object-shaped and advertises real provider metadata; sessions remains array',async t=>{
  const f=await fixture(t,{enableWorkBuddy:false}),listed=await f.web('/v1/sources',null,f.token);assert.equal(listed.status,200);assert.equal(listed.data.sources[0].provider,'opencode');assert.equal(listed.data.sessions[0].title,'原生');assert.equal(typeof listed.data.sessions[0].status,'string');assert.equal(listed.data.sessions[0].capabilities.multiAgentFollow,true);assert.ok(Array.isArray((await f.web('/v1/sessions',null,f.token)).data));
});

test('retained binding metadata distinguishes subscription from current selection and tracks background status without content',async t=>{
  const f=await fixture(t),task=await f.open();await until(async()=>(await f.read()).sessionId===task.taskId);const native=f.bindings.at(-1).find(x=>x.id==='ses_seed');assert.equal(native.subscribed,true);assert.equal(native.selected,false);assert.equal(f.bindings.at(-1).find(x=>x.id===task.taskId).selected,true);
  f.emit('ses_seed','session.execution.succeeded');await until(async()=>(await f.read()).subscriptions.find(x=>x.id==='ses_seed').status==='completed');
});

test('idempotent old open is not a new candidate and native follow after WB remains observation-only',async t=>{
  const f=await fixture(t),input={requestId:randomUUID(),title:'old open',workspaceId},old=(await f.local('open',input)).data,newest=await f.open();await until(async()=>(await f.read()).sessionId===newest.taskId);
  assert.equal((await f.local('open',input)).data.taskId,old.taskId);assert.equal((await f.read()).sessionId,newest.taskId);
  f.offer({id:'ses_seed',reason:'command'});await until(async()=>(await f.read()).sessionId==='ses_seed');assert.equal((await f.read()).binding.canControl,false);assert.equal((await f.read()).routing.lastSwitch.provider,'opencode');assert.equal((await f.web('/v1/run',{requestId:randomUUID(),text:'do not submit'},f.token)).status,403);
});

test('cross-workspace native candidate is rejected while old observation remains usable',async t=>{
  const f=await fixture(t);f.offer({id:'ses_foreign',title:'foreign',reason:'prompt'});await until(async()=>Boolean((await f.read()).routing.error));assert.equal((await f.read()).sessionId,'ses_seed');assert.ok(f.watchers.has('ses_seed'));assert.equal(f.watchers.has('ses_foreign'),false);
});

test('answer in flight holds even when native clears question early; explicit switch still rejects late answer',async t=>{
  const f=await fixture(t);f.emit('ses_seed','form.created',{question:question('ses_seed')});await until(async()=>(await f.read()).run.questions.length===1);let release,entered=false;
  f.adapter.replyQuestion=async()=>{entered=true;await new Promise(r=>{release=r;});};
  const reply=f.web('/v1/question/reply',{instanceId:f.bridge.instanceId,sessionId:'ses_seed',questionId:'frm_pending',answers:[['a']]},f.token);await until(()=>entered);f.emit('ses_seed','form.replied',{id:'frm_pending'});const task=await f.open();assert.equal((await f.read()).sessionId,'ses_seed');await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);release();assert.equal((await reply).status,409);assert.equal((await f.read()).sessionId,task.taskId);
});

test('binding during new-session creation holds candidates until completion without interrupting or replaying',async t=>{
  const f=await fixture(t);let release,entered=false;f.adapter.createSharedSession=async()=>{entered=true;await new Promise(r=>{release=r;});return{id:'ses_created'};};
  const creation=f.web('/v1/session/new',{sessionId:'ses_seed',requestId:randomUUID()},f.token);await until(()=>entered);assert.equal((await f.web('/v1/follow',{enabled:true},f.token)).status,200);const task=await f.open();assert.equal((await f.read()).sessionId,'ses_seed');release();assert.equal((await creation).status,200);await until(async()=>(await f.read()).sessionId===task.taskId);assert.equal(f.calls.filter(x=>['send','interrupt'].includes(x[0])).length,0);
});

test('late native submit acknowledgement cannot confirm a different manually selected source',async t=>{
  const f=await fixture(t);let release,entered=false;f.adapter.sendShared=async()=>{entered=true;await new Promise(r=>{release=r;});return{id:'msg_old_source'};};const submitted=f.web('/v1/run',{requestId:randomUUID(),text:'fixture only',sessionId:'ses_seed'},f.token);await until(()=>entered);const task=await f.open();await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);release();assert.equal((await submitted).status,409);assert.equal((await f.read()).sessionId,task.taskId);assert.doesNotMatch(JSON.stringify((await f.read()).run),/fixture only/);
});

test('a newest native task on the currently viewed source cancels an older in-flight selection',async t=>{
  const f=await fixture(t);let entered=false,release;f.adapter.readShared=async id=>{if(id==='ses_slow'){entered=true;await new Promise(r=>{release=r;});}return{status:'running',messages:[]};};f.offer({id:'ses_slow',reason:'prompt'});await until(()=>entered);f.offer({id:'ses_seed',reason:'prompt'});release();await until(async()=>!(await f.read()).routing.switching);assert.equal((await f.read()).sessionId,'ses_seed');assert.equal(f.watchers.has('ses_slow'),false);
});

test('pin during slow terminal-source eviction never leaves the selected source detached',async t=>{
  const f=await fixture(t);for(let i=1;i<8;i++){f.offer({id:'ses_full'+i,reason:'prompt'});await until(async()=>(await f.read()).sessionId==='ses_full'+i);}
  f.emit('ses_full7','session.execution.succeeded');let release,entered=false;f.adapter.removeBridge=async id=>{if(id==='ses_full7'){entered=true;await new Promise(r=>{release=r;});}};
  const task=await f.open();await until(()=>entered);await f.web('/v1/follow',{enabled:false},f.token);release();await until(async()=>!(await f.read()).routing.switching);const s=await f.read();assert.equal(s.routing.mode,'pinned');assert.ok(s.sessionId===task.taskId||f.watchers.has(s.sessionId),'selection must refer to a live authorized subscription');
});

test('subscription cap never evicts a terminal-looking source whose native submission is still in flight',async t=>{
  const f=await fixture(t);f.emit('ses_seed','session.execution.succeeded');let release,entered=false;f.adapter.sendShared=async()=>{entered=true;await new Promise(r=>{release=r;});return{id:'msg_inflight'};};
  const submission=f.web('/v1/run',{requestId:randomUUID(),text:'fixture only',sessionId:'ses_seed'},f.token);await until(()=>entered);
  for(let i=1;i<8;i++)assert.equal((await f.web('/v1/bind',{sessionId:'ses_full'+i,allowControl:false},f.token)).status,200);
  const task=await f.open(),attempt=await f.web('/v1/bind',{sessionId:task.taskId,allowControl:false},f.token);release();await submission;assert.equal(attempt.status,409);assert.ok(f.watchers.has('ses_seed'));
});

test('empty observer handshake does not call the unavailable primary adapter',async t=>{
  let nativeCalls=0;await fixture(t,{autoTrust:{origin},adapter:{descriptor:{id:'generic',status:'publish-only'},health:async()=>{nativeCalls++;throw Error('not available');}}});assert.equal(nativeCalls,0);
  assert.throws(()=>createConnector({adapter:{health:async()=>({ready:true})},autoTrust:{origin,allowControl:true}}),/控制|会话/);
});

test('background native status updates push metadata over SSE without publishing its full timeline',async t=>{
  const f=await fixture(t),task=await f.open();await until(async()=>(await f.read()).sessionId===task.taskId);const abort=new AbortController();t.after(()=>abort.abort());
  const response=await fetch(f.base+'/v1/events',{headers:{Origin:origin,Authorization:'Bearer '+f.token},signal:abort.signal}),reader=response.body.getReader();await reader.read();
  f.emit('ses_seed','session.execution.succeeded');const chunk=await Promise.race([reader.read(),new Promise(resolve=>setTimeout(()=>resolve(null),500))]);assert.ok(chunk,'background metadata must notify observers');assert.match(Buffer.from(chunk.value).toString(),/"status":"completed"/);await reader.cancel();
});

test('expired WB candidates cannot masquerade as native sessions on follow resume',async t=>{
  const f=await fixture(t,{workBuddyOptions:{workspaceId,taskTTL:100,leaseMs:50}});await f.web('/v1/follow',{enabled:false},f.token);const task=await f.open();f.advance(101);await f.read();await f.web('/v1/follow',{enabled:true},f.token);await until(async()=>!(await f.read()).routing.switching);
  assert.equal((await f.read()).sessionId,'ses_seed');assert.equal(f.calls.some(([kind,id])=>kind==='bind'&&id===task.taskId),false,'WB task IDs must never be sent to native bind');
});

test('isolated demo remains a hold, and stopping it drains the real task without replay',async t=>{
  const f=await fixture(t);await f.web('/v1/unbind',{},f.token);await f.web('/v1/follow',{enabled:true},f.token);assert.equal((await f.web('/v1/demo',{requestId:randomUUID()},f.token)).status,202);const task=await f.open();assert.equal((await f.read()).binding,null);assert.equal((await f.read()).routing.holdReason,'isolated-running');await f.web('/v1/stop',{},f.token);await until(async()=>(await f.read()).sessionId===task.taskId);
});

test('disconnect releases every retained watcher even while one instruction cleanup is slow',async t=>{
  const f=await fixture(t);f.offer({id:'ses_second',reason:'prompt'});await until(async()=>(await f.read()).sessionId==='ses_second');let entered=false,release;
  f.adapter.removeBridge=async id=>{if(id==='ses_second'){entered=true;await new Promise(r=>{release=r;});}};await f.web('/v1/disconnect',{},f.token);await until(()=>entered);const remaining=f.watchers.size,advertised=f.bindings.at(-1).length;release();await until(()=>f.watchers.size===0);assert.equal(remaining,0,'slow cleanup must not retain other authorized subscriptions');assert.equal(advertised,0,'revoked bindings must stop being advertised immediately');
});
test('较早发现的原生会话不能抢回较新的 WorkBuddy 任务', async t => {
  const f = await fixture(t);
  const observedOrder = nextSourceOrder();
  const newer = await f.open('更新的 WorkBuddy 任务');
  await until(async () => (await f.read()).sessionId === newer.taskId);
  await f.offer({ id: 'ses_older', reason: 'prompt', observedOrder });
  const snapshot = await f.read();
  assert.equal(snapshot.sessionId, newer.taskId);
  assert.equal(snapshot.binding.canControl, false);
});
test('旧WB请求body迟到时，在线选择与首次握手缓存seed都按观测顺序而非插入顺序',async t=>{const f=await fixture(t),body=JSON.stringify({requestId:randomUUID(),title:'较早但body迟到的任务A',workspaceId});let held;const response=new Promise((resolve,reject)=>{held=httpRequest(f.base+'/v1/local/workbuddy/tasks/open',{method:'POST',headers:{'X-Km-Agent':'1','X-Km-Publisher':key,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body),Expect:'100-continue'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve(JSON.parse(text)));});held.on('error',reject);});held.flushHeaders();await once(held,'continue');held.write(body.slice(0,20));const b=await f.open('较新的完整任务B');held.end(body.slice(20));assert.equal((await response).ok,true);assert.equal((await f.read()).sessionId,b.taskId);assert.equal((await f.read()).incomingSources[0].id,b.taskId,'缓存首项不能按body完成后的插入顺序');const newClient=await f.handshake();assert.equal(newClient.data.snapshot.sessionId,b.taskId);});

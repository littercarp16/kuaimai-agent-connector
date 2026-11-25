import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, symlink,writeFile } from 'node:fs/promises';
import{fileURLToPath}from'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fixture, event, INSTANCE, ORIGIN, PUBLISHER, TOKEN } from '../../fixtures/workbuddy-client-fixture.mjs';

async function client(t, f, options = {}) {
  const module = await import('../../../src/adapters/workbuddy/workbuddy-client.mjs');
  assert.equal(typeof module.createWorkBuddyClient, 'function', 'client factory exists');
  const value = await module.createWorkBuddyClient({ connectionFile: f.connectionFile, ...options });
  t.after(() => value.close());
  return value;
}

test('process-local open is concurrent-idempotent and exposes only public data', async t => {
  const f = await fixture(t), c = await client(t, f);
  const [a, b] = await Promise.all([c.open({ taskKey: 'report', title: '销售分析' }), c.open({ taskKey: 'report', title: '销售分析' })]);
  assert.deepEqual(a, b);
  assert.equal(a.taskId, 'task-1');
  assert.equal(a.provider, 'workbuddy');
  assert.equal(f.state.openCount, 1);
  assert.doesNotMatch(JSON.stringify(a), /secret|taskToken|publisherKey/);
  const request = f.requests.find(r => r.url.endsWith('/open'));
  assert.match(request.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(request.body.workspaceId, 'ws_' + createHash('sha256').update(f.root).digest('hex'));
  assert.deepEqual(Object.keys(request.body).sort(), ['requestId', 'title', 'workspaceId']);
  await assert.rejects(c.open({ taskKey: 'report', title: '另一个标题' }), /TASK_KEY_CONFLICT/);
  assert.equal(f.requests[0].url, '/v1/health');
  assert.equal(f.requests[0].headers.origin, ORIGIN);
  assert.equal(f.requests[0].headers['x-km-publisher'], undefined);
  assert.equal(request.headers.origin, undefined);
  assert.equal(request.headers['x-km-agent'], '1');
  assert.equal(request.headers['x-km-publisher'], PUBLISHER);
  const c2 = await client(t, f);
  await assert.rejects(c2.receipt({ taskId: a.taskId, eventId: 'evt-1' }), /UNKNOWN_TASK/);
  await c2.open({ taskKey: 'report', title: '销售分析' });
  assert.equal(f.state.openCount, 2, 'restart creates a new request, never adopts old ticket');
});

test('publish/receipt/finish use task tokens, reject foreign tasks and never return backend secrets', async t => {
  const f = await fixture(t), c = await client(t, f), task = await c.open({ taskKey: 'a', title: '正常任务' });
  const published = await c.publish({ taskId: task.taskId, event: event() });
  assert.equal(published.accepted, true);
  assert.equal(published.delivery, 'accepted');
  const received = await c.receipt({ taskId: task.taskId, eventId: 'evt-1' });
  assert.equal(received.delivery, 'applied');
  for (const request of f.requests.filter(r => /\/(publish|receipt)$/.test(r.url))) {
    assert.equal(request.headers['x-km-task-token'], TOKEN + '-1');
    assert.equal(request.headers['x-km-publisher'], undefined);
    assert.equal(request.headers.origin, undefined);
    assert.equal(request.body.instanceId, INSTANCE);
  }
  const count = f.requests.length;
  await assert.rejects(c.publish({ taskId: 'task-foreign', event: event() }), /UNKNOWN_TASK/);
  assert.equal(f.requests.length, count);
  const finished = await c.finish({ taskId: task.taskId, status: 'completed', note: '已生成本地预览' });
  assert.equal(finished.status, 'completed');
  assert.doesNotMatch(JSON.stringify([task, published, received, finished]), /secret|taskToken|publisherKey/);
  await assert.rejects(c.publish({ taskId: task.taskId, event: event('evt-2') }), /TASK_FINISHED/);
});

test('open accepts a server-filtered public title but never reflects publisher/task secrets', async t => {
  const f = await fixture(t), c = await client(t, f);
  f.state.handler = ({ req, reply }) => {
    if (!req.url.endsWith('/open')) return false;
    reply({ instanceId: INSTANCE, taskId: 'task-1', title: '公开标题 [已过滤]', taskToken: TOKEN + '-1', status: 'running' }); return true;
  };
  const task = await c.open({ taskKey: 'filtered', title: '公开标题 ' + PUBLISHER });
  assert.equal(task.title, '公开标题 [已过滤]');
  assert.doesNotMatch(JSON.stringify(task), /secret/);
});

test('strict command schemas reject privileged activity and accept normal HTML/CSS', async t => {
  const f = await fixture(t), c = await client(t, f), task = await c.open({ taskKey: 'a', title: '任务' });
  for (const kind of ['tool', 'thinking', 'permission', 'skill']) {
    await assert.rejects(c.publish({ taskId: task.taskId, event: { ...event(), type: 'activity.updated', payload: { id: 'a', kind, label: '隐藏', status: 'running' } } }), /INVALID_INPUT/);
  }
  for (const invalid of [{ ...event(), native: true }, { ...event(), type: 'question.reply' }, { ...event(), payload: { text: 'hello', privateReasoning: 'no' } }, { ...event(), payload: { text: 42 } }]) {
    await assert.rejects(c.publish({ taskId: task.taskId, event: invalid }), /INVALID_INPUT/);
  }
  await c.publish({ taskId: task.taskId, event: { ...event('html'), type: 'artifact.updated', payload: { id: 'page', kind: 'page', name: '页面', document: { html: '<h1>普通页面</h1>', css: 'h1{color:red}' } } } });
  const sent = f.requests.find(r => r.body?.event?.id === 'html');
  assert.equal(sent.body.event.payload.document.html, '<h1>普通页面</h1>');
  assert.equal(c.protocol().commands.length, 15);
  await assert.rejects(c.publish({ taskId: task.taskId, event: event('x'.repeat(150)) }), /INVALID_INPUT/);
  await assert.rejects(c.publish({ taskId: task.taskId, event: { ...event('large'), payload: { text: 'a'.repeat(20000) } } }), /EVENT_TOO_LARGE|INVALID_INPUT/);
});

test('UI schemas match canonical preview metrics/hints and optional chart type; unsupported shapes are rejected', async t => {
  const f = await fixture(t), c = await client(t, f), task = await c.open({ taskKey: 'ui', title: '预览' });
  const preview = { ...event('preview'), type: 'artifact.updated', payload: { id: 'page', kind: 'page', name: '销售概览', metrics: [{ label: '销售额', value: '120.00', hint: '模拟数据' }], chart: { labels: ['一月'], values: [120] }, sections: [{ title: '说明', text: '普通正文' }] } };
  await c.publish({ taskId: task.taskId, event: preview });
  for (const payload of [
    { ...preview.payload, buildState: 'failed' },
    { ...preview.payload, metrics: [{ label: '额外', value: '1', nativeTool: true }] },
    { ...preview.payload, chart: { labels: ['一月'], values: [-1] } },
    { id: 'table', kind: 'table', name: '列数不匹配', columns: ['一'], rows: [['a', 'b']] },
    { id: 'table', kind: 'table', name: '未知列结构', columns: [{ key: 'a', label: 'A' }], rows: [] },
    { id: 'task', kind: 'task', name: '任务', document: { html: '<h1>不能展示为页面</h1>' } }
  ]) await assert.rejects(c.publish({ taskId: task.taskId, event: { ...preview, payload } }), /INVALID_INPUT/);
});

test('runtime file and every ancestor enforce symlink/permission protection', async t => {
  const f = await fixture(t);
  await chmod(f.runtimeDir, 0o755);
  await assert.rejects(client(t, f), /UNSAFE_RUNTIME/);
  await chmod(f.runtimeDir, 0o700);
  await chmod(f.runtimeFile, 0o644);
  await assert.rejects(client(t, f), /UNSAFE_RUNTIME/);
  await chmod(f.runtimeFile, 0o600);
  const alias = join(f.root, 'alias');
  await symlink(f.runtimeDir, alias);
  await f.saveConnection({ ...f.connection, runtimeFile: join(alias, 'runtime.json') });
  await assert.rejects(client(t, f), /UNSAFE_PATH/);
  const workspace = join(f.root, 'workspace');
  await mkdir(workspace);
  await symlink(workspace, join(f.root, 'workspace-link'));
  await f.saveConnection({ ...f.connection, workspaceRoot: join(f.root, 'workspace-link') });
  await assert.rejects(client(t, f), /UNSAFE_PATH/);
});

test('invalid explicit configuration never guesses endpoint, origin or workspace', async t => {
  const f = await fixture(t);
  for (const patch of [{ version: 2 }, { origin: 'https://evil.invalid' }, { origin: ORIGIN + '/' }, { runtimeFile: 'relative.json' }, { extra: true }, { workspaceRoot: undefined }]) {
    await f.saveConnection({ ...f.connection, ...patch });
    await assert.rejects(client(t, f), /INVALID_CONFIG/);
  }
  assert.equal(f.requests.length, 0);
  await f.saveConnection();
  await f.saveRuntime({ ...f.runtime, endpoint: 'http://localhost:17653' });
  await assert.rejects(client(t, f), /INVALID_RUNTIME/);
});

test('health mismatch/capability removal fail closed before any authenticated request', async t => {
  for (const change of [s => { s.capability = false; }, s => { s.instanceId = 'other-instance'; }]) {
    const f = await fixture(t), c = await client(t, f);
    change(f.state);
    await assert.rejects(c.open({ taskKey: 'a', title: '任务' }), /UNSUPPORTED_SERVICE|STALE_INSTANCE/);
    assert.equal(f.state.openCount, 0);
  }
});

test('instance changes during a live task permanently stale the process client', async t => {
  const f = await fixture(t), c = await client(t, f), a = await c.open({ taskKey: 'a', title: '任务' });
  f.state.instanceId = 'new-instance';
  await assert.rejects(c.publish({ taskId: a.taskId, event: event() }), /STALE_INSTANCE/);
  f.state.instanceId = INSTANCE;
  await assert.rejects(c.open({ taskKey: 'b', title: '其他' }), /STALE_INSTANCE/);
  assert.equal(f.state.openCount, 1);
});
test('自动准备钩子不能迁移在途任务或未知open结果，仍不自动重发旧请求',async t=>{for(const mode of['active','unknown-open']){const f=await fixture(t),bootstrapFile=join(f.runtimeDir,'bootstrap.json');await writeFile(bootstrapFile,JSON.stringify({version:1,endpoint:f.endpoint,origin:ORIGIN,launcher:join(f.root,'unused-start.mjs'),runtimeFile:f.runtimeFile,mcpEntry:join(f.root,'unused-sdk.mjs'),launchArgs:['--adapter','generic','--trust-origin',ORIGIN,'--port',new URL(f.endpoint).port,'--workspace',f.root]}),{mode:0o600});await f.saveConnection({...f.connection,bootstrapFile,prepareEntry:fileURLToPath(new URL('../../../skills/km-agent-bridge/scripts/prepare.mjs',import.meta.url))});const c=await client(t,f);if(mode==='unknown-open'){f.state.handler=({req,reply})=>{if(!req.url.endsWith('/open'))return false;reply({},503);return true;};await assert.rejects(c.open({taskKey:'old-uncertain',title:'旧未知请求'}),/HTTP_REJECTED/);f.state.handler=undefined;}else await c.open({taskKey:'old-running',title:'旧任务运行中'});f.state.instanceId='fixture-instance-2';await f.saveRuntime({...f.runtime,instanceId:f.state.instanceId});await assert.rejects(c.open({taskKey:'must-not-migrate',title:'不可偷偷迁移'}),/STALE_INSTANCE/);assert.equal(f.requests.filter(r=>r.url.endsWith('/open')).length,1);}});
test('旧代次迟到健康响应只退休旧读取，不得毒化已经刷新的新任务',async t=>{const f=await fixture(t),bootstrapFile=join(f.runtimeDir,'bootstrap.json');await writeFile(bootstrapFile,JSON.stringify({version:1,endpoint:f.endpoint,origin:ORIGIN,launcher:join(f.root,'unused-start.mjs'),runtimeFile:f.runtimeFile,mcpEntry:join(f.root,'unused-sdk.mjs'),launchArgs:['--adapter','generic','--trust-origin',ORIGIN,'--port',new URL(f.endpoint).port,'--workspace',f.root]}),{mode:0o600});await f.saveConnection({...f.connection,bootstrapFile,prepareEntry:fileURLToPath(new URL('../../../skills/km-agent-bridge/scripts/prepare.mjs',import.meta.url))});const c=await client(t,f),a=await c.open({taskKey:'old',title:'旧任务'});await c.finish({taskId:a.taskId,status:'completed'});let held=false,release;f.state.handler=async({req,reply,state})=>{if(req.url!=='/v1/health'||held)return false;held=true;const instanceId=state.instanceId;await new Promise(r=>{release=r;});reply({service:'kuaimai-agent-connector',protocolVersion:2,interactionProtocol:'km-agent/1',instanceId,capabilities:{workbuddyPublish:true}});return true;};const late=c.receipt({taskId:a.taskId,eventId:'old-event'}).catch(e=>e.code);for(let i=0;i<100&&!release;i++)await new Promise(r=>setImmediate(r));assert.ok(release);f.state.instanceId='fixture-instance-2';await f.saveRuntime({...f.runtime,instanceId:f.state.instanceId});const b=await c.open({taskKey:'new',title:'新任务'});release();const oldCode=await late;assert.equal((await c.publish({taskId:b.taskId,event:event('new-event')})).accepted,true,'旧健康检查不能把新代次全局标stale');assert.equal(oldCode,'TASK_RETIRED');});

test('explicit retries reuse cached UUIDs; no open or finish is automatically retried', async t => {
  const f = await fixture(t), c = await client(t, f);
  f.state.handler = ({ req, reply }) => { if (req.url.endsWith('/open')) { reply({}, 503); return true; } return false; };
  await assert.rejects(c.open({ taskKey: 'same', title: '任务' }), /HTTP_REJECTED/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/open')).length, 1);
  const openId = f.requests.find(r => r.url.endsWith('/open')).body.requestId;
  f.state.handler = undefined;
  const a = await c.open({ taskKey: 'same', title: '任务' });
  assert.equal(f.requests.filter(r => r.url.endsWith('/open'))[1].body.requestId, openId);
  f.state.handler = ({ req, reply }) => { if (req.url.endsWith('/finish')) { reply({}, 503); return true; } return false; };
  await assert.rejects(c.finish({ taskId: a.taskId, status: 'completed' }), /HTTP_REJECTED/);
  const finishId = f.requests.find(r => r.url.endsWith('/finish')).body.requestId;
  const uncertainCount=f.requests.filter(r=>r.url.endsWith('/finish')).length;
  await assert.rejects(c.finish({taskId:a.taskId,status:'failed',note:'结果未知时不能改发相反终态'}),/FINISH_CONFLICT/);
  assert.equal(f.requests.filter(r=>r.url.endsWith('/finish')).length,uncertainCount);
  f.state.handler = undefined;
  await c.finish({ taskId: a.taskId, status: 'completed' });
  assert.equal(f.requests.filter(r => r.url.endsWith('/finish')).length, 2);
  assert.equal(f.requests.filter(r => r.url.endsWith('/finish'))[1].body.requestId, finishId);
  assert.notEqual(finishId, openId);
});

test('workspaceId is explicit alternative; invalid health service and protocol never get publisher credentials', async t => {
  const f = await fixture(t);
  await f.saveConnection({ version: 1, runtimeFile: f.runtimeFile, origin: ORIGIN, workspaceId: 'workspace-authorized' });
  const c = await client(t, f);
  for (const patch of [{ service: 'other' }, { interactionProtocol: 'wrong' }, { protocolVersion: 1 }]) {
    f.state.handler = ({ req, reply }) => {
      if (req.url !== '/v1/health') return false;
      reply({ instanceId: INSTANCE, service: 'kuaimai-agent-connector', protocolVersion: 2, interactionProtocol: 'km-agent/1', capabilities: { workbuddyPublish: true }, ...patch }); return true;
    };
    await assert.rejects(c.open({ taskKey: 'key', title: '任务' }), /UNSUPPORTED_SERVICE/);
  }
  f.state.handler = undefined;
  await c.open({ taskKey: 'key', title: '任务' });
  assert.equal(f.requests.find(r => r.url.endsWith('/open')).body.workspaceId, 'workspace-authorized');
  assert.equal(f.requests.filter(r => r.url.endsWith('/open')).length, 1);
});

test('redirects, oversized responses and server error text cannot leak secrets or trigger retry', async t => {
  let redirected = 0;
  const f = await fixture(t), c = await client(t, f), a = await c.open({ taskKey: 'a', title: '任务' });
  f.state.handler = ({ req, res }) => {
    if (req.url === '/redirect-target') { redirected++; res.end('{}'); return true; }
    if (req.url.endsWith('/publish')) { res.writeHead(307, { location: '/redirect-target' }); res.end(); return true; }
    return false;
  };
  await assert.rejects(c.publish({ taskId: a.taskId, event: event() }), /HTTP_FAILED/);
  assert.equal(redirected, 0);
  f.state.handler = ({ req, res }) => {
    if (!req.url.endsWith('/publish')) return false;
    res.writeHead(403); res.end(JSON.stringify({ ok: false, error: { message: PUBLISHER + TOKEN } })); return true;
  };
  await assert.rejects(c.publish({ taskId: a.taskId, event: event('e2') }), error => !error.message.includes('secret') && /HTTP_REJECTED/.test(error.message));
  f.state.handler = ({ req, res }) => {
    if (!req.url.endsWith('/receipt')) return false;
    res.end('x'.repeat(1024 * 1024 + 1)); return true;
  };
  await assert.rejects(c.receipt({ taskId: a.taskId, eventId: 'e2' }), /RESPONSE_TOO_LARGE/);
  assert.equal(f.requests.filter(r => r.url.endsWith('/publish')).length, 2);
});

test('32 process tasks maximum; unref heartbeat survives finish failure and stops on confirmed finish/close', async t => {
  const f = await fixture(t);
  const scheduled = [], cleared = [];
  const c = await client(t, f, { timers: { setInterval(fn, milliseconds) { const timer = { fn, milliseconds, unref() { this.unreferenced = true; } }; scheduled.push(timer); return timer; }, clearInterval(timer) { cleared.push(timer); } } });
  const task = await c.open({ taskKey: 'a', title: '任务' });
  assert.equal(scheduled[0].milliseconds, 20000);
  assert.equal(scheduled[0].unreferenced, true);
  await scheduled[0].fn();
  assert.equal(f.requests.filter(r => r.url.endsWith('/heartbeat')).length, 1);
  f.state.handler = ({ req, reply }) => { if (req.url.endsWith('/finish')) { reply({}, 503); return true; } return false; };
  await assert.rejects(c.finish({ taskId: task.taskId, status: 'failed' }), /HTTP_REJECTED/);
  assert.equal(cleared.length, 0);
  f.state.handler = undefined;
  await c.finish({ taskId: task.taskId, status: 'failed' });
  assert.equal(cleared.length, 1);
  for (let i = 1; i < 32; i++) await c.open({ taskKey: 'key-' + i, title: '任务' });
  await assert.rejects(c.open({ taskKey: 'overflow', title: '任务' }), /TASK_LIMIT/);
  c.close();
  assert.equal(cleared.length, 32);
  await assert.rejects(c.open({ taskKey: 'closed', title: '任务' }), /CLIENT_CLOSED/);
});


test('已完成任务之后的新任务通过可信准备器迁移至动态端口，旧票据不重放',async t=>{
  const first=await fixture(t),second=await fixture(t),bootstrapFile=join(first.runtimeDir,'bootstrap.json');
  second.state.instanceId='dynamic-instance';second.state.openCount=10;
  await second.saveRuntime({...second.runtime,instanceId:second.state.instanceId});
  await writeFile(bootstrapFile,JSON.stringify({version:1,allowPortFallback:true,endpoint:first.endpoint,origin:ORIGIN,launcher:join(first.root,'unused-start.mjs'),runtimeFile:first.runtimeFile,mcpEntry:join(first.root,'unused-sdk.mjs'),launchArgs:['--adapter','generic','--trust-origin',ORIGIN,'--port',new URL(first.endpoint).port,'--workspace',first.root]}),{mode:0o600});
  await first.saveConnection({...first.connection,bootstrapFile,prepareEntry:fileURLToPath(new URL('../../../skills/km-agent-bridge/scripts/prepare.mjs',import.meta.url))});
  const c=await client(t,first),old=await c.open({taskKey:'before',title:'旧任务'});await c.finish({taskId:old.taskId,status:'completed'});
  await first.saveRuntime({...second.runtime,instanceId:second.state.instanceId});
  const fresh=await c.open({taskKey:'after',title:'换端口后的任务'});
  assert.equal(second.state.openCount,11);assert.equal(first.state.openCount,1);
  assert.equal((await c.publish({taskId:fresh.taskId,event:event('dynamic-port')})).accepted,true);
  await assert.rejects(c.open({taskKey:'before',title:'旧任务'}),/TASK_RETIRED/);
});

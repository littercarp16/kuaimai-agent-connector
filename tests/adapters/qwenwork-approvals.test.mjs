import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQwenWorkAdapter } from '../../src/adapters/qwenwork.mjs';
import { qwenFileApprovals } from '../../src/protocol/qwen-approvals.mjs';
const taskId = 'e4791123-5d43-4f2b-90d9-f402fb858a17';
const action = () => ({ action_id: 'qxc_access_123', kind: 'permission', tool_name: 'SandboxFileAccess',
  input: { mode: 'sandbox_runtime_access', path: '/private/tmp/page7_latest.html', operation: 'write', objectType: 'file', command: 'Edit: /tmp/page7_latest.html', api: 'open', processId: 123 }, decisions: ['approve', 'deny'] });
const task = () => ({ task_id: taskId, session_id: 'fixture', turn_id: 'turn', status: 'waiting_for_input', terminal: false, actions: [action()] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'km-qwen-approvals-')), instance = 'a'.repeat(32);
  const f = { task: task(), sessionId: 'fixture', responses: [], events: [], responseError: null };
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks));
    let data;
    if (method === 'desktop.status') data = { protocol: 'qwenwork.desktop.v1', authenticated: true, features: { session_history: true, task_events: true, single_action_response: true } };
    else if (method === 'session.get') data = { session: { session_id: f.sessionId }, task: f.task };
    else if (method === 'session.history') data = { messages: [] };
    else if (method === 'task.events') data = { ...f.task, last_sequence: 0, events: [] };
    else if (method === 'action.respond') { f.responses.push(params); data = { resolved: true, task_id: params.task_id, action_id: params.action_id }; if (!f.responseError) f.task.actions = []; }
    else throw Error('Unexpected method ' + method);
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Qwenwork-Instance': instance });
    res.end(JSON.stringify(method === 'action.respond' && f.responseError ? { ok: false, error: { code: f.responseError } } : { ok: true, data }));
  });
  const adapter = createQwenWorkAdapter({ sessionId: 'fixture', controlDir: directory });
  t.after(async () => { adapter.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await mkdir(join(directory, instance)); await writeFile(join(directory, instance, 'token'), 'b'.repeat(64), { mode: 0o600 });
  const endpoint = { protocol: 'qwenwork.desktop.v1', port: server.address().port, instance_id: instance };
  await writeFile(join(directory, 'endpoint.json'), JSON.stringify(endpoint), { mode: 0o600 });
  await adapter.health(); const [{ id }] = await adapter.listSessions();
  const watcher = adapter.watch(id, event => f.events.push(event)); await watcher.ready;
  return { ...f, state: f, adapter, id, watcher, directory, endpoint };
}
const eventually = async predicate => { for (let i = 0; i < 80; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } assert.fail('event not observed'); };

test('文件审批初次绑定即显示，网页允许只回传当前任务的 approve，原生已处理后消失', async t => {
  const { state, adapter, id } = await fixture(t);
  const [approval] = (await adapter.readShared(id)).approvals;
  assert.equal(adapter.capabilities.nativeApprovals, true);
  assert.deepEqual(approval.decisions, ['accept', 'decline']);
  assert.match(approval.command, /路径：\/private\/tmp\/page7_latest.html\n操作：写入/);
  assert.match(approval.description, /当前会话记住/);
  assert.equal(state.events[0].type, 'session.approval.created');
  assert.deepEqual(await adapter.respondApproval(id, approval.id, 'accept'), { status: 'resolved' });
  assert.deepEqual(state.responses, [{ task_id: taskId, action_id: 'qxc_access_123', decision: 'approve' }]);
  await eventually(() => state.events.some(e => e.type === 'session.approval.resolved' && e.data.id === approval.id));
  await assert.rejects(adapter.respondApproval(id, approval.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(state.responses.length, 1);
});
test('网页拒绝回传 deny，审批终态不再展示', async t => {
  const { state, adapter, id } = await fixture(t);
  const [approval] = await adapter.listApprovals(id);
  await adapter.respondApproval(id, approval.id, 'decline');
  assert.equal(state.responses[0].decision, 'deny');
  state.task = { ...task(), terminal: true, status: 'completed' };
  assert.deepEqual(await adapter.listApprovals(id), []);
});
test('同一 action ID 的路径或操作变化后，旧网页按钮不能批准', async t => {
  const { state, adapter, id } = await fixture(t);
  const [old] = await adapter.listApprovals(id);
  state.task.actions[0].input.targetPath = '/private/tmp/other.html';
  const [next] = await adapter.listApprovals(id); assert.notEqual(old.id, next.id);
  await assert.rejects(adapter.respondApproval(id, old.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(state.responses.length, 0);
  await eventually(() => state.events.some(e => e.type === 'session.approval.resolved' && e.data.id === old.id));
});
test('任务、会话、控制权和连接变化都在原生答复前阻止提交', async t => {
  const { state, adapter, id, watcher } = await fixture(t);
  const [a] = await adapter.listApprovals(id);
  for (const mutate of [() => { state.task.task_id = 'different'; }, () => { state.task.session_id = 'different'; }, () => { state.sessionId = 'different'; }]) {
    state.task = task(); state.sessionId = 'fixture'; mutate();
    await assert.rejects(adapter.respondApproval(id, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  }
  state.task = task(); state.sessionId = 'fixture';
  await assert.rejects(adapter.respondApproval(id, a.id, 'accept', { assertCurrent: () => { throw Error('lost control'); } }), { code: 'APPROVAL_NOT_SUBMITTED' });
  watcher.close(); await assert.rejects(adapter.respondApproval(id, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(state.responses.length, 0);
});
test('原生竞态 ACTION_EXPIRED 不被当作已批准，也不重试', async t => {
  const { state, adapter, id } = await fixture(t);
  const [a] = await adapter.listApprovals(id); state.responseError = 'ACTION_EXPIRED';
  await assert.rejects(adapter.respondApproval(id, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(state.responses.length, 1);
});
test('未知权限、扩大范围的字段、被隐藏的路径均不能作为网页可批准的文件操作', () => {
  const map = t => qwenFileApprovals('instance', 'session', 'fixture', t);
  for (const change of [a => { a.tool_name = 'Bash'; }, a => { a.input.mode = 'sandbox_directory_access'; }, a => { a.input.recursive = true; }, a => { a.input.path = '/tmp/secret=abc'; }, a => { a.input.path = '/tmp/x\u202ey'; }, a => { a.input.operation = 'rename'; }, a => { a.decisions.push('always_allow'); }]) {
    const current = task(); change(current.actions[0]); assert.deepEqual(map(current), []);
  }
  const renamed = task(); renamed.actions[0].input.operation = 'rename'; renamed.actions[0].input.targetPath = '/tmp/destination';
  assert.match(map(renamed)[0].approval.command, /目标路径：\/tmp\/destination/);
});

test('千问实例改变后，旧实例审批不能发送给新客户端', async t => {
  const { state, adapter, id, directory, endpoint } = await fixture(t);
  const [a] = await adapter.listApprovals(id);
  const instance = 'c'.repeat(32);
  await mkdir(join(directory, instance));
  await writeFile(join(directory, instance, 'token'), 'd'.repeat(64), { mode: 0o600 });
  await writeFile(join(directory, 'endpoint.json'), JSON.stringify({ ...endpoint, instance_id: instance }), { mode: 0o600 });
  await assert.rejects(adapter.respondApproval(id, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(state.responses.length, 0);
});
test('原生响应不确定时不生成成功回执，也不自动再次提交', async t => {
  const { state, adapter, id } = await fixture(t);
  const [a] = await adapter.listApprovals(id); state.responseError = 'INTERNAL_ERROR';
  await assert.rejects(adapter.respondApproval(id, a.id, 'accept'), error => error.code === 'INTERNAL_ERROR');
  assert.equal(state.responses.length, 1);
});

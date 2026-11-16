import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chmod } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixture, event, PUBLISHER, TOKEN } from '../../fixtures/workbuddy-client-fixture.mjs';

const entry = fileURLToPath(new URL('../../../mcp-workbuddy.mjs', import.meta.url));
async function connect(t, f) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--config', f.connectionFile], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', chunk => { stderr += chunk; });
  const c = new Client({ name: 'workbuddy-fixture', version: '1.0.0' });
  t.after(async () => { await c.close(); assert.doesNotMatch(stderr, /secret|taskToken|publisherKey/); });
  await c.connect(transport);
  return { c, transport, stderr: () => stderr };
}
const data = result => result.structuredContent ?? JSON.parse(result.content[0].text);

test('real stdio SDK tools/list/call validates schemas and publishes scoped public output', async t => {
  const f = await fixture(t), { c, stderr } = await connect(t, f);
  const list = await c.listTools();
  assert.deepEqual(list.tools.map(tool => tool.name).sort(), ['km_agent_protocol', 'km_task_finish', 'km_task_open', 'km_task_publish', 'km_task_receipt']);
  assert.ok(list.tools.every(tool => tool.inputSchema.additionalProperties === false));
  const opened = await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'report', title: '销售页面' } });
  assert.equal(opened.isError, undefined);
  const task = data(opened);
  const again = data(await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'report', title: '销售页面' } }));
  assert.deepEqual(task, again);
  const published = data(await c.callTool({ name: 'km_task_publish', arguments: { taskId: task.taskId, event: event() } }));
  assert.equal(published.delivery, 'accepted');
  assert.equal(data(await c.callTool({ name: 'km_task_receipt', arguments: { taskId: task.taskId, eventId: 'evt-1' } })).delivery, 'applied');
  const foreign = await c.callTool({ name: 'km_task_receipt', arguments: { taskId: 'task-foreign', eventId: 'evt-1' } });
  assert.equal(foreign.isError, true);
  const invalid = await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'secret-input', title: '任务', taskToken: PUBLISHER } });
  assert.equal(invalid.isError, true);
  const invalidKind = await c.callTool({ name: 'km_task_publish', arguments: { taskId: task.taskId, event: { ...event(), type: 'activity.updated', payload: { id: 'hidden', kind: 'thinking', label: '思考', status: 'running' } } } });
  assert.equal(invalidKind.isError, true);
  let unknownError;
  try { await c.callTool({ name: PUBLISHER, arguments: {} }); } catch (error) { unknownError = error; }
  assert.ok(unknownError);
  assert.equal(String(unknownError).includes(PUBLISHER), false, 'SDK protocol errors must not echo untrusted tool names');
  assert.equal(data(await c.callTool({ name: 'km_agent_protocol', arguments: {} })).commands.length, 15);
  const finished = await c.callTool({ name: 'km_task_finish', arguments: { taskId: task.taskId, status: 'completed' } });
  assert.equal(data(finished).status, 'completed');
  assert.doesNotMatch(JSON.stringify([opened, published, foreign, invalid, invalidKind, finished]) + stderr(), new RegExp(PUBLISHER + '|' + TOKEN));
});

test('stdio rechecks runtime permissions after process startup', async t => {
  const f = await fixture(t), { c } = await connect(t, f);
  await chmod(f.runtimeFile, 0o644);
  const denied = await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'x', title: '任务' } });
  assert.equal(denied.isError, true);
  assert.match(JSON.stringify(denied), /UNSAFE_RUNTIME/);
  assert.equal(f.requests.length, 0);
});

test('stdio validates capability, runtime permissions, redirects and changed instances without disclosing credentials', async t => {
  const f = await fixture(t), { c } = await connect(t, f);
  f.state.capability = false;
  assert.equal((await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'x', title: '任务' } })).isError, true);
  assert.equal(f.state.openCount, 0);
  f.state.capability = true;
  const task = data(await c.callTool({ name: 'km_task_open', arguments: { taskKey: 'y', title: '任务' } }));
  f.state.handler = ({ req, res }) => { if (req.url.endsWith('/publish')) { res.writeHead(307, { location: '/stolen' }); res.end(); return true; } return false; };
  assert.equal((await c.callTool({ name: 'km_task_publish', arguments: { taskId: task.taskId, event: event() } })).isError, true);
  assert.equal(f.requests.some(request => request.url === '/stolen'), false);
  f.state.handler = undefined;
  f.state.instanceId = 'other';
  const stale = await c.callTool({ name: 'km_task_publish', arguments: { taskId: task.taskId, event: event('new') } });
  assert.equal(stale.isError, true);
  assert.match(JSON.stringify(stale), /STALE_INSTANCE/);
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQwenWorkAdapter } from '../../src/adapters/qwenwork.mjs';

test('千问办公已知任务并行读取事件，会话校验通过后才发布', { timeout: 6000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'km-qwen-poll-'));
  const instance = 'a'.repeat(32);
  const session = { session_id: 'fixture', title: '测试会话' };
  const task = { session_id: session.session_id, task_id: 'task', turn_id: 'reply', status: 'running' };
  let notifySessionCheck;
  const sessionCheck = new Promise(resolve => { notifySessionCheck = resolve; });
  let notifyParallel;
  const parallel = new Promise(resolve => { notifyParallel = resolve; });
  let eventReads = 0, sessionReads = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks));
    const send = data => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Qwenwork-Instance': instance });
      res.end(JSON.stringify({ ok: true, data }));
    };
    if (method === 'session.get') {
      if (++sessionReads === 4) notifySessionCheck(() => send({ session: { session_id: 'changed' }, task }));
      else send({ session, task });
    } else if (method === 'session.history') {
      send({ messages: [] });
    } else if (method === 'task.events') {
      const first = ++eventReads === 1;
      send({ ...task, answer: first ? '已确认的正文' : '不可发布的正文', next_cursor: params.after + 1 });
      if (!first) notifyParallel(params.after);
    } else {
      res.writeHead(404).end();
    }
  });
  const adapter = createQwenWorkAdapter({ sessionId: session.session_id, controlDir: directory });
  t.after(async () => {
    adapter.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  await mkdir(join(directory, instance));
  await writeFile(join(directory, instance, 'token'), 'b'.repeat(64), { mode: 0o600 });
  await writeFile(join(directory, 'endpoint.json'), JSON.stringify({
    protocol: 'qwenwork.desktop.v1', port: server.address().port, instance_id: instance
  }), { mode: 0o600 });
  const [{ id }] = await adapter.listSessions();
  const updates = [];
  let notifyDisconnected;
  const disconnected = new Promise(resolve => { notifyDisconnected = resolve; });
  const watcher = adapter.watch(id, event => {
    if (event.type === 'session.text.updated') updates.push(event.data.text);
  }, notifyDisconnected);
  await watcher.ready;
  const [cursor, releaseSessionCheck] = await Promise.all([parallel, sessionCheck]);
  assert.equal(cursor, 1);
  assert.deepEqual(updates, ['已确认的正文']);
  releaseSessionCheck();
  assert.equal(await disconnected, 'disconnected');
  assert.deepEqual(updates, ['已确认的正文']);
});

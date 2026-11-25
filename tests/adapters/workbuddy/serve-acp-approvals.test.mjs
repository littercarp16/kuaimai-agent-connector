import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openWorkBuddyServeSession } from '../../../src/adapters/workbuddy/serve-acp.mjs';

test('each WebFetch needs its own native one-time decision and visibly scoped URL', { timeout: 5000 }, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'wb-acp-approvals-')));
  const sessionId = 'approval-test', answers = new Map();
  const cancelled = Promise.withResolvers();
  let stream, turn;
  const frame = message => stream.write('data: ' + JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n\n');
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204).end(); return; }
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === 'session/prompt') {
      stream = res; turn = message.id;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/connect')) return res.end(JSON.stringify({ connectionId: 'connection', sessionToken: 'fixture' }));
    if (message.result) {
      answers.set(message.id, message.result.outcome);
      if (answers.size === 6) cancelled.resolve();
      res.writeHead(202).end(); return;
    }
    const result = message.method === 'initialize' ? { agentCapabilities: { promptCapabilities: { embeddedContext: true } } } : { sessionId };
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let adapter;
  t.after(async () => {
    await adapter?.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); await rm(workspace, { recursive: true, force: true });
  });
  adapter = await openWorkBuddyServeSession({ endpoint: 'http://127.0.0.1:' + server.address().port,
    password: 'fixture-password-1234', workspace });
  const [{ id }] = await adapter.listSessions();
  await adapter.sendShared(id, '读取这两个网页', { requestId: 'turn-1' });
  const options = [
    { kind: 'allow_once', optionId: 'once' }, { kind: 'allow_always', optionId: 'always' },
    { kind: 'reject_once', optionId: 'reject' },
  ];
  const ask = (rpcId, name, rawInput, choices = options) => frame({ method: 'session/request_permission', id: rpcId,
    params: { sessionId, options: choices, toolCall: { toolCallId: 'tool-' + rpcId,
      _meta: { 'codebuddy.ai/toolName': name }, rawInput } } });
  ask(20, 'WebFetch', { url: 'https://example.com/one', prompt: '读取标题' });
  ask(21, 'WebFetch', { url: 'https://example.org/two' });
  ask(22, 'Bash', { url: 'https://example.org/' });
  ask(23, 'WebFetch', { url: 'file:///tmp/private' });
  ask(24, 'WebFetch', { url: 'https://example.org/', method: 'POST' });
  ask(25, 'WebFetch', { url: 'https://user:secret@example.org/' });
  ask(26, 'WebFetch', { url: 'https://example.org/' }, [options[1]]);
  ask(27, 'WebFetch', { url: 'https://example.org/?token=secret' });
  await cancelled.promise;
  for (const rpcId of [22, 23, 24, 25, 26, 27]) assert.deepEqual(answers.get(rpcId), { outcome: 'cancelled' });
  const [first, second] = await adapter.listApprovals(id);
  assert.deepEqual([first.command, second.command], ['https://example.com/one', 'https://example.org/two']);
  assert.deepEqual(first.decisions, ['accept', 'decline']);
  assert.notEqual(first.id, second.id);
  await adapter.respondApproval(id, second.id, 'decline');
  assert.deepEqual((await adapter.listApprovals(id)).map(item => item.id), [first.id]);
  await adapter.respondApproval(id, first.id, 'accept');
  assert.deepEqual(answers.get(21), { outcome: 'selected', optionId: 'reject' });
  assert.deepEqual(answers.get(20), { outcome: 'selected', optionId: 'once' });
  await assert.rejects(adapter.respondApproval(id, first.id, 'accept'), /不再待处理/);
  frame({ id: turn, result: { stopReason: 'end_turn' } }); stream.end();
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openWorkBuddyServeSession } from '../../../src/adapters/workbuddy/serve-acp.mjs';

test('only managed Bash, named skill docs and scoped WebFetch become one-time approvals', { timeout: 5000 }, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'wb-acp-approvals-')));
  const sessionId = 'approval-test', answers = new Map();
  const cancelled = Promise.withResolvers();
  const rejectedCommands = Promise.withResolvers(), externalCommand = Promise.withResolvers();
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
      if ([32, 33, 34, 35].every(id => answers.has(id))) rejectedCommands.resolve();
      if (message.id === 38) externalCommand.resolve();
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
  const connection = { endpoint: 'http://127.0.0.1:' + server.address().port, password: 'fixture-password-1234', workspace };
  adapter = await openWorkBuddyServeSession({ ...connection, managedBash: true });
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
  const command = "printf '%s' 'review full command'\nlingtong-cli auth status";
  ask(30, 'Bash', { command, description: 'misleading title' });
  ask(31, 'Bash', { command: 'pwd', run_in_background: true });
  ask(32, 'Bash', { command: 'echo --token secret' });
  ask(33, 'Bash', { command: 'pwd', env: { altered: '1' } });
  ask(34, 'Bash', { command: 'pwd', dangerouslyDisableSandbox: true });
  ask(35, 'Bash', { command: 'a'.repeat(12001) });
  await rejectedCommands.promise;
  for (const rpcId of [32, 33, 34, 35]) assert.deepEqual(answers.get(rpcId), { outcome: 'cancelled' });
  const [shell, background] = await adapter.listApprovals(id);
  assert.equal(shell.command, command);
  assert.equal(shell.cwd, workspace);
  assert.match(background.title, /后台/);
  assert.equal(answers.has(30), false);
  await adapter.respondApproval(id, background.id, 'decline');
  await adapter.respondApproval(id, shell.id, 'accept');
  assert.deepEqual(answers.get(30), { outcome: 'selected', optionId: 'once' });
  assert.deepEqual(answers.get(31), { outcome: 'selected', optionId: 'reject' });
  const doc = join(homedir(), '.agents', 'skills', 'lingtong-kmmdtable', 'SKILL.md');
  const available = Promise.withResolvers();
  adapter.watch(id, e => { if (e.type === 'session.approval.created') available.resolve(e.data.approval); }, () => {});
  ask(36, 'Read', { file_path: doc });
  const read = await available.promise;
  assert.equal(read.command, doc);
  await adapter.respondApproval(id, read.id, 'decline');
  frame({ id: turn, result: { stopReason: 'end_turn' } }); stream.end();
  await adapter.close();
  adapter = await openWorkBuddyServeSession(connection);
  await adapter.sendShared(id, 'external', { requestId: 'external' });
  ask(38, 'Bash', { command: 'pwd' });
  await externalCommand.promise;
  assert.deepEqual(answers.get(38), { outcome: 'cancelled' });
  assert.deepEqual(await adapter.listApprovals(id), []);
  frame({ id: turn, result: { stopReason: 'end_turn' } }); stream.end();
});

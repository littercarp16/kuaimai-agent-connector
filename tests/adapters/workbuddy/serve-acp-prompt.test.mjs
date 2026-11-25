import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openWorkBuddyServeSession } from '../../../src/adapters/workbuddy/serve-acp.mjs';
import { createProjection } from '../../../src/session/shared-state.mjs';

test('WorkBuddy page questions retain the original title and history, and explain an unsupported permission stop', { timeout: 5000 }, async t => {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'wb-prompt-')));
  const page = { appId: '9', pageId: '8', pageName: '测试页面', draftVersionNo: 0, webOrigin: 'http://127.0.0.1' };
  const original = '  对比下豆包，千问办公，workbuddy  ';
  const sessionId = 'fixture-id', legacyUri = 'km-agent://page-context';
  const label = 'only-for-current-page-operations', uri = legacyUri + '/' + label;
  const context = (href, json) => '\n<context ref="' + href + '">\n' + json + '\n</context>';
  const legacy = context(legacyUri, JSON.stringify(page));
  let adapter, prompt, stream, rpcId;
  const frame = (res, message) => res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n\n');
  const server = createServer(async (req, res) => {
    if (req.method === 'DELETE') return res.writeHead(204).end();
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const msg = JSON.parse(body);
    if (req.url.endsWith('/connect')) return res.end(JSON.stringify({ connectionId: 'fixture', sessionToken: 'fixture' }));
    if (msg.method === 'session/prompt') {
      stream = res; rpcId = msg.id; prompt = msg.params.prompt;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.flushHeaders(); return;
    }
    if (msg.result) {
      assert.deepEqual(msg.result.outcome, { outcome: 'cancelled' });
      frame(stream, { id: rpcId, result: { stopReason: 'cancelled' } }); stream.end();
      return res.writeHead(202).end();
    }
    if (msg.method === 'session/load') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const current = context(uri, prompt[1].resource.text);
      const replay = (messageId, text) => frame(res, { method: 'session/update', params: { sessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text } } } });
      replay('legacy', original + 'page-context' + legacy);
      replay('current', original + ' ' + label + ' ' + current);
      replay('current', label + current);
      replay('ordinary', '用户自己提到 page-context');
      frame(res, { id: msg.id, result: { sessionId } }); return res.end();
    }
    const result = msg.method === 'initialize' ? { agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true } } } : { sessionId };
    res.end(JSON.stringify({ id: msg.id, result }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    await adapter?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true });
  });
  const options = { endpoint: 'http://127.0.0.1:' + server.address().port, password: 'fixture-password-1234', workspace };
  adapter = await openWorkBuddyServeSession(options);
  const [{ id }] = await adapter.listSessions();
  const projection = createProjection(id), finished = Promise.withResolvers();
  adapter.watch(id, event => {
    projection.accept(event);
    if (event.type === 'session.execution.interrupted') finished.resolve();
  }, () => {});
  await adapter.sendShared(id, original, { requestId: 'first', pageContext: page });
  assert.deepEqual(prompt[0], { type: 'text', text: original });
  assert.equal(prompt.length, 2);
  const resource = prompt[1].resource;
  assert.equal(resource.uri, uri);
  assert.deepEqual(JSON.parse(resource.text).page, page);
  assert.match(JSON.parse(resource.text).usage, /普通咨询、产品对比和讨论直接回答/);
  frame(stream, { method: 'session/request_permission', id: 81, params: { sessionId, options: [{ kind: 'allow_once', optionId: 'once' }],
    toolCall: { toolCallId: 'read', _meta: { 'codebuddy.ai/toolName': 'Read' }, rawInput: { file_path: '/outside-workspace' } } } });
  await finished.promise;
  assert.equal(projection.value.status, 'interrupted');
  assert.equal(projection.value.interruptionCode, 'workbuddy_unsupported_permission');
  const restored = createProjection(id);
  restored.hydrate(await adapter.readShared(id));
  assert.equal(restored.value.interruptionCode, projection.value.interruptionCode);
  await adapter.close();
  adapter = await openWorkBuddyServeSession({ ...options, existingSessionId: sessionId });
  assert.deepEqual((await adapter.readShared(id)).messages.map(m => m.text), [original, original, '用户自己提到 page-context']);
});

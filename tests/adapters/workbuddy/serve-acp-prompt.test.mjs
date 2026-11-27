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
  let adapter, prompt, stream, rpcId, decision;
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
      decision = msg.result.outcome;
      frame(stream, { id: rpcId, result: { stopReason: decision.outcome === 'selected' ? 'end_turn' : 'cancelled' } }); stream.end();
      return res.writeHead(202).end();
    }
    if (msg.method === 'session/load') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const current = context(uri, prompt[1].resource.text);
      const { usage, page: previousPage } = JSON.parse(prompt[1].resource.text);
      const previous = context(uri, JSON.stringify({ usage, page: previousPage }));
      const writeOnly = context(uri, JSON.stringify({ usage, page: previousPage,
        localDraft: '生成当前页面的本地 HTML 草稿时，使用 Write，并将 file_path 设为当前工作目录下 draft.html 的完整绝对路径，等待用户在绫通中审批。保存到绫通平台需另行使用页面保存接口。' }));
      const replay = (messageId, text) => frame(res, { method: 'session/update', params: { sessionId,
        update: { sessionUpdate: 'user_message_chunk', messageId, content: { type: 'text', text } } } });
      replay('legacy', original + 'page-context' + legacy);
      replay('previous', original + label + previous);
      replay('write-only', original + label + writeOnly);
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
  const options = { endpoint: 'http://127.0.0.1:' + server.address().port, password: 'fixture-password-1234', workspace, approvalFile: join(workspace, 'draft.html'), managedBash: true };
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
  assert.match(JSON.parse(resource.text).localDraft, /draft\.html 的完整绝对路径/);
  assert.match(JSON.parse(resource.text).localDraft, /file:\/\/\/ 地址/);
  assert.match(JSON.parse(resource.text).localDraft, /lingtong-kmmdtable\/SKILL\.md/);
  frame(stream, { method: 'session/request_permission', id: 81, params: { sessionId, options: [{ kind: 'allow_once', optionId: 'once' }],
    toolCall: { toolCallId: 'read', _meta: { 'codebuddy.ai/toolName': 'Read' }, rawInput: { file_path: '/outside-workspace' } } } });
  await finished.promise;
  assert.equal(projection.value.status, 'interrupted');
  assert.equal(projection.value.interruptionCode, 'workbuddy_unsupported_permission');
  const nextStop = Promise.withResolvers(), approvalReady = Promise.withResolvers(), completed = Promise.withResolvers();
  adapter.watch(id, event => {
    if (event.type === 'session.execution.interrupted') nextStop.resolve();
    if (event.type === 'session.approval.created') approvalReady.resolve(event.data.approval);
    if (event.type === 'session.execution.succeeded') completed.resolve();
  }, () => {});
  const askToWrite = (rpc, path) => frame(stream, { method: 'session/request_permission', id: rpc, params: { sessionId,
    options: [{ kind: 'allow_once', optionId: 'once' }, { kind: 'reject_once', optionId: 'reject' }],
    toolCall: { toolCallId: 'write-' + rpc, _meta: { 'codebuddy.ai/toolName': 'Write' }, rawInput: { file_path: path, content: '<html></html>' }, locations: [{ path }] } } });
  await adapter.sendShared(id, '生成页面', { requestId: 'named-html', pageContext: page });
  askToWrite(82, join(workspace, 'office-agent-showcase.html'));
  await nextStop.promise;
  assert.deepEqual(decision, { outcome: 'cancelled' });
  assert.deepEqual(await adapter.listApprovals(id), []);
  assert.equal(projection.value.interruptionCode, 'workbuddy_draft_path_required');
  const restored = createProjection(id);
  restored.hydrate(await adapter.readShared(id));
  assert.equal(restored.value.interruptionCode, projection.value.interruptionCode);
  await adapter.sendShared(id, '继续生成本地草稿', { requestId: 'retry', pageContext: page });
  askToWrite(83, options.approvalFile);
  const approval = await approvalReady.promise;
  assert.equal(approval.command, options.approvalFile);
  assert.deepEqual(approval.decisions, ['accept', 'decline']);
  await adapter.respondApproval(id, approval.id, 'accept');
  await completed.promise;
  assert.deepEqual(decision, { outcome: 'selected', optionId: 'once' });
  assert.equal(projection.value.interruptionCode, null);
  async function monitorTurn(requestId, command, options, expectedEvent) {
    const done = Promise.withResolvers();
    const subscription = adapter.watch(id, event => {
      if (event.type === expectedEvent) done.resolve();
    }, () => {});
    try {
      await adapter.sendShared(id, '查看预览', { requestId, pageContext: page });
      frame(stream, { method: 'session/request_permission', id: 84, params: { sessionId, options,
        toolCall: { toolCallId: requestId, _meta: { 'codebuddy.ai/toolName': 'Monitor' }, rawInput: { command } } } });
      await done.promise;
      assert.deepEqual(await adapter.listApprovals(id), []);
    } finally { subscription.close(); }
  }
  const allow = { kind: 'allow_once', optionId: 'allow' }, reject = { kind: 'reject_once', optionId: 'reject' };
  const command = 'cd ' + workspace + ' && python3 -m http.server 8765 --bind 127.0.0.1';
  await monitorTurn('preview-declined', command, [allow, reject], 'session.execution.succeeded');
  assert.deepEqual(decision, { outcome: 'selected', optionId: 'reject' });
  assert.equal(projection.value.interruptionCode, null);
  await monitorTurn('preview-stopped', command, [allow], 'session.execution.interrupted');
  assert.deepEqual(decision, { outcome: 'cancelled' });
  assert.equal(projection.value.interruptionCode, 'workbuddy_preview_server_unsupported');
  restored.hydrate(await adapter.readShared(id));
  assert.equal(restored.value.interruptionCode, projection.value.interruptionCode);
  await monitorTurn('unrelated-monitor', 'python3 other.py', [allow, reject], 'session.execution.interrupted');
  assert.deepEqual(decision, { outcome: 'cancelled' });
  assert.equal(projection.value.interruptionCode, 'workbuddy_unsupported_permission');
  await adapter.close();
  adapter = await openWorkBuddyServeSession({ ...options, existingSessionId: sessionId });
  assert.deepEqual((await adapter.readShared(id)).messages.map(m => m.text), [original, original, original, original, '用户自己提到 page-context']);
});

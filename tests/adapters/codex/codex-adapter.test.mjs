import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { createProjection } from '../../../src/session/shared-state.mjs';
import { fixture, THREAD, OTHER, SESSION, turn, user, agent, deferred, tick, until, questionParams, approvalParams } from '../../fixtures/codex-fixture.mjs';

test('namespace uses thread.id, never root sessionId, and declares honest capabilities', async t => {
  const f = await fixture(t); const meta = await f.bind();
  assert.deepEqual(meta, { id: SESSION, title: '原生测试', provider: 'codex', nativeThreadId: THREAD, directory: f.directory });
  assert.equal(f.adapter.descriptor.id, 'codex'); assert.equal(f.adapter.descriptor.status, 'native');
  for (const key of ['attachments', 'fileSearch', 'newSession', 'followSessions']) assert.equal(f.adapter.capabilities[key], false);
  for (const key of ['send', 'interrupt', 'questions', 'approvals', 'toolDetails']) assert.equal(f.adapter.capabilities[key], true);
  assert.equal(f.calls.some(c => c.method === 'thread/resume'), false);
});
test('list filters exact canonical workspace and rejects children, unknown sources and subagents', async t => {
  const f = await fixture(t); await symlink(f.directory, path.join(f.directory, 'alias'));
  f.threads.push({ ...f.thread, id: OTHER, cwd: path.join(f.directory, 'child') },
    { ...f.thread, id: OTHER, source: 'unknown' }, { ...f.thread, id: OTHER, source: { subAgent: 'review' } },
    { ...f.thread, id: OTHER, parentThreadId: THREAD }, { ...f.thread, id: OTHER, attachedToThreadId: THREAD }, { ...f.thread, id: OTHER, archived: true });
  assert.equal((await f.adapter.listSessions()).length, 1);
  assert.deepEqual(f.calls[0].params, { limit: 50, archived: false, useStateDbOnly: true });
  f.thread.cwd = path.join(f.directory, 'alias'); assert.equal((await f.adapter.listSessions()).length, 1);
});
test('list errors never become a success with an empty list', async t => {
  const f = await fixture(t); f.handlers.set('thread/list', () => { throw Error('secret native error'); });
  await assert.rejects(f.adapter.listSessions(), e => !e.message.includes('secret'));
});
test('list paginates with a finite cap and detects cursor cycles', async t => {
  const f = await fixture(t); f.handlers.set('thread/list', () => ({ data: [f.thread], nextCursor: 'cycle' }));
  await assert.rejects(f.adapter.listSessions()); assert.ok(f.calls.length <= 6);
});
test('bind rejects foreign provider IDs, noncanonical wrappers, archived, cwd and id mismatch', async t => {
  const f = await fixture(t);
  for (const id of [THREAD, 'ses_opencode_1', SESSION.toUpperCase(), SESSION + 'a']) await assert.rejects(f.adapter.bindSession(id));
  for (const patch of [{ archived: true }, { cwd: path.join(f.directory, 'child') }, { id: OTHER }, { source: 'unknown' }]) {
    f.handlers.set('thread/read', () => ({ thread: { ...f.thread, ...patch } })); await assert.rejects(f.bind());
  }
});
test('health caches at most two seconds, coalesces concurrent discovery and uses fixed safe errors', async t => {
  const f = await fixture(t); await Promise.all(Array.from({ length: 12 }, () => f.adapter.health()));
  assert.equal(f.discoveryCount, 1); assert.equal(f.connectCount, 1);
  await f.adapter.health(); assert.equal(f.discoveryCount, 1); f.advance(); await f.adapter.health(); assert.equal(f.discoveryCount, 2);
  f.setDiscovery({ ready: false, message: 'secret-error' }); f.advance();
  assert.equal((await f.adapter.health()).ready, false); assert.ok(!(await f.adapter.health()).message.includes('secret-error'));
});
test('unsupported versions and false discoveries never connect', async t => {
  const f = await fixture(t); for (const d of [false, { ready: true, version: '0.167.0', socketPath: '/x', instanceId: 'x' }]) {
    f.setDiscovery(d); f.advance(); assert.equal((await f.adapter.health()).ready, false);
  } assert.equal(f.connectCount, 0);
});
test('send idle uses start with stable client id and no sticky permission/model overrides', async t => {
  const f = await fixture(t); await f.bind();
  const result = await f.adapter.sendShared(SESSION, '你好', { requestId: 'request-1' });
  const request = f.calls.find(c => c.method === 'turn/start');
  assert.deepEqual(Object.keys(request.params).sort(), ['clientUserMessageId', 'input', 'threadId']);
  assert.deepEqual(request.params.input, [{ type: 'text', text: '你好', text_elements: [] }]);
  assert.deepEqual(result, { id: request.params.clientUserMessageId, payload: { text: '你好' },accepted:true,delivery:'accepted',nativeEcho:true,nativeTurnId:'turn-new' });
});
test('active send steers exact turn and precondition failure never falls back to start', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind();
  f.handlers.set('turn/steer', () => { throw Object.assign(Error('private conflict'), { code: 'CODEX_RPC_ERROR', rpcCode: -32602 }); });
  await assert.rejects(f.adapter.sendShared(SESSION, '补充', { requestId: 'r' }));
  assert.equal(f.calls.find(c => c.method === 'turn/steer').params.expectedTurnId, 'turn-1');
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});
test('request id is single-flight, signature checked and successful results reused', async t => {
  const f = await fixture(t); await f.bind(); const gate = deferred();
  f.handlers.set('turn/start', async p => { await gate.promise; return { turn: turn('t', 'inProgress', [user(p.clientUserMessageId, p.input[0].text)]) }; });
  const a = f.adapter.sendShared(SESSION, 'one', { requestId: 'same' }); const b = f.adapter.sendShared(SESSION, 'one', { requestId: 'same' });
  await assert.rejects(f.adapter.sendShared(SESSION, 'other', { requestId: 'same' })); gate.resolve();
  assert.deepEqual(await a, await b); await f.adapter.sendShared(SESSION, 'one', { requestId: 'same' });
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('uncertain sends are never resent for the same request id', async t => {
  const f = await fixture(t); await f.bind(); f.handlers.set('turn/start', () => { throw Object.assign(Error('wire private'), { code: 'CODEX_RESULT_UNKNOWN' }); });
  for (let i = 0; i < 2; i++) await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'same' }), { code: 'CODEX_RESULT_UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('definite not-submitted sends can be retried without changing client id', async t => {
  const f = await fixture(t); await f.bind(); f.handlers.set('turn/start', () => { throw Object.assign(Error('not sent'), { code: 'NOT_SUBMITTED' }); });
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'same' }), { code: 'NOT_SUBMITTED' });
  f.handlers.delete('turn/start'); await f.adapter.sendShared(SESSION, 'one', { requestId: 'same' });
  const writes = f.calls.filter(c => c.method === 'turn/start'); assert.equal(writes[0].params.clientUserMessageId, writes[1].params.clientUserMessageId);
});
test('attachments, references and aborted requests are NOT_SUBMITTED without writes', async t => {
  const f = await fixture(t); await f.bind();
  for (const opts of [{ uploads: [{}] }, { references: ['a'] }, { signal: AbortSignal.abort() }])
    await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'same', ...opts }), { code: 'NOT_SUBMITTED' });
  assert.equal(f.calls.some(c => c.method.startsWith('turn/')), false);
});
test('snapshot excludes reasoning and raw outputs but retains public JSON exactly, model and details', async t => {
  const f = await fixture(t); const text = '{ "count":9007199254740993, "url":"https://example.com/a?q=x" }';
  f.turns.push(turn('turn-1', 'completed', [user('u', '普通用户'), agent('a', text),
    { type: 'reasoning', id: 'r', summary: ['PRIVATE SUMMARY'], content: ['PRIVATE REASONING'] },
    { type: 'commandExecution', id: 'cmd', command: 'git status --short', cwd: f.directory, status: 'completed', aggregatedOutput: 'RAW OUTPUT token=secret' }]));
  await f.bind(); const snap = await f.adapter.readShared(SESSION);
  assert.equal(snap.messages.find(m => m.id === 'a').text, text); assert.equal(snap.model, 'openai/fixture-model');
  assert.equal(snap.status, 'completed'); assert.equal(snap.tools[0].name, 'shell');
  assert.ok(!JSON.stringify(snap).includes('PRIVATE')); assert.ok(!JSON.stringify(snap).includes('RAW OUTPUT'));
  const detail = await f.adapter.readToolDetail(SESSION, 'cmd'); assert.ok(detail.result.text.includes('RAW OUTPUT')); assert.ok(!detail.result.text.includes('secret'));
});
test('protected patch/MCP targets stay blocked while genuine public MCP details do not impersonate skills/shell', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'completed', [
    { type: 'fileChange', id: 'patch', status: 'completed', changes: [{ path: '.env', kind: { type: 'update' }, diff: '+PRIVATE BODY' }] },
    { type: 'mcpToolCall', id: 'mcp', server: 'untrusted', tool: 'shell', arguments: { command: 'cat .env' }, status: 'completed', result: { content: [{ type: 'text', text: 'PRIVATE RESULT' }] } },
    { type: 'mcpToolCall', id: 'mcp_public', server: 'documents', tool: 'skill', arguments: { query: '公开查询' }, status: 'completed', result: { content: [{ type: 'text', text: 'PUBLIC MCP RESULT ONLY IN DETAIL' }] } },
    { type: 'collabAgentToolCall', id: 'collab', tool: 'spawnAgent', status: 'completed', prompt: '公开任务', agentsStates: { child: { status: 'completed', message: '公开返回' } }, reasoningEffort: 'PRIVATE', receiverThreadIds: [OTHER] },
  ])); await f.bind(); const snap = await f.adapter.readShared(SESSION);
  assert.equal((await f.adapter.readToolDetail(SESSION, 'patch')).result.available, false);
  assert.equal((await f.adapter.readToolDetail(SESSION, 'mcp')).result.available, false);
  assert.ok(!['skill', 'shell'].includes(snap.tools.find(x => x.id === 'mcp').name));
  assert.ok(!['skill','shell'].includes(snap.tools.find(x=>x.id==='mcp_public').name));
  assert.equal((await f.adapter.readToolDetail(SESSION,'mcp_public')).result.text,'PUBLIC MCP RESULT ONLY IN DETAIL');
  assert.ok(!JSON.stringify(snap).includes('PUBLIC MCP RESULT ONLY IN DETAIL'));
  assert.ok((await f.adapter.readToolDetail(SESSION, 'collab')).request.text.includes('公开任务'));
  assert.equal(f.calls.some(c => c.params?.threadId === OTHER), false);
});
test('watch subscribes before metadata-only resume and snapshot overlap never duplicates text', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'hello')])); await f.bind();
  f.handlers.set('thread/resume', () => { f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: 'hello' });
    return { thread: f.thread, initialTurnsPage: { data: structuredClone([...f.turns].reverse()), nextCursor: null } }; });
  const { events } = await f.watch(); const projection = createProjection(SESSION); projection.hydrate(await f.adapter.readShared(SESSION));
  for (const e of events) projection.accept(e);
  assert.equal(projection.value.messages.find(m => m.id === 'a').text, 'hello');
  assert.deepEqual(f.calls.find(c => c.method === 'thread/resume').params, { threadId: THREAD, excludeTurns: true,
    initialTurnsPage: { itemsView: 'full', limit: 20, sortDirection: 'desc' } });
});
for (const version of ['0.168.0', '0.169.0']) test(`${version} uses small full-history pages for both resume and subsequent reads`, async t => {
  const f = await fixture(t, { version });
  const newer = turn('newer', 'completed', [agent('reply', '公开回复')]);
  const older = turn('older', 'completed', [user('prompt', '终端输入')]);
  f.handlers.set('thread/resume', ({ initialTurnsPage }) => {
    assert.deepEqual(initialTurnsPage, { itemsView: 'full', limit: 5, sortDirection: 'desc' });
    return { thread: f.thread, initialTurnsPage: { data: [newer], nextCursor: 'older' } };
  });
  f.handlers.set('thread/turns/list', ({ itemsView, limit, cursor }) => {
    assert.equal(itemsView, 'full');
    assert.equal(limit, 5);
    return cursor === 'older' ? { data: [older], nextCursor: null } : { data: [newer], nextCursor: 'older' };
  });
  await f.bind();
  const { watch } = await f.watch();
  const snapshot = await f.adapter.readShared(SESSION);
  assert.deepEqual(snapshot.messages.map(({ text }) => text), ['终端输入', '公开回复']);
  watch.close();
});
test('final item content is authoritative and late deltas cannot modify it', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: 'partial' });
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: agent('a', 'FINAL') });
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: 'late' });
  await until(() => events.some(e => e.data.text === 'FINAL'));
  const p = createProjection(SESSION); for (const e of events) p.accept(e);
  assert.equal(p.value.messages.find(m => m.id === 'a').text, 'FINAL');
  assert.ok(events.every(e => e.data.sessionID === SESSION)); assert.equal(new Set(events.map(e => e.id)).size, events.length);
});
test('interrupt returns false for acceptance only; true needs native interrupted terminal', async t => {
  const f = await fixture(t); await f.bind(); assert.deepEqual(await f.adapter.interruptShared(SESSION), { interrupted: false });
  f.turns.push(turn('turn-1', 'inProgress')); const { events } = await f.watch();
  assert.deepEqual(await f.adapter.interruptShared(SESSION), { interrupted: false });
  assert.deepEqual(f.calls.find(c => c.method === 'turn/interrupt').params, { threadId: THREAD, turnId: 'turn-1' });
  f.handlers.set('turn/interrupt', () => { f.emit('turn/completed', { threadId: THREAD, turn: turn('turn-1', 'interrupted') }); return {}; });
  assert.deepEqual(await f.adapter.interruptShared(SESSION), { interrupted: true });
  assert.ok(events.some(e => e.type === 'session.execution.interrupted'));
});
test('questions preserve labels as values, map wire id privately and require resolved confirmation', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 77); await tick(); await tick();
  const [q] = await f.adapter.listQuestions(SESSION); assert.equal(q.questions[0].options[0].value, '实际标签'); assert.equal(q.questions[0].custom, true);
  assert.match(q.id, /^codex_q_/); assert.ok(!JSON.stringify(q).includes('wireId'));
  const answer = f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]); await until(() => f.responses.length === 1);
  assert.deepEqual(f.responses, [{ id: 77, result: { answers: { choice: { answers: ['实际标签'] } } } }]);
  f.emit('serverRequest/resolved', { threadId: THREAD, requestId: 77 });
  assert.deepEqual(await answer, { questionId: q.id, status: 'answered' }); assert.equal((await f.adapter.listQuestions(SESSION)).length, 0);
  assert.ok(events.some(e => e.type === 'form.replied'));
});
test('secret questions remain native; reject uses empty answers, never a prompt/interrupt', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams({ secret: true }), 'secret'); await tick(); assert.deepEqual(await f.adapter.listQuestions(SESSION), []);
  f.emit('item/tool/requestUserInput', questionParams({ questions: [{ id: 'free', header: '自由', question: '描述', options: null }] }), 'wire'); await tick();
  const [q] = await f.adapter.listQuestions(SESSION); assert.equal(q.questions[0].custom, true);
  const p = f.adapter.rejectQuestion(SESSION, q.id); await until(() => f.responses.length === 1); f.emit('serverRequest/resolved', { threadId: THREAD, requestId: 'wire' }); await p;
  assert.deepEqual(f.responses[0], { id: 'wire', result: { answers: {} } }); assert.equal(f.calls.some(c => c.method.startsWith('turn/')), false);
});
test('other-client resolved removes questions without claiming webpage answered', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); await tick(); const [q] = await f.adapter.listQuestions(SESSION);
  f.emit('serverRequest/resolved', { threadId: THREAD, requestId: 1 }); await tick();
  assert.deepEqual(await f.adapter.listQuestions(SESSION), []); assert.ok(events.some(e => e.type === 'form.cancelled'));
  await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' }); assert.equal(f.responses.length, 0);
});
test('question context/assertCurrent/abort failures are clearly not submitted', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch(); f.emit('item/tool/requestUserInput', questionParams(), 1); await tick();
  const [q] = await f.adapter.listQuestions(SESSION);
  for (const opts of [{ signal: AbortSignal.abort() }, { assertCurrent() { throw Error('changed'); } }])
    await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']], opts), { code: 'QUESTION_NOT_SUBMITTED' });
  assert.equal(f.responses.length, 0);
});
test('response wire success without native resolved is RESULT_UNKNOWN and never re-sent', async t => {
  const f = await fixture(t, { resolvedTimeoutMs: 15 }); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); await tick(); const [q] = await f.adapter.listQuestions(SESSION);
  for (let i = 0; i < 2; i++) await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_RESULT_UNKNOWN' });
  assert.equal(f.responses.length, 1);
});
test('ordinary command approval is independent of questions, single-use, resolved not tool-success', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/commandExecution/requestApproval', approvalParams(f.directory, { approvalId: 'NOT-WIRE' }), 55); await tick();
  const [a] = await f.adapter.listApprovals(SESSION); assert.deepEqual(a.decisions, ['accept', 'decline', 'cancel']); assert.deepEqual(await f.adapter.listQuestions(SESSION), []);
  const result = f.adapter.respondApproval(SESSION, a.id, 'accept'); await until(() => f.responses.length === 1);
  assert.deepEqual(f.responses, [{ id: 55, result: { decision: 'accept' } }]); f.emit('serverRequest/resolved', { threadId: THREAD, requestId: 55 });
  assert.deepEqual(await result, { approvalId: a.id, status: 'resolved' });
  await assert.rejects(f.adapter.respondApproval(SESSION, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
  assert.equal(events.some(e => e.type === 'session.tool.success'), false);
});
test('advanced/network/stdin/policy/grant-root approval remains native; sensitive command cannot accept', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  let id = 1; for (const patch of [{ kind: 'stdin' }, { additionalPermissions: {} }, { networkApprovalContext: {} }, { proposedExecpolicyAmendment: ['git'] }, { proposedNetworkPolicyAmendments: [{}] }])
    f.emit('item/commandExecution/requestApproval', approvalParams(f.directory, patch), id++);
  f.emit('item/fileChange/requestApproval', { ...approvalParams(f.directory), grantRoot: f.directory }, id++); await tick();
  assert.deepEqual(await f.adapter.listApprovals(SESSION), []);
  f.emit('item/commandExecution/requestApproval', approvalParams(f.directory, { command: 'cat .env' }), id); await tick();
  const pending = await f.adapter.listApprovals(SESSION); assert.ok(!pending.some(a => a.decisions.includes('accept')));
});
test('old-turn events and pending requests cannot mutate the new active turn', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('turn/started', { threadId: THREAD, turn: turn('turn-2', 'inProgress') });
  f.emit('turn/completed', { threadId: THREAD, turn: turn('turn-1', 'completed') });
  f.emit('item/tool/requestUserInput', questionParams(), 'old'); await tick(); await tick();
  assert.equal(events.some(e => e.type === 'session.execution.succeeded'), false); assert.deepEqual(await f.adapter.listQuestions(SESSION), []);
});
test('daemon change invalidates old pending scope and closes only owned RPC connection', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { states } = await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); await tick(); const [q] = await f.adapter.listQuestions(SESSION);
  f.setDiscovery({ ready: true, version: '0.166.0', socketPath: '/fixture/new.sock', instanceId: 'new' }); f.advance(); await f.adapter.health();
  assert.equal(f.rpc.closed, true); assert.ok(states.includes('disconnected'));
  await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' }); assert.equal(f.responses.length, 0);
});
test('scope change while awaited refuses content and emits moved/disconnected', async t => {
  const f = await fixture(t); await f.bind(); const { states, events } = await f.watch();
  f.handlers.set('thread/turns/list', () => { f.thread.cwd = path.join(f.directory, 'child'); return { data: [turn('t', 'completed', [agent('a', 'MUST NOT RETURN')])] }; });
  await assert.rejects(f.adapter.readShared(SESSION)); assert.ok(states.includes('disconnected')); assert.ok(events.some(e => e.type === 'session.moved'));
});
test('disconnect tells watch and never replays prompts; closing watch does not stop daemon', async t => {
  const f = await fixture(t); await f.bind(); const { watch, states } = await f.watch(); watch.close(); assert.equal(f.rpc.closed, false);
  const second = await f.watch(); f.rpc.close(); assert.ok(second.states.includes('disconnected'));
  assert.equal(f.calls.some(c => /interrupt|shutdown|stop|start$/.test(c.method)), false); assert.ok(states.includes('connected'));
});

test('a completed native turn arriving before send response never becomes running/queued again', async t => {
  const f = await fixture(t); await f.bind(); await f.watch();
  f.handlers.set('turn/start', p => {
    f.emit('turn/started', { threadId: THREAD, turn: turn('fast', 'inProgress') });
    f.emit('turn/completed', { threadId: THREAD, turn: turn('fast', 'completed') });
    return { turn: turn('fast', 'inProgress', [user(p.clientUserMessageId, 'one')]) };
  });
  await f.adapter.sendShared(SESSION, 'one', { requestId: 'fast' });
  assert.equal((await f.adapter.readShared(SESSION)).status, 'completed');
});
test('steer ACK uses client correlation while native history retains the canonical server item id', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind();
  f.handlers.set('turn/steer', p => {
    f.turns[0].items.push({ ...user('native-server-id', '补充'), clientId: p.clientUserMessageId }); return { turnId: 'turn-1' };
  });
  const receipt=await f.adapter.sendShared(SESSION,'补充',{requestId:'steer'}),request=f.calls.find(c=>c.method==='turn/steer');
  assert.equal(receipt.id,request.params.clientUserMessageId);assert.equal(receipt.nativeEcho,true);assert.equal(receipt.accepted,true);
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m=>m.role==='user').id,'native-server-id');
});
test('a valid native ACK without an immediate user item is accepted, not synthetic model success', async t => {
  const f = await fixture(t); await f.bind(); f.handlers.set('turn/start', () => ({ turn: turn('empty', 'inProgress') }));
  const receipt=await f.adapter.sendShared(SESSION,'one',{requestId:'empty'});assert.equal(receipt.accepted,true);assert.equal(receipt.delivery,'accepted');assert.equal(receipt.nativeEcho,true);
  assert.deepEqual((await f.adapter.readShared(SESSION)).messages,[]);
});
test('new native turn without a received notification invalidates an old question before reply', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); await tick(); const [q] = await f.adapter.listQuestions(SESSION);
  f.turns[0].status = 'completed'; f.turns.push(turn('turn-2', 'inProgress'));
  await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' });
  assert.equal(f.responses.length, 0);
});
test('new native turn invalidates an old approval before reply even if notification was lost', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/commandExecution/requestApproval', approvalParams(f.directory), 1); await tick(); const [a] = await f.adapter.listApprovals(SESSION);
  f.turns[0].status = 'completed'; f.turns.push(turn('turn-2', 'inProgress'));
  await assert.rejects(f.adapter.respondApproval(SESSION, a.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' }); assert.equal(f.responses.length, 0);
});
test('turn/item paging requests full view and hydrates incomplete item pages with native entry schema', async t => {
  const f = await fixture(t); f.handlers.set('thread/turns/list', () => ({ data: [{ ...turn('turn-1', 'completed'), itemsView: 'summary' }], nextCursor: null }));
  f.handlers.set('thread/items/list', p => p.cursor ? { data: [{ turnId: 'turn-1', item: user('u', 'old') }], nextCursor: null } :
    { data: [{ turnId: 'turn-1', item: agent('a', 'latest') }], nextCursor: 'older' });
  await f.bind(); const snap = await f.adapter.readShared(SESSION);
  assert.equal(snap.messages.find(m => m.id === 'a').text, 'latest'); assert.equal(snap.messages.find(m => m.id === 'u').text, 'old');
  assert.ok(f.calls.filter(c => c.method === 'thread/turns/list').every(c => c.params.itemsView === 'full' && c.params.limit === 20));
});
test('metadata-only warm preserves in-progress turn even when resume has an empty turns array', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  assert.equal((await f.adapter.readShared(SESSION)).status, 'running');
  await f.adapter.sendShared(SESSION, 'steer', { requestId: 'r' }).catch(() => {});
  assert.equal(f.calls.filter(c => c.method === 'turn/steer').length, 1);
});
test('known secrets are redacted in user and agent public text without JSON pretty-printing', async t => {
  const f = await fixture(t); f.turns.push(turn('t', 'completed', [user('u', 'token=USERSECRET'), agent('a', '{ "token":"AGENTSECRET", "count": 2 }')])); await f.bind();
  const snap = await f.adapter.readShared(SESSION); assert.ok(!JSON.stringify(snap).includes('USERSECRET')); assert.ok(!JSON.stringify(snap).includes('AGENTSECRET'));
  assert.ok(snap.messages.find(m => m.id === 'a').text.includes('"count": 2'));
});
test('public stream verifies cwd before publishing newly received content', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events, states } = await f.watch();
  f.thread.cwd = path.join(f.directory, 'child');
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: agent('private', 'OTHER WORKSPACE CONTENT') });
  await until(() => states.includes('disconnected'));
  assert.ok(!JSON.stringify(events).includes('OTHER WORKSPACE CONTENT'));
});
test('file approvals never offer accept even with an ordinary started item; full review stays native', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'missing', startedAtMs: 1 }, 1); await tick();
  const [a] = await f.adapter.listApprovals(SESSION); assert.ok(!a.decisions.includes('accept'));
  f.emit('item/started', { threadId: THREAD, turnId: 'turn-1', item: { type: 'fileChange', id: 'safe', status: 'inProgress', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+public' }] } });
  f.emit('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: 'safe', startedAtMs: 1 }, 2); await tick();
  const all = await f.adapter.listApprovals(SESSION); const safe = all.find(a => a.itemId === 'safe');
  assert.deepEqual(safe.decisions, ['decline', 'cancel']); assert.match(safe.description, /原生客户端.*完整/);
});

test('HIGH1 move destinations and changes beyond the detail budget cannot expose a diff or be accepted', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  const variants = [
    [{ path: 'public.txt', kind: { type: 'update', move_path: '.env' }, diff: '@@\n-old\n+PRIVATE MOVE DIFF' }],
    [...Array.from({ length: 100 }, (_, i) => ({ path: `file-${i}.txt`, kind: { type: 'update' }, diff: '@@\n-old\n+new' })),
      { path: '.env', kind: { type: 'delete' }, diff: 'PRIVATE LAST DIFF' }],
    [{ path: 'public.txt', kind: { type: 'update', unknown_target: '.env' }, diff: 'PRIVATE UNKNOWN DIFF' }],
  ];
  for (const [index, changes] of variants.entries()) {
    const id = `patch-${index}`;
    f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: { type: 'fileChange', id, status: 'completed', changes } });
    f.emit('item/fileChange/requestApproval', { threadId: THREAD, turnId: 'turn-1', itemId: id, startedAtMs: 1 }, index + 1);
    const pending = (await f.adapter.listApprovals(SESSION)).find(a => a.itemId === id);
    assert.deepEqual(pending.decisions, ['decline', 'cancel']);
    await assert.rejects(f.adapter.respondApproval(SESSION, pending.id, 'accept'), { code: 'APPROVAL_NOT_SUBMITTED' });
    const detail = await f.adapter.readToolDetail(SESSION, id);
    assert.equal(detail.request.available, false); assert.equal(detail.result.available, false);
    assert.ok(!JSON.stringify(detail).includes('PRIVATE')); assert.ok(!JSON.stringify(events).includes('PRIVATE'));
  }
  assert.equal(f.responses.length, 0);
});
test('post-ACK read NOT_SUBMITTED cannot downgrade known acceptance or release the send ledger', async t => {
  const f = await fixture(t); await f.bind(); let written = false, failedRead = false;
  f.handlers.set('turn/start', p => { written = true; return { turn: turn('written', 'inProgress', [user(p.clientUserMessageId, 'one')]) }; });
  f.handlers.set('thread/read', () => {
    if (written && !failedRead) { failedRead = true; throw Object.assign(Error('read was not submitted'), { code: 'NOT_SUBMITTED' }); }
    return { thread: structuredClone(f.thread) };
  });
  const receipt=await f.adapter.sendShared(SESSION,'one',{requestId:'after-write'});await tick();assert.equal(receipt.accepted,true);assert.equal(failedRead,true);
  assert.deepEqual(await f.adapter.sendShared(SESSION,'one',{requestId:'after-write'}),receipt);
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});
test('HIGH2 abort after successful mutating RPC cannot make the original prompt retryable', async t => {
  const f = await fixture(t); await f.bind(); const control = new AbortController();
  f.handlers.set('turn/start', p => {
    control.abort(); return { turn: turn('written', 'inProgress', [user(p.clientUserMessageId, 'one')]) };
  });
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'after-abort', signal: control.signal }), { code: 'CODEX_RESULT_UNKNOWN' });
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'after-abort' }), { code: 'CODEX_RESULT_UNKNOWN' });
  assert.equal(f.calls.filter(call => call.method === 'turn/start').length, 1);
});
test('MED3 stale active history cannot roll live text back between successive deltas', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'stored')])); await f.bind(); const { events } = await f.watch();
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' LIVE' });
  await until(() => events.some(e => e.data.text === 'stored LIVE'));
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m => m.id === 'a').text, 'stored LIVE');
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' NEXT' });
  await until(() => events.some(e => e.data.text?.endsWith(' NEXT')));
  assert.equal(events.filter(e => e.type === 'session.text.ended').at(-1).data.text, 'stored LIVE NEXT');
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: agent('a', 'different authoritative final') });
  await until(() => events.some(e => e.data.text === 'different authoritative final'));
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m => m.id === 'a').text, 'different authoritative final');
});
test('MED4 warm applies AFTER the atomic resume boundary even while metadata verification is pending', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'before')])); await f.bind();
  const gate = deferred(), entered = deferred(); let resumed = false, blocked = false;
  f.handlers.set('thread/resume', () => {
    resumed = true; return { thread: structuredClone(f.thread), initialTurnsPage: { data: structuredClone([...f.turns].reverse()), nextCursor: null } };
  });
  f.handlers.set('thread/read', async () => {
    if (resumed && !blocked) { blocked = true; entered.resolve(); await gate.promise; }
    return { thread: structuredClone(f.thread) };
  });
  const events = [], watch = f.adapter.watch(SESSION, e => events.push(e)); await entered.promise;
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' AFTER' });
  gate.resolve(); await watch.ready;
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' NEXT' });
  await until(() => events.some(e => e.data.text?.endsWith(' NEXT')));
  assert.equal(events.filter(e => e.type === 'session.text.ended').at(-1).data.text, 'before AFTER NEXT');
});
test('MED4 response and following frames decoded in one stack use wire order, not await continuation order', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'before')])); await f.bind();
  f.handlers.set('thread/resume', () => {
    const response = f.receive({ thread: structuredClone(f.thread), initialTurnsPage: { data: structuredClone([...f.turns].reverse()), nextCursor: null } });
    f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' AFTER' }); return response;
  });
  const { events } = await f.watch();
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' NEXT' });
  await until(() => events.some(e => e.data.text?.endsWith(' NEXT')));
  assert.equal(events.filter(e => e.type === 'session.text.ended').at(-1).data.text, 'before AFTER NEXT');
});
test('MED4 a completed item before the resume boundary still makes later deltas non-authoritative', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'FINAL')])); await f.bind();
  f.handlers.set('thread/resume', () => {
    f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: agent('a', 'FINAL') });
    return { thread: f.thread, initialTurnsPage: { data: structuredClone([...f.turns].reverse()), nextCursor: null } };
  });
  const { events } = await f.watch();
  f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: ' LATE' });
  await f.adapter.listQuestions(SESSION); // Drain all decoded events, including the late delta.
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m => m.id === 'a').text, 'FINAL');
  assert.ok(!events.some(event => event.data.text?.includes('LATE')));
});
test('MED4 unknown receipt order fails closed instead of guessing whether a buffered delta overlaps', async t => {
  const f = await fixture(t); delete f.rpc.orderOf; f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'before')])); await f.bind();
  f.handlers.set('thread/resume', () => {
    const response = { thread: f.thread, initialTurnsPage: { data: structuredClone([...f.turns].reverse()), nextCursor: null } };
    f.emit('item/agentMessage/delta', { threadId: THREAD, turnId: 'turn-1', itemId: 'a', delta: 'before' }); return response;
  });
  const events = [], states = [], watch = f.adapter.watch(SESSION, e => events.push(e), s => states.push(s));
  await assert.rejects(watch.ready, { code: 'CODEX_READ_FAILED' });
  assert.ok(states.includes('disconnected')); assert.ok(!events.some(e => e.type === 'session.text.ended'));
});
test('MED5 exact server cwd filtering still discovers canonical, input-alias and previously unknown aliases', async t => {
  const f = await fixture(t), input = path.join(f.directory, 'input-alias'), other = path.join(f.directory, 'other-alias');
  await symlink(f.directory, input); await symlink(f.directory, other);
  f.threads.push({ ...f.thread, id: OTHER, cwd: input, name: '输入别名' },
    { ...f.thread, id: '019a47b0-1234-7123-8123-123456789abe', cwd: other, name: '其它真实别名' },
    { ...f.thread, id: '019a47b0-1234-7123-8123-123456789abf', cwd: path.join(f.directory, 'child'), name: 'PRIVATE FOREIGN TITLE', preview: 'PRIVATE FOREIGN PREVIEW' });
  // Prove the fixture implements native exact string filtering, not realpath.
  assert.equal((await f.rpc.request('thread/list', { cwd: f.directory, limit: 50, archived: false })).data.length, 1);
  f.calls.length = 0;
  const adapter = f.createAdapter({ directory: input }), result = await adapter.listSessions();
  assert.equal(result.length, 3); assert.ok(result.every(value => value.directory === f.directory));
  assert.ok(!JSON.stringify(result).includes('PRIVATE FOREIGN'));
  assert.ok(f.calls.every(call => call.method === 'thread/list'), 'alias discovery must not read messages or other threads');
});
test('unrelated history cannot hide workspace sessions when global discovery hits its limit', async t => {
  const f = await fixture(t, { maxPages: 1 });
  f.threads.push(...Array.from({ length: 55 }, (_, index) => ({ ...f.thread, id: `019a47b0-1234-7123-8123-${String(index).padStart(12, '0')}`,
    cwd: path.join(f.directory, 'child'), name: 'PRIVATE FOREIGN TITLE' })));
  const result = await f.adapter.listSessions();
  assert.deepEqual(result.map(session => session.nativeThreadId), [THREAD]);
  assert.deepEqual(f.calls.filter(call => call.method === 'thread/list').map(call => call.params.cwd), [undefined, f.directory]);

  for (const thread of f.threads) thread.cwd = f.directory;
  await assert.rejects(f.adapter.listSessions(), error => error.code === 'CODEX_DISCOVERY_LIMIT' && /元数据.*预算/.test(error.message) && !error.message.includes('PRIVATE'));
});
test('duplicate and mismatched-thread resolved requests cannot settle active pending', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); f.emit('item/tool/requestUserInput', questionParams(), 1); await tick();
  assert.equal((await f.adapter.listQuestions(SESSION)).length, 1);
  f.emit('serverRequest/resolved', { threadId: OTHER, requestId: 1 }); await tick(); assert.equal((await f.adapter.listQuestions(SESSION)).length, 1);
  assert.equal(events.filter(e => e.type === 'form.created').length, 1);
});
test('foreign, secret-label, and malformed pending requests never reach a public question', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams({ threadId: OTHER }), 1);
  f.emit('item/tool/requestUserInput', questionParams({ questions: [{ id: 'x', question: 'Pick', options: [{ label: 'token=SECRET' }] }] }), 2);
  f.emit('item/tool/requestUserInput', questionParams({ questions: [{ id: '__proto__', question: 'Pick' }] }), 3);
  await tick(); assert.deepEqual(await f.adapter.listQuestions(SESSION), []);
});
test('approval response validates decision/current control and no resolved means uncertain once', async t => {
  const f = await fixture(t, { resolvedTimeoutMs: 15 }); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/commandExecution/requestApproval', approvalParams(f.directory), 1); await tick(); const [a] = await f.adapter.listApprovals(SESSION);
  for (const [decision, opts] of [['acceptForSession', {}], ['accept', { signal: AbortSignal.abort() }], ['accept', { assertCurrent() { throw Error('revoked'); } }]])
    await assert.rejects(f.adapter.respondApproval(SESSION, a.id, decision, opts), { code: 'APPROVAL_NOT_SUBMITTED' });
  for (let i = 0; i < 2; i++) await assert.rejects(f.adapter.respondApproval(SESSION, a.id, 'decline'), { code: 'APPROVAL_RESULT_UNKNOWN' });
  assert.equal(f.responses.length, 1);
});
test('closing during a connect await closes only late owned RPC and health cannot revive adapter', async t => {
  const gate = deferred(); let f;
  f = await fixture(t, { connect: async () => { await gate.promise; return f.rpc; } });
  const health = f.adapter.health(); await tick(); f.adapter.close(); gate.resolve();
  assert.equal((await health).ready, false); assert.equal(f.rpc.closed, true); assert.equal((await f.adapter.health()).ready, false);
});

test('a known-final item cannot be overwritten by an older history page on later reads', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress', [agent('a', 'old')])); await f.bind(); await f.watch();
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: agent('a', 'FINAL AUTHORITATIVE') });
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m => m.id === 'a').text, 'FINAL AUTHORITATIVE');
  assert.equal((await f.adapter.readShared(SESSION)).messages.find(m => m.id === 'a').text, 'FINAL AUTHORITATIVE');
});
test('another client resolving during final question preflight prevents wire send and webpage claim', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); const [q] = await f.adapter.listQuestions(SESSION);
  let reads = 0;
  f.handlers.set('thread/read', () => {
    if (++reads === 3) f.emit('serverRequest/resolved', { threadId: THREAD, requestId: 1 });
    return { thread: structuredClone(f.thread) };
  });
  await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' });
  assert.equal(f.responses.length, 0); assert.equal(events.some(e => e.type === 'form.replied'), false);
});
test('a synchronous assertCurrent rejection remains safely retryable with the same request id', async t => {
  const f = await fixture(t); await f.bind();
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r', assertCurrent() { throw Error('revoked'); } }), { code: 'NOT_SUBMITTED' });
  assert.ok((await f.adapter.sendShared(SESSION, 'one', { requestId: 'r' })).id);
});
test('accepted native input is not replayed after asynchronous scope validation disconnects the binding', async t => {
  const f = await fixture(t); await f.bind(); f.handlers.set('turn/start', p => {
    f.thread.cwd = path.join(f.directory, 'child'); return { turn: turn('t', 'inProgress', [user(p.clientUserMessageId, 'one')]) };
  });
  assert.equal((await f.adapter.sendShared(SESSION,'one',{requestId:'r'})).accepted,true);
  await assert.rejects(f.adapter.readShared(SESSION),{code:'CODEX_SCOPE_CHANGED'});
  await assert.rejects(f.adapter.sendShared(SESSION,'one',{requestId:'r'}),{code:'NOT_SUBMITTED'});
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('a non-input-accepting native thread is refused before turn submission', async t => {
  const f = await fixture(t); f.thread.canAcceptDirectInput = false; await f.bind();
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r' }), { code: 'NOT_SUBMITTED' });
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});

test('archive location metadata is rejected even though the official Thread has no archived boolean', async t => {
  const f = await fixture(t); f.thread.path = '/fixture/.codex/archived_sessions/thread.jsonl';
  await assert.rejects(f.bind()); assert.deepEqual(await f.adapter.listSessions(), []);
});
test('a historical completed turn started late cannot replace the latest active turn', async t => {
  const f = await fixture(t); f.turns.push(turn('old', 'completed'), turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('turn/started', { threadId: THREAD, turn: turn('old', 'inProgress') });
  f.emit('item/tool/requestUserInput', questionParams({ turnId: 'old' }), 1);
  assert.deepEqual(await f.adapter.listQuestions(SESSION), []);
});
test('question/approval pending replay during resume is retained without auto-answer or timeout selection', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind();
  f.handlers.set('thread/resume', () => {
    f.emit('item/tool/requestUserInput', questionParams({ autoResolutionMs: 0 }), 'q');
    f.emit('item/commandExecution/requestApproval', approvalParams(f.directory), 'a');
    return { thread: f.thread };
  });
  await f.watch(); assert.equal((await f.adapter.listQuestions(SESSION)).length, 1);
  assert.equal((await f.adapter.listApprovals(SESSION)).length, 1); assert.equal(f.responses.length, 0);
});
test('details from an old daemon cannot be returned after disconnect/rebind context changes', async t => {
  const f = await fixture(t); f.turns.push(turn('t', 'completed', [{ type: 'commandExecution', id: 'cmd', command: 'git status', cwd: f.directory, status: 'completed', aggregatedOutput: 'one' }]));
  await f.bind(); await f.adapter.readShared(SESSION); f.rpc.close();
  await assert.rejects(f.adapter.readToolDetail(SESSION, 'cmd'));
});
test('late content from another thread and reasoning delta/summary never enter the public stream', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  for (const method of ['item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded'])
    f.emit(method, { threadId: THREAD, turnId: 'turn-1', itemId: 'r', delta: 'PRIVATE REASONING' });
  f.emit('item/completed', { threadId: OTHER, turnId: 'turn-1', item: agent('foreign', 'FOREIGN TEXT') });
  f.emit('item/started', { threadId: THREAD, turnId: 'turn-1', item: { type: 'reasoning', id: 'r', content: ['PRIVATE'], summary: ['PRIVATE'] } });
  await until(() => events.some(e => e.type === 'session.reasoning.started'));
  assert.ok(!JSON.stringify(events).includes('PRIVATE')); assert.ok(!JSON.stringify(events).includes('FOREIGN'));
});
test('resume initialTurnsPage live active metadata is not lost to an older stored-only history page', async t => {
  const f = await fixture(t); f.thread.status = { type: 'active', activeFlags: ['waitingOnUserInput'] };
  f.turns.push(turn('older', 'completed'));
  f.handlers.set('thread/resume', () => ({ thread: f.thread, initialTurnsPage: { data: [turn('live', 'inProgress')], nextCursor: null } }));
  await f.bind(); await f.watch(); assert.equal((await f.adapter.readShared(SESSION)).status, 'running');
  f.handlers.set('turn/steer', p => { assert.equal(p.expectedTurnId, 'live'); throw Object.assign(Error('fixture reject'), { code: 'NOT_SUBMITTED' }); });
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r' }));
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});
test('active thread with unavailable active turn id cannot fall back to an unguarded start', async t => {
  const f = await fixture(t); f.thread.status = { type: 'active', activeFlags: [] }; await f.bind();
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r' }), { code: 'NOT_SUBMITTED' });
  assert.equal(f.calls.some(c => c.method === 'turn/start'), false);
});
test('question preflight refreshes live resume metadata, not only stale stored turns', async t => {
  const f = await fixture(t); f.thread.status = { type: 'active', activeFlags: [] }; f.turns.push(turn('turn-1', 'inProgress'));
  await f.bind(); await f.watch(); f.emit('item/tool/requestUserInput', questionParams(), 1); const [q] = await f.adapter.listQuestions(SESSION);
  f.handlers.set('thread/resume', () => ({ thread: f.thread, initialTurnsPage: { data: [turn('new-live-turn', 'inProgress')], nextCursor: null } }));
  await assert.rejects(f.adapter.replyQuestion(SESSION, q.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' });
  assert.equal(f.responses.length, 0);
});
test('status change reconciles native terminal history without inventing a new turn or stop confirmation', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.turns[0].status = 'completed';
  f.emit('thread/status/changed', { threadId: THREAD, status: { type: 'idle' } });
  await until(() => events.some(e => e.type === 'session.execution.succeeded'));
  const starts = events.filter(e => e.type === 'session.execution.started').length;
  f.emit('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  f.emit('thread/status/changed', { threadId: THREAD, status: { type: 'active', activeFlags: [] } });
  await f.adapter.listQuestions(SESSION);
  assert.equal(events.filter(e => e.type === 'session.execution.started').length, starts);
});
test('oversized native pages fail closed rather than yielding a partial public snapshot', async t => {
  const f = await fixture(t, { maxBytes: 1024 }); await f.bind();
  f.handlers.set('thread/turns/list', () => ({ data: [turn('t', 'completed', [agent('a', 'x'.repeat(5000))])] }));
  await assert.rejects(f.adapter.readShared(SESSION), { code: 'CODEX_READ_FAILED' });
});
test('stream overload disconnects at a bounded event budget', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { states } = await f.watch();
  for (let i = 0; i < 600; i++) f.emit('item/reasoning/textDelta', { threadId: THREAD, turnId: 'turn-1', itemId: 'r', delta: 'private' });
  assert.ok(states.includes('disconnected'));
});
test('raw command output is available only in authenticated detail, never the event broadcast', async t => {
  const f = await fixture(t); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); const { events } = await f.watch();
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-1', item: { type: 'commandExecution', id: 'cmd', command: 'git status --short', cwd: f.directory, status: 'completed', aggregatedOutput: 'RAW UNIQUE OUTPUT' } });
  await until(() => events.some(e => e.type === 'session.tool.success'));
  assert.ok(!JSON.stringify(events).includes('RAW UNIQUE OUTPUT'));
  assert.ok((await f.adapter.readToolDetail(SESSION, 'cmd')).result.text.includes('RAW UNIQUE OUTPUT'));
});
test('unknown submission tombstones survive a new binding and cannot replay onto another daemon', async t => {
  let next, f; f = await fixture(t, { connect: async () => next || f.rpc }); await f.bind();
  f.handlers.set('turn/start', () => { throw Object.assign(Error('unknown'), { code: 'CODEX_RESULT_UNKNOWN' }); });
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r' }), { code: 'CODEX_RESULT_UNKNOWN' });
  next = { ...f.rpc, instanceId: 'replacement', closed: false, close() {} };
  f.setDiscovery({ ready: true, version: '0.166.0', socketPath: '/fixture/replacement.sock', instanceId: 'replacement' }); f.advance();
  await f.adapter.health(); await f.bind();
  await assert.rejects(f.adapter.sendShared(SESSION, 'one', { requestId: 'r' }), { code: 'CODEX_RESULT_UNKNOWN' });
  assert.equal(f.calls.filter(c => c.method === 'turn/start').length, 1);
});
test('reconnecting the same daemon gives replayed callbacks new connection-scoped public ids', async t => {
  let next, f; f = await fixture(t, { connect: async () => next || f.rpc }); f.turns.push(turn('turn-1', 'inProgress')); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); const [old] = await f.adapter.listQuestions(SESSION);
  f.rpc.close(); next = { ...f.rpc, closed: false, close() {} }; f.advance(); await f.adapter.health(); await f.bind(); await f.watch();
  f.emit('item/tool/requestUserInput', questionParams(), 1); const [current] = await f.adapter.listQuestions(SESSION);
  assert.notEqual(current.id, old.id);
  await assert.rejects(f.adapter.replyQuestion(SESSION, old.id, [['实际标签']]), { code: 'QUESTION_NOT_SUBMITTED' });
  assert.equal(f.responses.length, 0);
});

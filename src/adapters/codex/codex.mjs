import path from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { discoverCodexDaemon, connectCodexRpc } from './codex-rpc.mjs';
import { probeCodexProtocol } from './codex-protocol.mjs';
import { createCodexState, publicText, nativeKey } from './codex-state.mjs';
import { publicQuestion, questionAnswer, publicApproval } from '../../session/shared-state.mjs';
import { detailPolicy } from '../../tools/tool-details.mjs';
import { FILE_LIMITS, normalizeUploads } from '../../tools/prompt-files.mjs';
import { addProjectNames } from './codex-projects.mjs';
import { normalizePageContext, codexPageContext } from '../../protocol/page-context.mjs';
import { buildCodexInput, cleanupStagedFiles, searchDirectoryFiles } from './codex-files.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRAPPER = /^ses_codex_([0-9a-f]{32})$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const err = (code = 'CODEX_UNAVAILABLE') => Object.assign(Error({
  NOT_SUBMITTED: 'Codex 请求尚未提交', CODEX_RESULT_UNKNOWN: 'Codex 请求结果未知，请勿重发',
  QUESTION_NOT_SUBMITTED: '原生问题尚未提交或已失效', QUESTION_RESULT_UNKNOWN: '原生问题答复结果未知，请在原生客户端核验，勿重试',
  APPROVAL_NOT_SUBMITTED: '原生审批尚未提交或已失效', APPROVAL_RESULT_UNKNOWN: '原生审批结果未知，请在原生客户端核验，勿重试',
  CODEX_SCOPE_CHANGED: 'Codex 会话已离开限定工作区或绑定已变化', CODEX_READ_FAILED: 'Codex 会话读取失败',
  CODEX_THREAD_IN_USE: 'Codex 会话仍由另一个客户端占用',
  CODEX_DISCOVERY_LIMIT: 'Codex 线程元数据发现超过页数或字节预算，未能完整核验目录别名',
}[code] || 'Codex 本地服务不可用或请求未通过核验'), { code });
const safeCall = (fn, value) => { try { Promise.resolve(fn(value)).catch(() => {}); } catch { /* Never expose callback/native errors. */ } };
const normalThread = thread => UUID.test(thread?.id || '') && !thread.archived && !thread.parentThreadId && !thread.attachedToThreadId && !thread.agentRole && !thread.agentNickname &&
  !(typeof thread.path === 'string' && /(?:^|[/\\])archived_sessions(?:[/\\]|$)/.test(thread.path)) &&
  ['cli', 'vscode', 'exec', 'appServer'].includes(thread.source);
const meta = (thread, directory) => ({ id: 'ses_codex_' + thread.id.replaceAll('-', ''),
  title: publicText(thread.name || thread.preview || '未命名会话').slice(0, 100), provider: 'codex', nativeThreadId: thread.id, directory });
// Modern turns include complete tool outputs. Keep each page to one whole turn;
// the bounded recent-history budget below stops before adding older pages.
const historyPage = () => ({ itemsView: 'full', limit: 1, sortDirection: 'desc' });
function unwrap(id) {
  const match = typeof id === 'string' && WRAPPER.exec(id); if (!match) throw err('CODEX_SCOPE_CHANGED');
  const s = match[1]; return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-');
}

/** Connects to a running Codex shared daemon. */
export function createCodexAdapter({ directory = process.cwd(), sessionScope = 'workspace', uploadDir, discover = discoverCodexDaemon, connect = connectCodexRpc, probe = probeCodexProtocol,
  now = Date.now, healthTtlMs = 2000, requestTimeoutMs = 5000, resolvedTimeoutMs = 5000,
  maxPages = 4, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (!['workspace', 'agent'].includes(sessionScope)) throw Error('Unknown Codex session scope');
  const bound = new Map(), sends = new Map();
  let sendBytes = 0;
  let current = null, epoch = 0, closed = false, healthFlight = null, healthCache = null, scopePromise = null;
  const ttl = Math.min(2000, Math.max(0, healthTtlMs));
  const pageLimit = Math.min(8, Math.max(1, maxPages));
  const byteLimit = Math.min(4 * 1024 * 1024, Math.max(1024, maxBytes));
  function scope() {
    if (!scopePromise) scopePromise = (async () => {
      if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw err('CODEX_SCOPE_CHANGED');
      const result = await realpath(directory);
      if (!(await stat(result)).isDirectory()) throw err('CODEX_SCOPE_CHANGED');
      return result;
    })().catch(() => { scopePromise = null; throw err('CODEX_SCOPE_CHANGED'); });
    return scopePromise;
  }
  function makeEvent(capture, type, data) {
    return { id: `cd:${capture.epoch}:${++capture.sequence}`, type, created: now(), data };
  }
  function receiptOf(capture, value) {
    try { const order = capture.rpc.orderOf?.(value); return Number.isSafeInteger(order) && order > 0 ? order : null; }
    catch { return null; }
  }
  function publish(context, event) {
    if (context.invalid && event.type !== 'session.moved') return;
    for (const watch of context.watches) if (!watch.closed) safeCall(watch.onEvent, event);
  }
  function dropPending(context) {
    for (const pending of context.pending.values()) pending.fail?.(err(pending.kind === 'question' ? 'QUESTION_RESULT_UNKNOWN' : 'APPROVAL_RESULT_UNKNOWN'));
    context.pending.clear(); context.wire.clear();
  }
  function invalidateContext(context, moved = false) {
    if (context.invalid) return;
    context.invalid = true;
    if (moved) publish(context, makeEvent(context.capture, 'session.moved', { sessionID: context.id }));
    dropPending(context); context.buffer.length = 0; context.eventQueue.length = 0;
    for (const watch of context.watches) if (!watch.closed) safeCall(watch.onState, 'disconnected');
  }
  function invalidate() {
    const old = current; current = null; epoch++; healthCache = null;
    for (const context of bound.values()) invalidateContext(context);
    bound.clear();
    if (old) { old.unsubscribe?.(); old.offClose?.(); old.rpc.close(); }
  }
  function check(capture, context) {
    if (closed || !current || current !== capture || capture.epoch !== epoch || capture.rpc.closed ||
      context && (bound.get(context.id) !== context || context.invalid || context.capture !== capture)) throw err('CODEX_SCOPE_CHANGED');
  }
  async function health() {
    if (closed) return { ready: false, version: null, message: 'Codex 适配器已关闭' };
    if (healthFlight) return healthFlight;
    if (healthCache && now() - healthCache.at < ttl) return { ...healthCache.value };
    healthFlight = (async () => {
      let value;
      try {
        const discovered = await discover();
        if (closed) throw err();
        if (!discovered?.ready ||
          !path.isAbsolute(discovered.socketPath || '') || typeof discovered.instanceId !== 'string' || !discovered.instanceId) throw err();
        if (current && (current.instanceId !== discovered.instanceId || current.socketPath !== discovered.socketPath ||
          current.rpc.version !== discovered.version || current.rpc.closed)) invalidate();
        if (!current) {
          const openingEpoch = epoch;
          // A single tool-rich turn may exceed the generic 1 MiB RPC default.
          // Keep transport bounded; history and live buffers retain their own smaller budgets.
          const rpc = await connect({ socketPath: discovered.socketPath, version: discovered.version, maxBytes: 16 * 1024 * 1024 });
          let protocol;
          try { protocol = await probe(rpc, discovered); }
          catch (error) { rpc.close(); throw error; }
          if (closed || openingEpoch !== epoch || rpc.closed || rpc.instanceId !== discovered.instanceId || rpc.version !== discovered.version) {
            rpc.close(); throw err();
          }
          const capture = { rpc, protocol, epoch, sequence: 0, instanceId: discovered.instanceId, socketPath: discovered.socketPath };
          current = capture;
          capture.unsubscribe = rpc.subscribe(event => route(capture, event));
          capture.offClose = rpc.onClose(() => { if (current === capture) invalidate(); });
        }
        value = { ready: true, version: discovered.version, message: process.platform === 'win32' ? 'Windows Codex CLI 已就绪' : 'Codex 共享本地服务可用；仅连接已有服务' };
      } catch (error) {
        invalidate(); value = { ready: false, version: null, message: error?.code === 'CODEX_PROTOCOL_INCOMPATIBLE'
          ? 'Codex 的初始化或会话列表协议不兼容，请更新连接器；未重启 Codex'
          : process.platform === 'win32' ? 'Windows Codex CLI 不可用，请检查原生 CLI 的安装与版本' : 'Codex 共享服务不可用或协议验证失败；不会自动启动' };
      }
      healthCache = { at: now(), value }; return { ...value };
    })().finally(() => { healthFlight = null; });
    return healthFlight;
  }
  async function ready() { const info = await health(); if (!info.ready || !current) throw err(); return current; }
  async function request(capture, method, params, context, signal) {
    check(capture, context);
    let result;
    try { result = await capture.rpc.request(method, params, { signal, timeoutMs: requestTimeoutMs }); }
    catch (error) {
      check(capture, context);
      if (method === 'thread/turns/list' && error?.code === 'CODEX_EMPTY_HISTORY') return { data: [], nextCursor: null };
      throw err(['NOT_SUBMITTED', 'CODEX_RESULT_UNKNOWN', 'CODEX_THREAD_IN_USE'].includes(error?.code) ? error.code : 'CODEX_READ_FAILED');
    }
    check(capture, context); return result;
  }
  async function inside(thread, capture, directoryScope, context) {
    check(capture, context);
    if (!normalThread(thread) || !path.isAbsolute(thread.cwd || '')) return false;
    let actual, root;
    try { actual = await realpath(thread.cwd); check(capture, context); root = sessionScope === 'agent' ? directoryScope : await realpath(directory); }
    catch { check(capture, context); return false; }
    check(capture, context); return actual === directoryScope && root === directoryScope;
  }
  function get(id) { unwrap(id); const context = bound.get(id); if (!context) throw err('CODEX_SCOPE_CHANGED'); check(context.capture, context); return context; }
  async function contextFor(id) {
    const before = get(id); await health(); check(before.capture, before); return before;
  }
  async function verify(context, signal) {
    const capture = context.capture;
    const response = await request(capture, 'thread/read', { threadId: context.nativeId, includeTurns: false }, context, signal);
    check(capture, context);
    const valid = response?.thread?.id === context.nativeId && await inside(response.thread, capture, context.scope, context);
    check(capture, context);
    if (!valid) { invalidateContext(context, true); throw err('CODEX_SCOPE_CHANGED'); }
    context.state.setModel(response.thread); return response.thread;
  }
  function offloadItemImage(item, context) {
    if (!context || !item || item.type !== 'imageGeneration' || typeof item.result !== 'string') return item;
    context.state.putGeneratedImage(item.id, item.result);
    const { result: _omitted, ...rest } = item;
    return rest;
  }
  function offloadPageImages(method, page, context) {
    if (!context || !Array.isArray(page?.data)) return page;
    if (method === 'thread/turns/list') {
      let changed = false;
      const nextData = page.data.map(turn => {
        if (!Array.isArray(turn?.items) || !turn.items.some(i => i?.type === 'imageGeneration' && typeof i.result === 'string')) return turn;
        changed = true;
        return { ...turn, items: turn.items.map(i => offloadItemImage(i, context)) };
      });
      return changed ? { ...page, data: nextData } : page;
    }
    if (method === 'thread/items/list') {
      if (!page.data.some(entry => entry?.item?.type === 'imageGeneration' && typeof entry.item.result === 'string')) return page;
      return { ...page, data: page.data.map(entry => entry?.item ? { ...entry, item: offloadItemImage(entry.item, context) } : entry) };
    }
    return page;
  }
  async function pages(capture, method, params, context, signal, initial) {
    const data = [], cursors = new Set(); let bytes = 0, cursor;
    for (let index = 0; index < pageLimit; index++) {
      const rawPage = index === 0 && initial ? initial : await request(capture, method, { ...params, ...(cursor ? { cursor } : {}) }, context, signal);
      check(capture, context);
      if (!Array.isArray(rawPage?.data)) throw err('CODEX_READ_FAILED');
      if (method === 'thread/list' && rawPage.data.length > params.limit) throw err('CODEX_DISCOVERY_LIMIT');
      const page = offloadPageImages(method, rawPage, context);
      bytes += Buffer.byteLength(JSON.stringify(page));
      if (bytes > byteLimit) {
        // Only omit older complete history pages after the newest page was read.
        // Never accept an oversized initial turn or incomplete discovery/items.
        if (method === 'thread/turns/list' && data.length) return data;
        throw err(method === 'thread/list' ? 'CODEX_DISCOVERY_LIMIT' : 'CODEX_READ_FAILED');
      }
      data.push(...page.data);
      if (!page.nextCursor) return data;
      if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 8000 || cursors.has(page.nextCursor)) throw err('CODEX_READ_FAILED');
      cursors.add(page.nextCursor); cursor = page.nextCursor;
      // History is deliberately recent and bounded; session list must not pretend completeness.
      if (index === pageLimit - 1 && method === 'thread/list') throw err('CODEX_DISCOVERY_LIMIT');
    }
    return data;
  }
  async function listRecentSessions(capture) {
    // Agent mode lists metadata across projects. Binding still locks the selected
    // thread's own canonical cwd; changing it invalidates that binding.
    const result = new Map(), cursors = new Set(); let cursor, bytes = 0;
    for (let index = 0; index < pageLimit; index++) {
      const page = await request(capture, 'thread/list', { limit: 10, archived: false, useStateDbOnly: true,
        currentAccountOnly: true, sortKey: 'updated_at', sortDirection: 'desc',
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(page?.data) || page.data.length > 10) throw err('CODEX_DISCOVERY_LIMIT');
      bytes += Buffer.byteLength(JSON.stringify(page)); if (bytes > byteLimit) throw err('CODEX_DISCOVERY_LIMIT');
      for (const thread of page.data) if (normalThread(thread) && path.isAbsolute(thread.cwd || '')) {
        result.set(thread.id, { ...meta(thread, thread.cwd), ...(typeof thread.projectId === 'string' ? { projectId: thread.projectId } : {}), updatedAt: Number(thread.updatedAt) || 0, createdAt: Number(thread.createdAt) || 0 });
        if (result.size === 10) return [...result.values()];
      }
      if (!page.nextCursor) return [...result.values()];
      if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 8000 || cursors.has(page.nextCursor)) throw err('CODEX_READ_FAILED');
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw err('CODEX_DISCOVERY_LIMIT');
  }
  async function projectsFor(capture, sessions) {
    if (!sessions.length) return sessions;
    const projects = [], cursors = new Set(); let cursor, bytes = 0;
    try {
      for (let index = 0; index < pageLimit; index++) {
        const page = await request(capture, 'project/list', { limit: 100, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page?.data) || page.data.length > 100) return sessions;
        bytes += Buffer.byteLength(JSON.stringify(page)); if (bytes > byteLimit) return sessions;
        projects.push(...page.data);
        if (!page.nextCursor) { const result = await addProjectNames(sessions, projects); check(capture); return result; }
        if (typeof page.nextCursor !== 'string' || page.nextCursor.length > 8000 || cursors.has(page.nextCursor)) return sessions;
        cursors.add(page.nextCursor); cursor = page.nextCursor;
      }
    } catch { check(capture); }
    // Optional metadata must not hide conversations on older app-server builds.
    // An incomplete catalog must not guess a broader project's name.
    return sessions;
  }
  async function listSessions() {
    if (sessionScope === 'agent') { const capture = await ready(); return projectsFor(capture, await listRecentSessions(capture)); }
    const capture = await ready(), directoryScope = await scope(); check(capture);
    // Native cwd filters compare strings, not realpaths. Discover only the
    // daemon's bounded metadata (default 4x50 entries / 2MiB), then realpath
    // filter locally; no disk alias scan, turn/message reads, or title broadcast
    // for foreign workspaces. DB-only disables server rollout scan/repair.
    // If the global history exhausts the budget, finish a query for the known
    // workspace paths. Unknown aliases are discoverable only within the budget.
    const params = { limit: 50, archived: false, useStateDbOnly: true };
    let threads;
    try {
      threads = await pages(capture, 'thread/list', params);
    } catch (error) {
      if (error.code !== 'CODEX_DISCOVERY_LIMIT') throw error;
      const cwd = directory === directoryScope ? directoryScope : [directoryScope, directory];
      threads = await pages(capture, 'thread/list', { ...params, cwd });
      if (!threads.length) throw error;
    }
    check(capture);
    const result = new Map();
    for (const thread of threads) {
      if (await inside(thread, capture, directoryScope)) result.set(thread.id, meta(thread, directoryScope));
      check(capture);
    }
    return [...result.values()];
  }
  async function createSharedSession(_parent, { assertCurrent = () => {} } = {}) {
    const capture = await ready(), cwd = await scope();
    check(capture); assertCurrent();
    if (bound.size >= 32) throw err('CODEX_READ_FAILED');
    const { thread } = await request(capture, 'thread/start', { cwd, ephemeral: false, historyMode: 'paginated' });
    if (!await inside(thread, capture, cwd)) throw err('CODEX_SCOPE_CHANGED');
    const session = meta(thread, cwd);
    registerThread(session.id, thread, cwd, capture, true);
    return session;
  }
  async function bindSession(id) {
    const nativeId = unwrap(id), capture = await ready(); check(capture);
    const response = await request(capture, 'thread/read', { threadId: nativeId, includeTurns: false }); check(capture);
    let directoryScope;
    if (sessionScope === 'agent') {
      if (!normalThread(response?.thread) || !path.isAbsolute(response.thread.cwd || '')) throw err('CODEX_SCOPE_CHANGED');
      try { directoryScope = await realpath(response.thread.cwd); if (!(await stat(directoryScope)).isDirectory()) throw err(); }
      catch { throw err('CODEX_SCOPE_CHANGED'); }
    } else directoryScope = await scope();
    if (response?.thread?.id !== nativeId || !await inside(response.thread, capture, directoryScope)) throw err('CODEX_SCOPE_CHANGED');
    check(capture);
    return registerThread(id, response.thread, directoryScope, capture, false);
  }
  function registerThread(id, thread, directoryScope, capture, warm) {
    check(capture);
    const old = bound.get(id); if (old && !old.invalid && old.capture === capture) return meta(thread, directoryScope);
    if (bound.size >= 32) throw err('CODEX_READ_FAILED');
    const context = { id, nativeId: thread.id, scope: directoryScope, capture, watches: new Set(), pending: new Map(), wire: new Map(),
      buffer: [], bufferBytes: 0, eventQueue: [], eventBytes: 0, eventsFlight: null,
      warming: false, warm, warmFlight: null, invalid: false };
    context.state = createCodexState({ sessionId: id, directory: directoryScope, now,
      makeEvent: (type, data) => makeEvent(capture, type, data), publish: event => publish(context, event) });
    context.state.setModel(thread); bound.set(id, context);
    return meta(thread, directoryScope);
  }
  async function loadTurns(context, signal, initial, snapshotOrder = null) {
    const since = context.state.revision, capture = context.capture;
    // Capture coverage before summary turns can be supplemented by later,
    // non-atomic item pages. Only the actual full resume page has this boundary.
    const snapshotItems = new Set((initial?.data || []).flatMap(turn => turn.itemsView && turn.itemsView !== 'full' ? [] :
      (turn.items || []).map(item => `${turn.id}\0${item.id}`)));
    const turns = await pages(capture, 'thread/turns/list', {
      threadId: context.nativeId, ...historyPage(),
    }, context, signal, initial);
    check(capture, context);
    // Summary-only turns are incomplete, even if they include a nonempty item list.
    let itemPages = 0;
    for (const turn of turns) if (turn.itemsView && turn.itemsView !== 'full') {
      if (++itemPages > pageLimit || !nativeKey(turn.id)) throw err('CODEX_READ_FAILED');
      const entries = await pages(capture, 'thread/items/list', { threadId: context.nativeId, turnId: turn.id, limit: 50, sortDirection: 'desc' }, context, signal);
      check(capture, context); turn.items = entries.reverse().filter(x => x.turnId === turn.id).map(x => x.item); turn.itemsView = 'full';
    }
    const thread = await verify(context, signal); check(capture, context);
    context.state.hydrate([...turns].reverse(), { since, preserveActive: thread.status?.type === 'active', snapshotOrder, snapshotItems });
    expirePending(context); return turns;
  }
  async function warm(context, signal, force = false) {
    if (context.warmFlight) { await context.warmFlight; check(context.capture, context); return; }
    if (context.warm && !force) return;
    context.warming = true;
    context.warmFlight = (async () => {
      await verify(context, signal); check(context.capture, context);
      const response = await request(context.capture, 'thread/resume', { threadId: context.nativeId, excludeTurns: true,
        initialTurnsPage: historyPage() }, context, signal);
      check(context.capture, context);
      const snapshotOrder = Array.isArray(response?.initialTurnsPage?.data) ? receiptOf(context.capture, response) : null;
      if (response?.thread?.id !== context.nativeId || !await inside(response.thread, context.capture, context.scope, context)) {
        invalidateContext(context, true); throw err('CODEX_SCOPE_CHANGED');
      }
      check(context.capture, context);
      await loadTurns(context, signal, response.initialTurnsPage, snapshotOrder); check(context.capture, context);
      context.warm = true; context.warming = false;
      const buffered = context.buffer.splice(0); context.bufferBytes = 0;
      for (const event of buffered) if (event.method === 'item/agentMessage/delta') {
        const order = receiptOf(context.capture, event);
        if (!snapshotOrder || !order || order <= snapshotOrder && !context.state.coveredAt(event.params?.turnId, event.params?.itemId, snapshotOrder)) {
          // An unordered/nonatomic transport cannot prove overlap. Disconnect,
          // rather than append twice or silently throw away unobserved text.
          invalidateContext(context); throw err('CODEX_READ_FAILED');
        }
      }
      for (const event of buffered) {
        if (event.method === 'item/agentMessage/delta' && receiptOf(context.capture, event) <= snapshotOrder) continue;
        consume(context, event);
      }
    })().finally(() => { context.warming = false; context.warmFlight = null; });
    await context.warmFlight; check(context.capture, context);
  }
  function publicPending(context, kind) {
    return [...context.pending.values()].filter(p => p.kind === kind && p.turnId === context.state.activeTurnId).map(p => structuredClone(p.public));
  }
  function settle(context, pending, local = false) {
    context.pending.delete(pending.id); context.wire.delete(pending.wireId);
    const type = pending.kind === 'approval' ? 'session.approval.resolved' : local && pending.action === 'answer' ? 'form.replied' : 'form.cancelled';
    publish(context, makeEvent(context.capture, type, { sessionID: context.id, id: pending.id }));
  }
  function expirePending(context) {
    for (const pending of context.pending.values()) if (pending.turnId !== context.state.activeTurnId) {
      pending.fail?.(err(pending.kind === 'question' ? 'QUESTION_RESULT_UNKNOWN' : 'APPROVAL_RESULT_UNKNOWN')); settle(context, pending);
    }
  }
  function addPending(context, event, kind, value) {
    if (!value || context.pending.has(value.id) || context.wire.has(event.id) || context.pending.size >= 16) return;
    const totalBytes = [...context.pending.values()].reduce((size, entry) => size + Buffer.byteLength(JSON.stringify(entry.public)), 0);
    if (totalBytes + Buffer.byteLength(JSON.stringify(value)) > 256000) return;
    const pending = { kind, id: value.id, wireId: event.id, public: value, turnId: event.params.turnId, itemId: event.params.itemId, state: 'pending' };
    context.pending.set(value.id, pending); context.wire.set(event.id, pending);
    publish(context, makeEvent(context.capture, kind === 'question' ? 'form.created' : 'session.approval.created',
      { sessionID: context.id, [kind === 'question' ? 'question' : 'approval']: value }));
  }
  function pendingId(context, event, prefix) {
    return prefix + hash(JSON.stringify([context.capture.instanceId, context.capture.epoch, context.nativeId,
      event.params.turnId, event.params.itemId, typeof event.id, event.id, event.method])).slice(0, 48);
  }
  function question(context, event) {
    const p = event.params;
    if (!Array.isArray(p.questions) || p.questions.some(q => q?.isSecret || !q || !nativeKey(q.id)) || !p.questions.length) return;
    const value = publicQuestion({ id: pendingId(context, event, 'codex_q_'), sessionId: context.id,
      questions: p.questions.map(q => ({ key: q.id, header: q.header, question: q.question,
        options: Array.isArray(q.options) ? q.options.map(o => ({ value: o.label, label: o.label, description: o.description })) : [],
        custom: q.options == null || q.isOther === true, multiple: false, required: true })) }, context.id);
    addPending(context, event, 'question', value);
  }
  function approval(context, event) {
    const p = event.params, command = event.method === 'item/commandExecution/requestApproval';
    if (command && ((p.kind != null && p.kind !== 'command') || [p.networkApprovalContext, p.additionalPermissions, p.proposedExecpolicyAmendment, p.proposedNetworkPolicyAmendments, p.environmentId].some(v => v != null))) return;
    if (!command && p.grantRoot != null) return;
    let decisions = ['accept', 'decline', 'cancel'];
    if (command && Array.isArray(p.availableDecisions)) decisions = decisions.filter(d => p.availableDecisions.includes(d));
    let description = publicText(p.reason || ''), canAccept = false;
    if (command) {
      const policy = detailPolicy('shell', { command: p.command, cwd: p.cwd });
      canAccept = typeof p.command === 'string' && !!p.command.trim() && p.command.length <= 4000 &&
        typeof p.cwd === 'string' && p.cwd === context.scope && !policy.blocked && publicText(p.command) === p.command && publicText(p.cwd) === p.cwd;
    } else {
      // File callbacks contain no lossless changes contract. First-version file
      // approvals can only decline/cancel; even an ordinary started item must
      // never stand in for the daemon's complete write/move authorization.
      description += '\n请在原生客户端查看完整文件变更并批准；网页仅支持拒绝或取消。';
    }
    if (!canAccept) decisions = decisions.filter(d => d !== 'accept');
    if (!decisions.length) return;
    const value = publicApproval({ id: pendingId(context, event, 'codex_a_'), sessionId: context.id,
      turnId: p.turnId, itemId: p.itemId, kind: command ? 'command' : 'fileChange', title: command ? '单次命令审批' : '单次文件变更审批',
      description, command: canAccept && command ? p.command : command ? '[命令缺少完整公开上下文，请在原生客户端核验]' : '',
      cwd: command ? p.cwd : context.scope, decisions }, context.id);
    addPending(context, event, 'approval', value);
  }
  function consume(context, event) {
    if (context.invalid) return;
    const p = event.params || {}, state = context.state;
    if (event.method === 'serverRequest/resolved') {
      const pending = context.wire.get(p.requestId); if (!pending) return;
      const local = event.resolvedLocally === true && pending.state === 'submitting';
      settle(context, pending, local); pending.resolved = local;
      if (local) pending.resolve?.();
      else pending.fail?.(err(pending.kind === 'question' ? 'QUESTION_RESULT_UNKNOWN' : 'APPROVAL_RESULT_UNKNOWN'));
      return;
    }
    if (['thread/closed', 'thread/deleted', 'thread/archived'].includes(event.method)) { invalidateContext(context, true); return; }
    if (event.method === 'turn/started') { if (state.setTurn(p.turn)) expirePending(context); return; }
    if (event.method === 'turn/completed') { if (state.setTurn(p.turn)) expirePending(context); return; }
    if (event.method === 'thread/status/changed') {
      if (p.status?.type === 'systemError') {
        state.runtimeError(); publish(context, makeEvent(context.capture, 'session.execution.failed', { sessionID: context.id }));
      }
      // Status flags alone identify neither a turn nor a new user intent.
      return;
    }
    if (event.method === 'item/agentMessage/delta') { state.delta(p, receiptOf(context.capture, event)); return; }
    if (event.method === 'item/started' || event.method === 'item/completed') {
      state.item(p.item, p.turnId, { completed: event.method === 'item/completed', receiptOrder: receiptOf(context.capture, event) }); return;
    }
    if (!Object.hasOwn(event, 'id') || !(typeof event.id === 'string' || Number.isSafeInteger(event.id)) ||
      !nativeKey(p.turnId) || !nativeKey(p.itemId) || p.turnId !== state.activeTurnId) return;
    if (event.method === 'item/tool/requestUserInput') question(context, event);
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(event.method)) approval(context, event);
  }
  async function reconcileStatus(context, event) {
    const type = event.params?.status?.type;
    consume(context, event);
    if (!['idle', 'active', 'notLoaded'].includes(type) || type === 'active' && context.state.activeTurnId) return;
    const before = context.state.status;
    await warm(context, undefined, true); check(context.capture, context);
    const after = context.state.status;
    // A status broadcast itself is not a terminal outcome. Only a freshly
    // hydrated native turn may establish one (and activeFlags are not intent).
    if (after !== before) {
      const mapped = { completed: 'session.execution.succeeded', failed: 'session.execution.failed',
        interrupted: 'session.execution.interrupted', running: 'session.execution.started' }[after];
      if (mapped) publish(context, makeEvent(context.capture, mapped, { sessionID: context.id }));
    }
  }
  function route(capture, event) {
    if (current !== capture || capture.epoch !== epoch || closed) return;
    const nativeId = event?.params?.threadId;
    if (!UUID.test(nativeId || '')) return;
    const context = bound.get('ses_codex_' + nativeId.replaceAll('-', ''));
    if (!context || context.invalid || context.capture !== capture) return;
    if (event.method === 'serverRequest/resolved') {
      // Capture origin BEFORE any asynchronous scope read. A previously native-
      // resolved callback must not look like our answer merely because wire send
      // starts while that earlier notification is awaiting validation.
      event = { ...event, resolvedLocally: context.wire.get(event.params.requestId)?.state === 'submitting' };
    }
    if ((event.method === 'item/started' || event.method === 'item/completed') &&
      event.params?.item?.type === 'imageGeneration' && typeof event.params.item.result === 'string') {
      event = { ...event, params: { ...event.params, item: offloadItemImage(event.params.item, context) } };
    }
    if (!context.warm || context.warming) {
      const bytes = Buffer.byteLength(JSON.stringify(event));
      if (context.buffer.length >= 512 || context.bufferBytes + bytes > byteLimit) { invalidateContext(context); return; }
      context.buffer.push(event); context.bufferBytes += bytes; return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (context.eventQueue.length >= 512 || context.eventBytes + bytes > byteLimit) { invalidateContext(context); return; }
    context.eventQueue.push(event); context.eventBytes += bytes;
    if (!context.eventsFlight) {
      context.eventsFlight = (async () => {
        while (context.eventQueue.length && !context.invalid) {
          await verify(context); check(capture, context);
          const batch = context.eventQueue.splice(0); context.eventBytes = 0;
          for (const source of batch) {
            check(capture, context);
            if (source.method === 'thread/status/changed') { await reconcileStatus(context, source); check(capture, context); }
            else consume(context, source);
          }
        }
      })().catch(() => invalidateContext(context)).finally(() => { context.eventsFlight = null; });
    }
  }
  async function drain(context) {
    while (context.eventsFlight) { await context.eventsFlight; check(context.capture, context); }
  }
  function watch(id, onEvent, onState = () => {}) {
    const context = get(id), watcher = { onEvent, onState, closed: false }; context.watches.add(watcher);
    const readyPromise = (async () => {
      await health(); check(context.capture, context);
      if (watcher.closed) throw err();
      await warm(context); check(context.capture, context);
      if (watcher.closed) throw err();
      safeCall(onState, 'connected');
    })().catch(error => { if (!watcher.closed) safeCall(onState, 'disconnected'); throw error; });
    return { ready: readyPromise, close() { watcher.closed = true; context.watches.delete(watcher); } };
  }
  async function readShared(id) {
    const context = await contextFor(id); check(context.capture, context);
    await warm(context); check(context.capture, context);
    await loadTurns(context); check(context.capture, context);
    await drain(context); check(context.capture, context);
    return context.state.snapshot(publicPending(context, 'question'), publicPending(context, 'approval'));
  }
  async function readToolDetail(id, toolId) {
    const context = await contextFor(id); check(context.capture, context);
    await verify(context); check(context.capture, context);
    let value = context.state.readDetail(toolId);
    if (!value) { await readShared(id); check(context.capture, context); value = context.state.readDetail(toolId); }
    await verify(context); check(context.capture, context); return value;
  }
  async function readGeneratedImage(id, imageId) {
    const context = await contextFor(id); check(context.capture, context);
    await verify(context); check(context.capture, context);
    let value = context.state.readGeneratedImage(imageId);
    if (!value) { await readShared(id); check(context.capture, context); value = context.state.readGeneratedImage(imageId); }
    await verify(context); check(context.capture, context); return value;
  }
  async function listPending(id, kind) {
    const context = await contextFor(id); check(context.capture, context);
    await warm(context); check(context.capture, context); await verify(context); check(context.capture, context);
    await drain(context); check(context.capture, context);
    return publicPending(context, kind);
  }
  async function searchWorkspaceFiles(id, query = '') {
    const context = await contextFor(id); check(context.capture, context);
    if (context.capture.protocol?.attachments !== true) throw err('CODEX_READ_FAILED');
    await verify(context); check(context.capture, context);
    const files = await searchDirectoryFiles(context.scope, query);
    check(context.capture, context);
    return files;
  }
  function sendShared(id, text, { requestId, signal, uploads = [], references = [], pageContext, assertCurrent = () => {} } = {}) {
    let context;
    try {
      context = get(id);
      if (signal?.aborted || !Array.isArray(uploads) || !Array.isArray(references) ||
        uploads.length + references.length > FILE_LIMITS.count ||
        references.some(item => typeof item !== 'string' || !item || item.length > 500) ||
        typeof text !== 'string' || !text.trim() || text.length > 100000 || typeof requestId !== 'string' || !requestId || requestId.length > 200) throw err('NOT_SUBMITTED');
      const hasFiles = uploads.length > 0 || references.length > 0;
      if (hasFiles && context.capture.protocol?.attachments !== true) throw err('NOT_SUBMITTED');
      if (uploads.length) normalizeUploads(uploads);
      const page = normalizePageContext(pageContext);
      if (page && context.capture.protocol?.pageContext !== true) throw err('NOT_SUBMITTED');
      const additionalContext = codexPageContext(page);
      const signature = hash(JSON.stringify({ text, pageContext: page || null, uploads, references })), sendKey = JSON.stringify([id, requestId]), old = sends.get(sendKey);
      if (old) { if (old.signature !== signature) throw err('NOT_SUBMITTED'); return old.promise; }
      // Never evict an unknown/successful submission and accidentally resend it.
      const bytes = Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(additionalContext || {})) + (uploads.length + references.length) * 256 + 256;
      if (sends.size >= 256 || sendBytes + bytes > byteLimit) throw err('NOT_SUBMITTED');
      const entry = { signature, bytes };
      sendBytes += bytes;
      entry.promise = Promise.resolve().then(async () => {
        let submitted = false;
        let stagedPaths = [];
        const guard = () => { check(context.capture, context); assertCurrent(); if (signal?.aborted) throw err('NOT_SUBMITTED'); };
        try {
          guard(); await health(); guard(); await warm(context, signal); guard();
          await loadTurns(context, signal); guard();
          const thread = await verify(context, signal); guard();
          if (thread.canAcceptDirectInput === false) throw err('NOT_SUBMITTED');
          const turnId = context.state.activeTurnId;
          if (thread.status?.type === 'active' && !turnId) throw err('NOT_SUBMITTED');
          let input = [{ type: 'text', text, text_elements: [] }];
          let fileSummary = [];
          if (hasFiles) {
            const built = await buildCodexInput({ text, uploads, references, directory: context.scope, uploadDir, now });
            stagedPaths = built.stagedPaths;
            input = built.input;
            fileSummary = built.fileSummary;
            guard();
          }
          const clientId = 'km_' + hash(JSON.stringify([id, requestId])).slice(0, 48);
          const params = { threadId: context.nativeId, input, clientUserMessageId: clientId,
            ...(turnId ? { expectedTurnId: turnId } : {}), ...(additionalContext ? { additionalContext } : {}) };
          submitted = true;
          let result;
          try { result = await request(context.capture, turnId ? 'turn/steer' : 'turn/start', params, context, signal); }
          catch (error) {
            // Only the mutating RPC's own definite pre-wire rejection releases
            // the ledger. Later reads/guards/abort errors describe a different
            // operation and can never prove this prompt was not submitted.
            if (error?.code === 'NOT_SUBMITTED') submitted = false;
            throw error;
          }
          guard();
          // The native success response acknowledges THIS submitted input.
          // Model events and durable userMessage history are independent and
          // may lag. Waiting for them here incorrectly turns accepted input
          // into UNKNOWN (or waits for a long-running model turn to finish).
          const acceptedTurnId=turnId?result?.turnId:result?.turn?.id;
          if(!nativeKey(acceptedTurnId)||turnId&&acceptedTurnId!==turnId||!turnId&&!['inProgress','completed','interrupted','failed'].includes(result?.turn?.status))throw err('CODEX_RESULT_UNKNOWN');
          // Continue scope enforcement independently; it may disconnect the
          // reader on a real move but cannot undo a native acceptance receipt.
          void verify(context).catch(()=>{});
          return { id: clientId, payload: { text, ...(fileSummary.length ? { files: fileSummary } : {}) }, accepted:true,delivery:'accepted',nativeEcho:true,nativeTurnId:acceptedTurnId };
        } catch (error) {
          if (!submitted) {
            await cleanupStagedFiles(stagedPaths);
            sends.delete(sendKey); sendBytes -= bytes; throw err('NOT_SUBMITTED');
          }
          throw err('CODEX_RESULT_UNKNOWN');
        }
      });
      sends.set(sendKey, entry); return entry.promise;
    } catch { return Promise.reject(err('NOT_SUBMITTED')); }
  }
  async function interruptShared(id) {
    const context = await contextFor(id); check(context.capture, context);
    await warm(context); check(context.capture, context); await loadTurns(context); check(context.capture, context);
    const turnId = context.state.activeTurnId; if (!turnId) return { interrupted: false };
    await verify(context); check(context.capture, context);
    if (context.state.activeTurnId !== turnId) return { interrupted: context.state.terminal(turnId) === 'interrupted' };
    await request(context.capture, 'turn/interrupt', { threadId: context.nativeId, turnId }, context); check(context.capture, context);
    await drain(context); check(context.capture, context);
    return { interrupted: context.state.terminal(turnId) === 'interrupted' };
  }
  async function respondPending(id, pendingId, kind, answer, { signal, assertCurrent = () => {} } = {}, reject = false) {
    const prefix = kind === 'question' ? 'QUESTION' : 'APPROVAL'; let submitted = false, pending;
    try {
      const context = get(id), capture = context.capture;
      const guard = () => { check(capture, context); assertCurrent(); if (signal?.aborted) throw err(); };
      guard(); await health(); guard(); await verify(context, signal); guard();
      // Stored pages need not contain a loaded daemon's latest live turn. A
      // fresh metadata-only resume supplies its official active-turn page.
      await warm(context, signal, true); guard();
      await loadTurns(context, signal); guard(); await drain(context); guard();
      pending = context.pending.get(pendingId);
      if (!pending || pending.kind !== kind || pending.turnId !== context.state.activeTurnId || context.wire.get(pending.wireId) !== pending) throw err();
      if (pending.state !== 'pending') throw err(prefix + '_RESULT_UNKNOWN');
      let result;
      if (kind === 'question') {
        if (!reject) questionAnswer(pending.public, answer);
        const answers = Object.create(null);
        if (!reject) pending.public.questions.forEach((field, index) => { answers[field.key] = { answers: [...answer[index]] }; });
        result = { answers };
      } else {
        if (!pending.public.decisions.includes(answer)) throw err();
        result = { decision: answer };
      }
      // Recheck scope immediately before consuming this exact wire callback.
      await verify(context, signal); guard(); await drain(context); guard();
      if (context.pending.get(pendingId) !== pending || pending.turnId !== context.state.activeTurnId || pending.state !== 'pending') throw err();
      let resolveWait, rejectWait;
      const confirmation = new Promise((resolve, fail) => { resolveWait = resolve; rejectWait = fail; });
      // Install waiters BEFORE wire send: resolved may race the respond callback.
      pending.resolve = resolveWait; pending.fail = rejectWait; pending.state = 'submitting'; pending.action = reject ? 'reject' : 'answer';
      const timer = setTimeout(() => rejectWait(err(prefix + '_RESULT_UNKNOWN')), resolvedTimeoutMs);
      const abort = () => rejectWait(err(prefix + '_RESULT_UNKNOWN'));
      signal?.addEventListener('abort', abort, { once: true });
      confirmation.catch(() => {});
      try {
        guard(); submitted = true;
        try { await capture.rpc.respond(pending.wireId, result); }
        catch (error) { if (error?.code === 'NOT_SUBMITTED') { submitted = false; pending.state = 'pending'; } throw error; }
        guard(); await confirmation; guard(); await verify(context, signal); guard();
        if (!pending.resolved) throw err();
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.resolve = null; pending.fail = null; }
      return kind === 'question' ? { questionId: pendingId, status: reject ? 'rejected' : 'answered' } : { approvalId: pendingId, status: 'resolved' };
    } catch (error) {
      if (pending && submitted && !pending.resolved) pending.state = 'unknown';
      if (error?.code === prefix + '_RESULT_UNKNOWN') throw err(error.code);
      throw err(prefix + (submitted ? '_RESULT_UNKNOWN' : '_NOT_SUBMITTED'));
    }
  }
  const capabilities = Object.freeze({ send: true, interrupt: true, questions: true, approvals: true, toolDetails: true,
    get attachments() { return !closed && current?.protocol?.attachments === true; },
    get workspaceFiles() { return !closed && current?.protocol?.attachments === true; },
    get fileSearch() { return !closed && current?.protocol?.attachments === true; },
    newSession: true, followSessions: false,
    get pageContext() { return !closed && current?.protocol?.pageContext === true; } });
  return {
    descriptor: Object.freeze({ id: 'codex', status: 'native', capabilities }), capabilities,
    health, listSessions, createSharedSession, bindSession, readShared, watch, sendShared, interruptShared, readToolDetail, readGeneratedImage, searchWorkspaceFiles,
    listQuestions: id => listPending(id, 'question'), listApprovals: id => listPending(id, 'approval'),
    replyQuestion: (id, qid, answers, options) => respondPending(id, qid, 'question', answers, options),
    rejectQuestion: (id, qid, options) => respondPending(id, qid, 'question', null, options, true),
    respondApproval: (id, approvalId, decision, options) => respondPending(id, approvalId, 'approval', decision, options),
    close() { if (closed) return; closed = true; invalidate(); },
  };
}

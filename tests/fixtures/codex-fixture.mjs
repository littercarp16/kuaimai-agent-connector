import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

export const THREAD = '019a47b0-1234-7123-8123-123456789abc';
export const OTHER = '019a47b0-1234-7123-8123-123456789abd';
export const SESSION = 'ses_codex_' + THREAD.replaceAll('-', '');
export const turn = (id = 'turn-1', status = 'completed', items = []) => ({ id, status, items, itemsView: 'full' });
export const user = (id, text) => ({ id, type: 'userMessage', content: [{ type: 'text', text }] });
export const agent = (id, text) => ({ id, type: 'agentMessage', text });
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > deadline) throw Error('Fixture condition did not become true'); await tick(); }
}

// In-memory App Server contract fixture. It cannot start Codex or access its files.
export async function fixture(t, { version = '0.166.0', ...options } = {}) {
  const tempRoot = path.join(tmpdir(), 'opencode'); await mkdir(tempRoot, { recursive: true });
  const root = await mkdtemp(path.join(tempRoot, 'codex-adapter-'));
  const directory = await realpath(root);
  await mkdir(path.join(directory, 'child'));
  const thread = { id: THREAD, sessionId: OTHER, cwd: directory, source: 'cli', parentThreadId: null,
    name: '原生测试', preview: '', status: { type: 'idle' }, turns: [], model: 'fixture-model', modelProvider: 'openai' };
  const calls = [], responses = [], handlers = new Map(), subscribers = new Set(), closers = new Set();
  let closed = false, discoveryCount = 0, connectCount = 0, clock = 0;
  let discovery = { ready: true, version, socketPath: '/fixture/owned.sock', instanceId: 'fixture-one' };
  const turns = [], threads = [thread], receipts = new WeakMap(); let receiptOrder = 0;
  const receive = value => {
    if (value !== null && typeof value === 'object' && !receipts.has(value)) receipts.set(value, ++receiptOrder);
    return value;
  };
  const rpc = {
    instanceId: 'fixture-one', version, get closed() { return closed; },
    request(method, params, opts) {
      calls.push({ method, params: structuredClone(params), opts });
      try {
        const result = (() => {
          if (handlers.has(method)) return handlers.get(method)(params, opts);
          if (method === 'thread/list') {
            const matches = threads.filter(value => (params.cwd == null || (Array.isArray(params.cwd) ? params.cwd.includes(value.cwd) : value.cwd === params.cwd)) &&
              (params.archived === true ? value.archived === true : value.archived !== true));
            const offset = params.cursor ? Number(params.cursor.replace('fixture:', '')) : 0, limit = params.limit || 50;
            return { data: structuredClone(matches.slice(offset, offset + limit).map(value => ({ ...value, turns: [] }))),
              nextCursor: offset + limit < matches.length ? `fixture:${offset + limit}` : null };
          }
          if (method === 'thread/read' || method === 'thread/resume') return { thread: structuredClone(thread), model: thread.model };
          if (method === 'thread/turns/list') return { data: structuredClone([...turns].reverse()), nextCursor: null };
          if (method === 'thread/items/list') return { data: [], nextCursor: null };
          if (method === 'turn/start') {
            const item = { ...user(params.clientUserMessageId, params.input[0].text), clientId: params.clientUserMessageId };
            const value = turn('turn-new', 'inProgress', [item]); turns.push(value); thread.status = { type: 'active', activeFlags: [] };
            return { turn: structuredClone(value) };
          }
          if (method === 'turn/steer') return { turnId: params.expectedTurnId };
          if (method === 'turn/interrupt') return {};
          throw Error('Unexpected fixture method: ' + method);
        })();
        return result && typeof result.then === 'function' ? result.then(receive) : Promise.resolve(receive(result));
      } catch (error) { return Promise.reject(error); }
    },
    orderOf: value => value !== null && typeof value === 'object' ? receipts.get(value) ?? null : null,
    async respond(id, result) { responses.push({ id, result: structuredClone(result) }); if (handlers.has('respond')) await handlers.get('respond')(id, result); },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    onClose(fn) { closers.add(fn); return () => closers.delete(fn); },
    close() { if (closed) return; closed = true; for (const fn of [...closers]) fn(); },
  };
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const { createCodexAdapter } = await import('../../src/adapters/codex/codex.mjs');
  const createAdapter = extra => {
    const value = createCodexAdapter({ directory, discover: async () => { discoveryCount++; return discovery; },
      connect: async () => { connectCount++; return rpc; }, now: () => clock, resolvedTimeoutMs: 100, ...options, ...extra });
    t.after(() => value.close()); return value;
  };
  const adapter = createAdapter();
  return { adapter, createAdapter, rpc, thread, threads, turns, calls, responses, handlers, directory,
    receive,
    emit(method, params, id) { const event = receive({ method, params, ...(id !== undefined ? { id } : {}) }); for (const fn of [...subscribers]) fn(event); },
    get discoveryCount() { return discoveryCount; }, get connectCount() { return connectCount; },
    setDiscovery(value) { discovery = value; }, advance(ms = 2100) { clock += ms; },
    async bind() { return adapter.bindSession(SESSION); },
    async watch() { const events = [], states = []; const watch = adapter.watch(SESSION, e => events.push(e), s => states.push(s)); await watch.ready; return { watch, events, states }; },
  };
}

export function questionParams({ turnId = 'turn-1', secret = false, ...extra } = {}) {
  return { threadId: THREAD, turnId, itemId: 'q-item', isBlocking: true,
    questions: [{ id: 'choice', header: '选择', question: '采用哪个？', isSecret: secret,
      options: [{ label: '实际标签', description: '公开选项' }], isOther: true }], ...extra };
}
export function approvalParams(directory, extra = {}) {
  return { threadId: THREAD, turnId: 'turn-1', itemId: 'cmd-1', startedAtMs: 1,
    command: 'git status --short', cwd: directory, kind: 'command', ...extra };
}

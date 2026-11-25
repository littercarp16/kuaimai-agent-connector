import { basename } from 'node:path';
import { openWorkBuddyServeSession, validateWorkBuddyEndpoint, workBuddySessionKey } from './serve-acp.mjs';

export function createWorkBuddySessionList(options) {
  const { endpoint, password, workspace } = options;
  const lifetime = new AbortController();
  const bindings = new Map();
  const creating = new Map();
  const descriptor = { id: 'workbuddy', status: 'native' };
  const capabilities = { pageContext: true, attachments: false, publishUI: false, nativeApprovals: true };
  async function get(path) {
    await validateWorkBuddyEndpoint(options);
    const response = await fetch(endpoint + path, {
      headers: { 'X-CodeBuddy-Request': '1', Authorization: 'Bearer ' + password },
      redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Error('无法读取 WorkBuddy 会话服务（HTTP ' + response.status + '）');
    }
    return response.json();
  }
  async function entries() {
    const reply = await get('/api/v1/sessions?cwd=' + encodeURIComponent(workspace));
    if (!Array.isArray(reply.data?.sessions)) throw Error('WorkBuddy 会话列表格式无效');
    const rows = reply.data.sessions.filter(row => typeof row?.id === 'string' && /^[\w:-]{1,128}$/.test(row.id) &&
      (row.cwd === undefined || row.cwd === workspace))
      .map(row => ({ nativeId: row.id, session: {
        id: workBuddySessionKey(row.id), title: typeof row.name === 'string' && row.name.trim() ? row.name.slice(0,160) : '未命名会话',
        provider: 'workbuddy', projectName: basename(workspace), source: { nativeSession: true },
        updatedAt: Number.isFinite(row.updatedAt) ? Math.trunc(row.updatedAt) : 0,
        createdAt: Number.isFinite(row.createdAt) ? Math.trunc(row.createdAt) : 0,
      } })).sort((a,b) => b.session.updatedAt - a.session.updatedAt);
    for (const { session } of rows) {
      const active = bindings.get(session.id);
      if (active) active.emptySession = null;
    }
    return rows;
  }
  async function selected(id, allowLiveEmpty = false) {
    const entry = (await entries()).find(item => item.session.id === id);
    const active = bindings.get(id);
    if (!entry && allowLiveEmpty && active?.emptySession && active.source?.connected()) return { session: active.emptySession };
    if (!entry) throw Object.assign(Error('所选 WorkBuddy 会话已不可用，请刷新列表'), { code: 'WORKBUDDY_SESSION_GONE' });
    return entry;
  }
  const current = id => {
    const source = bindings.get(id)?.source;
    if (!source?.connected()) throw Error('WorkBuddy 会话已断开，请重新绑定');
    return source;
  };
  function watch(id, event, state) {
    let entry = bindings.get(id);
    if (!entry) {
      const controller = new AbortController();
      entry = { controller, count: 0, source: null, ready: null };
      bindings.set(id, entry);
      entry.ready = (async () => {
        const fresh = creating.get(id);
        if (fresh) {
          entry.source = fresh.source;
          entry.emptySession = fresh.session;
          return entry.source;
        }
        const item = await selected(id);
        controller.signal.throwIfAborted();
        entry.source = await openWorkBuddyServeSession({ ...options, existingSessionId: item.nativeId, title: item.session.title,
          signal: AbortSignal.any([controller.signal, lifetime.signal]) });
        return entry.source;
      })();
    }
    entry.count++;
    let watcher, closed = false;
    function close() {
      if (closed) return;
      closed = true;
      watcher?.close();
      if (--entry.count !== 0) return;
      if (bindings.get(id) === entry) bindings.delete(id);
      if (entry.source) void entry.source.close().catch(() => {});
      else entry.controller.abort();
    }
    const ready = entry.ready.then(async source => {
      if (closed) { if (!entry.count) await source.close(); return; }
      watcher = source.watch(id, event, state);
      await watcher.ready;
    }).catch(error => { close(); throw error; });
    return { ready, close };
  }
  return {
    descriptor, capabilities,
    async health() { await get('/api/v1/health'); return { ready: true, version: 'ACP/1', message: 'WorkBuddy 已授权会话服务' }; },
    async listSessions() {
      const saved = (await entries()).map(item => item.session);
      const unsaved = [...bindings.values()].filter(entry => entry.emptySession && entry.source?.connected());
      return [...unsaved.map(entry => entry.emptySession), ...saved];
    },
    async bindSession(id) { return creating.get(id)?.session || (await selected(id, true)).session; },
    // An empty ACP session first appears in the CLI's directory after a prompt.
    // Hold its original connection until the binding has acquired a watcher.
    async createAndBind(bind) {
      const source = await openWorkBuddyServeSession({ ...options, title: '新建 CLI 会话', signal: lifetime.signal });
      const [created] = await source.listSessions();
      const session = created && { ...created, projectName: basename(workspace), updatedAt: Date.now() };
      if (!session || bindings.has(session.id) || creating.has(session.id)) {
        await source.close();
        throw Error('WorkBuddy CLI 未分配独立会话');
      }
      creating.set(session.id, { session, source });
      try {
        await bind(session);
        return session;
      } finally {
        creating.delete(session.id);
        if (bindings.get(session.id)?.source !== source) await source.close();
      }
    },
    watch,
    readShared: (id, ...args) => current(id).readShared(id, ...args),
    sendShared: (id, ...args) => current(id).sendShared(id, ...args),
    listApprovals: (id, ...args) => current(id).listApprovals(id, ...args),
    respondApproval: (id, ...args) => current(id).respondApproval(id, ...args),
    async close() {
      const active = [...bindings.values()];
      bindings.clear();
      await Promise.all(active.map(entry => {
        if (entry.source) return entry.source.close();
        entry.controller.abort();
        return entry.ready.then(source => source.close(), () => {});
      }));
      lifetime.abort();
    },
  };
}

export function workBuddySessionOptions(workspace = process.env.KM_AGENT_WORKBUDDY_WORKSPACE, env = process.env) {
  const endpoint = env.KM_AGENT_WORKBUDDY_ENDPOINT, password = env.KM_AGENT_WORKBUDDY_PASSWORD;
  if (!endpoint && !password) return null;
  if (!endpoint || !password || !workspace) throw Error('WorkBuddy 会话服务需要端点、密码和授权工作目录');
  return { endpoint, password, workspace, approvalFile: env.KM_AGENT_WORKBUDDY_APPROVAL_FILE };
}

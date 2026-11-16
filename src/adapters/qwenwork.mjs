import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactText } from '../tools/display-safety.mjs';

const protocol = 'qwenwork.desktop.v1';
const sessionPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const requestPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const defaultControlDir = join(homedir(), 'Library', 'Application Support', 'QwenWorkCN', 'cli-control');
const active = new Set(['starting', 'running', 'waiting_for_input']);
const terminalEvents = {
  completed: 'session.execution.succeeded',
  failed: 'session.execution.failed',
  cancelled: 'session.execution.interrupted',
  interrupted: 'session.execution.interrupted'
};
const historyStatus = message => ({ failed: 'failed', cancelled: 'interrupted', interrupted: 'interrupted' }[message?.status] || 'completed');
const text = value => typeof value === 'string' ? redactText(value.slice(0, 16000), false, { complete: true }) : '';
const isSessionId = value => typeof value === 'string' && sessionPattern.test(value);
const sessionKey = value => 'ses_qwen_' + createHash('sha256').update(value).digest('hex').slice(0, 32);

async function readPrivateFile(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 4096) {
      throw Error('千问办公本机连接文件权限无效');
    }
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}

async function connectDesktop(directory) {
  const { protocol: version, port, instance_id: instance } = JSON.parse(await readPrivateFile(join(directory, 'endpoint.json')));
  if (version !== protocol || !Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-f0-9]{32}$/.test(instance)) {
    throw Error('千问办公本机接口不兼容');
  }
  const token = (await readPrivateFile(join(directory, instance, 'token'))).trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error('千问办公本机连接凭据无效');
  return {
    instance,
    async call(method, params = {}, { signal, timeout = 4000 } = {}) {
      const deadline = AbortSignal.timeout(timeout);
      const response = await fetch('http://127.0.0.1:' + port + '/v1/control', {
        method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ schema_version: 'qwenwork.desktop-request.v1', method, params })
      });
      if (response.headers.get('X-Qwenwork-Instance') !== instance) {
        await response.body?.cancel();
        throw Error('千问办公本机实例已变化');
      }
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        throw Object.assign(Error('千问办公本机请求失败'), { code: result.error?.code });
      }
      return result.data;
    }
  };
}

function historyMessages(history) {
  return history.messages.flatMap(message => {
    if (!['assistant', 'user'].includes(message.role) || !sessionPattern.test(message.id || '')) return [];
    const body = text(message.parts.filter(part => part.type === 'text').map(part => part.text).join('\n'));
    return body ? [{ id: message.id, role: message.role, text: body, status: message.metadata?.status }] : [];
  });
}

export function createQwenWorkAdapter({ sessionId: fixedSessionId, controlDir = defaultControlDir } = {}) {
  if (fixedSessionId !== undefined && !isSessionId(fixedSessionId)) throw Error('千问办公会话 ID 无效');
  const fixedKey = fixedSessionId && sessionKey(fixedSessionId);
  const descriptor = { id: 'qwen', status: 'native' };
  const watchers = new Set();
  let canSubmit = false, listed = new Map();
  function describe(session) {
    return { id: sessionKey(session.session_id), provider: descriptor.id, title: text(session.title).slice(0, 100) || '千问办公会话' };
  }
  function lookupSession(target) {
    return fixedSessionId ? (target === fixedKey ? fixedSessionId : undefined)
      : listed.get(target) || [...watchers].find(watcher => watcher.id === target)?.sessionId;
  }
  async function requireSession(target, client) {
    let sessionId = lookupSession(target);
    if (!sessionId && !fixedSessionId && /^ses_qwen_[a-f0-9]{32}$/.test(target)) {
      await readSessionList(client);
      sessionId = lookupSession(target);
    }
    if (!sessionId) throw Error('该千问办公会话不在当前来源范围内');
    return sessionId;
  }
  async function readSessionList(client) {
    const { sessions } = await client.call('session.list', { limit: 100, offset: 0 });
    if (!Array.isArray(sessions)) throw Error('千问办公会话列表无效');
    const available = sessions.slice(0, 100).filter(session => isSessionId(session?.session_id));
    listed = new Map(available.map(session => [sessionKey(session.session_id), session.session_id]));
    return available.map(describe);
  }
  async function health() {
    try {
      const client = await connectDesktop(controlDir);
      const status = await client.call('desktop.status');
      const ready = status.protocol === protocol && status.authenticated === true &&
        status.features?.session_history === true && status.features?.task_events === true;
      canSubmit = ready && status.features?.task_execution === true;
      return { ready, version: status.app?.version, message: ready ? '千问办公桌面会话同步' : '千问办公尚未登录或接口不可用' };
    } catch {
      canSubmit = false;
      return { ready: false, message: '请启动千问办公并开启桌面本机控制接口' };
    }
  }
  async function bindSession(target) {
    const client = await connectDesktop(controlDir);
    const sessionId = await requireSession(target, client);
    const { session } = await client.call('session.get', { session_id: sessionId });
    if (session?.session_id !== sessionId) throw Error('千问办公会话未找到');
    return describe(session);
  }
  async function readState(client, sessionId) {
    const params = { session_id: sessionId };
    const [history, current] = await Promise.all([
      client.call('session.history', { ...params, limit: 40 }), client.call('session.get', params)
    ]);
    if (current.session?.session_id !== sessionId || !Array.isArray(history.messages)) throw Error('千问办公会话范围已变化');
    return { messages: historyMessages(history), task: current.task };
  }
  async function readShared(target) {
    const client = await connectDesktop(controlDir);
    const { messages, task } = await readState(client, await requireSession(target, client));
    const lastReply = messages.findLast(message => message.role === 'assistant');
    const status = active.has(task?.status) ? 'running' : lastReply ? historyStatus(lastReply) : 'idle';
    return { messages, status };
  }
  async function readTaskEvents(client, task) {
    try {
      return await client.call('task.events', { task_id: task.taskId, after: task.cursor, limit: 100 });
    } catch (error) {
      if (error.code !== 'EVENT_CURSOR_EXPIRED') throw error;
      return client.call('task.get', { task_id: task.taskId });
    }
  }
  async function sendShared(target, prompt, { requestId, signal, assertCurrent, uploads = [], references = [] } = {}) {
    const notSubmitted = reason => Object.assign(Error('千问办公尚未收到消息'), { code: 'NOT_SUBMITTED', reason });
    if (!canSubmit || !requestPattern.test(requestId || '') || typeof prompt !== 'string' ||
        !prompt.trim() || prompt.length > 4000 || uploads.length || references.length) {
      throw notSubmitted();
    }
    let client, sessionId;
    try {
      client = await connectDesktop(controlDir);
      const watcher = [...watchers].find(watcher => watcher.id === target && watcher.instance === client.instance);
      sessionId = watcher?.sessionId;
      assertCurrent?.();
      if (signal?.aborted || !sessionId) throw Error();
    } catch {
      throw notSubmitted();
    }
    const task = await client.call('task.submit', { session_id: sessionId, prompt, request_id: requestId }, { signal, timeout: 15500 })
      .catch(error => {
        if (error.code === 'SESSION_BUSY') throw notSubmitted('busy');
        if (['DESKTOP_AUTH_REQUIRED', 'SESSION_NOT_FOUND', 'INVALID_INPUT'].includes(error.code)) throw notSubmitted();
        throw error;
      });
    if (task?.task_id !== requestId || task.session_id !== sessionId) throw Error('千问办公提交结果待核对');
    for (const watcher of watchers) {
      if (watcher.id === target && watcher.instance === client.instance) watcher.observeSubmission(task);
    }
    return { id: requestId, accepted: true, delivery: 'accepted', nativeEcho: true, nativeTurnId: task.turn_id };
  }
  function watch(target, listener, onState = () => {}) {
    const sessionId = lookupSession(target);
    if (!sessionId) throw Error('该千问办公会话不在当前来源范围内');
    const params = { session_id: sessionId };
    let closed = false, timer, current, revision = 0, nextHistoryRead = 0;
    let instance, submitted;
    const known = new Map();
    const emit = (type, data = {}) => {
      if (!closed) listener({ id: 'qwen:' + target + ':' + watcherEpoch + ':' + (++revision), type, data: { sessionID: target, ...data } });
    };
    const watcherEpoch = ++watchSequence;
    function projectMessage(message) {
      const previous = known.get(message.id);
      if (previous === message.text) return false;
      known.set(message.id, message.text);
      if (message.role === 'user') {
        emit('session.inbox.enqueued', { inboxID: message.id, item: { type: 'user', payload: { text: message.text } } });
      } else {
        // Replace from the native cumulative answer. This also repairs missed
        // pages and lets redaction inspect text across delta boundaries.
        emit('session.text.updated', { assistantMessageID: message.id, ordinal: 0, text: message.text });
      }
      return true;
    }
    const ready = (async () => {
      const client = await connectDesktop(controlDir);
      const initial = await readState(client, sessionId);
      instance = client.instance;
      for (const message of initial.messages) known.set(message.id, message.text);
      schedule(client);
    })();
    function schedule(client, delay = 200) {
      if (!closed) timer = setTimeout(() => void poll(client), delay).unref();
    }
    async function poll(client) {
      try {
        const loadHistory = Date.now() >= nextHistoryRead;
        // A known task can be read alongside session validation. Publish its
        // events only after the session and task IDs have both been checked.
        const [snapshot, state, knownTaskEvents] = await Promise.all([
          loadHistory ? client.call('session.history', { ...params, limit: 12 }) : null,
          client.call('session.get', params),
          current ? readTaskEvents(client, current) : null
        ]);
        if (closed) return;
        const { session, task } = state;
        if (session?.session_id !== sessionId) throw Error('千问办公会话范围已变化');
        const next = task && active.has(task.status) ? task : submitted;
        if (!current && next) {
          if (next.session_id !== sessionId || !sessionPattern.test(next.task_id || '')) throw Error('千问办公任务不匹配');
          current = { taskId: next.task_id, turnId: next.turn_id, cursor: 0, answer: '' };
          emit('session.execution.started');
        }
        if (submitted?.task_id === current?.taskId) submitted = undefined;
        if (snapshot) {
          nextHistoryRead = Date.now() + 700;
          let latestReply;
          for (const message of historyMessages(snapshot)) {
            if (message.role === 'assistant' && message.id === current?.turnId) continue;
            if (projectMessage(message) && message.role === 'assistant') latestReply = message;
          }
          if (!current && latestReply) {
            emit(terminalEvents[latestReply.status] || terminalEvents.completed);
          }
        }
        if (current) {
          const events = knownTaskEvents ?? await readTaskEvents(client, current);
          if (closed) return;
          if (events.session_id !== sessionId || events.task_id !== current.taskId) throw Error('千问办公任务不匹配');
          current.turnId = events.events?.find(item => item.event.type === 'turn.started')?.event.assistantMessageId ??
            current.turnId ?? events.turn_id;
          current.cursor = events.next_cursor ?? events.last_sequence;
          const answer = text(events.answer);
          if (answer && answer !== current.answer && sessionPattern.test(current.turnId || '')) {
            current.answer = answer;
            projectMessage({ id: current.turnId, role: 'assistant', text: answer });
          }
          if (events.terminal) {
            emit(terminalEvents[events.status] || 'session.execution.failed');
            current = null;
          }
        }
        while (known.size > 100) known.delete(known.keys().next().value);
        schedule(client, current ? 200 : 500);
      } catch {
        if (!closed) {
          watcher.close();
          onState('disconnected');
        }
      }
    }
    const watcher = {
      id: target, sessionId, ready,
      get instance() { return instance; },
      observeSubmission(task) { if (task.task_id !== current?.taskId) submitted = task; },
      close() { closed = true; clearTimeout(timer); watchers.delete(watcher); }
    };
    watchers.add(watcher);
    return watcher;
  }
  let watchSequence = 0;
  return {
    descriptor, health, bindSession, readShared, watch, sendShared,
    capabilities: {
      get submitPrompt() { return canSubmit; },
      attachments: false, publishUI: false, uiCommands: false, uiReceipts: false
    },
    async listSessions() {
      return fixedSessionId ? [await bindSession(fixedKey)] : readSessionList(await connectDesktop(controlDir));
    },
    close() { for (const watcher of watchers) watcher.close(); }
  };
}

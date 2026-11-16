import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';
import WebSocket from 'ws';

const execVersion = promisify(execFile);
const VERSION_BYTES = 64 * 1024;
const MAX_PENDING = 128;
const MAX_SERVER_IDS = 4096;
const supportedVersions = '0.166.x、0.167.2、0.168.0、0.169.0';
export const isSupportedCodexVersion = version =>
  typeof version === 'string' && (['0.167.2', '0.168.0', '0.169.0'].includes(version) || /^0\.166\.(0|[1-9]\d*)$/.test(version));
const compatibleDaemonVersion = (cli, server) =>
  isSupportedCodexVersion(server) && (cli === server || (cli === '0.167.2' && server === '0.168.0') || (cli === '0.168.0' && server === '0.169.0'));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.hasOwn(object, key);
const validId = id => typeof id === 'string' || Number.isSafeInteger(id);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;
const safeError = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const notSubmitted = reason => safeError('NOT_SUBMITTED', 'Codex 请求未提交', { reason });
const unknownResult = reason => safeError('CODEX_RESULT_UNKNOWN', 'Codex 请求结果未知，请勿自动重发', { reason });
const invalidSocket = () => safeError('CODEX_UNSAFE_SOCKET', 'Codex 本地套接字不存在或不安全');

// System path aliases and one private daemon-control leaf alias are distinct.
// Never accept a general intermediate symlink or connect through the alias.
async function checkComponents(socketPath, uid,allowControlAlias=false) {
  const components = socketPath.split('/').filter(Boolean);
  let current = '/';
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    const stat = await lstat(current, { bigint: true });
    const last = index === components.length - 1;
    if (stat.isSymbolicLink()) {
      if(last&&allowControlAlias&&stat.uid===uid&&path.basename(current)==='app-server-control.sock'&&path.basename(path.dirname(current))==='app-server-control'){
        const parent=await lstat(path.dirname(current),{bigint:true});
        if(!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o077n)!==0n)throw invalidSocket();
        continue;
      }
      const alias = process.platform === 'darwin' && ['/var', '/tmp', '/etc'].includes(current);
      if (last || !alias || stat.uid !== 0n || await realpath(current) !== `/private${current}`) throw invalidSocket();
      continue;
    }
    if (last) {
      if (!stat.isSocket() || stat.uid !== uid||(stat.mode&0o022n)!==0n) throw invalidSocket();
    } else {
      if (!stat.isDirectory() || (stat.uid !== uid && stat.uid !== 0n)) throw invalidSocket();
      // A root-owned sticky system temp root may be an ancestor, not the socket's parent.
      const systemTemp = ['/tmp', '/private/tmp'].includes(current) && stat.uid === 0n && (stat.mode & 0o1000n) !== 0n;
      if ((stat.mode & 0o022n) !== 0n && !(systemTemp && index < components.length - 2)) throw invalidSocket();
    }
  }
}

async function inspectSocket(socketPath) {
  try {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || socketPath.includes('\0') ||
        path.normalize(socketPath) !== socketPath || typeof process.getuid !== 'function') throw invalidSocket();
    const uid = BigInt(process.getuid());
    const declared=await lstat(socketPath,{bigint:true});
    await checkComponents(socketPath, uid,true);
    const actualPath = await realpath(socketPath);
    // Check the canonical chain too: allowing /var must not skip /private/var permissions.
    if (actualPath !== socketPath) await checkComponents(actualPath, uid);
    if(declared.isSymbolicLink()){
      const parent=await lstat(path.dirname(actualPath),{bigint:true});
      if(!parent.isDirectory()||parent.uid!==uid||(parent.mode&0o077n)!==0n)throw invalidSocket();
    }
    const stat = await lstat(actualPath, { bigint: true });
    if (!stat.isSocket() || stat.uid !== uid||(stat.mode&0o022n)!==0n) throw invalidSocket();
    const identity = [actualPath, stat.dev, stat.ino, stat.ctimeNs, stat.birthtimeNs].join('\0');
    return { socketPath: actualPath, instanceId: `codex_${createHash('sha256').update(identity).digest('hex')}` };
  } catch {
    throw invalidSocket();
  }
}

/** Read-only discovery. This never starts/stops a daemon or reads Codex config/auth/DB. */
export async function discoverCodexDaemon({ run = execVersion, command = 'codex' } = {}) {
  const unready = message => ({ ready: false, version: null, message });
  let status;
  try {
    if (typeof run !== 'function' || typeof command !== 'string' || !command) return unready('Codex 命令不可用');
    const output = await run(command, ['app-server', 'daemon', 'version'], {
      encoding: 'utf8', timeout: 5000, maxBuffer: VERSION_BYTES, shell: false, windowsHide: true,
    });
    const text = output?.stdout;
    if (typeof text !== 'string' || Buffer.byteLength(text) > VERSION_BYTES) return unready('Codex 版本信息无效');
    status = JSON.parse(text);
  } catch {
    return unready('Codex 命令不可用或未能读取服务状态');
  }
  if (!record(status) || status.status !== 'running') return unready('Codex 共享服务未运行，不会自动启动');
  if (!compatibleDaemonVersion(status.cliVersion, status.appServerVersion)) {
    return unready(`Codex CLI 与共享服务的版本组合未支持。同版本支持 ${supportedVersions}，另支持 0.167.2→0.168.0、0.168.0→0.169.0`);
  }
  try {
    const socket = await inspectSocket(status.socketPath);
    return { ready: true, version: status.appServerVersion, ...socket };
  } catch {
    return unready('Codex 本地套接字不存在、所有权不符或目录权限不安全');
  }
}

// Keys alone are not a sufficient allowlist: arbitrary reason/type strings may be secrets.
const safeClassifications = new Set([
  'busy', 'conflict', 'not_found', 'thread_not_found', 'turn_not_found', 'invalid_request',
  'invalid_params', 'unauthorized', 'permission_denied', 'unsupported', 'rate_limited',
  'overloaded', 'cancelled', 'timeout', 'internal_error', 'server_error',
]);
function rpcError(error, method) {
  if (method === 'thread/resume' && error.code === -32600 && typeof error.message === 'string' &&
    /^thread [0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12} already has an active writer$/.test(error.message)) {
    return safeError('CODEX_THREAD_IN_USE', 'Codex 会话仍由另一个客户端占用');
  }
  const data = {};
  if (record(error.data)) {
    for (const key of ['reason', 'type']) {
      if (safeClassifications.has(error.data[key])) data[key] = error.data[key];
    }
  }
  return safeError('CODEX_RPC_ERROR', 'Codex RPC 请求失败', {
    ...(Number.isSafeInteger(error.code) ? { rpcCode: error.code } : {}), data,
  });
}

function invokeSafely(fn, value) {
  try { Promise.resolve(fn(value)).catch(() => {}); } catch { /* Never log native bodies/callback errors. */ }
}

/** WebSocket HTTP Upgrade over an owned Unix socket; never stdio/JSONL or a new server. */
export async function connectCodexRpc({ socketPath, version = '0.166.0', timeoutMs = 5000, maxBytes = 1024 * 1024 } = {}) {
  if (!isSupportedCodexVersion(version)) throw safeError('CODEX_UNSUPPORTED_VERSION', `Codex 版本不受支持，支持 ${supportedVersions}`);
  if (!positiveInteger(timeoutMs) || timeoutMs > 2 ** 31 - 1 || !positiveInteger(maxBytes)) {
    throw safeError('CODEX_INVALID_OPTIONS', 'Codex 连接参数无效');
  }
  const identity = await inspectSocket(socketPath);
  let ws;
  try {
    // The URL supplies HTTP Host only. All bytes go through net.connect(path), never TCP.
    ws = new WebSocket('ws://localhost/', {
      createConnection: () => createConnection({ path: identity.socketPath }),
      handshakeTimeout: timeoutMs, maxPayload: maxBytes, perMessageDeflate: false,
      followRedirects: false,
    });
  } catch { throw safeError('CODEX_CONNECTION_FAILED', 'Codex 本地连接失败'); }

  const pending = new Map();
  const serverRequests = new Map();
  const seenServerRequests = new Set();
  const subscribers = new Set();
  const closeSubscribers = new Set();
  const receiptOrders = new WeakMap();
  let receiptSequence = 0;
  let closed = false;
  let sequence = 0;
  let initialized = false;
  let closeTimer;
  let serverIdBytes = 0;

  const finishClose = () => {
    if (closed) return;
    closed = true;
    for (const entry of [...pending.values()]) entry.fail(unknownResult('connection_closed'));
    serverRequests.clear();
    seenServerRequests.clear();
    serverIdBytes = 0;
    subscribers.clear();
    for (const fn of [...closeSubscribers]) invokeSafely(fn, safeError('CODEX_CONNECTION_CLOSED', 'Codex 本地连接已关闭'));
    closeSubscribers.clear();
  };
  const terminate = () => { finishClose(); ws.terminate(); };
  const rememberServerId = id => {
    if (seenServerRequests.has(id)) return true;
    const bytes = typeof id === 'string' ? Buffer.byteLength(id) : 8;
    if (seenServerRequests.size >= MAX_SERVER_IDS || serverIdBytes + bytes > Math.max(maxBytes, 64 * 1024)) return false;
    seenServerRequests.add(id);
    serverIdBytes += bytes;
    return true;
  };
  ws.on('error', terminate); // Raw errors can contain socket paths, HTTP bodies or tokens.
  ws.on('close', () => { clearTimeout(closeTimer); finishClose(); });

  function encode(message) {
    let text;
    try { text = JSON.stringify(message); } catch { throw notSubmitted('invalid_json'); }
    if (Buffer.byteLength(text) > maxBytes) throw notSubmitted('message_too_large');
    if (ws.bufferedAmount + Buffer.byteLength(text) > maxBytes) throw notSubmitted('send_budget');
    return text;
  }

  function request(method, params, { signal, timeoutMs: requestTimeout = timeoutMs } = {}, initializing = false) {
    return new Promise((resolve, reject) => {
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(notSubmitted('connection_closed'));
      if (signal?.aborted) return reject(notSubmitted('aborted'));
      if (typeof method !== 'string' || !method || (!initializing && ['initialize', 'initialized'].includes(method)) ||
          !positiveInteger(requestTimeout) || requestTimeout > 2 ** 31 - 1 ||
          (signal != null && (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function'))) {
        return reject(notSubmitted('invalid_request'));
      }
      if (pending.size >= MAX_PENDING || sequence >= Number.MAX_SAFE_INTEGER) return reject(notSubmitted('pending_limit'));
      const id = ++sequence;
      let text;
      try { text = encode({ id, method, ...(params === undefined ? {} : { params }) }); } catch (error) { return reject(error); }
      // Serialization can invoke caller-owned getters/toJSON; recheck before submission.
      if (signal?.aborted) return reject(notSubmitted('aborted'));
      if (closed || ws.readyState !== WebSocket.OPEN) return reject(notSubmitted('connection_closed'));
      if (pending.size >= MAX_PENDING) return reject(notSubmitted('pending_limit'));
      let timer;
      const cleanup = () => {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const entry = {
        method,
        succeed: result => { cleanup(); resolve(result); },
        fail: error => { cleanup(); reject(error); },
      };
      const onAbort = () => entry.fail(unknownResult('aborted'));
      pending.set(id, entry);
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => entry.fail(unknownResult('timeout')), requestTimeout);
      // From this point the wire may have accepted bytes. This is NOT business-applied.
      try {
        ws.send(text, error => { if (error && pending.get(id) === entry) entry.fail(unknownResult('send_failed')); });
      } catch { entry.fail(unknownResult('send_failed')); }
    });
  }

  ws.on('message', (bytes, binary) => {
    if (closed) return;
    if (binary || bytes.length > maxBytes) return terminate();
    let message;
    try { message = JSON.parse(bytes.toString('utf8')); } catch { return terminate(); }
    if (!record(message)) return terminate();
    if (receiptSequence >= Number.MAX_SAFE_INTEGER) return terminate();
    const receiptOrder = ++receiptSequence;
    if (typeof message.method === 'string' && message.method) {
      if (has(message, 'result') || has(message, 'error') || (has(message, 'id') && !validId(message.id))) return terminate();
      if (message.method === 'serverRequest/resolved' && validId(message.params?.requestId)) {
        const id = message.params.requestId;
        if (!rememberServerId(id)) return terminate();
        serverRequests.delete(id);
      }
      if (has(message, 'id')) {
        if (seenServerRequests.has(message.id)) return; // Consumed/resolved IDs cannot become replyable again.
        // Never forget tombstones and accidentally reopen old requests: close at the finite lifetime budget.
        if (serverRequests.size >= MAX_PENDING || !rememberServerId(message.id)) return terminate();
        serverRequests.set(message.id, message.id);
      }
      const event = { method: message.method, ...(has(message, 'params') ? { params: message.params } : {}),
        ...(has(message, 'id') ? { id: message.id } : {}) };
      receiptOrders.set(event, receiptOrder); // BEFORE callbacks or Promise continuations.
      for (const fn of [...subscribers]) invokeSafely(fn, event);
      return;
    }
    if (!has(message, 'id') || !validId(message.id)) return terminate();
    const entry = pending.get(message.id);
    if (!entry) return; // Unknown, cancelled, timed out and late responses are never broadcast/replayed.
    if (record(message.error)) entry.fail(rpcError(message.error, entry.method));
    else if (has(message, 'result') && !has(message, 'error')) {
      if (message.result !== null && typeof message.result === 'object') receiptOrders.set(message.result, receiptOrder);
      entry.succeed(message.result);
    }
    else terminate();
  });

  async function respond(id, result) {
    if (closed || ws.readyState !== WebSocket.OPEN) throw notSubmitted('connection_closed');
    if (!serverRequests.has(id)) throw notSubmitted('server_request_not_pending');
    if (result === undefined) throw notSubmitted('invalid_result');
    const text = encode({ id: serverRequests.get(id), result });
    if (!has(JSON.parse(text), 'result')) throw notSubmitted('invalid_result');
    if (closed || !serverRequests.has(id)) throw notSubmitted('server_request_not_pending');
    serverRequests.delete(id); // Consume before send; failure is unknown, never retry automatically.
    await new Promise((resolve, reject) => {
      let settled=false;
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve();};
      const timer=setTimeout(()=>finish(unknownResult('write_timeout')),timeoutMs);
      try { ws.send(text, error => finish(error?unknownResult('send_failed'):null)); }
      catch { finish(unknownResult('send_failed')); }
    });
    // Successful return confirms local wire send only, not daemon/business application.
  }

  const client = {
    request: (method, params, options) => request(method, params, options),
    // Root result/event identity only. No enumerable fields or JSON mutations;
    // each connection owns its WeakMap, including frames coalesced in one read.
    orderOf: value => value !== null && typeof value === 'object' ? receiptOrders.get(value) ?? null : null,
    respond,
    subscribe(fn) {
      if (typeof fn !== 'function') throw notSubmitted('invalid_subscriber');
      if (!closed) subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    onClose(fn) {
      if (typeof fn !== 'function') throw notSubmitted('invalid_subscriber');
      if (!closed) closeSubscribers.add(fn);
      else {
        let active = true;
        queueMicrotask(() => { if (active) invokeSafely(fn, safeError('CODEX_CONNECTION_CLOSED', 'Codex 本地连接已关闭')); });
        return () => { active = false; };
      }
      return () => closeSubscribers.delete(fn);
    },
    close() {
      if (closed) return;
      finishClose();
      ws.close();
      closeTimer = setTimeout(() => ws.terminate(), 1000);
      closeTimer.unref();
    },
    get closed() { return closed; },
    instanceId: identity.instanceId,
    version,
  };

  try {
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', open);
        ws.off('error', fail);
        ws.off('close', fail);
      };
      const open = () => { cleanup(); resolve(); };
      const fail = () => { cleanup(); reject(safeError('CODEX_CONNECTION_FAILED', 'Codex 本地连接失败或握手超时')); };
      ws.once('open', open);
      ws.once('error', fail);
      ws.once('close', fail);
      // Custom Unix createConnection does not inherit http.request's socket timeout.
      // An independent deadline also bounds a peer dripping partial HTTP headers.
      timer = setTimeout(fail, timeoutMs);
    });
    // Do not carry pending state across a replaced socket, even at the same pathname.
    if ((await inspectSocket(identity.socketPath)).instanceId !== identity.instanceId) throw invalidSocket();
    await request('initialize', {
      clientInfo: { name: 'kuaimai_codex_bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [
        'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
      ] },
    }, {}, true);
    if (closed || initialized) throw safeError('CODEX_CONNECTION_FAILED', 'Codex 初始化未完成');
    initialized = true;
    await new Promise((resolve, reject) => {
      const text = encode({ method: 'initialized' });
      try { ws.send(text, error => error ? reject(unknownResult('send_failed')) : resolve()); }
      catch { reject(unknownResult('send_failed')); }
    });
    if (closed) throw safeError('CODEX_CONNECTION_FAILED', 'Codex 初始化未完成');
    return client;
  } catch (error) {
    terminate();
    throw error;
  }
}

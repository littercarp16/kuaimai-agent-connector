import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, lstat, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createWorkBuddyAccountLogin } from './workbuddy-account.mjs';
import { createWorkBuddySessionList } from '../adapters/workbuddy/session-list.mjs';
import { readConfigFile, safeLocalPath } from '../../skills/km-agent-bridge/scripts/prepare.mjs';
import { listenAvailable } from './service-instance.mjs';

const cliRelative = 'Contents/Resources/app.asar.unpacked/cli/bin/codebuddy';
async function findCli() {
  for (const directory of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of ['WorkBuddy AI.app', 'WorkBuddy.app']) {
      const cli = join(directory, name, cliRelative);
      if ((await stat(cli).catch(() => null))?.isFile()) return cli;
    }
  }
  throw Error('请先安装支持 --serve 的 WorkBuddy 桌面版');
}

async function stopChild(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await Promise.race([exited, delay(1500)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

async function startOwnedService(directory, signal, setPhase, assertAllowed) {
  const cli = await findCli();
  signal.throwIfAborted();
  assertAllowed();
  const root = await safeLocalPath(join(directory, 'workbuddy-cli'), { allowMissing: true });
  const config = join(root, 'settings');
  const workspace = join(root, 'workspace');
  const approvalFile = join(workspace, 'draft.html');
  let child, adapter, temp;
  async function close() {
    try {
      await adapter?.close();
    } finally {
      await stopChild(child);
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  }
  try {
    for (const path of [root, config, workspace]) {
      await mkdir(path, { mode: 0o700, recursive: true });
      const info = await lstat(path);
      if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('WorkBuddy CLI 数据目录权限无效');
    }
    const settings = join(config, 'settings.json');
    temp = await mkdtemp(join(root, 'run-'));
    const initialSettings = join(temp, 'initial-settings.json');
    await writeFile(initialSettings, JSON.stringify({
      gateway: { password: randomBytes(32).toString('base64url') },
      permissions: { ask: ['Write(' + approvalFile + ')'], deny: ['Bash'] },
    }), { mode: 0o600, flag: 'wx' });
    try {
      await link(initialSettings, settings);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await rm(initialSettings); }
    const { gateway } = await readConfigFile(settings, { runtime: true });
    const password = gateway?.password;
    if (typeof password !== 'string' || !/^[!-~]{16,256}$/.test(password)) throw Error('WorkBuddy CLI 本机服务密码配置无效');
    const reservation = createServer();
    const port = await listenAvailable(reservation, 0);
    await new Promise(resolve => reservation.close(resolve));
    signal.throwIfAborted();
    assertAllowed();
    const endpoint = 'http://127.0.0.1:' + port;
    child = spawn(process.execPath, [cli, '--serve', '--host', '127.0.0.1', '--port', String(port),
      '--auth', 'password', '--agent', 'cli', '--permission-mode', 'default',
      '--setting-sources', 'user'], {
      cwd: workspace, stdio: 'ignore',
      env: { PATH: process.env.PATH, TMPDIR: temp, CODEBUDDY_CONFIG_DIR: config,
        // This independently launched CLI cannot use the desktop's encrypted credential store.
        // Keep its own official login only for the lifetime of this process.
        CODEBUDDY_CREDENTIALS_IN_MEMORY: '1', CODEBUDDY_DISABLE_COMPILE_CACHE: '1', CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' },
    });
    await once(child, 'spawn');
    let ready = false;
    for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(endpoint + '/api/v1/health', {
        headers: { 'X-CodeBuddy-Request': '1', Authorization: 'Bearer ' + password },
        redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(400)]),
      }).catch(() => null);
      await response?.body?.cancel();
      if (response?.ok) { ready = true; break; }
      await delay(100, undefined, { signal });
    }
    if (!ready) throw Error('WorkBuddy 本机 HTTP 服务未就绪，请检查客户端版本');
    const options = { endpoint, password, workspace, approvalFile };
    const account = createWorkBuddyAccountLogin({ endpoint, password, signal });
    adapter = createWorkBuddySessionList(options);
    return { adapter, close, running: () => child.exitCode === null && child.signalCode === null,
      isAuthenticated: account.isAuthenticated, authenticate: guard => account.authenticate(guard, setPhase),
      reopen: account.reopen, canReopen: account.canReopen };
  } catch (error) {
    await close();
    throw error;
  }
}

// Preparing the shared CLI service never creates or selects a conversation.
export function createWorkBuddyServeManager({ directory, start = startOwnedService }) {
  let instance, flight, loginAttemptId = null, closed = false;
  let lifetime = new AbortController();
  let preparation = { phase: 'idle', message: '等待连接 WorkBuddy CLI。' };
  const status = () => ({ ...preparation, loginAttemptId, canReopenLogin: preparation.phase === 'authenticating' && instance?.canReopen?.() === true });
  async function readPreparation() {
    const current = instance;
    let authenticated = null;
    if (!closed && current?.running()) {
      try { authenticated = await current.isAuthenticated(); } catch { /* Account status may be unavailable while sessions are usable. */ }
    }
    return { ...status(), authenticated: !closed && current === instance && current?.running() ? authenticated : null };
  }
  const update = (phase, message) => { preparation = { phase, message }; };
  function ensure({ assertAllowed = () => {} } = {}) {
    if (closed) throw Error('WorkBuddy 桥接已关闭');
    assertAllowed();
    if (flight) return status();
    if (instance?.running()) {
      if (preparation.phase === 'failed') update('ready', 'WorkBuddy CLI 服务已连接，可重试会话操作');
      return status();
    }
    update('starting', '正在启动 WorkBuddy CLI…');
    flight = (async () => {
      try {
        await instance?.close();
        instance = await start(directory, lifetime.signal, update, assertAllowed);
        lifetime.signal.throwIfAborted();
        update('ready', 'WorkBuddy 已就绪，可选择会话');
      } catch (error) {
        if (!closed) update('failed', error.message);
      } finally { flight = null; }
    })();
    return status();
  }
  function source() {
    if (!instance?.running()) throw Error('WorkBuddy CLI 未就绪');
    return instance.adapter;
  }
  const adapter = {
    descriptor: { id: 'workbuddy', status: 'native' },
    capabilities: { pageContext: true, attachments: false, publishUI: false, nativeApprovals: true },
    async health() {
      const ready = instance?.running() === true;
      if (!ready && preparation.phase === 'ready') update('failed', 'WorkBuddy 本机服务已断开，请重新准备会话。');
      return { ready, version: ready ? 'ACP/1' : null, ...status() };
    },
    async listSessions() { return instance?.running() ? source().listSessions() : []; },
    bindSession: (...args) => source().bindSession(...args),
    readShared: (...args) => source().readShared(...args),
    watch: (...args) => source().watch(...args),
    sendShared: (...args) => source().sendShared(...args),
    listApprovals: (...args) => source().listApprovals(...args),
    respondApproval: (...args) => source().respondApproval(...args),
    async close() {
      if (closed) return;
      closed = true;
      lifetime.abort();
      const stopping = instance;
      try {
        await stopping?.close();
        await flight;
        if (instance !== stopping) await instance?.close();
      } finally {
        instance = null;
        lifetime = new AbortController();
        update('idle', '等待连接 WorkBuddy CLI。');
        closed = false;
      }
    },
  };
  function authenticate(assertAllowed, { reopen = false, attemptId } = {}) {
    assertAllowed();
    if (closed || !instance?.running()) throw Error('WorkBuddy CLI 服务已断开');
    if (attemptId !== undefined && attemptId !== loginAttemptId) return;
    if (flight && reopen && instance.canReopen?.()) return instance.reopen(assertAllowed);
    if (!flight) {
      loginAttemptId = randomUUID();
      update('authenticating', '正在检查 WorkBuddy CLI 登录');
      flight = instance.authenticate(assertAllowed).then(() => {
        if (!closed) update('ready', 'WorkBuddy CLI 已登录');
      }, error => {
        if (!closed) update('failed', error.publicMessage || 'WorkBuddy CLI 登录未完成，请重新登录。');
      }).finally(() => { loginAttemptId = null; flight = null; });
    }
  }
  return { adapter, ensure, status, readPreparation, authenticate, createAndBind: bind => source().createAndBind(bind) };
}

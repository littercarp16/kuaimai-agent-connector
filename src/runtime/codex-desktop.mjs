import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { discoverCodexDaemon } from '../adapters/codex/codex-rpc.mjs';
import { inspectCodexDesktopTransport } from './codex-desktop-transport.mjs';

const APP = '/Applications/ChatGPT.app';
const FLAG = 'CODEX_APP_SERVER_USE_LOCAL_DAEMON=1';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const exec = promisify(execFile);

export class CodexDesktopFailure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new CodexDesktopFailure(status, message); };

async function supportsDaemon() {
  if (!(await stat(`${APP}/Contents/MacOS/ChatGPT`)).isFile()) return false;
  const needles = new Set(['CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'CODEX_APP_SERVER_WS_URL', 'ws+unix:']);
  let tail = '';
  // Scan the installed bundle without executing it or keeping it all in memory.
  for await (const chunk of createReadStream(`${APP}/Contents/Resources/app.asar`)) {
    const text = tail + chunk.toString('latin1');
    for (const needle of needles) if (text.includes(needle)) needles.delete(needle);
    if (!needles.size) return true;
    tail = text.slice(-64);
  }
  return false;
}

export function desktopSocketUrl(socketPath) {
  // ws splits the pathname on ':' and does not URL-decode the Unix path.
  // The caller validates the canonical socket (or its private control alias).
  // Never take this path from an HTTP parameter.
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/') || normalize(socketPath) !== socketPath
    || /[:%?#\\\s]/u.test(socketPath))
    fail(409, '共享 socket 路径无法用于桌面连接，桌面端尚未退出');
  const url = new URL(`ws+unix://localhost${socketPath}:/rpc`);
  if (url.pathname !== `${socketPath}:/rpc` || url.hostname !== 'localhost')
    fail(409, '共享 socket 路径无法用于桌面连接，桌面端尚未退出');
  // localhost keeps the desktop's explicit-URL route out of its SOCKS proxy branch.
  return url.href;
}

export async function probeDesktopSocket(url) {
  const socket = new WebSocket(url, { handshakeTimeout: 5000, perMessageDeflate: false,
    followRedirects: false, maxPayload: 64 * 1024 });
  try {
    await new Promise((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('socket closed before opening')));
    });
  } finally { socket.terminate(); }
}

/** Fixed macOS actions only. No shell, arbitrary executable, arguments, or app path from HTTP. */
export function createCodexDesktopRuntime({ run = exec, discover = discoverCodexDaemon,
  probeApp = supportsDaemon, platform = process.platform, env = process.env, uid = process.getuid?.(),
  home = homedir(), sleep = delay, probeSocket = probeDesktopSocket } = {}) {
  let preparedSocketUrl = null;
  const command = (file, args, timeout = 10000) => run(file, args, {
    encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, shell: false,
  });
  const isRunning = async () => {
    const { stdout } = await command('/bin/ps', ['-axo', 'uid=,pid=,comm=']);
    return stdout.split('\n').some(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
      return match && Number(match[1]) === uid && match[3] === `${APP}/Contents/MacOS/ChatGPT`;
    });
  };
  return {
    inspectTransport: () => inspectCodexDesktopTransport({ run, discover, uid }),
    async check() {
      if (platform !== 'darwin') fail(409, '桌面端切换目前仅支持 macOS');
      if (env.CODEX_APP_SERVER_FORCE_CLI === '1' || env.CODEX_CLI_PATH?.trim())
        fail(409, '当前环境强制使用自定义 CLI，请先移除 CODEX_APP_SERVER_FORCE_CLI / CODEX_CLI_PATH 配置');
      if (env.CODEX_HOME && !isAbsolute(env.CODEX_HOME)) fail(409, 'CODEX_HOME 须为绝对路径');
      let supported = false;
      try { supported = await probeApp(); } catch { /* Report a fixed public error. */ }
      if (!supported) fail(409, '未找到支持共享 Unix socket 连接的 /Applications/ChatGPT.app');
    },
    async ensureDaemon() {
      preparedSocketUrl = null;
      let daemon = await discover();
      if (!daemon.ready) {
        // start is idempotent and does not restart/update an existing daemon.
        await command('codex', ['app-server', 'daemon', 'start'], 30000);
        daemon = await discover();
      }
      if (!daemon.ready) fail(409, '共享 daemon 未就绪或 socket 校验失败，桌面端尚未退出');
      const url = desktopSocketUrl(daemon.socketPath);
      try { await probeSocket(url); }
      catch { fail(409, '共享 socket 的 WebSocket 连接验证失败，桌面端尚未退出'); }
      preparedSocketUrl = url;
      return { ready: true, version: daemon.version };
    },
    isRunning,
    async quit() {
      await command('/usr/bin/osascript', ['-e', `tell application "${APP}" to quit`], 20000);
    },
    async open({ onAttempt = () => {}, onRetry = () => {} } = {}) {
      if (!preparedSocketUrl) fail(409, '共享 socket 尚未准备，未启动桌面端');
      // In 26.1111.21308 the local-daemon branch requires empty config overrides,
      // but the desktop always adds its codex_app plugin override. Explicit WS URL
      // selects the WebSocket transport before that contradictory stdio fallback.
      const args = ['-a', APP, '--env', FLAG, '--env', `CODEX_HOME=${env.CODEX_HOME || `${home}/.codex`}`,
        '--env', `CODEX_APP_SERVER_WS_URL=${preparedSocketUrl}`];
      for (let attempt = 1; attempt <= 3; attempt++) {
        onAttempt(attempt);
        try { await command('/usr/bin/open', args); return; }
        catch (error) {
          // LaunchServices can retain the just-exited process for a short time.
          // -600 means the reopen event targeted that dead process, not a new launch.
          const match = /\b(?:error|Code)\s*[=:]?\s*(-\d{1,6})\b/i.exec(String(error.stderr || ''));
          error.launchErrorCode = match ? Number(match[1]) : null;
          if (attempt === 3 || error.launchErrorCode !== -600 || error.killed || error.signal) throw error;
          if (await isRunning()) return;
          const delayMs = attempt * 500;
          onRetry({ attempt, delayMs, code: error.launchErrorCode });
          await sleep(delayMs);
          // The user or LaunchServices may have opened it while we were waiting.
          if (await isRunning()) return;
        }
      }
    },
  };
}

/** Ensure the desktop uses the shared daemon; session binding is still a separate step. */
export function createCodexDesktopManager({ runtime = createCodexDesktopRuntime(), dock = null, now = Date.now,
  sleep = delay, waitMs = 20000, pollMs = 250, cooldownMs = 30000 } = {}) {
  const operations = new Map();
  let active = null, last = null, closed = false, lastMutationAt = null;
  const view = operation => operation ? structuredClone(operation.value) : null;
  const status = () => ({ application: 'ChatGPT', operation: view(last) });
  async function waitFor(running) {
    const deadline = now() + waitMs;
    do {
      if (await runtime.isRunning() === running) return;
      if (now() >= deadline) break;
      await sleep(pollMs);
    } while (true);
    fail(409, running ? '桌面端启动尚未确认，请检查应用；不会自动再次重启'
      : '桌面端未退出，可能正在等待用户处理；未强制结束进程，也未重复打开应用');
  }
  async function execute(operation, assertAllowed, assertCanRestart) {
    const value = operation.value;
    let quitCompleted = false;
    const reuse = transport => {
      value.action = 'reuse'; value.daemon = transport.daemon;
      value.transportAfter = 'shared'; value.state = 'completed'; value.stage = 'shared-ready';
      value.message = 'ChatGPT 已连接共享 Unix socket，直接接入会话，未重启桌面端'
        + (value.dock?.enabled ? '；已启用 Dock 默认共享连接' : '');
    };
    const inspect = async () => {
      const transport = await runtime.inspectTransport();
      if (!['shared', 'stdio', 'not-running'].includes(transport?.mode))
        fail(409, '无法确认 ChatGPT 当前的通信方式，已保留桌面运行；请稍后重新检测');
      return transport;
    };
    const checkCooldown = () => {
      if (lastMutationAt !== null && now() - lastMutationAt < cooldownMs)
        fail(409, '桌面端刚执行过切换，请先查看结果，30 秒内不重复重启');
    };
    try {
      assertAllowed();
      await runtime.check();
      value.stage = 'checking-transport';
      let transport = await inspect();
      assertAllowed();
      value.transportBefore = transport.mode;
      value.action = transport.mode === 'shared' ? 'reuse' : transport.mode === 'stdio' ? 'restart' : 'start';
      if (transport.mode === 'stdio') assertCanRestart();
      if (transport.mode !== 'shared') checkCooldown();
      if (dock) {
        value.stage = 'checking-dock';
        value.dock = { enabled: false, action: null };
        const before = await dock.status();
        assertAllowed();
        value.dock.action = before.enabled ? 'reuse' : before.installed ? 'repair' : 'install';
        if (!before.enabled) value.stage = 'configuring-dock';
        // enable is idempotent: existing files/agent are verified and reused.
        // Only compact outcome fields leave this process, never paths or env values.
        const configured = await dock.enable({ assertAllowed });
        if (configured?.enabled !== true) fail(409, 'Dock 默认接入尚未配置成功，已保留桌面运行，请重试');
        value.dock.enabled = true;
        assertAllowed();
        // Installation may take time; refresh kernel evidence before choosing reuse/restart.
        value.stage = 'checking-transport';
        transport = await inspect();
        assertAllowed();
      }
      if (transport.mode === 'shared') { reuse(transport); return; }
      if (transport.mode === 'stdio') assertCanRestart();
      checkCooldown();
      value.action = transport.mode === 'stdio' ? 'restart' : 'start';
      value.stage = 'starting-daemon';
      assertAllowed();
      value.daemon = await runtime.ensureDaemon();
      assertAllowed();
      // The desktop may have switched on its own while the daemon was starting.
      value.stage = 'checking-transport';
      transport = await inspect();
      if (transport.mode === 'shared') { assertAllowed(); reuse(transport); return; }
      checkCooldown();
      if (transport.mode === 'stdio') {
        assertAllowed();
        assertCanRestart();
        value.action = 'restart';
        value.stage = 'quitting';
        lastMutationAt = now();
        await runtime.quit();
        value.stage = 'waiting-for-exit';
        await waitFor(false);
        quitCompleted = true;
      }
      // Once quit has completed, finish the explicitly authorized relaunch even
      // if the initiating browser has gone away. No second quit/restart is attempted.
      if (!quitCompleted) assertAllowed();
      if (!quitCompleted) value.action = 'start';
      value.stage = 'opening';
      lastMutationAt = now();
      await runtime.open({
        onAttempt: attempt => { value.stage = 'opening'; value.launchAttempts = attempt; },
        onRetry: ({ code }) => { value.stage = 'waiting-for-launch-service'; value.launchErrorCode = code; },
      });
      value.stage = 'checking-launch';
      await waitFor(true);
      value.stage = 'checking-transport';
      const deadline = now() + waitMs;
      do {
        transport = await runtime.inspectTransport();
        if (transport?.mode === 'shared') break;
        if (now() >= deadline) fail(409, transport?.mode === 'stdio'
          ? 'ChatGPT 仍在使用私有 stdio，本次切换未生效，请检查桌面端配置'
          : '尚未确认 ChatGPT 已连接共享 Unix socket，请稍后重新检测');
        await sleep(pollMs);
      } while (true);
      value.transportAfter = 'shared';
      value.daemon = transport.daemon;
      value.state = 'completed';
      value.stage = 'launched';
      value.message = 'ChatGPT 已连接共享 Unix socket，请继续绑定目标会话'
        + (value.dock?.enabled ? '；已启用 Dock 默认共享连接' : '');
    } catch (error) {
      if (Number.isInteger(error.launchErrorCode)) value.launchErrorCode = error.launchErrorCode;
      value.state = 'failed';
      value.message = error instanceof CodexDesktopFailure ? error.message
        : ({ checking: '桌面端启动条件检查失败', 'checking-dock': 'Dock 默认接入配置检查失败，已保留桌面运行，请重试',
          'configuring-dock': 'Dock 默认接入配置失败，已保留桌面运行，请检查本机安装权限后重试',
          'checking-transport': '桌面端通信方式检测失败，未自动重复重启', 'starting-daemon': '共享 daemon 启动失败，桌面端尚未退出',
          quitting: '桌面端退出未获确认，请检查 macOS 自动化权限或应用提示；未强制结束进程',
          'waiting-for-exit': '无法确认桌面端已退出，未重复打开应用',
          opening: `桌面端重新打开失败${value.launchErrorCode === null ? '' : `（macOS ${value.launchErrorCode}，已尝试 ${value.launchAttempts} 次）`}，可在网页重新选择 ChatGPT / Codex 重试打开`,
          'waiting-for-launch-service': '等待 macOS 清理旧应用记录失败，可在网页重新选择 ChatGPT / Codex 重试打开',
          'checking-launch': '桌面端启动状态未获确认，请检查应用' }[value.stage] || '桌面端切换未完成');
    } finally {
      value.finishedAt = now();
      if (active === operation) active = null;
    }
  }
  return {
    capabilities: Object.freeze({ dockPersistence: Boolean(dock) }),
    status,
    restart({ requestId, assertAllowed = () => {}, assertCanRestart = () => {} } = {}) {
      if (closed) fail(503, '连接器正在关闭');
      if (typeof requestId !== 'string' || !UUID.test(requestId)) fail(400, '请求标识须为 UUID');
      const previous = operations.get(requestId);
      if (previous) return view(previous);
      if (active) fail(409, '桌面端切换正在进行，请等待当前操作');
      if (operations.size >= 64) fail(409, '本次连接器的桌面端操作记录已满，请重新启动连接器');
      assertAllowed();
      const operation = { value: { requestId, state: 'running', stage: 'checking', startedAt: now(),
        finishedAt: null, daemon: null, action: null, transportBefore: null, transportAfter: null,
        launchAttempts: 0, launchErrorCode: null, dock: null,
        sharedSessionVerified: false, message: '正在检查桌面端接入方式' } };
      operations.set(requestId, operation);
      active = last = operation;
      operation.promise = new Promise(resolve => setImmediate(resolve)).then(() => execute(operation, assertAllowed, assertCanRestart));
      return view(operation);
    },
    async close() { closed = true; await active?.promise; },
  };
}

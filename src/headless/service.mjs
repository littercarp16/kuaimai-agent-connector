import net from 'node:net';
import { mkdir, lstat, chmod, unlink, realpath } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import packageInfo from '../../package.json' with { type: 'json' };
import { createDesktopHost } from '../desktop/host.mjs';
import { createCodexDesktopManager } from '../runtime/codex-desktop.mjs';
import { parseConnectURL } from '../desktop/connect-grants.mjs';
import { DIRECT_REQUEST_TTL_MS } from '../desktop/direct-grants.mjs';
import { validWebOrigin } from '../runtime/web-origin.mjs';
import { claimService } from '../runtime/service-instance.mjs';
import { createFileLogger } from '../runtime/logger.mjs';
import { ORIGINS as EXTENSION_ORIGINS } from '../extension/policy.mjs';

export const VERSION = packageInfo.version;
export const dataRoot = () => join(homedir(), '.kuaimai-agent', 'code');
const sharedDirectory = () => join(dataRoot(), 'instances', 'shared');
const CONTROL_PROTOCOL = 1;
const missingService = error => ['ENOENT', 'ECONNREFUSED'].includes(error.code);
const requireOrigin = origin => {
  if (!validWebOrigin(origin)) throw Error('无效的网页来源');
};
const legacyDirectory = origin => join(dataRoot(), 'instances', createHash('sha256').update(origin).digest('hex').slice(0, 16));
export async function privateDirectory(directory) {
  const absolute = resolve(directory).replace(/^\/var\//, '/private/var/').replace(/^\/tmp\//, '/private/tmp/'); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('运行路径不能包含链接或普通文件');
  }
  const info = await lstat(absolute);
  if (info.uid !== process.getuid()) throw Error('运行目录不属于当前用户');
  await chmod(absolute, 0o700); return absolute;
}
export function decodeRequest(encoded, now = Date.now()) {
  if (typeof encoded !== 'string' || !/^[\w-]{1,10000}$/.test(encoded)) throw Error('连接请求格式无效');
  const value = JSON.parse(Buffer.from(encoded, 'base64url'));
  if (!value || Object.keys(value).sort().join() !== 'created,url' || !Number.isFinite(value.created) || now - value.created >= DIRECT_REQUEST_TTL_MS || value.created > now + 30000) throw Error('连接请求已过期，请在网页重新复制');
  const origin = new URL(value.url).searchParams.get('origin');
  return { ...value, ...parseConnectURL(value.url, [origin]) };
}
export async function control(directory, request) {
  const socketPath = join(directory, 'control.sock'), info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('本机控制通道权限无效');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let bytes = '';
    socket.setTimeout(15000, () => socket.destroy(Error('本机服务响应超时')));
    socket.on('connect', () => socket.end(JSON.stringify(request) + '\n'));
    socket.on('data', data => { bytes += data; if (bytes.length > 20000) socket.destroy(Error('响应过长')); });
    socket.on('error', reject);
    socket.on('end', () => { try { const value = JSON.parse(bytes); if (!value.ok) throw Object.assign(Error(value.error), { code: value.code }); resolve(value.data); } catch (error) { reject(error); } });
  });
}
export async function manageService(action, { origin, directory } = {}) {
  if (origin !== undefined || !directory) requireOrigin(origin);
  const request = { action, origin };
  if (directory) return control(directory, request);
  const shared = await control(sharedDirectory(), request).catch(error => {
    if (!missingService(error)) throw error;
    return null;
  });
  if (shared && (action === 'status' || shared.stopped)) return shared;
  return control(legacyDirectory(origin), { action });
}
export async function runService({ origin, directory = sharedDirectory(), port = 17653, qwenDesktopFactory }) {
  requireOrigin(origin);
  process.title = 'kuaimai-agent-connector';
  directory = await privateDirectory(directory);
  const logger = createFileLogger({ path: join(directory, 'service.log') });
  const socketPath = join(directory, 'control.sock');
  const host = createDesktopHost({ directory, preferredPort: port, reconnect: true, direct: true, logger, qwenDesktopFactory,
    // Code mode never installs either the bridge or Codex login task.
    desktopFactory: () => createCodexDesktopManager(),
  });
  let server, closing = false, shutdownRequested = false, ownsControlSocket = false, browserSetup;
  const publicStatus = requestedOrigin => {
    const { endpoint, instanceId, state, origins } = host.status();
    return { version: VERSION, controlProtocol: CONTROL_PROTOCOL, endpoint, instanceId, state: shutdownRequested ? 'stopping' : state, origin: requestedOrigin ?? origins[0] ?? null, origins, pid: process.pid, loginStartup: false, qwenDesktopPreparation: true, logging: logger.status() };
  };
  const fatal = error => logger.error('process.uncaught_exception', { instanceId: host.status().instanceId, error });
  process.on('uncaughtExceptionMonitor', fatal);
  const signals = new Map(['SIGINT','SIGTERM'].map(signal => [signal, () => { logger.info('service.signal', { signal }); void stop().catch(() => { process.exitCode = 1; }); }]));
  async function stop() {
    if (closing) return; closing = true; shutdownRequested = true;
    try {
      await host.stop();
    } finally {
      server?.close(); if (ownsControlSocket) await unlink(socketPath).catch(() => {});
      for (const [signal, handler] of signals) process.removeListener(signal, handler);
      process.removeListener('uncaughtExceptionMonitor', fatal); logger.close();
    }
  }
  function assertRunning() {
    if (shutdownRequested) throw Object.assign(Error('连接器正在退出'), { code: 'ESHUTDOWN' });
  }
  function registerBrowser() {
    return browserSetup ||= import('../extension/install.mjs').then(module => module.installExtensionHost()).finally(() => { browserSetup = null; });
  }
  try {
    if (Buffer.byteLength(socketPath) > 100) throw Error('后台运行目录路径过长');
    await host.start({ origins: [origin] });
    // The host lease was acquired first, so only its owner may replace a stale socket.
    try { const old = await lstat(socketPath); if (!old.isSocket() || old.uid !== process.getuid()) throw Error('已有控制路径无法替换'); await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    server = net.createServer({ allowHalfOpen: true }, socket => {
      let bytes = '';
      socket.setTimeout(10000, () => { logger.warn('control.timeout'); socket.destroy(); });
      socket.on('error', error => logger.warn('control.socket_error', { error }));
      socket.on('data', data => { bytes += data; if (bytes.length > 16000) { logger.warn('control.rejected', { reason: 'request_too_large' }); socket.destroy(); } });
      socket.on('end', async () => {
        const started = performance.now(); let action = 'unknown';
        try {
          const request = JSON.parse(bytes); let data, stopService = false;
          if (['status','start','connect','stop'].includes(request.action)) action = request.action;
          if (request.origin !== undefined) requireOrigin(request.origin);
          if (action === 'status') {
            const status = publicStatus(request.origin);
            data = request.origin === undefined || status.origins.includes(request.origin) ? status : null;
          }
          else if (action === 'start') {
            assertRunning();
            host.allowOrigin(request.origin);
            data = publicStatus(request.origin);
          }
          else if (action === 'connect') {
            assertRunning();
            const parsed = decodeRequest(request.request);
            const browserExtension = request.registerExtension === true && parsed.transport === 'direct' && EXTENSION_ORIGINS.includes(parsed.origin) ? await registerBrowser() : null;
            assertRunning();
            const added = host.allowOrigin(parsed.origin);
            try {
              const pending = host.inspectLink(parsed.url, { requestExpiresAt: parsed.created + DIRECT_REQUEST_TTL_MS });
              data = { ...host.authorize(pending.id), ...publicStatus(parsed.origin) };
            } catch (error) {
              if (added) host.revokeOrigin(parsed.origin);
              throw error;
            }
            if (browserExtension) data.browserExtension = browserExtension;
            if (parsed.provider === 'qwen') data.preparation = host.prepareQwen();
            logger.info('web.authorized', { origin: parsed.origin, instanceId: data.instanceId });
          } else if (action === 'stop') {
            assertRunning();
            const stopped = request.origin === undefined || host.revokeOrigin(request.origin);
            stopService = stopped && (request.origin === undefined || !host.status().origins.length);
            if (stopService) shutdownRequested = true;
            data = { stopped, serviceStopped: stopService };
          }
          else throw Error('不支持的本机操作');
          logger.info('control.request', { action, durationMs: Math.round((performance.now() - started) * 100) / 100, outcome: 'completed' });
          socket.end(JSON.stringify({ ok: true, data }), () => {
            if (stopService) void stop().catch(() => { process.exitCode = 1; });
          });
        } catch (error) {
          logger.warn('control.request', { action, durationMs: Math.round((performance.now() - started) * 100) / 100, outcome: 'rejected', error });
          socket.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 240), ...(error.code === 'ESHUTDOWN' ? { code: error.code } : {}) }));
        }
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    ownsControlSocket = true;
    await chmod(socketPath, 0o600);
    for (const [signal, handler] of signals) process.once(signal, handler);
    return { status: publicStatus, stop };
  } catch (error) { logger.error('service.start_failed', { error }); await stop(); throw error; }
}
export async function ensureService({ origin, directory = sharedDirectory(), port = 17653 }) {
  requireOrigin(origin);
  directory = await privateDirectory(directory);
  const check = async () => {
    try {
      const status = await control(directory, { action: 'status' });
      if (status?.controlProtocol !== CONTROL_PROTOCOL || !/^\d+\.\d+\.\d+$/.test(status.version || '')) throw Error('已有连接器的本机控制协议不兼容，请使用匹配的 npm 版本');
      return status;
    } catch (error) { if (missingService(error)) return null; throw error; }
  };
  const reusable = status => status?.state === 'running' && status.version.localeCompare(VERSION, undefined, { numeric: true }) >= 0;
  let release;
  for (let i = 0; i < 100; i++) {
    const existing = await check();
    if (reusable(existing)) return { ...existing, reused: true };
    if (existing?.state !== 'stopping') {
      try { release = await claimService(join(directory, 'startup'), 'shared'); break; }
      catch (error) { if (error.message !== '连接器已经运行或正在启动') throw error; }
    }
    await delay(100);
  }
  if (!release) throw Error('后台启动未获确认，请检查服务日志');
  try {
    const raced = await check(); if (reusable(raced)) return { ...raced, reused: true };
    if (raced) {
      // Upgrade through the shared, user-owned control socket.
      if (raced.state !== 'stopping') await control(directory, { action: 'stop' }).catch(error => { if (!missingService(error) && error.code !== 'ESHUTDOWN') throw error; });
      for (let i = 0; i < 100 && await check(); i++) await delay(100);
      if (await check()) throw Error('旧连接器尚未退出，请稍后重试');
    }
    const entry = fileURLToPath(new URL('../../headless.mjs', import.meta.url));
    const launchLog = createFileLogger({ path: join(directory, 'service.log') });
    launchLog.info('service.launching', { origin, preferredPort: port }); launchLog.close();
    // The child writes structured logs itself. Raw stderr can contain prompts
    // or credentials and must not bypass rotation or the log field allowlist.
    const child = spawn(process.execPath, [entry, 'serve', '--origin', origin, '--directory', directory, '--port', String(port)], { detached: true, stdio: 'ignore', cwd: await realpath(fileURLToPath(new URL('../../', import.meta.url))) });
    const failed = error => {
      const log = createFileLogger({ path: join(directory, 'service.log') });
      log.error('service.launch_failed', { error, exitCode: child.exitCode, signal: child.signalCode }); log.close();
    };
    try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref(); }
    catch (error) { failed(error); throw error; }
    for (let i = 0; i < 100; i++) {
      await delay(100); const ready = await check(); if (ready) return { ...ready, reused: false };
      if (child.exitCode !== null || child.signalCode !== null) { failed(); throw Error('后台启动失败，请检查服务日志'); }
    }
    throw Error('后台启动未获确认，请检查服务日志；不会重复启动');
  } finally { await release(); }
}
export async function connectService(encoded, { directory = sharedDirectory(), port, registerExtension = false } = {}) {
  const { origin } = decodeRequest(encoded);
  const status = await ensureService({ origin, directory, port });
  const request = { action: 'connect', request: encoded, registerExtension };
  try {
    return { ...await control(directory, request), reused: status.reused };
  } catch (error) {
    if (!missingService(error) && error.code !== 'ESHUTDOWN') throw error;
    const ready = await ensureService({ origin, directory, port });
    return { ...await control(directory, request), reused: ready.reused };
  }
}
export async function startService({ origin, directory = sharedDirectory(), port }) {
  const status = await ensureService({ origin, directory, port });
  return { ...await control(directory, { action: 'start', origin }), reused: status.reused };
}
export async function openCallback(result) {
  const browsers = { chrome: 'com.google.Chrome', edge: 'com.microsoft.edgemac', firefox: 'org.mozilla.firefox', safari: 'com.apple.Safari' };
  await promisify(execFile)('/usr/bin/open', [...(browsers[result.browser] ? ['-b', browsers[result.browser]] : []), result.callbackURL], { timeout: 10000 });
}

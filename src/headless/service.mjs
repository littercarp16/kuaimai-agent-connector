import net from 'node:net';
import { mkdir, lstat, chmod, unlink, realpath } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopHost } from '../desktop/host.mjs';
import { createCodexDesktopManager } from '../runtime/codex-desktop.mjs';
import { parseConnectURL } from '../desktop/connect-grants.mjs';
import { validWebOrigin } from '../runtime/web-origin.mjs';
import { claimService } from '../runtime/service-instance.mjs';
import { createFileLogger } from '../runtime/logger.mjs';

export const VERSION = '0.4.0';
export const dataRoot = () => join(homedir(), '.kuaimai-agent', 'code');
export function instanceDirectory(origin, root = dataRoot()) {
  if (!validWebOrigin(origin)) throw Error('无效的网页来源');
  return join(root, 'instances', createHash('sha256').update(origin).digest('hex').slice(0, 16));
}
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
  if (!value || Object.keys(value).sort().join() !== 'created,url' || !Number.isFinite(value.created) || now - value.created > 1800000 || value.created > now + 30000) throw Error('连接请求已过期，请在网页重新复制');
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
    socket.on('end', () => { try { const value = JSON.parse(bytes); if (!value.ok) throw Error(value.error); resolve(value.data); } catch (error) { reject(error); } });
  });
}
export async function runService({ origin, directory, port = 17653, qwenDesktopFactory }) {
  process.title = 'kuaimai-agent-connector';
  directory = await privateDirectory(directory);
  const logger = createFileLogger({ path: join(directory, 'service.log') });
  const socketPath = join(directory, 'control.sock');
  const host = createDesktopHost({ directory, preferredPort: port, reconnect: true, direct: true, logger, qwenDesktopFactory,
    // Code mode never installs either the bridge or Codex login task.
    desktopFactory: () => createCodexDesktopManager(),
  });
  const publicStatus = () => { const { endpoint, instanceId, state } = host.status(); return { version: VERSION, endpoint, instanceId, state, origin, pid: process.pid, loginStartup: false, qwenDesktopPreparation: true, logging: logger.status() }; };
  const fatal = error => logger.error('process.uncaught_exception', { instanceId: host.status().instanceId, error });
  process.on('uncaughtExceptionMonitor', fatal);
  let server, closing = false, ownsControlSocket = false;
  const signals = new Map(['SIGINT','SIGTERM'].map(signal => [signal, () => { logger.info('service.signal', { signal }); void stop().catch(() => { process.exitCode = 1; }); }]));
  async function stop() {
    if (closing) return; closing = true;
    try {
      server?.close(); await host.stop(); if (ownsControlSocket) await unlink(socketPath).catch(() => {});
    } finally {
      for (const [signal, handler] of signals) process.removeListener(signal, handler);
      process.removeListener('uncaughtExceptionMonitor', fatal); logger.close();
    }
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
          const request = JSON.parse(bytes); let data;
          if (['status','connect','stop'].includes(request.action)) action = request.action;
          if (action === 'status') data = publicStatus();
          else if (action === 'connect') {
            const parsed = decodeRequest(request.request);
            if (parsed.origin !== origin) throw Error('连接请求不属于当前网页');
            const pending = host.inspectLink(parsed.url); data = { ...host.authorize(pending.id), ...publicStatus() };
            if (parsed.provider === 'qwen') data.preparation = host.prepareQwen();
            logger.info('web.authorized', { origin, instanceId: data.instanceId });
          } else if (action === 'stop') { data = { stopped: true }; setTimeout(() => void stop().catch(() => { process.exitCode = 1; }), 50); }
          else throw Error('不支持的本机操作');
          logger.info('control.request', { action, durationMs: Math.round((performance.now() - started) * 100) / 100, outcome: 'completed' });
          socket.end(JSON.stringify({ ok: true, data }));
        } catch (error) {
          logger.warn('control.request', { action, durationMs: Math.round((performance.now() - started) * 100) / 100, outcome: 'rejected', error });
          socket.end(JSON.stringify({ ok: false, error: String(error.message).slice(0, 240) }));
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
export async function ensureService({ origin, directory = instanceDirectory(origin), port = 17653 }) {
  directory = await privateDirectory(directory);
  const check = async () => {
    try { const status = await control(directory, { action: 'status' }); if (status.origin !== origin) throw Error('已有连接器来源不匹配'); return status; }
    catch (error) { if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null; throw error; }
  };
  const existing = await check(); if (existing?.version === VERSION && existing.qwenDesktopPreparation === true) return { ...existing, reused: true };
  let release;
  try { release = await claimService(join(directory, 'startup'), origin); }
  catch { for (let i = 0; i < 100; i++) { await delay(100); const ready = await check(); if (ready?.version === VERSION && ready.qwenDesktopPreparation === true) return { ...ready, reused: true }; } throw Error('后台启动未获确认，请检查服务日志'); }
  try {
    const raced = await check(); if (raced?.version === VERSION && raced.qwenDesktopPreparation === true) return { ...raced, reused: true };
    if (raced) {
      // This is the owned per-origin control socket, never an arbitrary TCP
      // process or the native Agent. Upgrade only older known release versions.
      if (!/^\d+\.\d+\.\d+$/.test(raced.version || '') || raced.version.localeCompare(VERSION, undefined, { numeric: true }) > 0) throw Error('已有连接器版本更新，请使用匹配的 npm 版本');
      await control(directory, { action: 'stop' });
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
export async function connectService(encoded, options = {}) {
  const request = decodeRequest(encoded), directory = options.directory || instanceDirectory(request.origin);
  const status = await ensureService({ ...options, origin: request.origin, directory });
  const result = await control(directory, { action: 'connect', request: encoded });
  return { ...result, reused: status.reused };
}
export async function openCallback(result) {
  const browsers = { chrome: 'com.google.Chrome', edge: 'com.microsoft.edgemac', firefox: 'org.mozilla.firefox', safari: 'com.apple.Safari' };
  await promisify(execFile)('/usr/bin/open', [...(browsers[result.browser] ? ['-b', browsers[result.browser]] : []), result.callbackURL], { timeout: 10000 });
}

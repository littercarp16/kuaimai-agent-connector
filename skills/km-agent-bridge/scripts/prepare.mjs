#!/usr/bin/env node
// Portable Node 22 bootstrap. Only built-ins; no SDK, repository imports or install scripts.
import { constants } from 'node:fs';
import { lstat, stat, open, realpath, mkdir, mkdtemp, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const MAX_DOWNLOAD = 64 * 1024 * 1024;
const MAX_DECODED = 48 * 1024 * 1024;
const MAX_FILES = 10000;
const IDENTIFIER = /^[\w:.-]{1,140}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ALIASES = new Map([['/var', '/private/var'], ['/tmp', '/private/tmp'], ['/etc', '/private/etc']]);
const CODES = new Set(['RETIRED_ADAPTER', 'INVALID_CONFIG', 'UNSAFE_PATH', 'UNSAFE_RUNTIME', 'INVALID_RUNTIME', 'UNSUPPORTED_SERVICE', 'STALE_INSTANCE', 'HTTP_REJECTED', 'HTTP_FAILED', 'PORT_UNKNOWN', 'INSTALL_SOURCE_REQUIRED', 'INSTALL_CONFLICT', 'DOWNLOAD_FAILED', 'DOWNLOAD_TOO_LARGE', 'HASH_MISMATCH', 'INVALID_BUNDLE', 'LOCK_TIMEOUT', 'LOCK_UNSAFE', 'START_UNKNOWN', 'READINESS_TIMEOUT', 'LOCAL_FAILURE', 'SDK_FAILED']);
export class RuntimePrepareError extends Error {
  constructor(code, message = code) { super(message); this.name = 'RuntimePrepareError'; this.code = code; }
}
const fail = code => { throw new RuntimePrepareError(code); };
export const publicErrorCode = error => error instanceof RuntimePrepareError && CODES.has(error.code) ? error.code : 'LOCAL_FAILURE';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value, required, optional = []) => object(value) && required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key));
const owned = info => !process.getuid || info.uid === process.getuid();
const absolute = path => typeof path === 'string' && isAbsolute(path) && !path.includes('\0') && !path.includes('://');
const sha256 = value => createHash('sha256').update(value).digest('hex');
export function validVersion(value) {
  if (typeof value !== 'string' || value.length > 120 || !SEMVER.test(value)) return false;
  const prerelease = value.split('+')[0].match(/^[^-]+-(.+)/)?.[1];
  return !prerelease || prerelease.split('.').every(part => !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'));
}

export async function safeLocalPath(path, { allowMissing = false } = {}) {
  if (!absolute(path)) fail('UNSAFE_PATH');
  const full = resolve(path), root = parse(full).root, parts = full.slice(root.length).split(sep).filter(Boolean);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return join(await realpath(dirname(current)), ...parts.slice(index));
      fail('UNSAFE_PATH');
    }
    if (info.isSymbolicLink()) {
      if (process.platform !== 'darwin' || !ALIASES.has(current) || await realpath(current) !== ALIASES.get(current)) fail('UNSAFE_PATH');
    } else if (index < parts.length - 1 && !info.isDirectory()) fail('UNSAFE_PATH');
  }
  return realpath(full);
}

export async function readConfigFile(path, { runtime = false, limit = 16384 } = {}) {
  const canonical = await safeLocalPath(path);
  let handle;
  try {
    const parent = await stat(dirname(canonical));
    if (runtime && (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || !owned(parent))) fail('UNSAFE_RUNTIME');
    handle = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (runtime ? constants.O_NONBLOCK || 0 : 0));
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) fail(runtime ? 'INVALID_RUNTIME' : 'INVALID_CONFIG');
    if (runtime && ((before.mode & 0o777) !== 0o600 || !owned(before) || before.nlink !== 1)) fail('UNSAFE_RUNTIME');
    // Bounded reads also handle files that grow after stat().
    const buffer = Buffer.alloc(limit + 1); let size = 0;
    while (size < buffer.length) { const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size); if (!bytesRead) break; size += bytesRead; }
    if (size > limit) fail(runtime ? 'INVALID_RUNTIME' : 'INVALID_CONFIG');
    await safeLocalPath(path);
    const after = await lstat(canonical), parentAfter = await stat(dirname(canonical));
    if (before.ino !== after.ino || before.dev !== after.dev || parent.ino !== parentAfter.ino || parent.dev !== parentAfter.dev) fail('UNSAFE_PATH');
    return JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } catch (error) {
    if (error instanceof RuntimePrepareError) throw error;
    fail(runtime ? 'INVALID_RUNTIME' : 'INVALID_CONFIG');
  } finally { await handle?.close(); }
}

export function validLoopbackOrigin(value, endpoint = false) {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && (endpoint
      ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port) && Number(url.port) >= 1024
      : ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}

// Keep this portable bootstrap validator aligned with runtime/web-origin.mjs.
function validAdditionalOrigin(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  try {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password || url.search || url.hash || !url.hostname || url.hostname.includes('*')) return false;
    return url.protocol === 'https:' || url.protocol === 'http:' && (['127.0.0.1', '[::1]', 'localhost', 'local.lt.com', 'lt.com'].includes(url.hostname) || url.hostname.endsWith('.localhost'));
  } catch { return false; }
}

export async function loadBootstrapConfig(configFile) {
  const config = await readConfigFile(configFile);
  if (!shape(config, ['version', 'endpoint', 'origin', 'launcher', 'runtimeFile', 'mcpEntry', 'launchArgs'], ['release', 'allowPortFallback']) || config.allowPortFallback !== undefined && typeof config.allowPortFallback !== 'boolean' || config.version !== 1 || !validLoopbackOrigin(config.endpoint, true) || !validLoopbackOrigin(config.origin) || !['launcher', 'runtimeFile', 'mcpEntry'].every(key => absolute(config[key]))) fail('INVALID_CONFIG');
  const args = config.launchArgs, values = new Map(), additionalOrigins = [];
  if (!Array.isArray(args) || args.length > 43 || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) fail('INVALID_CONFIG');
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === '--allow-origin') {
      const origin = args[++index];
      if (!validAdditionalOrigin(origin) || origin === config.origin || additionalOrigins.includes(origin) || additionalOrigins.length >= 15) fail('INVALID_CONFIG');
      additionalOrigins.push(origin); continue;
    }
    if (values.has(key)) fail('INVALID_CONFIG');
    if (key === '--pin-session') { values.set(key, true); continue; }
    if (!['--adapter', '--session', '--trust-origin', '--port', '--workspace'].includes(key) || index + 1 >= args.length) fail('INVALID_CONFIG');
    values.set(key, args[++index]);
  }
  if (values.get('--adapter') === 'opencode') throw new RuntimePrepareError('RETIRED_ADAPTER', '当前配置指定了已移除的 OpenCode。请在网页重新选择 Agent 并复制连接请求。');
  if (values.get('--adapter') !== 'generic' || values.get('--trust-origin') !== config.origin || values.get('--port') !== new URL(config.endpoint).port || !absolute(values.get('--workspace')) || values.has('--session') && !/^ses[\w-]{1,120}$/.test(values.get('--session'))) fail('INVALID_CONFIG');
  const workspace = await safeLocalPath(values.get('--workspace'));
  if (!(await stat(workspace)).isDirectory()) fail('INVALID_CONFIG');
  for (const key of ['launcher', 'mcpEntry', 'runtimeFile']) await safeLocalPath(config[key], { allowMissing: true });
  if (config.release !== undefined) {
    const release = config.release;
    if (!shape(release, ['url', 'sha256', 'version', 'installRoot']) || typeof release.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(release.sha256) || !validVersion(release.version) || !absolute(release.installRoot)) fail('INVALID_CONFIG');
    let url;
    try { url = new URL(release.url); } catch { fail('INVALID_CONFIG'); }
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash || typeof release.url !== 'string' || release.url.length > 2048) fail('INVALID_CONFIG');
    await safeLocalPath(release.installRoot, { allowMissing: true });
  }
  return config;
}

async function regularFile(path) {
  const canonical = await safeLocalPath(path, { allowMissing: true });
  try { if (!(await lstat(canonical)).isFile()) fail('UNSAFE_PATH'); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function privateDirectory(path) {
  const canonical = await safeLocalPath(path, { allowMissing: true });
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  await safeLocalPath(path);
  const info = await lstat(canonical);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || !owned(info)) fail('UNSAFE_PATH');
  return canonical;
}

// Locks are never stolen, even when apparently stale. A timeout requires local investigation.
async function withLock(path, waitMs, action, { retainUncertain = false } = {}) {
  const token = randomUUID(), deadline = Date.now() + waitMs;
  let handle, identity, release = true;
  while (!handle) {
    // Only the parent is stable. The owner can release the lock at any time.
    await safeLocalPath(dirname(path));
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') fail('LOCK_UNSAFE');
      const info = await lstat(path).catch(cause => {
        if (cause.code === 'ENOENT') return null;
        throw cause;
      });
      if (info && (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || !owned(info) || info.nlink !== 1)) fail('LOCK_UNSAFE');
      if (Date.now() >= deadline) fail('LOCK_TIMEOUT');
      if (!info) continue;
      await delay(Math.min(40, Math.max(1, deadline - Date.now())));
    }
  }
  try {
    identity = await handle.stat(); await handle.writeFile(JSON.stringify({ token })); await handle.close(); handle = null;
    return await action();
  } catch (error) {
    // A launcher can detach before timing out. Keeping our lock prevents another
    // automatic call from launching a second, still-starting instance. A late
    // healthy instance can still be reused without touching this lock.
    if (retainUncertain && ['START_UNKNOWN', 'READINESS_TIMEOUT'].includes(error.code)) release = false;
    throw error;
  } finally {
    await handle?.close();
    // Both inode and token must still be ours. Never remove a replaced/foreign lock.
    try {
      if (release) {
        const current = await lstat(path), data = await readConfigFile(path);
        if (current.ino === identity?.ino && current.dev === identity?.dev && data.token === token) await unlink(path);
      }
    } catch {}
  }
}

async function portOpen(endpoint, timeoutMs) {
  return new Promise((resolvePort, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
    let finished = false;
    const finish = result => { if (finished) return; finished = true; socket.destroy(); result instanceof Error ? reject(result) : resolvePort(result); };
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(error.code === 'ECONNREFUSED' ? false : new RuntimePrepareError('PORT_UNKNOWN')));
    socket.setTimeout(timeoutMs, () => finish(new RuntimePrepareError('PORT_UNKNOWN')));
  });
}

async function boundedBody(response, limit, code) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); fail(code); }
  const chunks = []; let bytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > limit) { await reader.cancel(); fail(code); } chunks.push(value); }
    } finally { reader.releaseLock(); }
  }
  return Buffer.concat(chunks, bytes);
}
async function health(config, timeoutMs) {
  let data;
  try {
    const response = await fetch(config.endpoint + '/v1/health', { redirect: 'error', headers: { Origin: config.origin, 'X-Km-Agent': '1' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); fail('HTTP_REJECTED'); }
    data = JSON.parse((await boundedBody(response, 65536, 'UNSUPPORTED_SERVICE')).toString('utf8'));
  } catch (error) { if (error instanceof RuntimePrepareError) throw error; fail('HTTP_FAILED'); }
  if (data?.ok !== true || data.data?.service !== 'kuaimai-agent-connector' || data.data?.interactionProtocol !== 'km-agent/1' || typeof data.data?.instanceId !== 'string' || !IDENTIFIER.test(data.data.instanceId)) fail('UNSUPPORTED_SERVICE');
  return data.data;
}
async function readRuntime(config) {
  const runtime = await readConfigFile(config.runtimeFile, { runtime: true, limit: 128 * 1024 });
  if (!shape(runtime, ['instanceId', 'endpoint', 'protocol', 'key', 'bindings']) || typeof runtime.instanceId !== 'string' || !IDENTIFIER.test(runtime.instanceId) || runtime.protocol !== 'km-agent/1' || typeof runtime.key !== 'string' || !/^[\x21-\x7e]{20,256}$/.test(runtime.key) || !Array.isArray(runtime.bindings) || runtime.bindings.length > 1000 || !validLoopbackOrigin(runtime.endpoint, true)) fail('INVALID_RUNTIME');
  return runtime;
}
async function verifyRuntime(config, instance) {
  const runtime = await readRuntime(config);
  if (runtime.endpoint !== config.endpoint || runtime.instanceId !== instance.instanceId) fail('STALE_INSTANCE');
}

async function isRunning(config, timeoutMs, { manifestPending = false } = {}) {
  if (config.allowPortFallback === true) {
    if (!await regularFile(config.runtimeFile)) return false;
    const runtime = await readRuntime(config);
    if (!await portOpen(runtime.endpoint, timeoutMs)) return false;
    let instance;
    try { instance = await health({ ...config, endpoint: runtime.endpoint }, timeoutMs); }
    catch (error) { if (['HTTP_FAILED', 'HTTP_REJECTED', 'UNSUPPORTED_SERVICE'].includes(error.code)) return false; throw error; }
    if (instance.instanceId !== runtime.instanceId) return false;
    await verifyRuntime({ ...config, endpoint: runtime.endpoint }, instance);
    return { endpoint: runtime.endpoint, instanceId: instance.instanceId };
  }
  if (!await portOpen(config.endpoint, timeoutMs)) return false;
  const instance = await health(config, timeoutMs);
  // Only our own bounded startup may wait for an absent manifest. An existing listener
  // without a matching private manifest is never treated as an install/start opportunity.
  if (manifestPending && !await regularFile(config.runtimeFile)) return false;
  await verifyRuntime(config, instance);
  return { endpoint: config.endpoint, instanceId: instance.instanceId };
}

// Read-only discovery: only a private manifest plus matching service identity is published.
export async function inspectRuntime({ configFile, expectedOrigin, requestTimeoutMs = 1000 } = {}) {
  const config = await loadBootstrapConfig(configFile);
  if (expectedOrigin !== undefined && expectedOrigin !== config.origin) fail('INVALID_CONFIG');
  return await isRunning(config, duration(requestTimeoutMs, 1000)) || null;
}

function relativeBundlePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1000 && !/[\\:\x00-\x1f\x7f]/.test(path) && !path.startsWith('/') && path.split('/').every(part => part && part !== '.' && part !== '..');
}
function safePayloadPath(path) {
  return relativeBundlePath(path) && !path.split('/').some(part => /^(?:\.runtime|\.env(?:\..*)?|\.git|\.npmrc|\.netrc|\.ssh)$/i.test(part) || /\.(?:pem|key|log)$/i.test(part));
}
function validatedBundle(bytes, config) {
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); } catch { fail('INVALID_BUNDLE'); }
  if (!shape(bundle, ['format', 'version', 'entries', 'files']) || bundle.format !== 'km-runtime-bundle/1' || bundle.version !== config.release.version || !shape(bundle.entries, ['launcher', 'mcpEntry', 'runtimeFile']) || !Array.isArray(bundle.files) || bundle.files.length < 2 || bundle.files.length > MAX_FILES) fail('INVALID_BUNDLE');
  const target = join(config.release.installRoot, config.release.version);
  for (const key of ['launcher', 'mcpEntry', 'runtimeFile']) {
    if (!relativeBundlePath(bundle.entries[key]) || resolve(target, bundle.entries[key]) !== resolve(config[key])) fail('INVALID_BUNDLE');
  }
  if (new Set(Object.values(bundle.entries)).size !== 3) fail('INVALID_BUNDLE');
  const paths = new Set(), decoded = []; let total = 0;
  for (const file of bundle.files) {
    if (!shape(file, ['path', 'content']) || !safePayloadPath(file.path) || file.path === bundle.entries.runtimeFile || paths.has(file.path.toLowerCase()) || typeof file.content !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) fail('INVALID_BUNDLE');
    const content = Buffer.from(file.content, 'base64');
    if (content.toString('base64') !== file.content || (total += content.length) > MAX_DECODED) fail('INVALID_BUNDLE');
    paths.add(file.path.toLowerCase()); decoded.push({ path: file.path, content });
  }
  for (const key of ['launcher', 'mcpEntry']) if (!decoded.some(file => file.path === bundle.entries[key])) fail('INVALID_BUNDLE');
  // A file cannot also be an ancestor directory (including on case-insensitive macOS).
  for (const file of decoded) { const parts = file.path.toLowerCase().split('/'); parts.pop(); while (parts.length) { if (paths.has(parts.join('/'))) fail('INVALID_BUNDLE'); parts.pop(); } }
  return decoded;
}

async function installRuntime(config, { fetcher, requestTimeoutMs, lockWaitMs }) {
  if (!config.release) fail('INSTALL_SOURCE_REQUIRED');
  const installRoot = await privateDirectory(config.release.installRoot), target = join(installRoot, config.release.version);
  return withLock(join(installRoot, '.prepare-install.lock'), lockWaitMs, async () => {
    if (await regularFile(config.launcher) && await regularFile(config.mcpEntry)) return false;
    // Never fill or replace an existing target, even when it appears empty.
    try { await lstat(target); fail('INSTALL_CONFLICT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let bytes;
    try {
      const response = await fetcher(config.release.url, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!response.ok || response.redirected) { await response.body?.cancel(); fail('DOWNLOAD_FAILED'); }
      bytes = await boundedBody(response, MAX_DOWNLOAD, 'DOWNLOAD_TOO_LARGE');
    } catch (error) { if (error instanceof RuntimePrepareError) throw error; fail('DOWNLOAD_FAILED'); }
    if (sha256(bytes) !== config.release.sha256.toLowerCase()) fail('HASH_MISMATCH');
    const files = validatedBundle(bytes, config), staging = await mkdtemp(join(installRoot, '.prepare-staging-'));
    try {
      for (const file of files) {
        const path = join(staging, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        try { await handle.writeFile(file.content); } finally { await handle.close(); }
      }
      await safeLocalPath(installRoot);
      try { await lstat(target); fail('INSTALL_CONFLICT'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await rename(staging, target);
    } finally { await rm(staging, { recursive: true, force: true }); }
    return true;
  });
}

function duration(value, fallback) {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || result < 1 || result > 120000) fail('INVALID_CONFIG');
  return result;
}
export async function ensureRuntime({ configFile, fetcher = fetch, readinessMs, requestTimeoutMs, lockWaitMs, expectedOrigin } = {}) {
  try {
    const config = await loadBootstrapConfig(configFile);
    if (expectedOrigin !== undefined && expectedOrigin !== config.origin) fail('INVALID_CONFIG');
    readinessMs = duration(readinessMs, 15000); requestTimeoutMs = duration(requestTimeoutMs, 5000); lockWaitMs = duration(lockWaitMs, 30000);
    if (typeof fetcher !== 'function') fail('INVALID_CONFIG');
    let connection;
    const running = async (...args) => { connection = await isRunning(config, ...args); return Boolean(connection); };
    const result = (state, downloaded = false, started = false) => ({ ready: true, state, endpoint: connection.endpoint, runtimeFile: config.runtimeFile, launcher: config.launcher, mcpEntry: config.mcpEntry, downloaded, started });
    if (await running(requestTimeoutMs)) return result('running');
    // Per-user, per-endpoint temporary lock also serializes different product config files.
    const locks = await privateDirectory(join(tmpdir(), `km-agent-prepare-${process.getuid?.() ?? 'user'}`));
    return await withLock(join(locks, sha256(config.endpoint) + '.lock'), lockWaitMs, async () => {
      if (await running(requestTimeoutMs)) return result('running');
      let downloaded = false;
      if (!await regularFile(config.launcher) || !await regularFile(config.mcpEntry)) downloaded = await installRuntime(config, { fetcher, requestTimeoutMs, lockWaitMs });
      if (!await regularFile(config.launcher) || !await regularFile(config.mcpEntry)) fail('INSTALL_CONFLICT');
      // Network/download time cannot make an earlier ECONNREFUSED a permanent permission to launch.
      if (await running(requestTimeoutMs)) return result('running', downloaded);
      const deadline = Date.now() + readinessMs;
      try {
        // Capture both streams. Neither launcher output nor credentials are relayed to clients.
        await promisify(execFile)(process.execPath, [config.launcher, ...config.launchArgs], { cwd: dirname(config.launcher), timeout: readinessMs, maxBuffer: 65536, encoding: 'utf8', windowsHide: true });
      } catch { fail('START_UNKNOWN'); }
      while (Date.now() < deadline) {
        const remaining = Math.max(1, Math.min(requestTimeoutMs, deadline - Date.now()));
        if (await running(remaining, { manifestPending: true })) return result(downloaded ? 'installed' : 'started', downloaded, true);
        await delay(Math.min(60, Math.max(1, deadline - Date.now())));
      }
      fail('READINESS_TIMEOUT');
    }, { retainUncertain: true });
  } catch (error) { if (error instanceof RuntimePrepareError) throw error; fail('LOCAL_FAILURE'); }
}

export async function runPrepareCli(args = process.argv.slice(2)) {
  try {
    if (args.length !== 2 || args[0] !== '--config' || !absolute(args[1])) fail('INVALID_CONFIG');
    const data = await ensureRuntime({ configFile: args[1] });
    process.stdout.write(JSON.stringify({ ok: true, data }) + '\n');
  } catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: { code: publicErrorCode(error) } }) + '\n'); process.exitCode = 1; }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) await runPrepareCli();

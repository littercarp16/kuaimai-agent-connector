import { createHash, randomUUID } from 'node:crypto';
import { mkdir, chmod, open, lstat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readPrivateConfig } from './private-config.mjs';

export function serviceProfile(config, workspace) {
  return createHash('sha256').update(JSON.stringify({ ...config, workspace,
    disableCodex: process.env.KM_AGENT_DISABLE_CODEX || '',
    nativeSources: process.env.KM_AGENT_NATIVE_SOURCES_FILE || '',
  })).digest('hex');
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
export async function serviceLease(runtimePath, profile) {
  const path = runtimePath + '.lease';
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const lease = await readPrivateConfig(path);
  if (!Number.isSafeInteger(lease.pid) || lease.pid < 1 || typeof lease.token !== 'string' || typeof lease.profile !== 'string') throw Error('连接器实例记录无效');
  if (!alive(lease.pid)) return null;
  if (lease.profile !== profile) throw Error('同一连接器配置已有其他授权范围的实例，请先关闭原实例');
  return lease;
}

// One process per preferred-port profile, independent of the actual TCP port.
export async function claimService(runtimePath, profile) {
  await mkdir(dirname(runtimePath), { recursive: true, mode: 0o700 });
  await chmod(dirname(runtimePath), 0o700);
  const path = runtimePath + '.lease', token = randomUUID();
  for (let attempt = 0; attempt < 20; attempt++) {
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // An exclusive create may still be writing its small record.
      await delay(50);
      const before = await lstat(path).catch(() => null);
      if (!before) continue;
      const old = await readPrivateConfig(path);
      if (!Number.isSafeInteger(old.pid) || old.pid < 1) throw Error('连接器实例记录无效');
      if (alive(old.pid)) throw Error('连接器已经运行或正在启动');
      // Elect exactly one stale-record cleaner; other starters wait for it.
      let recovery;
      try { recovery = await open(path + '.recover', 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') continue; throw error; }
      try {
        const current = await lstat(path).catch(() => null);
        if (current?.ino === before.ino && current?.dev === before.dev) await unlink(path);
      } finally { await recovery.close(); await unlink(path + '.recover'); }
      continue;
    }
    const identity = await handle.stat();
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, profile })); }
    finally { await handle.close(); }
    return async () => {
      try {
        const info = await lstat(path), data = await readPrivateConfig(path);
        if (info.ino === identity.ino && info.dev === identity.dev && data.token === token) await unlink(path);
      } catch {}
    };
  }
  throw Error('连接器正在启动，请稍后检查');
}

export async function listenAvailable(server, preferredPort) {
  const listen = port => new Promise((resolve, reject) => {
    const error = cause => { server.off('listening', ready); reject(cause); };
    const ready = () => { server.off('error', error); resolve(server.address().port); };
    server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1');
  });
  try { return await listen(preferredPort); }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; return listen(0); }
}

// Code-mode discovery has a small documented range. Do not scan arbitrary ports
// or terminate their owners; fail explicitly when this whole range is occupied.
export const DIRECT_PORTS = Object.freeze(Array.from({ length: 32 }, (_, i) => 17653 + i));
export async function listenDiscoverable(server, preferredPort = DIRECT_PORTS[0]) {
  const ports = [...new Set([...(DIRECT_PORTS.includes(preferredPort) ? [preferredPort] : []), ...DIRECT_PORTS])];
  for (const port of ports) {
    try {
      return await new Promise((resolve, reject) => {
        const error = cause => { server.off('listening', ready); reject(cause); };
        const ready = () => { server.off('error', error); resolve(server.address().port); };
        server.once('error', error); server.once('listening', ready); server.listen(port, '127.0.0.1');
      });
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw Error('连接器预留端口 17653–17684 均被占用，请释放其中一个端口后重试');
}

import { randomBytes, randomInt, createHash } from 'node:crypto';
import { mkdir, chmod, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnector } from '../http/server.mjs';
import { createProductAdapters } from '../adapters/product-adapters.mjs';
import { createCodexAdapter } from '../adapters/codex/codex.mjs';
import { createCodexDesktopManager } from '../runtime/codex-desktop.mjs';
import { createQwenDesktopManager } from '../runtime/qwen-desktop.mjs';
import { createCodexDockManager } from '../runtime/codex-desktop-dock.mjs';
import { claimService, listenAvailable, listenDiscoverable } from '../runtime/service-instance.mjs';
import { validWebOrigin } from '../runtime/web-origin.mjs';
import { createConnectGrants, parseConnectURL } from './connect-grants.mjs';
import { createConnectionWindow } from './public-window.mjs';
import { createDirectGrants } from './direct-grants.mjs';
import { createFileLogger, nullLogger } from '../runtime/logger.mjs';

export function createDesktopHost({ directory, preferredPort = 17653, onChange = () => {}, now = Date.now,
  reconnect = false, direct = false, logger = null,
  adapterFactory = options => createProductAdapters(options, { codex: createCodexAdapter }),
  qwenDesktopFactory = () => createQwenDesktopManager(),
  desktopFactory = () => createCodexDesktopManager({ dock: createCodexDockManager() }),
  codexEnabled = process.env.KM_AGENT_DISABLE_CODEX !== '1',
  qwenEnabled = process.env.KM_AGENT_DISABLE_QWEN !== '1',
} = {}) {
  let qwenDesktop;
  let connector, release, endpoint, origins = [], pairCode, grants, directGrants, bindings = [], writes = Promise.resolve();
  let log = logger || nullLogger;
  const runtimePath = join(directory, 'connector.json'), pending = new Map();
  const status = () => ({ state: connector ? 'running' : 'stopped', endpoint: endpoint || null,
    instanceId: connector?.instanceId || null, sessionScope: 'agent', sessionLimit: 10, origins: [...origins], pairCode: pairCode || null });
  const publish = () => onChange(status());
  function persist(key, instanceId) {
    const data = { instanceId, endpoint, protocol: 'km-agent/1', key, bindings };
    writes = writes.catch(() => {}).then(async () => {
      await writeFile(runtimePath + '.next', JSON.stringify(data), { mode: 0o600 });
      await rename(runtimePath + '.next', runtimePath);
    }); return writes;
  }
  async function stop() {
    const old = connector; connector = null; pending.clear(); grants?.clear(); directGrants?.clear();
    let stopped = false;
    if (old) log.info('service.stopping', { instanceId: old.instanceId, endpoint });
    try { await old?.close(); await writes.catch(() => {});
      if (old) try { if (JSON.parse(await readFile(runtimePath, 'utf8')).instanceId === old.instanceId) await unlink(runtimePath); } catch {}
      stopped = true;
    } catch (error) { log.error('service.stop_failed', { instanceId: old?.instanceId, error }); throw error;
    } finally { await release?.(); release = null; if (old && stopped) log.info('service.stopped', { instanceId: old.instanceId, endpoint }); endpoint = null; pairCode = null; publish(); if (!logger) { log.close(); log = nullLogger; } }
    return status();
  }
  async function start(config) {
    if (!Array.isArray(config.origins) || config.origins.length < 1 || config.origins.length > 16 || config.origins.some(o => !validWebOrigin(o)) || new Set(config.origins).size !== config.origins.length) throw Error('请填写完整且不重复的网页来源（协议、域名和端口）');
    if (connector && JSON.stringify(origins) === JSON.stringify(config.origins)) return status();
    if (connector) throw Error('请先停止桥接，再修改允许的网站');
    origins = [...config.origins]; bindings = [];
    await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
    release = await claimService(runtimePath, createHash('sha256').update(JSON.stringify({ sessionScope: 'agent', origins, desktop: true })).digest('hex'));
    const key = randomBytes(32).toString('base64url'); pairCode = String(randomInt(100000, 1000000));
    grants = createConnectGrants({ now, reconnect });
    directGrants = direct ? createDirectGrants({ now }) : null;
    try {
      if (!logger) log = createFileLogger({ path: join(directory, 'service.log') });
      log.info('service.starting', { preferredPort, maxBytes: log.maxBytes, backups: log.backups });
      qwenDesktop = qwenEnabled && process.platform === 'darwin' ? qwenDesktopFactory() : null;
      const adapter = adapterFactory({ adapter: 'generic', codexSessionScope: 'agent', codexEnabled, qwenEnabled });
      const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
      const publisherCommand = [process.execPath, fileURLToPath(new URL('../../publish.mjs', import.meta.url)), '--runtime', runtimePath].map(quote).join(' ');
      connector = createConnector({ adapter, allowedOrigins: origins, pairCode, publisherKey: key, logger: log,
        publisherCommand, projectIndependentSessions: true, qwenDesktop,
        onPairCode: code => { pairCode = code; publish(); },
        onBindings: value => { bindings = value; if (connector && endpoint) void persist(key, connector.instanceId); },
        codexDesktop: codexEnabled && process.platform === 'darwin' ? desktopFactory() : null,
        enableWorkBuddy: true, enableMultiAgentFollow: true,
        workBuddyOptions: { workspaceId: 'ws_' + createHash('sha256').update(directory).digest('hex') },
        desktopConnect: { ...createConnectionWindow(grants), direct: directGrants },
      });
      const port = await (direct ? listenDiscoverable : listenAvailable)(connector.server, preferredPort); endpoint = `http://127.0.0.1:${port}`;
      await persist(key, connector.instanceId); publish();
      log.info('service.started', { instanceId: connector.instanceId, endpoint, port, preferredPort });
      return status();
    } catch (error) { log.error('service.start_failed', { instanceId: connector?.instanceId, error }); await stop(); throw error; }
  }
  function inspectLink(url, { requestExpiresAt } = {}) {
    if (!connector) throw Error('请先启动本机桥接');
    const request = parseConnectURL(url, origins);
    for (const [id, entry] of pending) if (entry.expires <= now()) pending.delete(id);
    if (pending.size >= 8) throw Error('接入请求过多，请稍后重试');
    const id = randomBytes(24).toString('base64url'); pending.set(id, { request, requestExpiresAt, expires: now() + 120000 });
    return { id, origin: request.origin, sessionScope: 'agent', sessionLimit: 10, browser: request.browser };
  }
  function authorize(id) {
    const entry = pending.get(id); pending.delete(id);
    if (!connector || !entry || entry.expires <= now()) throw Error('网页接入请求已过期，请回到网页重新点击接入');
    if (entry.request.transport === 'direct' && !directGrants) throw Error('请更新连接器以支持原页面直连');
    return (entry.request.transport === 'direct' ? directGrants : grants).issue(entry.request, { endpoint, instanceId: connector.instanceId, expiresAt: entry.requestExpiresAt });
  }
  function allowOrigin(origin) {
    if (!connector || !validWebOrigin(origin)) throw Error('无效的网页来源');
    if (origins.includes(origin)) return false;
    if (origins.length >= 16) throw Error('连接器已达到网页来源上限，请先停止不用的来源');
    connector.allowOrigin(origin);
    origins.push(origin);
    return true;
  }
  function revokeOrigin(origin) {
    if (!origins.includes(origin)) return false;
    origins = origins.filter(value => value !== origin);
    for (const [id, entry] of pending) if (entry.request.origin === origin) pending.delete(id);
    connector.revokeOrigin(origin);
    return true;
  }
  return { start, stop, status, inspectLink, authorize, allowOrigin, revokeOrigin, prepareQwen() { return qwenDesktop?.ensure(); }, deny(id) { pending.delete(id); } };
}

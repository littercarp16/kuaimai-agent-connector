import { spawn } from 'node:child_process';
import { mkdir, open, realpath, stat, lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLaunchOptions } from '../runtime/launch-options.mjs';
import { serviceLease, serviceProfile } from '../runtime/service-instance.mjs';
import { readConfigFile, validLoopbackOrigin } from '../../skills/km-agent-bridge/scripts/prepare.mjs';

if (process.argv.includes('--help')) {
  console.log('node start.mjs --adapter opencode|generic --trust-origin http://127.0.0.1:4173 [--allow-origin https://another-app.example] [--session <ses...>] [--workspace /绝对工作目录] [--allow-control] [--pin-session] [--port 17653]\n启动后台连接器；首选端口占用时自动分配空闲端口，重复调用复用相同配置的实例。');
  process.exit(0);
}
try {
  const args = process.argv.slice(2), config = parseLaunchOptions(args);
  if (!config.auto) throw Error('技能启动需明确--trust-origin');
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const workspace = await realpath(config.workspace || root);
  if (!(await stat(workspace)).isDirectory()) throw Error('工作区须为现有目录');
  const profile = serviceProfile(config, workspace);
  const directory = root + '.runtime/', stem = config.port === 17653 ? 'connector' : `connector-${config.port}`;
  const runtimePath = directory + stem + '.json';
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Read the private process lease, never infer ownership from an occupied TCP port.
  let existing;
  try { existing = await serviceLease(runtimePath, profile); }
  catch (error) {
    if (error.code !== 'INVALID_RUNTIME') throw error;
    await delay(100); existing = await serviceLease(runtimePath, profile);
  }
  if (!existing) {
    const log = await open(directory + stem + '.log', 'a', 0o600);
    const child = spawn(process.execPath, [root + 'main.mjs', ...args], { detached: true, stdio: ['ignore', log.fd, log.fd], cwd: root });
    const spawned = new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    try { await spawned; child.unref(); } finally { await log.close(); }
  }
  const deadline = Date.now() + 10000;
  let ready;
  while (Date.now() < deadline) {
    const lease = await serviceLease(runtimePath, profile).catch(error => {
      if (error.code === 'INVALID_RUNTIME' || error.code === 'UNSAFE_PATH') return null;
      throw error;
    });
    if (lease) try {
      await lstat(runtimePath);
      const runtime = await readConfigFile(runtimePath, { runtime: true });
      if (!validLoopbackOrigin(runtime.endpoint, true) || runtime.protocol !== 'km-agent/1') throw Error('invalid runtime');
      const response = await fetch(runtime.endpoint + '/v1/health', { redirect: 'error', headers: { Origin: config.origin, 'X-Km-Agent': '1' }, signal: AbortSignal.timeout(1000) });
      const result = await response.json();
      if (response.ok && result.ok && result.data?.service === 'kuaimai-agent-connector' && result.data.instanceId === runtime.instanceId && result.data.interactionProtocol === 'km-agent/1' && result.data.capabilities?.autoHandshake && result.data.adapter?.id === config.adapter) {
        ready = { pid: lease.pid, endpoint: runtime.endpoint }; break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) throw Error('启动尚未确认，检查本机.runtime连接器日志，不自动重复启动');
  console.log(JSON.stringify({ ok: true, ...ready, reused: Boolean(existing), service: 'km-agent/1', adapter: config.adapter, autoHandshake: true, control: config.allowControl, notice: '服务已就绪，浏览器还需完成自动握手；未保存平台资源' }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: String(error.message).slice(0, 240) })); process.exitCode = 1;
}

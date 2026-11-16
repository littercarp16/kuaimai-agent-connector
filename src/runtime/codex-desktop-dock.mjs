import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cp, lstat, mkdir, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexDesktopRuntime, desktopSocketUrl, probeDesktopSocket } from './codex-desktop.mjs';
import { discoverCodexDaemon } from '../adapters/codex/codex-rpc.mjs';

const exec = promisify(execFile);
const LABEL = 'local.agent-connector.codex-dock';
const KEYS = ['CODEX_HOME', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'CODEX_APP_SERVER_WS_URL'];
const defaultEntry = fileURLToPath(new URL('../../codex-desktop.mjs', import.meta.url));
const xml = text => String(text).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

async function installRuntime(directory) {
  const source = dirname(defaultEntry), temp = `${directory}.${randomUUID()}.tmp`;
  await mkdir(temp, { recursive: true, mode: 0o700 });
  try {
    for (const file of ['src/runtime/codex-desktop-dock.mjs', 'src/runtime/codex-desktop.mjs',
      'src/runtime/codex-desktop-transport.mjs', 'src/adapters/codex/codex-rpc.mjs']) {
      await mkdir(dirname(join(temp, file)), { recursive: true, mode: 0o700 });
      await cp(join(source, file), join(temp, file));
    }
    await cp(await realpath(join(source, 'node_modules', 'ws')), join(temp, 'node_modules', 'ws'), { recursive: true });
    await writeFile(join(temp, 'codex-desktop.mjs'), `import { createCodexDockManager } from './src/runtime/codex-desktop-dock.mjs';
try {
  if (process.argv.length !== 3 || process.argv[2] !== 'dock-apply') throw Error('Invalid login action');
  console.log(JSON.stringify({ time: new Date().toISOString(), ...await createCodexDockManager().apply() }));
} catch (error) {
  console.error(JSON.stringify({ time: new Date().toISOString(), error: error.message?.slice(0, 240) }));
  process.exitCode = 1;
}
`, { mode: 0o600 });
    await rename(temp, directory);
  } finally { await rm(temp, { recursive: true, force: true }); }
}

/** Prepare the same daemon as the bridge, then verify its stable private alias. */
export async function prepareCodexDockEnvironment({ codexHome, cliPath, run = exec }) {
  const runInHome = (file, args, options) => run(file === 'codex' ? cliPath : file, args,
    { ...options, env: { ...process.env, CODEX_HOME: codexHome } });
  const discover = () => discoverCodexDaemon({ command: cliPath, run: runInHome });
  const runtime = createCodexDesktopRuntime({ env: { ...process.env, CODEX_HOME: codexHome }, run: runInHome, discover });
  await runtime.check();
  await runtime.ensureDaemon();
  const daemon = await discover();
  const alias = join(codexHome, 'app-server-control', 'app-server-control.sock');
  const parent = await lstat(dirname(alias)), file = await lstat(alias);
  if (!daemon.ready || !parent.isDirectory() || parent.uid !== process.getuid() || (parent.mode & 0o077)
    || file.uid !== process.getuid() || (!file.isSocket() && !file.isSymbolicLink())
    || await realpath(alias) !== daemon.socketPath) throw Error('共享 socket 固定入口与已校验的 daemon 不一致');
  const url = desktopSocketUrl(alias);
  await probeDesktopSocket(url);
  return { CODEX_HOME: codexHome, CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1', CODEX_APP_SERVER_WS_URL: url };
}

/** User-level login job for the authorized desktop flow and local CLI; fixed paths only. */
export function createCodexDockManager({ home = homedir(), uid = process.getuid?.(), platform = process.platform,
  nodePath = process.execPath, env = process.env, run = exec, prepare = prepareCodexDockEnvironment,
  deploy = installRuntime } = {}) {
  const directory = join(home, 'Library', 'Application Support', 'Agent Connector');
  const configPath = join(directory, 'codex-dock.json');
  const plistPath = join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const logPath = join(directory, 'codex-dock.log');
  const domain = `gui/${uid}`, service = `${domain}/${LABEL}`;
  const command = (file, args) => run(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, shell: false });
  const launchctl = args => command('/bin/launchctl', args);
  const checkPlatform = () => { if (platform !== 'darwin') throw Error('Dock 默认共享连接仅支持 macOS'); };
  const ownedFile = async path => {
    try {
      const st = await lstat(path);
      if (!st.isFile() || st.uid !== uid || (st.mode & 0o022)) throw Error('Dock 配置文件所有权或权限不正确');
      return true;
    } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  };
  const load = async () => {
    if (!await ownedFile(configPath)) return null;
    const c = JSON.parse(await readFile(configPath, 'utf8'));
    if (c.version !== 1 || c.label !== LABEL || ![c.nodePath, c.entryPath, c.cliPath, c.codexHome].every(p => typeof p === 'string' && isAbsolute(p))
      || dirname(dirname(c.entryPath)) !== directory || !/^codex-dock-runtime-[0-9a-f-]{36}$/.test(dirname(c.entryPath).split('/').at(-1))
      || c.entryPath !== join(dirname(c.entryPath), 'codex-desktop.mjs')
      || !c.previous || !c.environment || KEYS.some(k => !Object.hasOwn(c.previous, k)
        || !(c.previous[k] === null || typeof c.previous[k] === 'string'))
      || c.environment.CODEX_HOME !== c.codexHome || c.environment.CODEX_APP_SERVER_USE_LOCAL_DAEMON !== '1'
      || c.environment.CODEX_APP_SERVER_WS_URL !== desktopSocketUrl(join(c.codexHome, 'app-server-control', 'app-server-control.sock')))
      throw Error('Dock 配置格式不匹配，未修改现有设置');
    return c;
  };
  const getEnvironment = async () => Object.fromEntries(await Promise.all(KEYS.map(async key => {
    const { stdout } = await launchctl(['getenv', key]);
    return [key, stdout.replace(/\n$/, '') || null];
  })));
  const agentStatus = async () => {
    try {
      const { stdout } = await launchctl(['print', service]);
      const exit = /^\s*last exit code = (-?\d+)\s*$/m.exec(stdout);
      return { loaded: true, state: /^\s*state = (.+)$/m.exec(stdout)?.[1]?.trim() ?? null,
        lastExitCode: exit ? Number(exit[1]) : null };
    } catch (e) { if ([3, 113].includes(e.code)) return { loaded: false, state: null, lastExitCode: null }; throw e; }
  };
  const loaded = async () => (await agentStatus()).loaded;
  const verifyAgent = async () => {
    const deadline = Date.now() + 10000;
    do {
      const state = await agentStatus();
      if (state.lastExitCode === 0) return;
      if (!state.loaded || state.lastExitCode !== null) throw Error(`Dock 登录任务执行失败，请查看 ${logPath}`);
      await delay(100);
    } while (Date.now() < deadline);
    throw Error('Dock 登录任务尚未完成验证');
  };
  const atomicWrite = async (path, text) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await ownedFile(path);
    const temp = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, text, { mode: 0o600, flag: 'wx' }); await rename(temp, path); }
    finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  };
  const agentPlist = c => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(c.nodePath)}</string><string>${xml(c.entryPath)}</string><string>dock-apply</string></array>
<key>WorkingDirectory</key><string>${xml(dirname(c.entryPath))}</string>
<key>LimitLoadToSessionType</key><string>Aqua</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>EnvironmentVariables</key><dict><key>CODEX_HOME</key><string>${xml(c.codexHome)}</string>
<key>PATH</key><string>${xml([...new Set([dirname(c.nodePath), dirname(c.cliPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':'))}</string></dict>
<key>StandardOutPath</key><string>${xml(logPath)}</string>
<key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>\n`;
  const restore = async c => {
    const current = await getEnvironment(), preservedChangedKeys = [];
    // Restore only values still owned by this installation; retain later user changes.
    for (const key of [...KEYS].reverse()) {
      if (current[key] !== c.environment[key]) { preservedChangedKeys.push(key); continue; }
      await launchctl(c.previous[key] === null ? ['unsetenv', key] : ['setenv', key, c.previous[key]]);
    }
    return preservedChangedKeys;
  };
  const apply = async ({ assertAllowed = () => {} } = {}) => {
    assertAllowed();
    checkPlatform();
    const c = await load(); if (!c) throw Error('尚未启用 Dock 默认共享连接');
    if ((await launchctl(['getenv', 'CODEX_APP_SERVER_FORCE_CLI'])).stdout.trim() === '1')
      throw Error('登录环境强制使用私有 CLI，未覆盖 CODEX_APP_SERVER_FORCE_CLI');
    const desired = await prepare({ codexHome: c.codexHome, cliPath: c.cliPath, run });
    assertAllowed();
    if (KEYS.some(key => desired[key] !== c.environment[key])) throw Error('共享 socket 设置发生变化，未发布启动环境');
    // Publish WS_URL last, only after the daemon and stable alias are ready.
    const current = await getEnvironment();
    const changed = [];
    try {
      for (const key of KEYS) if (current[key] !== desired[key]) {
        assertAllowed();
        await launchctl(['setenv', key, desired[key]]); changed.push(key);
      }
    } catch (error) {
      for (const key of changed.reverse()) await launchctl(current[key] === null ? ['unsetenv', key] : ['setenv', key, current[key]]);
      throw error;
    }
    return { applied: true, transport: 'shared-unix-socket' };
  };
  const status = async () => {
    checkPlatform();
    const c = await load();
    if (!c) return { installed: false, enabled: false };
    const current = await getEnvironment(), agent = await agentStatus(), agentLoaded = agent.loaded;
    const environmentMatches = KEYS.every(key => current[key] === c.environment[key]);
    const forceCli = (await launchctl(['getenv', 'CODEX_APP_SERVER_FORCE_CLI'])).stdout.trim() === '1';
    return { installed: true, enabled: agentLoaded && environmentMatches && !forceCli && agent.lastExitCode === 0,
      agentLoaded, environmentMatches, forceCli, agentState: agent.state, lastExitCode: agent.lastExitCode,
      websocketUrl: c.environment.CODEX_APP_SERVER_WS_URL, configPath, plistPath };
  };
  return {
    apply, status,
    async enable({ assertAllowed = () => {} } = {}) {
      assertAllowed();
      checkPlatform();
      const existing = await load();
      if (existing) {
        if (existing.codexHome !== (env.CODEX_HOME || join(home, '.codex')))
          throw Error('Dock 默认接入与当前连接器的 CODEX_HOME 不一致，未覆盖已有配置');
        if (!await ownedFile(plistPath) || await readFile(plistPath, 'utf8') !== agentPlist(existing)) throw Error('登录启动项已被修改，未覆盖');
        await apply({ assertAllowed });
        assertAllowed();
        if (!await loaded()) await launchctl(['bootstrap', domain, plistPath]);
        await verifyAgent();
        return status();
      }
      if (await ownedFile(plistPath) || await loaded()) throw Error('同名登录启动项已存在，未覆盖');
      const { stdout: force } = await launchctl(['getenv', 'CODEX_APP_SERVER_FORCE_CLI']);
      if (force.trim() === '1') throw Error('登录环境强制使用私有 CLI，请先关闭 CODEX_APP_SERVER_FORCE_CLI');
      const { stdout } = await command('/usr/bin/which', ['codex']);
      const cliPath = stdout.trim(), codexHome = env.CODEX_HOME || join(home, '.codex');
      if (!isAbsolute(cliPath) || !isAbsolute(codexHome)) throw Error('Codex CLI 和 CODEX_HOME 须为绝对路径');
      const environment = await prepare({ codexHome, cliPath, run });
      assertAllowed();
      const runtimeDirectory = join(directory, `codex-dock-runtime-${randomUUID()}`);
      const entryPath = join(runtimeDirectory, 'codex-desktop.mjs');
      const c = { version: 1, label: LABEL, nodePath, entryPath, cliPath, codexHome, environment,
        previous: await getEnvironment() };
      let published = false, registered = false;
      try {
        await deploy(runtimeDirectory);
        assertAllowed();
        await atomicWrite(configPath, JSON.stringify(c, null, 2) + '\n');
        await atomicWrite(plistPath, agentPlist(c));
        await command('/usr/bin/plutil', ['-lint', plistPath]);
        await apply({ assertAllowed }); published = true;
        assertAllowed();
        await launchctl(['bootstrap', domain, plistPath]); registered = true;
        await verifyAgent();
        return await status();
      } catch (error) {
        if (registered) await launchctl(['bootout', service]);
        if (published) await restore(c);
        await unlink(plistPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await unlink(configPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
        await rm(runtimeDirectory, { recursive: true, force: true });
        throw error;
      }
    },
    async disable() {
      checkPlatform();
      const c = await load(); if (!c) return { installed: false, enabled: false };
      if (await ownedFile(plistPath) && await readFile(plistPath, 'utf8') !== agentPlist(c)) throw Error('登录启动项已被修改，未移除');
      if (await loaded()) await launchctl(['bootout', service]);
      const preservedChangedKeys = await restore(c);
      await unlink(plistPath).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await unlink(configPath);
      await rm(dirname(c.entryPath), { recursive: true, force: true });
      return { installed: false, enabled: false, preservedChangedKeys };
    },
  };
}

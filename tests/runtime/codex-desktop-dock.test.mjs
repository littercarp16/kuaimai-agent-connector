import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexDockManager } from '../../src/runtime/codex-desktop-dock.mjs';

async function fixture(t, { previous = {}, rejectBootstrap = false, failPrepare = false, agentExit = 0 } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'codex-dock-&-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const environment = new Map(Object.entries(previous)), calls = [];
  const state = { loaded: false, failPrepare, rejectBootstrap };
  const manager = createCodexDockManager({ home, platform: 'darwin', env: {}, nodePath: '/usr/local/bin/node',
    prepare: async ({ codexHome, cliPath }) => {
      calls.push(['prepare', cliPath]);
      if (state.failPrepare) throw Error('daemon unavailable');
      return { CODEX_HOME: codexHome, CODEX_APP_SERVER_USE_LOCAL_DAEMON: '1',
        CODEX_APP_SERVER_WS_URL: `ws+unix://localhost${codexHome}/app-server-control/app-server-control.sock:/rpc` };
    },
    deploy: async directory => { await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'codex-desktop.mjs'), '// fixture'); },
    run: async (file, args, options) => {
      assert.equal(options.shell, false); calls.push([file, ...args]);
      if (file === '/usr/bin/which') return { stdout: '/Users/test/.local/bin/codex\n' };
      if (file === '/usr/bin/plutil') return { stdout: 'OK\n' };
      assert.equal(file, '/bin/launchctl');
      if (args[0] === 'getenv') return { stdout: environment.has(args[1]) ? environment.get(args[1]) + '\n' : '' };
      if (args[0] === 'setenv') { environment.set(args[1], args[2]); return { stdout: '' }; }
      if (args[0] === 'unsetenv') { environment.delete(args[1]); return { stdout: '' }; }
      if (args[0] === 'print') {
        if (!state.loaded) throw Object.assign(Error('no service'), { code: 113 });
        return { stdout: `state = not running\nruns = 1\nlast exit code = ${agentExit}\n` };
      }
      if (args[0] === 'bootstrap') {
        if (state.rejectBootstrap) throw Error('bootstrap failed');
        state.loaded = true; return { stdout: '' };
      }
      if (args[0] === 'bootout') { state.loaded = false; return { stdout: '' }; }
      throw Error('Unexpected OS action: ' + args[0]);
    },
  });
  const configPath = join(home, 'Library', 'Application Support', 'Agent Connector', 'codex-dock.json');
  const plistPath = join(home, 'Library', 'LaunchAgents', 'local.agent-connector.codex-dock.plist');
  return { manager, home, environment, calls, state, configPath, plistPath };
}

test('Dock enable prepares daemon before publishing environment and installs an isolated login runtime', async t => {
  const f = await fixture(t), result = await f.manager.enable();
  assert.equal(result.enabled, true); assert.equal(result.agentLoaded, true);
  const config = JSON.parse(await readFile(f.configPath, 'utf8'));
  const plist = await readFile(f.plistPath, 'utf8');
  assert.match(config.entryPath, /Application Support\/Agent Connector\/codex-dock-runtime-/);
  assert.doesNotMatch(config.entryPath, /Desktop/);
  assert.match(plist, /&amp;/); assert.match(plist, /<string>dock-apply<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<string>Aqua<\/string>/);
  assert.match(plist, /<key>PATH<\/key><string>\/usr\/local\/bin:\/Users\/test\/\.local\/bin:/);
  const writes = f.calls.filter(c => c[1] === 'setenv');
  assert.deepEqual(writes.map(c => c[2]), ['CODEX_HOME', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON', 'CODEX_APP_SERVER_WS_URL']);
  assert.ok(f.calls.findIndex(c => c[0] === 'prepare') < f.calls.indexOf(writes[0]));
  assert.equal(f.calls.some(c => c.includes('stop') || c.includes('restart') || c[0] === '/usr/bin/open'), false);
});

test('re-enabling preserves the original environment backup and does not register a second agent', async t => {
  const previous = { CODEX_HOME: '/previous/home', CODEX_APP_SERVER_WS_URL: 'ws://localhost:9001/' };
  const f = await fixture(t, { previous });
  await f.manager.enable(); await f.manager.enable();
  assert.equal(f.calls.filter(c => c[1] === 'bootstrap').length, 1);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')).previous,
    { CODEX_HOME: previous.CODEX_HOME, CODEX_APP_SERVER_USE_LOCAL_DAEMON: null, CODEX_APP_SERVER_WS_URL: previous.CODEX_APP_SERVER_WS_URL });
  const result = await f.manager.disable();
  assert.equal(result.enabled, false); assert.equal(f.state.loaded, false);
  assert.deepEqual(Object.fromEntries(f.environment), previous);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
  await assert.rejects(readFile(f.plistPath), { code: 'ENOENT' });
});

test('login apply restores settings in a fresh session using the saved CLI and stable alias', async t => {
  const f = await fixture(t); await f.manager.enable();
  f.environment.clear(); f.calls.length = 0;
  await f.manager.apply();
  assert.deepEqual(f.calls.find(c => c[0] === 'prepare'), ['prepare', '/Users/test/.local/bin/codex']);
  assert.equal((await f.manager.status()).enabled, true);
  assert.ok(f.environment.get('CODEX_APP_SERVER_WS_URL').endsWith('/app-server-control/app-server-control.sock:/rpc'));
});

test('daemon failure publishes no launch environment; login failure does not stop existing daemon', async t => {
  const f = await fixture(t, { failPrepare: true });
  await assert.rejects(f.manager.enable(), /daemon unavailable/);
  assert.equal(f.environment.size, 0); assert.equal(f.state.loaded, false);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
  f.state.failPrepare = false; await f.manager.enable();
  f.environment.clear(); f.state.failPrepare = true;
  await assert.rejects(f.manager.apply(), /daemon unavailable/);
  assert.equal(f.environment.size, 0);
});

test('failed registration rolls back files and launch environment', async t => {
  const previous = { CODEX_APP_SERVER_WS_URL: 'ws://localhost:9876/' };
  const f = await fixture(t, { previous, rejectBootstrap: true });
  await assert.rejects(f.manager.enable(), /bootstrap failed/);
  assert.deepEqual(Object.fromEntries(f.environment), previous); assert.equal(f.state.loaded, false);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
  await assert.rejects(readFile(f.plistPath), { code: 'ENOENT' });
});

test('an agent that registers but exits unsuccessfully is rolled back rather than reported enabled', async t => {
  const f = await fixture(t, { agentExit: 1 });
  await assert.rejects(f.manager.enable(), /登录任务执行失败/);
  assert.equal(f.state.loaded, false); assert.equal(f.environment.size, 0);
  assert.equal(f.calls.filter(c => c[1] === 'bootout').length, 1);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
});

test('disable preserves subsequent user changes and refuses to delete a modified launch item', async t => {
  const f = await fixture(t); await f.manager.enable();
  const original = await readFile(f.plistPath, 'utf8');
  await writeFile(f.plistPath, original + '<!-- user edit -->');
  await assert.rejects(f.manager.disable(), /已被修改/); assert.equal(f.state.loaded, true);
  await writeFile(f.plistPath, original);
  f.environment.set('CODEX_HOME', '/later/user/home');
  const result = await f.manager.disable();
  assert.deepEqual(result.preservedChangedKeys, ['CODEX_HOME']);
  assert.deepEqual(Object.fromEntries(f.environment), { CODEX_HOME: '/later/user/home' });
});

test('forced CLI conflicts are reported without overriding the user setting', async t => {
  const f = await fixture(t); f.environment.set('CODEX_APP_SERVER_FORCE_CLI', '1');
  await assert.rejects(f.manager.enable(), /强制使用私有 CLI/);
  f.environment.delete('CODEX_APP_SERVER_FORCE_CLI'); await f.manager.enable();
  f.environment.set('CODEX_APP_SERVER_FORCE_CLI', '1');
  assert.equal((await f.manager.status()).enabled, false);
  await assert.rejects(f.manager.apply(), /强制使用私有 CLI/);
});

test('web authorization revoked during preparation prevents installing files or environment', async t => {
  const f = await fixture(t); let checks = 0;
  await assert.rejects(f.manager.enable({ assertAllowed: () => { if (++checks > 1) throw Error('web session revoked'); } }), /revoked/);
  assert.equal(f.state.loaded, false); assert.equal(f.environment.size, 0);
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
  await assert.rejects(readFile(f.plistPath), { code: 'ENOENT' });
});

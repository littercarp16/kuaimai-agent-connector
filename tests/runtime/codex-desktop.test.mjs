import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCodexDesktopManager, createCodexDesktopRuntime, CodexDesktopFailure } from '../../src/runtime/codex-desktop.mjs';

const socketPath = '/private/tmp/codex-desktop-test/daemon.sock';
const socketUrl = `ws+unix://localhost${socketPath}:/rpc`;
const testRuntime = options => createCodexDesktopRuntime({
  discover: async () => ({ ready: true, version: '0.169.0', socketPath }),
  probeSocket: async url => { assert.equal(url, socketUrl); }, ...options,
});

const waitUntil = async condition => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw Error('operation did not finish');
};
function fixture(overrides = {}, options = {}) {
  const calls = [];
  let running = true, shared = false, time = 1000;
  const runtime = {
    check: async () => { calls.push('check'); },
    ensureDaemon: async () => { calls.push('daemon'); return { ready: true, version: '0.168.0' }; },
    isRunning: async () => running,
    inspectTransport: async () => ({ mode: !running ? 'not-running' : shared ? 'shared' : 'stdio',
      daemon: { ready: true, version: '0.168.0' } }),
    quit: async () => { calls.push('quit'); running = false; },
    open: async () => { calls.push('open'); running = shared = true; }, ...overrides,
  };
  const manager = createCodexDesktopManager({ runtime, now: () => time,
    sleep: async ms => { time += ms; }, waitMs: 50, pollMs: 10, ...options });
  const restart = () => manager.restart({ requestId: randomUUID() });
  const result = async () => { await waitUntil(() => manager.status().operation?.state !== 'running'); return manager.status().operation; };
  return { manager, runtime, calls, restart, result, setRunning: value => { running = value; }, setShared: value => { shared = value; } };
}

test('desktop relaunch checks daemon before quitting and does not claim same-thread bridging', async () => {
  const f = fixture(), accepted = f.restart();
  assert.equal(accepted.state, 'running');
  assert.deepEqual(f.calls, [], 'return acceptance before launching an OS action');
  const result = await f.result();
  assert.deepEqual(f.calls, ['check', 'daemon', 'quit', 'open']);
  assert.equal(result.state, 'completed');
  assert.equal(result.sharedSessionVerified, false);
  assert.equal(result.daemon.version, '0.168.0');
});

test('retries retain the same operation; concurrent and cooldown restarts do not quit again', async () => {
  let release;
  const f = fixture({ check: () => new Promise(resolve => { release = resolve; }) });
  const first = f.restart();
  assert.deepEqual(f.manager.restart({ requestId: first.requestId }), first);
  assert.throws(f.restart, /正在进行/);
  await waitUntil(() => release);
  release();
  const result = await f.result();
  result.message = 'mutated';
  assert.notEqual(f.manager.status().operation.message, 'mutated');
  assert.equal(f.manager.restart({ requestId: first.requestId }).state, 'completed');
  f.runtime.check = async () => {}; f.setShared(false); f.restart();
  assert.match((await f.result()).message, /30 秒/);
  assert.equal(f.calls.filter(c => c === 'quit').length, 1);
});

test('verified shared socket reuses the desktop without daemon startup, quit, open or busy guard', async () => {
  const f = fixture(); f.setShared(true);
  f.manager.restart({ requestId: randomUUID(), assertCanRestart: () => { throw Error('busy desktop must stay running'); } });
  const result = await f.result();
  assert.deepEqual(f.calls, ['check']);
  assert.equal(result.action, 'reuse'); assert.equal(result.transportAfter, 'shared');
  assert.equal(result.sharedSessionVerified, false);
  f.restart(); assert.equal((await f.result()).action, 'reuse', 'read-only reuse has no restart cooldown');
});

test('unknown transport cannot authorize a restart', async () => {
  const f = fixture({ inspectTransport: async () => ({ mode: 'unknown' }) }); f.restart();
  assert.equal((await f.result()).state, 'failed');
  assert.deepEqual(f.calls, ['check']);
});

test('transport is rechecked before quit and reuses a desktop that switched while preparing', async () => {
  let checks = 0;
  const f = fixture({ inspectTransport: async () => ({ mode: ++checks === 1 ? 'stdio' : 'shared', daemon: { ready: true, version: '0.168.0' } }) });
  f.restart(); assert.equal((await f.result()).action, 'reuse');
  assert.deepEqual(f.calls, ['check', 'daemon']);
});

test('busy guard is rechecked before quitting; failed stdio-to-socket switch is not success', async () => {
  let checks = 0;
  const f = fixture();
  f.manager.restart({ requestId: randomUUID(), assertCanRestart: () => { if (++checks === 2) throw new CodexDesktopFailure(409, 'busy'); } });
  assert.equal((await f.result()).message, 'busy'); assert.ok(!f.calls.includes('quit'));
  const failed = fixture({ inspectTransport: async () => ({ mode: 'stdio' }) }); failed.restart();
  const result = await failed.result();
  assert.equal(result.state, 'failed'); assert.match(result.message, /仍在使用私有 stdio/);
  assert.equal(failed.calls.filter(c => c === 'quit').length, 1);
});

test('direct reuse after relaunch is allowed during restart cooldown', async () => {
  const f = fixture(); f.restart(); assert.equal((await f.result()).action, 'restart');
  f.restart(); assert.equal((await f.result()).action, 'reuse');
  assert.equal(f.calls.filter(c => c === 'quit').length, 1);
});

test('unsupported app or unusable daemon leaves the desktop running', async () => {
  for (const stage of ['check', 'ensureDaemon']) {
    const f = fixture({ [stage]: async () => { throw new CodexDesktopFailure(409, '不可用'); } });
    f.restart();
    assert.equal((await f.result()).state, 'failed');
    assert.ok(!f.calls.includes('quit'));
    assert.ok(!f.calls.includes('open'));
  }
});

test('quit refusal or timeout never force-kills or opens a duplicate desktop', async () => {
  for (const quit of [async () => { throw Error('secret OS details'); }, async () => {}]) {
    const f = fixture({ quit });
    f.restart();
    const result = await f.result();
    assert.equal(result.state, 'failed');
    assert.ok(!f.calls.includes('open'));
    assert.doesNotMatch(result.message, /secret/);
  }
});

test('closed desktop starts without sending a quit event; startup timeout is not success', async () => {
  const f = fixture(); f.setRunning(false); f.restart();
  assert.equal((await f.result()).state, 'completed');
  assert.ok(!f.calls.includes('quit'));
  const failed = fixture({ open: async () => {} }); failed.restart();
  assert.equal((await failed.result()).state, 'failed');
});

test('authorization is checked again after daemon startup and before desktop shutdown', async () => {
  let allowed = true;
  const f = fixture({ ensureDaemon: async () => { allowed = false; return { ready: true }; } });
  f.manager.restart({ requestId: randomUUID(), assertAllowed: () => {
    if (!allowed) throw new CodexDesktopFailure(401, '授权失效');
  } });
  assert.equal((await f.result()).message, '授权失效');
  assert.ok(!f.calls.includes('quit'));
});

test('closing the manager waits for an already authorized relaunch and rejects new operations', async () => {
  const f = fixture(); f.restart(); await f.manager.close();
  assert.equal(f.manager.status().operation.state, 'completed');
  assert.throws(f.restart, /正在关闭/);
});

test('macOS runtime only sends fixed commands and forwards the same CODEX_HOME', async () => {
  const calls = [];
  let ready = false;
  const runtime = testRuntime({ platform: 'darwin', uid: 501,
    env: { CODEX_HOME: '/tmp/codex-desktop-fixture' }, probeApp: async () => true,
    discover: async () => ({ ready, version: '0.168.0', socketPath }),
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (file === 'codex') ready = true;
      return { stdout: '  502  12 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n  501  34 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' };
    } });
  await runtime.check(); await runtime.ensureDaemon();
  assert.equal(await runtime.isRunning(), true);
  await runtime.quit(); await runtime.open();
  assert.deepEqual(calls[0].args, ['app-server', 'daemon', 'start']);
  assert.deepEqual(calls.at(-1).args, ['-a', '/Applications/ChatGPT.app', '--env',
    'CODEX_APP_SERVER_USE_LOCAL_DAEMON=1', '--env', 'CODEX_HOME=/tmp/codex-desktop-fixture',
    '--env', `CODEX_APP_SERVER_WS_URL=${socketUrl}`]);
  assert.ok(calls.every(c => c.options.shell === false && c.options.timeout <= 30000));
  assert.equal(calls.some(c => c.args.includes('-n') || c.file.includes('kill')), false);
});

test('runtime rejects unsupported platform/app or explicit CLI overrides before launching commands', async () => {
  for (const overrides of [{ platform: 'linux' }, { probeApp: async () => false },
    { env: { CODEX_CLI_PATH: '/custom/codex' } }, { env: { CODEX_APP_SERVER_FORCE_CLI: '1' } }]) {
    let calls = 0;
    const runtime = createCodexDesktopRuntime({ platform: 'darwin', env: {}, probeApp: async () => true,
      run: async () => { calls++; }, ...overrides });
    await assert.rejects(runtime.check(), CodexDesktopFailure);
    assert.equal(calls, 0);
  }
});

test('runtime does not restart an existing daemon and refuses a still incompatible one', async () => {
  let calls = 0;
  const ready = testRuntime({
    run: async () => { calls++; } });
  await ready.ensureDaemon(); assert.equal(calls, 0);
  const bad = createCodexDesktopRuntime({ discover: async () => ({ ready: false }),
    run: async () => { calls++; } });
  await assert.rejects(bad.ensureDaemon(), /尚未退出/);
  assert.equal(calls, 1);
});

const launchFailure = (code = -600, extra = {}) => Object.assign(Error('private command diagnostic'), {
  code: 1, stderr: `The application cannot be opened, error=Error Domain=NSOSStatusErrorDomain Code=${code} "procNotFound"`, ...extra,
});
test('LaunchServices stale-process error retries only open with the original environment', async () => {
  const calls = [], waits = [], attempts = [], retries = [];
  const runtime = testRuntime({ uid: 501, env: { CODEX_HOME: '/tmp/same-codex-home' },
    sleep: async ms => waits.push(ms), run: async (file, args) => {
      if (file === '/bin/ps') return { stdout: '' };
      assert.equal(file, '/usr/bin/open'); calls.push([...args]);
      if (calls.length < 3) throw launchFailure();
      return { stdout: '' };
    } });
  await runtime.ensureDaemon();
  await runtime.open({ onAttempt: n => attempts.push(n), onRetry: value => retries.push(value) });
  assert.deepEqual(attempts, [1, 2, 3]); assert.deepEqual(waits, [500, 1000]);
  assert.deepEqual(calls[0], calls[1]); assert.deepEqual(calls[1], calls[2]);
  assert.ok(calls.every(args => !args.includes('-n'))); assert.equal(retries.length, 2);
});
test('a manual launch during the retry delay is verified without another open or quit', async () => {
  let calls = 0, running = false;
  const runtime = testRuntime({ uid: 501, sleep: async () => { running = true; },
    run: async file => {
      if (file === '/bin/ps') return { stdout: running ? '501 123 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n' : '' };
      assert.equal(file, '/usr/bin/open'); calls++; throw launchFailure();
    } });
  await runtime.ensureDaemon(); await runtime.open(); assert.equal(calls, 1);
});
test('permanent errors and timeouts do not retry; persistent -600 has a three-attempt bound', async () => {
  for (const [error, expected] of [[launchFailure(-10810), 1], [launchFailure(-600, { killed: true, signal: 'SIGTERM' }), 1], [launchFailure(), 3]]) {
    let calls = 0;
    const runtime = testRuntime({ sleep: async () => {}, run: async file => {
      if (file === '/bin/ps') return { stdout: '' };
      assert.equal(file, '/usr/bin/open'); calls++; throw error;
    } });
    await runtime.ensureDaemon(); await assert.rejects(runtime.open()); assert.equal(calls, expected);
  }
});

test('socket preparation is required and unsafe URL paths fail before opening the desktop', async () => {
  let calls = 0, probes = 0;
  const options = { run: async () => { calls++; }, probeSocket: async () => { probes++; } };
  await assert.rejects(testRuntime(options).open(), /尚未准备/);
  for (const path of [undefined, 'relative.sock', '//evil/socket', '/tmp/a:b.sock', '/tmp/a?b.sock',
    '/tmp/a#b.sock', '/tmp/a%20b.sock', '/tmp/a b.sock', '/tmp/../other.sock', '/tmp/中文.sock', '/tmp/a\\b.sock']) {
    const runtime = testRuntime({ ...options, discover: async () => ({ ready: true, socketPath: path }) });
    await assert.rejects(runtime.ensureDaemon(), /socket 路径/);
    await assert.rejects(runtime.open(), /尚未准备/);
  }
  assert.equal(calls, 0); assert.equal(probes, 0);
});

test('failed socket preflight leaves the desktop running and clears a previously prepared URL', async () => {
  let available = true, calls = 0;
  const runtime = testRuntime({ probeSocket: async () => { if (!available) throw Error('private path'); },
    run: async () => { calls++; } });
  await runtime.ensureDaemon(); available = false;
  await assert.rejects(runtime.ensureDaemon(), /WebSocket 连接验证失败/);
  await assert.rejects(runtime.open(), /尚未准备/);
  const f = fixture({ ensureDaemon: runtime.ensureDaemon }); f.restart();
  assert.match((await f.result()).message, /尚未退出/);
  assert.deepEqual(f.calls, ['check']); assert.equal(calls, 0);
});
test('manager exposes launch retry progress and still requires a shared connection', async () => {
  let f;
  f = fixture({ open: async ({ onAttempt, onRetry }) => {
    onAttempt(1); onRetry({ code: -600 });
    assert.equal(f.manager.status().operation.stage, 'waiting-for-launch-service');
    onAttempt(2); f.setRunning(true); f.setShared(true);
  } });
  f.restart(); const result = await f.result();
  assert.equal(result.state, 'completed'); assert.equal(result.launchAttempts, 2); assert.equal(result.launchErrorCode, -600);
  assert.equal(f.calls.filter(c => c === 'quit').length, 1);
});

test('first connection configures Dock before quitting; repeat requests and subsequent reuse do not reinstall', async () => {
  let installed = false, installations = 0;
  const sequence = [];
  const dock = { status: async () => ({ installed, enabled: installed }), enable: async ({ assertAllowed }) => {
    assertAllowed(); if (!installed) { installations++; sequence.push('install'); installed = true; }
    return { enabled: true, websocketUrl: 'private-path', configPath: 'private-config' };
  } };
  const f = fixture({}, { dock });
  const originalQuit = f.runtime.quit;
  f.runtime.quit = async () => { assert.equal(installed, true); sequence.push('quit'); await originalQuit(); };
  const first = f.restart(), result = await f.result();
  assert.equal(result.state, 'completed'); assert.deepEqual(result.dock, { enabled: true, action: 'install' });
  assert.deepEqual(sequence, ['install', 'quit']);
  assert.equal(f.manager.restart({ requestId: first.requestId }).dock.action, 'install');
  f.restart(); const reused = await f.result();
  assert.equal(reused.action, 'reuse'); assert.deepEqual(reused.dock, { enabled: true, action: 'reuse' });
  assert.equal(installations, 1); assert.equal(f.calls.filter(c => c === 'quit').length, 1);
  assert.equal(JSON.stringify(result).includes('private-'), false);
});

test('a running shared desktop installs or repairs Dock settings without quitting or checking busy state', async () => {
  for (const installed of [false, true]) {
    let configured = 0;
    const f = fixture({}, { dock: { status: async () => ({ installed, enabled: false }),
      enable: async () => { configured++; return { enabled: true }; } } });
    f.setShared(true);
    f.manager.restart({ requestId: randomUUID(), assertCanRestart: () => { throw Error('must not restart busy shared desktop'); } });
    const result = await f.result();
    assert.equal(result.state, 'completed'); assert.equal(result.action, 'reuse');
    assert.deepEqual(result.dock, { enabled: true, action: installed ? 'repair' : 'install' });
    assert.deepEqual(f.calls, ['check']); assert.equal(configured, 1);
  }
});

test('Dock failures cannot masquerade as successful connection or trigger a desktop shutdown', async () => {
  for (const shared of [false, true]) for (const stage of ['status', 'enable', 'unverified']) {
    const f = fixture({}, { dock: {
      status: async () => { if (stage === 'status') throw Error('private-config'); return { installed: false, enabled: false }; },
      enable: async () => { if (stage === 'enable') throw Error('private-path'); return { enabled: false }; },
    } });
    f.setShared(shared); f.restart(); const result = await f.result();
    assert.equal(result.state, 'failed'); assert.equal(result.dock.enabled, false);
    assert.match(result.message, /Dock 默认接入/); assert.doesNotMatch(result.message, /private-/);
    assert.deepEqual(f.calls, ['check']);
  }
});

test('authorization is rechecked after checking Dock settings, before installation', async () => {
  let allowed = true, installed = false;
  const f = fixture({}, { dock: {
    status: async () => { allowed = false; return { installed: false }; },
    enable: async () => { installed = true; return { enabled: true }; },
  } });
  f.manager.restart({ requestId: randomUUID(), assertAllowed: () => { if (!allowed) throw Error('revoked'); } });
  assert.equal((await f.result()).state, 'failed'); assert.equal(installed, false);
  assert.deepEqual(f.calls, ['check']);
});

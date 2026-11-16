import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnector } from '../../src/http/server.mjs';
import { createCodexDesktopManager } from '../../src/runtime/codex-desktop.mjs';

const origin = 'http://127.0.0.1:4173', key = 'desktop-test-local-publisher-key';
const sessionId = 'ses_codex_0123456789abcdef0123456789abcdef';
async function fixture(t, { overrides = {}, dockOverrides = {}, runStatus = 'idle', enabled = true } = {}) {
  const calls = [], dockCalls = [];
  let running = true, shared = false, installed = false;
  const manager = createCodexDesktopManager({ dock: {
    status: async () => { dockCalls.push('status'); return { installed, enabled: installed }; },
    enable: async ({ assertAllowed }) => { assertAllowed(); dockCalls.push('enable'); installed = true;
      return { enabled: true, configPath: 'private-path', websocketUrl: 'private-url' }; }, ...dockOverrides,
  }, runtime: {
    check: async () => {}, ensureDaemon: async () => ({ ready: true, version: '0.168.0' }),
    isRunning: async () => running,
    inspectTransport: async () => ({ mode: shared ? 'shared' : running ? 'stdio' : 'not-running', daemon: { ready: true, version: '0.168.0' } }),
    quit: async () => { calls.push('quit'); running = false; },
    open: async () => { calls.push('open'); running = shared = true; }, ...overrides,
  } });
  const adapter = { descriptor: { id: 'codex', status: 'native' },
    health: async () => ({ ready: true, version: '0.168.0' }),
    bindSession: async id => ({ id, provider: 'codex', title: 'fixture' }),
    readShared: async () => ({ status: runStatus, messages: [], questions: [], approvals: [] }),
    watch: () => ({ ready: Promise.resolve(), close() {} }),
    sendShared: async () => { calls.push('send'); return { id: randomUUID() }; },
  };
  const connector = createConnector({ adapter, allowedOrigins: [origin], autoTrust: { origin },
    publisherKey: key, codexDesktop: enabled ? manager : null });
  connector.server.listen(0, '127.0.0.1'); await once(connector.server, 'listening');
  t.after(() => connector.close());
  const base = `http://127.0.0.1:${connector.server.address().port}`;
  let token;
  const web = async (path, body, headers = {}) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Km-Agent': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, ...await res.json() };
  };
  token = (await web('/v1/handshake', {})).data.token;
  const local = async (action, body, headers = {}) => {
    const res = await fetch(`${base}/v1/local/codex/desktop/${action}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Km-Agent': '1', 'X-Km-Publisher': key, ...headers },
      body: JSON.stringify(body) });
    return { status: res.status, ...await res.json() };
  };
  const input = () => ({ instanceId: connector.instanceId, requestId: randomUUID() });
  const done = async () => {
    const until = Date.now() + 3000;
    while (manager.status().operation?.state === 'running') {
      assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5));
    }
    return manager.status().operation;
  };
  return { connector, manager, base, web, local, input, done, calls, dockCalls };
}

test('desktop restart needs exact Origin, authentication, instance and fixed input fields', async t => {
  const f = await fixture(t), path = '/v1/codex/desktop/restart';
  assert.equal((await f.web(path, f.input(), { Authorization: '' })).status, 401);
  assert.equal((await f.web(path, f.input(), { Origin: 'http://evil.example' })).status, 403);
  assert.equal((await f.web(path, { ...f.input(), instanceId: randomUUID() })).status, 409);
  assert.equal((await f.web(path, { ...f.input(), command: 'arbitrary' })).status, 400);
  assert.equal((await f.web(path, { ...f.input(), requestId: 'invalid' })).status, 400);
  assert.equal((await f.web(path)).status, 405);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.dockCalls, []);
  const request = f.input(), accepted = await f.web(path, request);
  assert.equal(accepted.status, 202);
  assert.equal((await f.web(path, request)).data.requestId, request.requestId);
  const result = await f.done();
  assert.equal(result.state, 'completed');
  assert.equal(result.sharedSessionVerified, false);
  assert.deepEqual(result.dock, { enabled: true, action: 'install' });
  assert.deepEqual(f.dockCalls, ['status', 'enable']);
  assert.doesNotMatch(JSON.stringify(result), /private-(path|url)/);
  assert.deepEqual(f.calls, ['quit', 'open']);
  assert.equal((await f.web('/v1/codex/desktop')).data.operation.requestId, request.requestId);
  assert.equal((await f.web('/v1/health')).data.capabilities.codexDesktopRestart, true);
  assert.equal((await f.web('/v1/health')).data.capabilities.codexDesktopDockPersistence, true);
});

test('local restart rejects browser origins and missing publisher credentials; disabled service is inert', async t => {
  const f = await fixture(t);
  assert.equal((await f.local('restart', f.input(), { Origin: origin })).status, 403);
  assert.equal((await f.local('restart', f.input(), { 'X-Km-Publisher': '' })).status, 403);
  assert.equal((await f.local('restart', { ...f.input(), instanceId: 'old' })).status, 409);
  assert.deepEqual(f.calls, []);
  const disabled = await fixture(t, { enabled: false });
  assert.equal((await disabled.web('/v1/codex/desktop/restart', disabled.input())).status, 404);
  assert.equal((await disabled.web('/v1/health')).data.capabilities.codexDesktopRestart, false);
});

test('known running Codex sessions block restart before any desktop operation', async t => {
  const f = await fixture(t, { runStatus: 'running' });
  assert.equal((await f.web('/v1/bind', { sessionId, allowControl: true })).status, 200);
  const res = await f.web('/v1/codex/desktop/restart', f.input());
  assert.equal(res.status, 202); assert.match((await f.done()).message, /仍在执行/);
  assert.deepEqual(f.calls, []);
});

test('web disconnect during daemon startup prevents quitting the desktop', async t => {
  let release;
  const f = await fixture(t, { overrides: { ensureDaemon: () => new Promise(resolve => { release = resolve; }) } });
  await f.web('/v1/codex/desktop/restart', f.input());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.web('/v1/disconnect', {});
  release({ ready: true, version: '0.168.0' });
  assert.equal((await f.done()).state, 'failed');
  assert.deepEqual(f.calls, []);
});

test('web prompt submission is blocked while a desktop restart is pending', async t => {
  let release;
  const f = await fixture(t, { overrides: { ensureDaemon: () => new Promise(resolve => { release = resolve; }) } });
  await f.web('/v1/bind', { sessionId, allowControl: true });
  await f.web('/v1/codex/desktop/restart', f.input());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await f.web('/v1/run', { sessionId, requestId: randomUUID(), text: 'not submitted' })).status, 409);
  release({ ready: true, version: '0.168.0' }); await f.done();
  assert.ok(!f.calls.includes('send'));
});

test('running shared sessions can connect without restarting the desktop', async t => {
  const f = await fixture(t, { runStatus: 'running', overrides: {
    inspectTransport: async () => ({ mode: 'shared', daemon: { ready: true, version: '0.168.0' } }),
    ensureDaemon: async () => { throw Error('must not start daemon'); },
  } });
  await f.web('/v1/bind', { sessionId, allowControl: true });
  assert.equal((await f.web('/v1/codex/desktop/restart', f.input())).status, 202);
  const result = await f.done();
  assert.equal(result.state, 'completed'); assert.equal(result.action, 'reuse');
  assert.equal(result.transportBefore, 'shared'); assert.deepEqual(f.calls, []);
  assert.deepEqual(result.dock, { enabled: true, action: 'install' });
});

test('a web session revoked during Dock preparation cannot install or quit the desktop', async t => {
  let release, installed = false;
  const f = await fixture(t, { dockOverrides: { enable: async ({ assertAllowed }) => {
    await new Promise(resolve => { release = resolve; });
    assertAllowed(); installed = true; return { enabled: true };
  } } });
  await f.web('/v1/codex/desktop/restart', f.input());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await f.web('/v1/disconnect', {}); release();
  assert.equal((await f.done()).state, 'failed'); assert.equal(installed, false);
  assert.deepEqual(f.calls, []);
});

test('local CLI asks the running bridge to restart and reads its result without exposing credentials', async t => {
  const f = await fixture(t), dir = await mkdtemp(join(tmpdir(), 'desktop-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtime = join(dir, 'connector.json');
  await writeFile(runtime, JSON.stringify({ endpoint: f.base, instanceId: f.connector.instanceId, key }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../../codex-desktop.mjs', import.meta.url));
  const exec = promisify(execFile);
  const accepted = await exec(process.execPath, [cli, 'restart', '--runtime', runtime]);
  assert.equal(JSON.parse(accepted.stdout).ok, true);
  await f.done();
  const status = await exec(process.execPath, [cli, 'status', '--runtime', runtime]);
  assert.equal(JSON.parse(status.stdout).data.operation.state, 'completed');
  assert.ok(!accepted.stdout.includes(key) && !status.stdout.includes(key));
  assert.deepEqual(f.calls, ['quit', 'open']);
});

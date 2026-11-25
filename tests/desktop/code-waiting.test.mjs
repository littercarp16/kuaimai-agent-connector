import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await readFile(new URL('../../web/code-connect.js', import.meta.url), 'utf8');
const storage = () => { const items = new Map(); return { getItem: key => items.get(key) || null, setItem: (key, value) => items.set(key, value), removeItem: key => items.delete(key) }; };
const until = async predicate => { const end = Date.now() + 1500; while (!predicate()) { if (Date.now() > end) throw Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 2)); } };
function fixture() {
  const states = [], calls = [], endpoint = 'http://127.0.0.1:17653'; let authorized = false;
  const sessionStorage = storage();
  const context = vm.createContext({ URL, URLSearchParams, AbortController, AbortSignal, Headers, Response, crypto: webcrypto, btoa,
    location: { origin: 'https://app.ltpass.com' }, sessionStorage, localStorage: storage(),
    setTimeout: (fn, ms) => setTimeout(fn, ms === 1500 ? 5 : ms), clearTimeout,
    addEventListener() {}, removeEventListener() {}, KmDesktopConnector: { challengeFor: () => 'c'.repeat(43) },
    fetch: async (url, init) => {
      const u = new URL(url); calls.push(u.pathname);
      if (u.origin !== endpoint) throw Error('no service');
      let data;
      if (u.pathname === '/v1/connect/discover') data = { endpoint, instanceId: 'instance-1', service: 'kuaimai-agent-connector', transport: 'direct/1' };
      else if (u.pathname === '/v1/connect/claim') data = authorized
        ? { token: 't'.repeat(43), reconnectToken: 'r'.repeat(43), expiresAt: Date.now() + 60000, snapshot: { instanceId: 'instance-1' } }
        : { pending: true };
      return new Response(JSON.stringify({ ok: true, data }));
    },
  });
  vm.runInContext(source, context);
  return { client: context.KmCodeConnector.create({ onStatus: (message, state) => states.push({ message, ...state }) }), states, calls, sessionStorage,
    authorize() { authorized = true; } };
}
test('pending authorization has an actionable state and becomes connected only after a grant', async () => {
  const f = fixture(), prepared = f.client.prepare({ provider: 'codex' });
  try {
    assert.equal(f.client.hasPendingRequest(), true);
    assert.equal(f.states[0].phase, 'waiting-for-agent');
    await until(() => f.states.some(s => s.message.includes('已找到本机连接器')));
    assert.ok(f.states.every(s => s.phase === 'waiting-for-agent'));
    f.authorize(); await prepared.connection;
    assert.equal(f.client.hasSaved(), true);
    assert.equal(f.client.hasPendingRequest(), false);
    assert.equal(f.states.at(-1).phase, 'connected');
    assert.ok(!f.calls.includes('/v1/run'));
  } finally { f.client.close(); }
});
test('a restored pending request is available for ten hours from creation', async () => {
  const f = fixture(), hour = 60 * 60 * 1000;
  const pendingAt = created => f.sessionStorage.setItem('km-agent.code.pending', JSON.stringify({ state: 's'.repeat(43), verifier: 'v'.repeat(43), created }));
  pendingAt(Date.now() - 10 * hour);
  assert.equal(f.client.hasPendingRequest(), false);
  assert.equal(f.client.hasSaved(), false);
  await assert.rejects(f.client.connect(), /复制最新连接请求/);
  pendingAt(Date.now() - 9 * hour);
  assert.equal(f.client.hasSaved(), true);
  f.authorize();
  try { await f.client.connect(); assert.equal(f.states.at(-1).phase, 'connected'); }
  finally { f.client.close(); }
});
test('cancel and retry in the same tick never reuse an aborted pending promise or stale error', async () => {
  const f = fixture(), first = f.client.prepare({ provider: 'codex' });
  f.client.close(); f.authorize();
  const retry = f.client.connect();
  assert.notEqual(retry, first.connection);
  await assert.rejects(first.connection);
  try { await retry; assert.equal(f.states.at(-1).phase, 'connected'); assert.ok(!f.states.some(s => s.phase === 'error')); }
  finally { f.client.close(); }
});

test('explicit cancellation discards only the pending request and preserves an earlier grant', async () => {
  const f = fixture();
  f.authorize();
  await f.client.prepare({ provider: 'qwen' }).connection;
  const grant = f.sessionStorage.getItem('km-agent.code.direct-grant');
  const next = f.client.prepare({ provider: 'workbuddy' });
  assert.equal(f.client.savedProvider(), 'workbuddy');
  f.client.close({ discardPending: true });
  await assert.rejects(next.connection);
  assert.equal(f.client.hasPendingRequest(), false);
  assert.equal(f.client.hasSaved(), true);
  assert.equal(f.client.savedProvider(), 'qwen');
  assert.equal(f.sessionStorage.getItem('km-agent.code.direct-grant'), grant);
  assert.ok(!f.calls.includes('/v1/connect/direct-revoke'));
});

test('a retired provider cannot resume a grant or pending request as Codex', async () => {
  const f = fixture();
  f.sessionStorage.setItem('km-agent.code.pending', JSON.stringify({
    provider: 'opencode', state: 's'.repeat(43), verifier: 'v'.repeat(43), created: Date.now(),
  }));
  f.sessionStorage.setItem('km-agent.code.direct-grant', JSON.stringify({
    provider: 'opencode', endpoint: 'http://127.0.0.1:17653', instanceId: 'instance-1',
    reconnectToken: 'r'.repeat(43), expiresAt: Date.now() + 60000,
  }));
  assert.equal(f.client.hasSaved(), false);
  await assert.rejects(f.client.connect(), /复制最新连接请求/);
  assert.deepEqual(f.calls, []);
});

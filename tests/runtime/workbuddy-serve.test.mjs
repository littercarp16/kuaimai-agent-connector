import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createWorkBuddyAccountLogin } from '../../src/runtime/workbuddy-account.mjs';
import { createWorkBuddyServeManager } from '../../src/runtime/workbuddy-serve.mjs';

test('stopping the bridge closes an unfinished official login and permits a fresh start', { timeout: 2000 }, async () => {
  let starts = 0, stops = 0, endLogin;
  const manager = createWorkBuddyServeManager({
    async start() {
      starts++;
      return {
        adapter: {}, running: () => true,
        authenticate: () => new Promise(resolve => { endLogin = resolve; }),
        async close() { stops++; endLogin?.(); },
      };
    },
  });
  manager.ensure();
  await new Promise(resolve => setImmediate(resolve));
  manager.authenticate(() => {});
  assert.equal(manager.status().phase, 'authenticating');
  await manager.adapter.close();
  assert.equal(manager.status().phase, 'idle');
  manager.ensure();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.status().phase, 'ready');
  await manager.adapter.close();
  assert.equal(starts, 2);
  assert.equal(stops, 2);
});

test('one official login page and at most one successful recovery per account attempt', async t => {
  let authenticated = false, endedWithoutAccount = false, started = 0, time = 0, failOpen = true;
  const requests = [], opened = [];
  const url = 'https://www.workbuddy.ai/login?state=fixture';
  const server = createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/login')) {
      let body = '';
      for await (const part of req) body += part;
      assert.deepEqual(JSON.parse(body), {});
      started++;
      return res.end(JSON.stringify({ data: { success: true, authUrl: url } }));
    }
    res.end(JSON.stringify({ data: { authenticated, loginPending: !!started && !authenticated && !endedWithoutAccount } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const controller = new AbortController();
  const account = createWorkBuddyAccountLogin({ endpoint: 'http://127.0.0.1:' + server.address().port,
    password: 'fixture', signal: controller.signal, now: () => time,
    open: async value => {
      if (failOpen) throw Error('fixture browser unavailable');
      opened.push(value);
    } });
  assert.equal(await account.isAuthenticated(), false);
  assert.equal(started, 0);
  let waiting;
  const pending = new Promise(resolve => { waiting = resolve; });
  const run = account.authenticate(() => {}, waiting);
  await pending;
  assert.equal(account.canReopen(), false);
  await account.reopen(() => {});
  time += 5000;
  assert.ok(account.canReopen());
  await assert.rejects(account.reopen(() => { throw Error('revoked'); }), /revoked/);
  assert.deepEqual(opened, []);
  await assert.rejects(account.reopen(() => {}), /请重试/);
  assert.ok(account.canReopen());
  failOpen = false;
  await Promise.all(Array.from({ length: 10 }, () => account.reopen(() => {})));
  await account.reopen(() => {});
  assert.equal(account.canReopen(), false);
  authenticated = true;
  await run;
  assert.equal(await account.isAuthenticated(), true);
  assert.deepEqual(opened, [url]);
  assert.equal(account.canReopen(), false);
  await account.authenticate(() => {}, () => assert.fail('already signed in'));
  assert.equal(started, 1);
  authenticated = false; endedWithoutAccount = true;
  assert.equal(await account.isAuthenticated(), false);
  await assert.rejects(account.authenticate(() => {}, () => {}), /账号尚未登录/);
  assert.equal(account.canReopen(), false);
  assert.ok(requests.every(path => path.startsWith('/api/v1/auth/account/')));
});

test('retries join the active login and a stale recovery cannot open or start another attempt', async () => {
  let starts = 0, opens = 0, finish;
  const manager = createWorkBuddyServeManager({ async start() {
    return { running: () => true, close: async () => {}, canReopen: () => true,
      reopen: () => { opens++; }, authenticate: () => { starts++; return new Promise(resolve => { finish = resolve; }); } };
  } });
  const allowed = () => {};
  manager.ensure();
  await new Promise(resolve => setImmediate(resolve));
  manager.authenticate(allowed);
  const first = manager.status().loginAttemptId;
  manager.authenticate(allowed);
  assert.equal(starts, 1);
  assert.equal(opens, 0);
  manager.authenticate(allowed, { reopen: true, attemptId: first });
  assert.equal(opens, 1);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  manager.authenticate(allowed, { reopen: true, attemptId: first });
  assert.equal(starts, 1);
  manager.authenticate(allowed);
  assert.notEqual(manager.status().loginAttemptId, first);
  manager.authenticate(allowed, { reopen: true, attemptId: first });
  assert.equal(opens, 1);
  finish();
  await manager.adapter.close();
});

test('reading preparation reports only the current CLI account and never starts login', async () => {
  let signedIn = true, unavailable = false;
  const manager = createWorkBuddyServeManager({ async start() {
    return { running: () => true, close: async () => {}, isAuthenticated: async () => {
      if (unavailable) throw Error('account unavailable');
      return signedIn;
    } };
  } });
  assert.equal((await manager.readPreparation()).authenticated, null);
  manager.ensure();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await manager.readPreparation()).authenticated, true);
  signedIn = false;
  assert.equal((await manager.readPreparation()).authenticated, false);
  unavailable = true;
  const status = await manager.readPreparation();
  assert.equal(status.phase, 'ready');
  assert.equal(status.authenticated, null);
  await manager.adapter.close();
  assert.equal((await manager.readPreparation()).authenticated, null);
});

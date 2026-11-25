import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { validateRequest, EXTENSION_ID, HOST, ORIGINS } from '../../src/extension/policy.mjs';
import { runNativeHost, validCaller } from '../../src/extension/native-host.mjs';
import { installExtensionHost } from '../../src/extension/install.mjs';
import { createDesktopHost } from '../../src/desktop/host.mjs';
import { challengeFor } from '../../src/desktop/connect-grants.mjs';

test('扩展来源、固定身份、端口、方法和接口范围', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../browser-extension/manifest.json', import.meta.url)));
  const id = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16)].map(v => String.fromCharCode(97 + (v >> 4), 97 + (v & 15))).join('');
  assert.equal(id, EXTENSION_ID); assert.equal(validCaller(`chrome-extension://${id}/`), true);
  assert.equal(validCaller('chrome-extension://other/'), false);
  assert.deepEqual(manifest.permissions, ['nativeMessaging']); assert.equal(manifest.host_permissions, undefined);
  const request = { id: 'req', origin: ORIGINS[0], method: 'GET', url: 'http://127.0.0.1:17653/v1/connect/discover' };
  assert.equal(validateRequest(request).headers.Origin, ORIGINS[0]);
  for (const patch of [
    { origin: 'http://lt.com:8086' }, { origin: 'https://evil.test' }, { method: 'DELETE' },
    ...['http://192.168.1.1:17653/v1/connect/discover', 'http://127.0.0.1:8080/v1/connect/discover', 'http://127.0.0.1:17653/v1/local/publish', 'http://127.0.0.1:17653/v1/pair', 'http://127.0.0.1:17653/v1/snapshot', 'http://127.0.0.1:17653/v1/connect/discover?secret=1'].map(url => ({ url })),
    { headers: { Origin: ORIGINS[1] } }, { headers: { 'x-km-publisher': 'secret' } },
  ]) assert.throws(() => validateRequest({ ...request, ...patch }));
});

test('注册本机通道保留浏览器配置，固定扩展身份，可重复安装', async t => {
  const root = await mkdtemp('/private/tmp/km-ext-install-'); t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'Browser'), options = { directory: join(root, 'runtime'), profiles: [profile] };
  const result = await installExtensionHost(options); await installExtensionHost(options);
  assert.equal(result.extensionId, EXTENSION_ID);
  const manifest = JSON.parse(await readFile(join(profile, 'NativeMessagingHosts', HOST + '.json')));
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${EXTENSION_ID}/`]);
  assert.equal(manifest.type, 'stdio'); assert.equal(manifest.path, join(root, 'runtime/native-host'));
  assert.match(await readFile(manifest.path, 'utf8'), /exec '.*' '.*native-host.mjs' "\$@"/);
});

test('真实本机消息帧：授权仍需 PKCE，跨来源不可借用 token，关闭通道释放连接', { timeout: 15000 }, async t => {
  const directory = await mkdtemp('/private/tmp/km-ext-native-');
  let preparations = 0;
  const workBuddyServeManager = {
    ensure({ assertAllowed }) { assertAllowed(); preparations++; return { phase: 'starting' }; },
  };
  const host = createDesktopHost({ directory, direct: true, codexEnabled: false, workBuddyServeManager,
    adapterFactory: () => ({ health: async () => ({ ready: true }), listSessions: async () => [], close: async () => {} }) });
  const started = await host.start({ origins: ORIGINS }), input = new PassThrough(), output = new PassThrough();
  const native = await runNativeHost({ input, output });
  t.after(async () => { await native.close(); input.destroy(); output.destroy(); await host.stop(); await rm(directory, { recursive: true, force: true }); });
  let buffer = Buffer.alloc(0), sequence = 0; const pending = new Map();
  const send = value => { const bytes = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(bytes.length); input.write(header); input.write(bytes); };
  output.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0), value = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
      const task = pending.get(value.id); if (!task) continue;
      if (value.type === 'response') task.status = value.status;
      if (value.type === 'chunk') { task.body += Buffer.from(value.data, 'base64'); queueMicrotask(() => send({ id: value.id, type: 'ack' })); }
      if (value.type === 'end') { pending.delete(value.id); task.resolve({ status: task.status, ...JSON.parse(task.body) }); }
      if (value.type === 'error') { pending.delete(value.id); task.resolve({ error: value.error }); }
    }
  });
  const call = (path, body, headers, origin = ORIGINS[0]) => new Promise(resolve => {
    const id = 'r' + (++sequence); pending.set(id, { resolve, body: '' });
    send({ id, type: 'request', origin, url: started.endpoint + path, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), headers });
  });
  assert.equal((await call('/v1/connect/discover')).data.instanceId, started.instanceId);
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const url = 'km-agent://connect?' + new URLSearchParams({ origin: ORIGINS[0], callback: ORIGINS[0] + '/agent/connect-callback.html', state, challenge: challengeFor(verifier), browser: 'default', transport: 'direct' });
  host.authorize(host.inspectLink(url).id);
  const claim = { state, verifier, instanceId: started.instanceId };
  assert.equal((await call('/v1/connect/claim', { ...claim, verifier: randomBytes(32).toString('base64url') })).status, 403);
  const granted = await call('/v1/connect/claim', claim), headers = { authorization: 'Bearer ' + granted.data.token };
  assert.equal((await call('/v1/snapshot', null, headers)).status, 200);
  assert.equal((await call('/v1/snapshot', null, headers, ORIGINS[1])).status, 401);
  const workBuddy = { provider: 'workbuddy', instanceId: started.instanceId };
  assert.equal((await call('/v1/sources', null, headers)).status, 200);
  assert.equal(preparations, 0);
  assert.ok((await call('/v1/session/new', workBuddy)).error);
  assert.equal((await call('/v1/session/new', workBuddy, headers, ORIGINS[1])).status, 401);
  assert.equal((await call('/v1/session/new', { ...workBuddy, password: 'irrelevant' }, headers)).status, 400);
  assert.equal((await call('/v1/session/new', { ...workBuddy, instanceId: 'stale' }, headers)).status, 409);
  assert.equal(preparations, 0);
  assert.deepEqual((await call('/v1/session/new', workBuddy, headers)).data, { phase: 'starting' });
  assert.equal(preparations, 1);
  assert.ok((await call('/v1/local/publish', {}, headers)).error);
  await native.close();
  const after = await fetch(started.endpoint + '/v1/snapshot', { headers: { Origin: ORIGINS[0], Authorization: headers.authorization } });
  assert.equal(after.status, 401);
});

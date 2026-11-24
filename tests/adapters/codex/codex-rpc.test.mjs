import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, chmod, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const rpc = await import('../../../src/adapters/codex/codex-rpc.mjs').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes('codex-rpc.mjs')) throw error;
  return {};
});
const tempRoot = path.join(await realpath(tmpdir()), 'opencode');
await mkdir(tempRoot, { recursive: true, mode: 0o700 });
const waitFor = async predicate => {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture condition timed out');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};
const send = (peer, message) => peer.ws.send(JSON.stringify(message));
const versionOutput = socketPath => ({ stdout: JSON.stringify({
  status: 'running', cliVersion: '0.166.0', appServerVersion: '0.166.0', socketPath,
}) });
test('服务端答复在写入背压下有界失败，未知结果仍不允许重答',async t=>{
 const f=await connect(t,{}, {timeoutMs:50});let received=false;f.client.subscribe(m=>{if(m.id==='backpressure-q')received=true;});send(f.peer,{id:'backpressure-q',method:'item/tool/requestUserInput',params:{}});await waitFor(()=>received);
 f.peer.ws._socket.pause();t.after(()=>f.peer.ws._socket.resume());
 await assert.rejects(f.client.request('fixture/large',{text:'x'.repeat(900*1024)}),e=>e.code==='CODEX_RESULT_UNKNOWN');
 const result=await Promise.race([f.client.respond('backpressure-q',{answers:{}}).then(()=> 'wire-sent',e=>e.code),new Promise(r=>setTimeout(()=>r('still-waiting'),250))]);
 assert.equal(result,'CODEX_RESULT_UNKNOWN','写预算不等于写入时间有界');await assert.rejects(f.client.respond('backpressure-q',{answers:{}}),e=>e.code==='NOT_SUBMITTED');
});

async function fixture(t, { initialize = true, initializationResult = { userAgent: 'fixture' }, handshake = true, nested = false } = {}) {
  const directory = await mkdtemp(path.join(tempRoot, 'cdx-'));
  await chmod(directory, 0o700);
  const socketParent = nested ? path.join(directory, 'p') : directory;
  if (nested) await mkdir(socketParent, { mode: 0o700 });
  const socketPath = path.join(socketParent, 's');
  const peers = [];
  const upgrades = [];
  const sockets = new Set();
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    upgrades.push({ upgrade: request.headers.upgrade, origin: request.headers.origin });
    if (!handshake) return;
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const peer = { ws, messages: [] };
    peers.push(peer);
    ws.on('error', () => {});
    ws.on('message', bytes => {
      const message = JSON.parse(bytes.toString());
      peer.messages.push(message);
      if (initialize && message.method === 'initialize') send(peer, { id: message.id, result: initializationResult });
    });
  });
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(async () => {
    for (const { ws } of peers) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, socketPath, peers, upgrades, server };
}

async function connect(t, fixtureOptions, options = {}) {
  assert.equal(typeof rpc.connectCodexRpc, 'function', '需要实现 UnixSocket WebSocket RPC');
  const f = await fixture(t, fixtureOptions);
  const client = await rpc.connectCodexRpc({ socketPath: f.socketPath, ...options });
  t.after(() => client.close());
  await waitFor(() => f.peers[0].messages.some(message => message.method === 'initialized'));
  return { ...f, client, peer: f.peers[0] };
}

test('Task1 exposes only the requested discover/connect entry points', () => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  assert.equal(typeof rpc.connectCodexRpc, 'function');
});

test('MED4 receipt order is stamped during decode for coalesced notifications and response without JSON mutation', async t => {
  const f = await connect(t); assert.equal(typeof f.client.orderOf, 'function');
  const events = [];
  f.client.subscribe(event => { assert.ok(Number.isSafeInteger(f.client.orderOf(event))); events.push(event); });
  const resultPromise = f.client.request('fixture/order', {});
  await waitFor(() => f.peer.messages.some(m => m.method === 'fixture/order'));
  const request = f.peer.messages.find(m => m.method === 'fixture/order');
  f.peer.ws._socket.cork();
  send(f.peer, { method: 'fixture/before', params: { delta: 'before' } });
  send(f.peer, { id: request.id, result: { thread: { id: 'fixture' }, initialTurnsPage: { data: [] } } });
  send(f.peer, { method: 'fixture/after', params: { delta: 'after' } });
  f.peer.ws._socket.uncork();
  const result = await resultPromise; await waitFor(() => events.length === 2);
  assert.ok(f.client.orderOf(events[0]) < f.client.orderOf(result));
  assert.ok(f.client.orderOf(result) < f.client.orderOf(events[1]));
  assert.deepEqual(result, { thread: { id: 'fixture' }, initialTurnsPage: { data: [] } });
  assert.deepEqual(events[0], { method: 'fixture/before', params: { delta: 'before' } });
  assert.equal(Reflect.ownKeys(result).length, 2);
  assert.equal(f.client.orderOf(structuredClone(result)), null); assert.equal(f.client.orderOf(null), null);
  assert.equal(f.client.orderOf(1), null); assert.equal(f.client.orderOf({}), null);
});

test('MED4 receipt WeakMaps are per connection and never identify another peer result', async t => {
  const f = await connect(t); const other = await rpc.connectCodexRpc({ socketPath: f.socketPath }); t.after(() => other.close());
  assert.equal(typeof other.orderOf, 'function');
  const pending = f.client.request('fixture/order', {});
  await waitFor(() => f.peer.messages.some(m => m.method === 'fixture/order'));
  send(f.peer, { id: f.peer.messages.find(m => m.method === 'fixture/order').id, result: { value: 1 } });
  const result = await pending; assert.ok(f.client.orderOf(result) > 0); assert.equal(other.orderOf(result), null);
});

test('discovery runs only the read-only daemon version command and identifies the owned socket', async t => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const f = await fixture(t);
  const calls = [];
  const run = async (...args) => { calls.push(args); return versionOutput(f.socketPath); };
  const found = await rpc.discoverCodexDaemon({ run, command: '/fixture/codex' });
  assert.equal(found.ready, true);
  assert.equal(found.version, '0.166.0');
  assert.equal(found.socketPath, f.socketPath);
  assert.ok(found.instanceId);
  assert.ok(!found.instanceId.includes(f.directory));
  assert.deepEqual(calls[0].slice(0, 2), ['/fixture/codex', ['app-server', 'daemon', 'version']]);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][2].timeout > 0);
  assert.ok(calls[0][2].maxBuffer <= 64 * 1024);
  assert.equal((await rpc.discoverCodexDaemon({ run })).instanceId, found.instanceId);
  await chmod(f.socketPath, 0o600);
  assert.notEqual((await rpc.discoverCodexDaemon({ run })).instanceId, found.instanceId, 'ctime is part of daemon identity');
});
test('官方受保护control socket别名可解析到自有私有短路径，仍拒绝任意链接',async t=>{
 const f=await fixture(t),parent=path.join(f.directory,'app-server-control');await mkdir(parent,{mode:0o700});const alias=path.join(parent,'app-server-control.sock');await symlink(f.socketPath,alias);
 const found=await rpc.discoverCodexDaemon({run:async()=>versionOutput(alias)});assert.equal(found.ready,true,'官方控制入口的私有别名不应当成任意符号链接');assert.equal(found.socketPath,await realpath(f.socketPath));
 const c=await rpc.connectCodexRpc({socketPath:alias,timeoutMs:500});t.after(()=>c.close());assert.equal(c.closed,false);
 await chmod(parent,0o750);assert.equal((await rpc.discoverCodexDaemon({run:async()=>versionOutput(alias)})).ready,false);await chmod(parent,0o700);
 await chmod(f.directory,0o750);assert.equal((await rpc.discoverCodexDaemon({run:async()=>versionOutput(alias)})).ready,false,'短路径目标也必须位于私有目录');await chmod(f.directory,0o700);
});
test('socket本身可被其它账户写入时拒绝接入，不自行chmod修好厂商服务',async t=>{const f=await fixture(t);await chmod(f.socketPath,0o666);assert.equal((await rpc.discoverCodexDaemon({run:async()=>versionOutput(f.socketPath)})).ready,false);await assert.rejects(rpc.connectCodexRpc({socketPath:f.socketPath}),e=>e.code==='CODEX_UNSAFE_SOCKET');});

test('discovery rejects non-running daemons but never gates CLI/server release combinations', async t => {
  const f = await fixture(t), baseline = JSON.parse(versionOutput(f.socketPath).stdout);
  for (const status of ['stopped', 'missing', undefined]) {
    const found = await rpc.discoverCodexDaemon({ run: async () => ({ stdout: JSON.stringify({ ...baseline, status }) }) });
    assert.equal(found.ready, false); assert.equal(found.socketPath, undefined);
  }
  for (const [cliVersion, appServerVersion] of [
    ['0.166.7', '0.166.7'], ['0.167.2', '0.168.0'], ['0.168.0', '0.171.0'],
    ['0.168.0', '0.172.0'], ['0.168.0', '0.999.99'], ['0.168.0', '2.0.0-beta.1'],
    ['2.0.0', '0.166.0'], [null, 'nightly-20270101'], [null, null],
  ]) {
    const found = await rpc.discoverCodexDaemon({ run: async () => ({
      stdout: JSON.stringify({ ...baseline, cliVersion, appServerVersion }),
    }) });
    assert.equal(found.ready, true); assert.equal(found.version, appServerVersion);
    const client = await rpc.connectCodexRpc(found);
    assert.equal(client.version, appServerVersion); client.close();
  }
});

test('missing CLI, malformed output and private process errors are safe Chinese unready results', async () => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const secret = 'sk-fixture-private-token /private/auth.json';
  const failure = Object.assign(new Error(secret), { code: 'ENOENT', stdout: secret, stderr: secret });
  for (const run of [async () => { throw failure; }, async () => ({ stdout: secret }), async () => ({ stdout: 'x'.repeat(70 * 1024) })]) {
    const result = await rpc.discoverCodexDaemon({ run });
    assert.equal(result.ready, false);
    assert.equal(result.version, null);
    assert.match(result.message, /[\u4e00-\u9fff]/);
    assert.doesNotMatch(JSON.stringify(result), /sk-fixture|auth\.json/);
  }
  const absent = await rpc.discoverCodexDaemon({ command: path.join(tempRoot, 'never-installed-codex-fixture') });
  assert.equal(absent.ready, false);
  assert.doesNotMatch(JSON.stringify(absent), /never-installed/);
});

test('discovery rejects relative, regular, symlinked sockets and symlinked parents', async t => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const f = await fixture(t);
  const regular = path.join(f.directory, 'file');
  const alias = path.join(f.directory, 'alias');
  const parentAlias = path.join(f.directory, 'parent');
  await writeFile(regular, 'fixture');
  await symlink(f.socketPath, alias);
  await symlink(f.directory, parentAlias);
  for (const socketPath of ['relative.sock', regular, alias, path.join(parentAlias, 's')]) {
    const found = await rpc.discoverCodexDaemon({ run: async () => versionOutput(socketPath) });
    assert.equal(found.ready, false, socketPath);
  }
});

test('discovery rejects writable parents/ancestors and sockets not owned by the current user', async t => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const f = await fixture(t);
  for (const mode of [0o770, 0o707, 0o777]) {
    await chmod(f.directory, mode);
    const found = await rpc.discoverCodexDaemon({ run: async () => versionOutput(f.socketPath) });
    assert.equal(found.ready, false, mode.toString(8));
  }
  await chmod(f.directory, 0o700);
  const uid = process.getuid();
  const getuid = mock.method(process, 'getuid', () => uid + 1);
  try {
    assert.equal((await rpc.discoverCodexDaemon({ run: async () => versionOutput(f.socketPath) })).ready, false);
  } finally { getuid.mock.restore(); }
  const nested = await fixture(t, { nested: true });
  await chmod(nested.directory, 0o777);
  assert.equal((await rpc.discoverCodexDaemon({ run: async () => versionOutput(nested.socketPath) })).ready, false);
});

test('a macOS system /var alias is accepted but arbitrary directory symlinks are not', { skip: process.platform !== 'darwin' }, async t => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const f = await fixture(t);
  const alias = f.socketPath.replace(/^\/private\/var\//, '/var/');
  const direct = await rpc.discoverCodexDaemon({ run: async () => versionOutput(f.socketPath) });
  const found = await rpc.discoverCodexDaemon({ run: async () => versionOutput(alias) });
  assert.equal(found.ready, true);
  assert.equal(found.socketPath, f.socketPath);
  assert.equal(found.instanceId, direct.instanceId);
});

test('rebinding a replacement socket at the same path produces a new instance ID', async t => {
  assert.equal(typeof rpc.discoverCodexDaemon, 'function');
  const f = await fixture(t);
  const run = async () => versionOutput(f.socketPath);
  const first = await rpc.discoverCodexDaemon({ run });
  await new Promise(resolve => f.server.close(resolve));
  f.server.listen(f.socketPath);
  await once(f.server, 'listening');
  const replacement = await rpc.discoverCodexDaemon({ run });
  assert.equal(replacement.ready, true);
  assert.notEqual(replacement.instanceId, first.instanceId);
});

test('real HTTP Upgrade initializes once per connection with the truthful client and opt-outs', async t => {
  const { client, peer, upgrades, socketPath } = await connect(t);
  assert.deepEqual(upgrades, [{ upgrade: 'websocket', origin: undefined }]);
  assert.deepEqual(peer.messages, [{ id: 1, method: 'initialize', params: {
    clientInfo: { name: 'kuaimai_codex_bridge', version: '1.0.0' },
    capabilities: { experimentalApi: true, optOutNotificationMethods: [
      'item/reasoning/textDelta', 'item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded',
    ] },
  } }, { method: 'initialized' }]);
  assert.equal(client.version, null);
  assert.equal(client.closed, false);
  assert.equal(client.instanceId, (await rpc.discoverCodexDaemon({ run: async () => versionOutput(socketPath) })).instanceId);
});

test('two peers can reuse request IDs without cross-delivery, responses never broadcast', async t => {
  const { client, peer, peers, socketPath } = await connect(t);
  const other = await rpc.connectCodexRpc({ socketPath });
  t.after(() => other.close());
  const notifications = [];
  client.subscribe(message => notifications.push(message));
  const first = client.request('fixture/one', { value: 'one' });
  const second = other.request('fixture/two', { value: 'two' });
  await waitFor(() => peer.messages.length === 3 && peers[1]?.messages.length === 3);
  const a = peer.messages.at(-1), b = peers[1].messages.at(-1);
  assert.equal(a.id, b.id);
  send(peers[1], { id: b.id, result: { peer: 'two' } });
  send(peer, { id: a.id, result: { peer: 'one' } });
  assert.deepEqual(await first, { peer: 'one' });
  assert.deepEqual(await second, { peer: 'two' });
  assert.deepEqual(notifications, []);
});

test('notifications/server requests are native in-memory events; respond is scoped and single-use', async t => {
  const { client, peer } = await connect(t);
  const events = [];
  const unsubscribe = client.subscribe(message => events.push(message));
  const note = { method: 'fixture/note', params: { text: '公开内容' } };
  const request = { id: 'server-1', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'v', itemId: 'i' } };
  send(peer, note);
  send(peer, request);
  await waitFor(() => events.length === 2);
  assert.deepEqual(events, [note, request]);
  assert.equal(peer.messages.length, 2, 'server requests must not get automatic replies');
  await assert.rejects(() => client.respond('never-received', {}));
  await client.respond('server-1', { answers: { q: { answers: ['yes'] } } });
  await waitFor(() => peer.messages.length === 3);
  assert.deepEqual(peer.messages.at(-1), { id: 'server-1', result: { answers: { q: { answers: ['yes'] } } } });
  await assert.rejects(() => client.respond('server-1', {}));
  unsubscribe();
  send(peer, { method: 'fixture/ignored' });
  const barrier = client.request('fixture/barrier');
  await waitFor(() => peer.messages.at(-1).method === 'fixture/barrier');
  send(peer, { id: peer.messages.at(-1).id, result: {} });
  await barrier;
  assert.equal(events.length, 2);
});

test('serverRequest/resolved invalidates before delivery and foreign peers cannot respond', async t => {
  const { client, peer, socketPath } = await connect(t);
  const other = await rpc.connectCodexRpc({ socketPath });
  t.after(() => other.close());
  const events = [];
  client.subscribe(event => events.push(event));
  send(peer, { id: 9, method: 'fixture/question', params: { threadId: 'thread' } });
  await waitFor(() => events.length === 1);
  await assert.rejects(() => other.respond(9, {}));
  send(peer, { method: 'serverRequest/resolved', params: { threadId: 'thread', requestId: 9 } });
  await waitFor(() => events.length === 2);
  await assert.rejects(() => client.respond(9, {}));
  assert.equal(peer.messages.length, 2);
});

test('consumed/resolved server request IDs cannot be reopened by a duplicate native request', async t => {
  const { client, peer } = await connect(t);
  const events = [];
  client.subscribe(event => events.push(event));
  const native = { id: 'single-use', method: 'fixture/question', params: {} };
  send(peer, native);
  await waitFor(() => events.length === 1);
  await client.respond(native.id, { answer: 'once' });
  send(peer, native);
  send(peer, { id: 'resolved', method: 'fixture/question', params: {} });
  send(peer, { method: 'serverRequest/resolved', params: { requestId: 'resolved', threadId: 't' } });
  send(peer, { id: 'resolved', method: 'fixture/question', params: {} });
  const barrier = client.request('fixture/barrier');
  await waitFor(() => peer.messages.at(-1).method === 'fixture/barrier');
  send(peer, { id: peer.messages.at(-1).id, result: {} });
  await barrier;
  await assert.rejects(() => client.respond(native.id, {}));
  await assert.rejects(() => client.respond('resolved', {}));
  assert.equal(events.filter(event => event.id === native.id).length, 1);
  assert.equal(events.filter(event => event.id === 'resolved').length, 1);
});

test('non-JSON reply results are not sent and do not consume the server request', async t => {
  const { client, peer } = await connect(t);
  const events = [];
  client.subscribe(event => events.push(event));
  send(peer, { id: 'replyable', method: 'fixture/question', params: {} });
  await waitFor(() => events.length === 1);
  for (const result of [undefined, () => {}, Symbol('private'), { toJSON: () => undefined }]) {
    await assert.rejects(() => client.respond('replyable', result), { code: 'NOT_SUBMITTED' });
  }
  assert.equal(peer.messages.length, 2);
  await client.respond('replyable', { answer: 'valid JSON' });
  await waitFor(() => peer.messages.length === 3);
  assert.deepEqual(peer.messages.at(-1), { id: 'replyable', result: { answer: 'valid JSON' } });
});

test('client/server IDs and string/numeric IDs remain separate namespaces', async t => {
  const { client, peer } = await connect(t);
  const events = [];
  client.subscribe(event => events.push(event));
  const outgoing = client.request('fixture/outgoing');
  await waitFor(() => peer.messages.length === 3);
  const id = peer.messages.at(-1).id;
  send(peer, { id, method: 'fixture/question', params: {} });
  send(peer, { id: String(id), method: 'fixture/question', params: {} });
  await waitFor(() => events.length === 2);
  await client.respond(id, { kind: 'number' });
  await client.respond(String(id), { kind: 'string' });
  send(peer, { id, result: 'client response' });
  assert.equal(await outgoing, 'client response');
  await waitFor(() => peer.messages.length === 5);
  assert.deepEqual(peer.messages.slice(-2), [{ id, result: { kind: 'number' } }, { id: String(id), result: { kind: 'string' } }]);
});

test('out-of-order and unknown responses resolve only their own requests', async t => {
  const { client, peer } = await connect(t);
  const first = client.request('fixture/first');
  const second = client.request('fixture/second');
  await waitFor(() => peer.messages.length === 4);
  send(peer, { id: 'unknown', result: 'not delivered' });
  send(peer, { id: peer.messages[3].id, result: 'second' });
  assert.equal(await second, 'second');
  send(peer, { id: peer.messages[2].id, result: 'first' });
  assert.equal(await first, 'first');
});

test('RPC errors expose only fixed messages, numeric rpcCode and safe classification enums', async t => {
  const { client, peer } = await connect(t);
  const result = client.request('fixture/error');
  const assertion = assert.rejects(result, error => {
    assert.equal(error.code, 'CODEX_RPC_ERROR');
    assert.equal(error.rpcCode, -32001);
    assert.deepEqual(error.data, { reason: 'busy', type: 'conflict' });
    assert.doesNotMatch(JSON.stringify(error) + error.message, /sk-secret|private|bearer/);
    return true;
  });
  await waitFor(() => peer.messages.length === 3);
  send(peer, { id: peer.messages[2].id, error: { code: -32001, message: 'sk-secret private', data: {
    reason: 'busy', type: 'conflict', token: 'sk-secret', nested: { body: 'private' },
  } } });
  await assertion;
  const malicious = client.request('fixture/error');
  const safe = assert.rejects(malicious, error => {
    assert.deepEqual(error.data, {});
    assert.doesNotMatch(error.message + JSON.stringify(error), /sk-secret|private/);
    return true;
  });
  await waitFor(() => peer.messages.length === 4);
  send(peer, { id: peer.messages[3].id, error: { code: 1, message: 'private', data: { reason: 'sk-secret', type: 'private' } } });
  await safe;
});

test('only the Codex resume active-writer error reports a conversation in use', async t => {
  const f = await connect(t);
  const threadId = '01234567-89ab-4def-8123-456789abcdef';
  const message = `thread ${threadId} already has an active writer`;
  for (const [method, expected] of [['thread/resume', 'CODEX_THREAD_IN_USE'], ['thread/read', 'CODEX_RPC_ERROR']]) {
    const pending = f.client.request(method, { threadId });
    await waitFor(() => f.peer.messages.some(value => value.method === method));
    const { id } = f.peer.messages.find(value => value.method === method);
    send(f.peer, { id, error: { code: -32600, message } });
    await assert.rejects(pending, error => error.code === expected && !error.message.includes(threadId));
  }
});

test('pre-abort is NOT_SUBMITTED; post-send timeout/abort is UNKNOWN, never retried; late replies drop', async t => {
  const { client, peer } = await connect(t);
  const before = new AbortController();
  before.abort('private reason');
  await assert.rejects(() => client.request('fixture/preabort', {}, { signal: before.signal }), { code: 'NOT_SUBMITTED' });
  assert.equal(peer.messages.length, 2);
  const timed = client.request('fixture/timeout', {}, { timeoutMs: 25 });
  const timeoutAssertion = assert.rejects(timed, { code: 'CODEX_RESULT_UNKNOWN' });
  await waitFor(() => peer.messages.length === 3);
  const timedId = peer.messages.at(-1).id;
  await timeoutAssertion;
  const after = new AbortController();
  const aborted = client.request('fixture/abort', {}, { signal: after.signal });
  const abortAssertion = assert.rejects(aborted, error => error.code === 'CODEX_RESULT_UNKNOWN' && !error.message.includes('private'));
  await waitFor(() => peer.messages.length === 4);
  after.abort('private abort reason');
  await abortAssertion;
  send(peer, { id: timedId, result: 'late' });
  const final = client.request('fixture/final');
  await waitFor(() => peer.messages.length === 5);
  send(peer, { id: peer.messages.at(-1).id, result: 'fresh' });
  assert.equal(await final, 'fresh');
  assert.equal(peer.messages.filter(message => message.method === 'fixture/timeout').length, 1);
  assert.equal(peer.messages.filter(message => message.method === 'fixture/abort').length, 1);
});

test('disconnect clears pending without replay; onClose unsubscribes and local close only closes its own peer', async t => {
  const { client, peer, socketPath } = await connect(t);
  const other = await rpc.connectCodexRpc({ socketPath });
  t.after(() => other.close());
  let closes = 0;
  let unsubscribed = 0;
  client.onClose(() => { closes++; });
  const unsubscribe = client.onClose(() => { unsubscribed++; });
  unsubscribe();
  const pending = client.request('fixture/disconnect');
  const rejected = assert.rejects(pending, { code: 'CODEX_RESULT_UNKNOWN' });
  await waitFor(() => peer.messages.length === 3);
  peer.ws.close(1000, 'sk-private-close-reason');
  await rejected;
  await waitFor(() => client.closed);
  assert.equal(closes, 1);
  assert.equal(unsubscribed, 0);
  await assert.rejects(() => client.request('fixture/closed'), { code: 'NOT_SUBMITTED' });
  await assert.rejects(() => client.respond(1, {}));
  client.close();
  assert.equal(closes, 1);
  assert.equal(other.closed, false);
  const fresh = await rpc.connectCodexRpc({ socketPath });
  t.after(() => fresh.close());
  fresh.close();
  assert.equal(fresh.closed, true);
  assert.equal(other.closed, false);
});

test('128 pending budget rejects before sending and is released after cancellation', async t => {
  const { client, peer } = await connect(t);
  const controller = new AbortController();
  const pending = Array.from({ length: 128 }, () => client.request('fixture/pending', {}, { signal: controller.signal }));
  const settled = Promise.allSettled(pending);
  await waitFor(() => peer.messages.length === 130);
  await assert.rejects(() => client.request('fixture/overflow'));
  assert.equal(peer.messages.length, 130);
  controller.abort();
  assert.ok((await settled).every(result => result.status === 'rejected' && result.reason.code === 'CODEX_RESULT_UNKNOWN'));
  const next = client.request('fixture/recovered');
  await waitFor(() => peer.messages.length === 131);
  send(peer, { id: peer.messages.at(-1).id, result: 'recovered' });
  assert.equal(await next, 'recovered');
});

test('caller serialization cannot reenter request and bypass the 128 pending ceiling', async t => {
  const { client, peer } = await connect(t);
  const controller = new AbortController();
  const pending = Array.from({ length: 127 }, () => client.request('fixture/pending', {}, { signal: controller.signal }));
  const initial = Promise.allSettled(pending);
  const outer = client.request('fixture/outer', { toJSON() {
    pending.push(client.request('fixture/inner', {}, { signal: controller.signal }));
    return {};
  } }, { signal: controller.signal });
  const assertion = assert.rejects(outer, { code: 'NOT_SUBMITTED' });
  const nested = Promise.allSettled(pending);
  await waitFor(() => peer.messages.length >= 130);
  controller.abort();
  await initial;
  await nested;
  await assertion;
  assert.equal(peer.messages.filter(message => message.method === 'fixture/outer').length, 0);
});

test('abort during params serialization is NOT_SUBMITTED, with no frame sent', async t => {
  const { client, peer } = await connect(t);
  const controller = new AbortController();
  await assert.rejects(() => client.request('fixture/serializeAbort', { toJSON() {
    controller.abort('private');
    return {};
  } }, { signal: controller.signal }), { code: 'NOT_SUBMITTED' });
  assert.equal(peer.messages.length, 2);
});

test('message byte limits reject outbound before send and close on oversized inbound frames', async t => {
  const { client, peer } = await connect(t, {}, { maxBytes: 512 });
  await assert.rejects(() => client.request('fixture/tooLarge', { text: '中'.repeat(300) }));
  assert.equal(peer.messages.length, 2);
  const pending = client.request('fixture/inbound');
  const assertion = assert.rejects(pending, { code: 'CODEX_RESULT_UNKNOWN' });
  await waitFor(() => peer.messages.length === 3);
  send(peer, { method: 'fixture/tooLarge', params: { text: 'x'.repeat(700) } });
  await assertion;
  assert.equal(client.closed, true);
});

test('handshake/initialize timeouts and unsafe paths fail safely without daemon startup', async t => {
  assert.equal(typeof rpc.connectCodexRpc, 'function');
  const f = await fixture(t, { initialize: false });
  await assert.rejects(() => rpc.connectCodexRpc({ socketPath: f.socketPath, timeoutMs: 25 }), error => {
    assert.doesNotMatch(error.message, /cdx-|\/private/);
    return true;
  });
  assert.equal(f.peers.length, 1);
  await assert.rejects(() => rpc.connectCodexRpc({ socketPath: 'relative' }));
  const alias = path.join(f.directory, 'alias');
  await symlink(f.socketPath, alias);
  await assert.rejects(() => rpc.connectCodexRpc({ socketPath: alias }));
  assert.equal(f.peers.length, 1);
});

test('a server that never completes HTTP Upgrade times out without sending initialize', { timeout: 1000 }, async t => {
  const f = await fixture(t, { handshake: false });
  await assert.rejects(() => rpc.connectCodexRpc({ socketPath: f.socketPath, timeoutMs: 100 }), error => {
    assert.equal(error.code, 'CODEX_CONNECTION_FAILED');
    assert.doesNotMatch(error.message, /cdx-|\/private/);
    return true;
  });
  assert.equal(f.peers.length, 0);
  assert.equal(f.upgrades.length, 1);
});

test('incoming server requests also have a bounded pending budget and never receive automatic answers', async t => {
  const { client, peer } = await connect(t);
  for (let id = 1; id <= 129; id++) send(peer, { id: `server-${id}`, method: 'fixture/question', params: {} });
  await waitFor(() => client.closed);
  assert.equal(peer.messages.length, 2);
  await assert.rejects(() => client.respond('server-1', {}), { code: 'NOT_SUBMITTED' });
});

test('server-request tombstones have a total ID byte budget, not only a count limit', async t => {
  const { client, peer } = await connect(t);
  send(peer, { id: `a${'x'.repeat(600 * 1024)}`, method: 'fixture/question', params: {} });
  send(peer, { id: `b${'x'.repeat(600 * 1024)}`, method: 'fixture/question', params: {} });
  await waitFor(() => client.closed);
  assert.equal(peer.messages.length, 2);
});

test('malformed JSON and binary frames safely close and clear pending requests', async t => {
  for (const body of ['{private malformed', Buffer.from('{"method":"fixture/binary"}')]) {
    const { client, peer } = await connect(t);
    const pending = client.request('fixture/pending');
    const assertion = assert.rejects(pending, { code: 'CODEX_RESULT_UNKNOWN' });
    await waitFor(() => peer.messages.length === 3);
    peer.ws.send(body);
    await assertion;
    assert.equal(client.closed, true);
  }
});

test('initialization cannot be repeated through request and failed serialization is never submitted', async t => {
  const { client, peer } = await connect(t);
  for (const method of ['initialize', 'initialized']) {
    await assert.rejects(() => client.request(method), { code: 'NOT_SUBMITTED' });
  }
  await assert.rejects(() => client.request('fixture/invalid', { toJSON() { throw new Error('sk-private'); } }), error => {
    assert.equal(error.code, 'NOT_SUBMITTED');
    assert.doesNotMatch(error.message, /sk-private/);
    return true;
  });
  assert.equal(peer.messages.length, 2);
});

test('subscriber exceptions cannot leak uncaught errors or prevent later subscribers', async t => {
  const { client, peer } = await connect(t);
  const events = [];
  client.subscribe(() => { throw new Error('private callback error'); });
  client.subscribe(async () => { throw new Error('private async callback error'); });
  client.subscribe(message => events.push(message));
  send(peer, { method: 'fixture/note', params: {} });
  await waitFor(() => events.length === 1);
  assert.equal(client.closed, false);
});

test('successful RPC envelopes with incompatible initialize bodies are rejected', async t => {
  for (const initializationResult of [null, [], {}, { userAgent: 7 }, { userAgent: '' }]) {
    const f = await fixture(t, { initializationResult });
    await assert.rejects(rpc.connectCodexRpc({ socketPath: f.socketPath, version: '99.0.0' }), { code: 'CODEX_PROTOCOL_INCOMPATIBLE' });
    assert.ok(!f.peers[0].messages.some(m => m.method === 'initialized'));
  }
});

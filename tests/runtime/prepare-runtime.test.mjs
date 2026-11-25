import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, readdir, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const moduleUrl = new URL('../../skills/km-agent-bridge/scripts/prepare.mjs', import.meta.url);
const api = await import(moduleUrl).catch(error => { if (error.code === 'ERR_MODULE_NOT_FOUND') return {}; throw error; });
const ORIGIN = 'http://127.0.0.1:4173';
const RELEASE = 'https://releases.example.invalid/kuaimai/1.2.3.bundle.json';
const KEY = 'fixture-private-key-never-return-this';
const digest = value => createHash('sha256').update(value).digest('hex');
const launcherSource = `import {spawn} from 'node:child_process';
import {writeFile,appendFile} from 'node:fs/promises';
import {join,dirname} from 'node:path';
const args=process.argv.slice(2),port=args[args.indexOf('--port')+1],workspace=args[args.indexOf('--workspace')+1];
await appendFile(join(workspace,'launches'),JSON.stringify(args)+'\\n');
const program=\`import{createServer}from'node:http';import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
const root=process.argv[1],port=process.argv[2],runtime=process.argv[3],instanceId='fixture-instance';
await mkdir(new URL('.', 'file://'+runtime),{recursive:true,mode:0o700});
const endpoint='http://127.0.0.1:'+port;
await writeFile(runtime,JSON.stringify({instanceId,endpoint,protocol:'km-agent/1',key:'${KEY}',bindings:[]}),{mode:0o600});
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{service:'kuaimai-agent-connector',interactionProtocol:'km-agent/1',instanceId}}));});
server.listen(Number(port),'127.0.0.1',()=>writeFile(join(root,'child.pid'),String(process.pid)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));\`;
const child=spawn(process.execPath,['--input-type=module','-e',program,workspace,port,join(dirname(import.meta.filename),'.runtime','connector.json')],{detached:true,stdio:'ignore'});child.unref();
console.log(JSON.stringify({ok:true,key:'${KEY}'}));`;

async function freePort() {
  const server = createTcpServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function fixture(t, { installed = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'km-prepare-test-'));
  const product = join(root, 'product'); await mkdir(product, { mode: 0o700 });
  const workspace = join(root, 'workspace'); await mkdir(workspace, { mode: 0o700 });
  const port = await freePort(), endpoint = `http://127.0.0.1:${port}`;
  const installRoot = join(root, 'versions'), target = join(installRoot, '1.2.3');
  const config = { version: 1, endpoint, origin: ORIGIN, launcher: join(target, 'agent-connector/start.mjs'), mcpEntry: join(target, 'agent-connector/mcp-workbuddy.mjs'), runtimeFile: join(target, 'agent-connector/.runtime/connector.json'), launchArgs: ['--adapter', 'generic', '--trust-origin', ORIGIN, '--port', String(port), '--workspace', workspace] };
  const configFile = join(product, 'bootstrap.json');
  const save = async () => writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  if (installed) { await mkdir(join(target, 'agent-connector'), { recursive: true, mode: 0o700 }); await writeFile(config.launcher, launcherSource); await writeFile(config.mcpEntry, 'process.exit(0);'); }
  await save();
  t.after(async () => { const pid = Number(await readFile(join(workspace, 'child.pid'), 'utf8').catch(() => '')); if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} } await rm(root, { recursive: true, force: true }); });
  const ensure = options => { assert.equal(typeof api.ensureRuntime, 'function', 'ensureRuntime API 尚未实现'); return api.ensureRuntime({ configFile, readinessMs: 4000, requestTimeoutMs: 500, lockWaitMs: 5000, ...options }); };
  return { root, product, workspace, config, configFile, save, ensure, installRoot, target };
}
async function serving(t, f, { status = 200, patch = {}, manifest = {} } = {}) {
  await mkdir(join(f.target, 'agent-connector/.runtime'), { recursive: true, mode: 0o700 });
  await writeFile(f.config.runtimeFile, JSON.stringify({ instanceId: 'fixture-instance', endpoint: f.config.endpoint, protocol: 'km-agent/1', key: KEY, bindings: [], ...manifest }), { mode: 0o600 });
  const server = createServer((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { service: 'kuaimai-agent-connector', interactionProtocol: 'km-agent/1', instanceId: 'fixture-instance', ...patch } })); });
  server.listen(Number(new URL(f.config.endpoint).port), '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); }); return server;
}
function bundle(f, mutate = () => {}) {
  const value = { format: 'km-runtime-bundle/1', version: '1.2.3', entries: { launcher: 'agent-connector/start.mjs', mcpEntry: 'agent-connector/mcp-workbuddy.mjs', runtimeFile: 'agent-connector/.runtime/connector.json' }, files: [{ path: 'agent-connector/start.mjs', content: Buffer.from(launcherSource).toString('base64') }, { path: 'agent-connector/mcp-workbuddy.mjs', content: Buffer.from('process.exit(0);').toString('base64') }] };
  mutate(value); const bytes = Buffer.from(JSON.stringify(value));
  f.config.release = { url: RELEASE, sha256: digest(bytes), version: '1.2.3', installRoot: f.installRoot };
  return bytes;
}
async function downloadFixture(t, bytes, { headers = {}, status = 200 } = {}) {
  let requests = 0;
  const server = createServer((req, res) => { requests++; res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); for (let i = 0; i < bytes.length; i += 101) res.write(bytes.subarray(i, i + 101)); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  return { requests: () => requests, fetcher: (url, options) => { assert.equal(url, RELEASE); assert.equal(options.redirect, 'error'); return fetch(`http://127.0.0.1:${server.address().port}`, options); } };
}
const rejects = (action, code) => assert.rejects(action, error => error.code === code, code);

test('已装未运行：真实启动一次，无session、不提权，返回严格公开合同', async t => {
  const f = await fixture(t), result = await f.ensure();
  assert.deepEqual(result, { ready: true, state: 'started', endpoint: f.config.endpoint, runtimeFile: f.config.runtimeFile, launcher: f.config.launcher, mcpEntry: f.config.mcpEntry, downloaded: false, started: true });
  assert.deepEqual(JSON.parse((await readFile(join(f.workspace, 'launches'), 'utf8')).trim()), f.config.launchArgs);
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.equal((await f.ensure()).state, 'running');
  assert.equal((await readFile(join(f.workspace, 'launches'), 'utf8')).trim().split('\n').length, 1);
});
test('已运行优先复用，不依赖启动文件存在、不重授信', async t => {
  const f = await fixture(t, { installed: false }); await serving(t, f);
  assert.equal((await f.ensure()).state, 'running');
  await assert.rejects(readFile(join(f.workspace, 'launches')), { code: 'ENOENT' });
});
test('错误服务、403、实例不匹配、runtime字段及权限错误均失败关闭', async t => {
  for (const [options, code] of [[{ patch: { service: 'foreign' } }, 'UNSUPPORTED_SERVICE'], [{ status: 403 }, 'HTTP_REJECTED'], [{ manifest: { instanceId: 'stale' } }, 'STALE_INSTANCE'], [{ manifest: { extra: KEY } }, 'INVALID_RUNTIME']]) {
    const f = await fixture(t); await serving(t, f, options); await rejects(() => f.ensure(), code);
    await assert.rejects(readFile(join(f.workspace, 'launches')), { code: 'ENOENT' });
  }
  const f = await fixture(t); await serving(t, f); await chmod(f.config.runtimeFile, 0o644); await rejects(() => f.ensure(), 'UNSAFE_RUNTIME');
});
test('未知占用与HTTP超时不能当成未安装，不启动第二个', async t => {
  const f = await fixture(t), server = createTcpServer(() => {});
  const sockets = new Set(); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(Number(new URL(f.config.endpoint).port), '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  await rejects(() => f.ensure({ requestTimeoutMs: 100 }), 'HTTP_FAILED');
  await assert.rejects(readFile(join(f.workspace, 'launches')), { code: 'ENOENT' });
});
test('缺失且没有发布源：明确INSTALL_SOURCE_REQUIRED，不联网', async t => {
  const f = await fixture(t, { installed: false }); await rejects(() => f.ensure({ fetcher: () => assert.fail('不可下载') }), 'INSTALL_SOURCE_REQUIRED');
});
test('缺失从固定HTTPS源流式下载、sha验证、原子安装、启动；并发仅一次', async t => {
  const f = await fixture(t, { installed: false }), bytes = bundle(f); await f.save();
  const network = await downloadFixture(t, bytes);
  const results = await Promise.all(Array.from({ length: 3 }, () => f.ensure({ fetcher: network.fetcher })));
  assert.equal(network.requests(), 1); assert.equal(results.filter(r => r.state === 'installed').length, 1);
  assert.equal(results.filter(r => r.state === 'running').length, 2);
  assert.equal((await readFile(join(f.workspace, 'launches'), 'utf8')).trim().split('\n').length, 1);
  assert.deepEqual((await readdir(f.installRoot)).sort(), ['1.2.3']);
});
test('篡改hash不解包、不启动', async t => {
  const f = await fixture(t, { installed: false }), bytes = bundle(f); f.config.release.sha256 = '0'.repeat(64); await f.save();
  const network = await downloadFixture(t, bytes); await rejects(() => f.ensure({ fetcher: network.fetcher }), 'HASH_MISMATCH');
  await assert.rejects(readFile(f.config.launcher), { code: 'ENOENT' });
});
test('受限包拒绝遍历、重复、绝对路径、驱动、符号链接、运行凭据及非规范base64', async t => {
  for (const mutate of [b => b.files.push({ path: '../outside', content: '' }), b => b.files.push({ ...b.files[0] }), b => b.files.push({ path: '/absolute', content: '' }), b => b.files.push({ path: 'C:/bad', content: '' }), b => b.files.push({ path: 'link', content: '', type: 'symlink', target: 'start.mjs' }), ...['.env', 'secret.pem', 'secret.key', 'agent-connector/.runtime/token', 'agent-connector/connector.log'].map(path => b => b.files.push({ path, content: '' })), b => b.files[0].content = '%%%']) {
    const f = await fixture(t, { installed: false }), bytes = bundle(f, mutate); await f.save(); const network = await downloadFixture(t, bytes);
    await rejects(() => f.ensure({ fetcher: network.fetcher }), 'INVALID_BUNDLE');
    await assert.rejects(readFile(f.config.launcher), { code: 'ENOENT' });
  }
});
test('重定向/超长下载失败，不解包', async t => {
  for (const options of [{ status: 302, headers: { Location: 'https://evil.invalid/' } }, { headers: { 'Content-Length': String(64 * 1024 * 1024 + 1) } }]) {
    const f = await fixture(t, { installed: false }), bytes = bundle(f); await f.save(); const network = await downloadFixture(t, bytes, options);
    await rejects(() => f.ensure({ fetcher: network.fetcher }), options.status ? 'DOWNLOAD_FAILED' : 'DOWNLOAD_TOO_LARGE');
  }
});
test('已有不同版本目标拒绝，不覆盖未知文件', async t => {
  const f = await fixture(t, { installed: false }), bytes = bundle(f); await f.save();
  await mkdir(f.target, { recursive: true, mode: 0o700 }); await writeFile(join(f.target, 'user.txt'), '用户内容');
  const network = await downloadFixture(t, bytes); await rejects(() => f.ensure({ fetcher: network.fetcher }), 'INSTALL_CONFLICT');
  assert.equal(await readFile(join(f.target, 'user.txt'), 'utf8'), '用户内容');
});
test('显式配置严格拒绝提权、未知字段、非本机路径、远端来源、URL凭据和参数不匹配', async t => {
  for (const mutate of [c => c.extra = true, c => c.launcher = './relative', c => c.endpoint = 'http://localhost:12345', c => c.origin = 'https://remote.invalid', c => c.launchArgs.push('--allow-control'), c => c.launchArgs.push('--session', 'not-a-session'), c => c.launchArgs.push('--unknown'), c => c.launchArgs[c.launchArgs.indexOf('--port') + 1] = '17653', c => c.launchArgs[c.launchArgs.indexOf('--trust-origin') + 1] = 'http://127.0.0.1:9999', c => c.release = { url: 'https://user:password@releases.invalid/file', sha256: '0'.repeat(64), version: '1.0.0', installRoot: c.launcher }]) {
    const f = await fixture(t); mutate(f.config); await f.save(); await rejects(() => f.ensure(), 'INVALID_CONFIG');
  }
});
test('拒绝安装路径和运行清单任意symlink，不执行launcher', async t => {
  const f = await fixture(t), alias = join(f.root, 'alias'); await symlink(f.target, alias); f.config.launcher = join(alias, 'agent-connector/start.mjs'); await f.save();
  await rejects(() => f.ensure(), 'UNSAFE_PATH');
});

test('不同配置进程的相同端点串行化，仅execFile启动一次', async t => {
  const f = await fixture(t), other = join(f.root, 'other'); await mkdir(other, { mode: 0o700 });
  const second = join(other, 'bootstrap.json'); await writeFile(second, JSON.stringify(f.config));
  const run = path => new Promise(resolve => {
    const child = spawn(process.execPath, [fileURLToPath(moduleUrl), '--config', path]); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
  const results = await Promise.all([run(f.configFile), run(second)]);
  for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, ''); }
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).data.state).sort(), ['running', 'started']);
  assert.equal((await readFile(join(f.workspace, 'launches'), 'utf8')).trim().split('\n').length, 1);
});
test('外来锁只等待有界，不抢锁、不删除；自己锁被替换也不删除新锁', async t => {
  const f = await fixture(t), locks = join(tmpdir(), `km-agent-prepare-${process.getuid?.() ?? 'user'}`);
  await mkdir(locks, { recursive: true, mode: 0o700 }); const lock = join(locks, digest(f.config.endpoint) + '.lock');
  await writeFile(lock, JSON.stringify({ token: 'foreign-owner' }), { flag: 'wx', mode: 0o600 });
  t.after(() => rm(lock, { force: true }));
  await rejects(() => f.ensure({ lockWaitMs: 80 }), 'LOCK_TIMEOUT');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'foreign-owner');
  await rm(lock);
  // The launcher changes only this test's token; cleanup must not remove it.
  await writeFile(f.config.launcher, `import{writeFile}from'node:fs/promises';await writeFile(${JSON.stringify(lock)},JSON.stringify({token:'replacement'}));`);
  await rejects(() => f.ensure({ readinessMs: 120 }), 'READINESS_TIMEOUT');
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).token, 'replacement');
});
test('包文件数量、解码大小有界；大base64普通文件可安装不溢出正则堆栈', async t => {
  const f = await fixture(t, { installed: false }), bytes = bundle(f, b => b.files.push({ path: 'node_modules/dependency/data.bin', content: Buffer.alloc(1024 * 1024, 7).toString('base64') }));
  await f.save(); const network = await downloadFixture(t, bytes);
  assert.equal((await f.ensure({ fetcher: network.fetcher, requestTimeoutMs: 4000 })).state, 'installed');
  assert.equal((await readFile(join(f.target, 'node_modules/dependency/data.bin'))).length, 1024 * 1024);
  const tooMany = await fixture(t, { installed: false }), manyBytes = bundle(tooMany, b => { for (let i = 0; i < 10000; i++) b.files.push({ path: `node_modules/f${i}`, content: '' }); });
  await tooMany.save(); const manyNetwork = await downloadFixture(t, manyBytes);
  await rejects(() => tooMany.ensure({ fetcher: manyNetwork.fetcher }), 'INVALID_BUNDLE');
});
test('启动后清单延迟落盘：有界等待就绪，不重复spawn；完全不就绪会超时', async t => {
  const f = await fixture(t);
  const delayed = launcherSource.replace("await writeFile(runtime,JSON.stringify", "setTimeout(()=>writeFile(runtime,JSON.stringify").replace("{mode:0o600});\nconst server", "{mode:0o600}),180);\nconst server");
  await writeFile(f.config.launcher, delayed);
  assert.equal((await f.ensure()).state, 'started');
  const idle = await fixture(t); await writeFile(idle.config.launcher, 'console.log("private-do-not-echo");');
  t.after(() => rm(join(tmpdir(), `km-agent-prepare-${process.getuid?.() ?? 'user'}`, digest(idle.config.endpoint) + '.lock'), { force: true }));
  await rejects(() => idle.ensure({ readinessMs: 100 }), 'READINESS_TIMEOUT');
});

test('启动结果未知保留自身锁，之后的自动ensure不重复启动', async t => {
  const f = await fixture(t), lock = join(tmpdir(), `km-agent-prepare-${process.getuid?.() ?? 'user'}`, digest(f.config.endpoint) + '.lock');
  t.after(() => rm(lock, { force: true }));
  await writeFile(f.config.launcher, `import{appendFile}from'node:fs/promises';await appendFile(${JSON.stringify(join(f.workspace, 'launches'))},'one\\n');`);
  await rejects(() => f.ensure({ readinessMs: 80 }), 'READINESS_TIMEOUT');
  await rejects(() => f.ensure({ readinessMs: 80, lockWaitMs: 80 }), 'LOCK_TIMEOUT');
  assert.equal(await readFile(join(f.workspace, 'launches'), 'utf8'), 'one\n');
});
test('运行清单不接受被正则隐式转型的instanceId', async t => {
  const f = await fixture(t); await serving(t, f, { manifest: { instanceId: 123 } });
  await rejects(() => f.ensure(), 'INVALID_RUNTIME');
});
test('health实例标识类型严格', async t => {
  const healthFixture = await fixture(t); await serving(t, healthFixture, { patch: { instanceId: 123 } });
  await rejects(() => healthFixture.ensure(), 'UNSUPPORTED_SERVICE');
});
for (const patch of [{ sha256: ['0'.repeat(64)] }, { version: '1.2.3-01' }]) {
  test(`release摘要类型/semver严格：${Object.keys(patch)[0]}`, async t => {
    const f = await fixture(t, { installed: false }); bundle(f); Object.assign(f.config.release, patch); await f.save();
    await rejects(() => f.ensure({ fetcher: () => assert.fail('无效配置不应联网') }), 'INVALID_CONFIG');
  });
}
test('合法semver预发布与包含连字符的build metadata不误拒绝', async t => {
  const f = await fixture(t); await serving(t, f); bundle(f);
  for (const version of ['1.2.3-rc.1+build.01', '1.2.3+build-01']) {
    f.config.release.version = version; await f.save(); assert.equal((await f.ensure()).state, 'running');
  }
});
test('根CLI薄入口可用，技能prepare单文件复制后无仓库/SDK依赖可直接运行', async t => {
  const f = await fixture(t); await serving(t, f);
  const standalone = join(f.root, 'portable-prepare.mjs'); await copyFile(moduleUrl, standalone);
  for (const path of [fileURLToPath(new URL('../../prepare.mjs', import.meta.url)), standalone]) {
    const child = spawn(process.execPath, [path, '--config', f.configFile]); let stdout = '', stderr = '';
    child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
    const [code] = await once(child, 'exit'); assert.equal(code, 0, stderr); assert.equal(stderr, '');
    assert.equal(JSON.parse(stdout).data.state, 'running'); assert.ok(!stdout.includes(KEY));
  }
});
test('高并发等待者锁释放竞争不产生伪LOCAL_FAILURE或重复启动', async t => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const f = await fixture(t), results = await Promise.all(Array.from({ length: 24 }, () => f.ensure()));
    assert.equal(results.filter(result => result.started).length, 1);
    assert.equal((await readFile(join(f.workspace, 'launches'), 'utf8')).trim().split('\n').length, 1);
  }
});

test('bootstrap preserves explicit additional manual-pairing origins across restarts', async t => {
  const f = await fixture(t);
  f.config.launchArgs.push('--allow-origin', 'http://local.lt.com:8251'); await f.save();
  assert.deepEqual((await api.loadBootstrapConfig(f.configFile)).launchArgs, f.config.launchArgs);
  for (const origin of ['*', ORIGIN, 'http://local.lt.com:8251', 'http://remote.example']) {
    f.config.launchArgs.push('--allow-origin', origin); await f.save();
    await rejects(() => api.loadBootstrapConfig(f.configFile), 'INVALID_CONFIG');
    f.config.launchArgs.splice(-2);
  }
});

test('reject an old OpenCode bootstrap before reuse or launch', async t => {
  const f = await fixture(t);
  f.config.launchArgs[f.config.launchArgs.indexOf('--adapter') + 1] = 'opencode';
  await f.save();
  await assert.rejects(api.loadBootstrapConfig(f.configFile), {code: 'RETIRED_ADAPTER', message: /重新选择 Agent/});
});

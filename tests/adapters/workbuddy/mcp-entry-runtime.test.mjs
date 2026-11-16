import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const gateway = fileURLToPath(new URL('../../../skills/km-agent-bridge/scripts/mcp-entry.mjs', import.meta.url));
const ORIGIN = 'http://127.0.0.1:4173';
async function fixture(t, { linger = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'km-gateway-test-')), privateDir = join(root, 'private');
  await mkdir(privateDir, { mode: 0o700 }); const runtimeFile = join(privateDir, 'runtime.json'), mcpEntry = join(root, 'fake-sdk.mjs');
  const server = createServer((req, res) => { res.end(JSON.stringify({ ok: true, data: { service: 'kuaimai-agent-connector', interactionProtocol: 'km-agent/1', instanceId: 'gateway-fixture' } })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await writeFile(runtimeFile, JSON.stringify({ instanceId: 'gateway-fixture', endpoint, protocol: 'km-agent/1', key: 'fixture-private-publisher-key-123', bindings: [] }), { mode: 0o600 });
  await writeFile(mcpEntry, `import{readFile,stat,writeFile}from'node:fs/promises';const path=process.argv[3],cfg=JSON.parse(await readFile(path,'utf8'));await writeFile(${JSON.stringify(join(root, 'effective-seen.json'))},JSON.stringify({cfg,path,mode:(await stat(path)).mode&0o777,pid:process.pid}));console.log(JSON.stringify({jsonrpc:'2.0',id:1,result:{ok:true}}));${linger ? "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);" : ''}`);
  const bootstrapFile = join(privateDir, 'bootstrap.json'), configFile = join(privateDir, 'gateway.json');
  await writeFile(bootstrapFile, JSON.stringify({ version: 1, endpoint, origin: ORIGIN, launcher: join(root, 'unused-start.mjs'), runtimeFile, mcpEntry, launchArgs: ['--adapter', 'generic', '--trust-origin', ORIGIN, '--port', new URL(endpoint).port, '--workspace', root] }));
  const config = { version: 1, bootstrapFile, origin: ORIGIN, workspaceRoot: root };
  const save = () => writeFile(configFile, JSON.stringify(config)); await save();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, privateDir, runtimeFile, endpoint, configFile, config, save };
}
function run(f, executable = gateway) {
  const child = spawn(process.execPath, [executable, '--config', f.configFile], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  return { child, done: once(child, 'exit'), output: () => ({ stdout, stderr }) };
}
test('gateway仅SDK协议stdout；私有effective SDK合同携带准备钩子且退出删除，不停连接器', async t => {
  const f = await fixture(t), running = run(f), [code] = await running.done;
  assert.equal(code, 0, running.output().stderr);
  assert.equal(running.output().stdout.trim(), JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }));
  assert.equal(running.output().stderr, '');
  const seen = JSON.parse(await readFile(join(f.root, 'effective-seen.json'), 'utf8'));
  assert.deepEqual(seen.cfg, { version: 1, runtimeFile: f.runtimeFile, origin: ORIGIN, workspaceRoot: await realpath(f.root),bootstrapFile:f.config.bootstrapFile,prepareEntry:fileURLToPath(new URL('../../../skills/km-agent-bridge/scripts/prepare.mjs',import.meta.url)) });
  assert.equal(seen.mode, 0o600); assert.ok(seen.path.startsWith(await realpath(f.privateDir) + '/'));
  await assert.rejects(readFile(seen.path), { code: 'ENOENT' });
  assert.equal((await fetch(f.endpoint + '/v1/health')).status, 200);
});
test('gateway终止仅自身SDK child，清理临时连接文件，保留connector', async t => {
  const f = await fixture(t, { linger: true }), running = run(f);
  const chunk = await Promise.race([once(running.child.stdout, 'data').then(([value]) => String(value)), running.done.then(() => '')]);
  assert.match(chunk, /jsonrpc/, running.output().stderr);
  const seen = JSON.parse(await readFile(join(f.root, 'effective-seen.json'), 'utf8'));
  running.child.kill('SIGTERM'); await running.done;
  await assert.rejects(readFile(seen.path), { code: 'ENOENT' });
  assert.throws(() => process.kill(seen.pid, 0), { code: 'ESRCH' });
  assert.equal((await fetch(f.endpoint + '/v1/health')).status, 200);
});
test('gateway拒绝origin不匹配和未知字段，stderr不暴露配置或密钥、stdout为空', async t => {
  for (const mutate of [c => c.origin = 'http://127.0.0.1:8888', c => c.secret = 'do-not-leak-this']) {
    const f = await fixture(t); mutate(f.config); await f.save(); const running = run(f), [code] = await running.done;
    assert.equal(code, 1); assert.equal(running.output().stdout, '');
    assert.match(running.output().stderr, /^KM_GATEWAY: [A-Z_]+\n$/);
    assert.ok(!running.output().stderr.includes('do-not-leak-this'));
    assert.deepEqual((await readdir(f.privateDir)).sort(), ['bootstrap.json', 'gateway.json', 'runtime.json']);
  }
});
test('gateway workspaceRoot/workspaceId必须严格二选一，空字段不能被静默丢弃', async t => {
  const f = await fixture(t); f.config.workspaceRoot = ''; f.config.workspaceId = 'workspace-id'; await f.save();
  const running = run(f), [code] = await running.done;
  assert.equal(code, 1); assert.equal(running.output().stdout, ''); assert.equal(running.output().stderr, 'KM_GATEWAY: INVALID_CONFIG\n');
});
test('仅复制两份技能脚本的gateway仍独立运行，workspaceId兼容现有SDK合同', async t => {
  const f = await fixture(t), portable = join(f.root, 'portable-skill', 'scripts'); await mkdir(portable, { recursive: true });
  await copyFile(gateway, join(portable, 'mcp-entry.mjs'));
  await copyFile(new URL('../../../skills/km-agent-bridge/scripts/prepare.mjs', import.meta.url), join(portable, 'prepare.mjs'));
  delete f.config.workspaceRoot; f.config.workspaceId = 'explicit-workspace-id'; await f.save();
  const running = run(f, join(portable, 'mcp-entry.mjs')), [code] = await running.done;
  assert.equal(code, 0, running.output().stderr); assert.equal(running.output().stderr, '');
  const seen = JSON.parse(await readFile(join(f.root, 'effective-seen.json'), 'utf8'));
  assert.deepEqual(seen.cfg, { version: 1, runtimeFile: f.runtimeFile, origin: ORIGIN, workspaceId: 'explicit-workspace-id',bootstrapFile:f.config.bootstrapFile,prepareEntry:await realpath(join(portable,'prepare.mjs')) });
});

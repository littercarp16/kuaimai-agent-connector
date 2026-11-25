import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createControlServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION, ensureService, control, connectService, decodeRequest, manageService, privateDirectory, runService } from '../../src/headless/service.mjs';
import { challengeFor, createConnectGrants } from '../../src/desktop/connect-grants.mjs';
const random = () => randomBytes(32).toString('base64url');
const origin = 'http://local.lt.com:8251';
function request(websiteOrigin = origin, transport, created = Date.now()) {
  const verifier = random(), state = random();
  const url = 'km-agent://connect?' + new URLSearchParams({ origin: websiteOrigin, callback: websiteOrigin + '/agent/connect-callback.html', state, challenge: challengeFor(verifier), browser: 'chrome', ...(transport && { transport }) });
  return { verifier, state, encoded: Buffer.from(JSON.stringify({ url, created })).toString('base64url') };
}
test('代码连接请求过期/来源/回调检查与私有目录链接拒绝', async t => {
  const created = Date.now(), r = request(origin, 'direct', created);
  const tenHours = 10 * 60 * 60 * 1000;
  assert.equal(decodeRequest(r.encoded, created + tenHours - 1).origin, origin);
  assert.throws(() => decodeRequest(r.encoded, created + tenHours), /连接请求已过期/);
  const modified = JSON.parse(Buffer.from(r.encoded,'base64url')); modified.url += '&command=rm';
  assert.throws(() => decodeRequest(Buffer.from(JSON.stringify(modified)).toString('base64url')));
  const root = await mkdtemp(join(tmpdir(),'km-code-path-')); t.after(() => rm(root,{recursive:true,force:true}));
  await symlink(root,join(root,'link')); await assert.rejects(privateDirectory(join(root,'link','child')));
});
test('纯代码后台启动、端口冲突、复用、来源隔离和关闭',{timeout:30000},async t => {
  const directory = await mkdtemp('/private/tmp/km-code-'), blocker = createServer((req,res) => res.end('other'));
  blocker.listen(0,'127.0.0.1'); await once(blocker,'listening');
  t.after(async () => { await control(directory,{action:'stop'}).catch(()=>{}); blocker.close(); await delay(200); await rm(directory,{recursive:true,force:true}); });
  const options = { origin, directory, port: blocker.address().port };
  const first = await ensureService(options); assert.equal(first.loginStartup,false); assert.notEqual(Number(new URL(first.endpoint).port), options.port);
  assert.equal(first.logging.path,join(directory,'service.log'));assert.equal(first.logging.maxBytes,5*1024*1024);assert.equal(first.logging.backups,5);assert.equal(first.logging.writeFailures,0);
  await assert.rejects(runService(options));assert.equal((await control(directory,{action:'status'})).pid,first.pid,'失败的重复启动不能移除当前实例的控制 socket');
  const second = await ensureService(options); assert.equal(second.pid,first.pid); assert.equal(second.reused,true);
  const r = request(), connected = await connectService(r.encoded,options);
  assert.equal(connected.endpoint,first.endpoint); assert.equal(connected.reused,true);
  const data = Object.fromEntries(new URLSearchParams(new URL(connected.callbackURL).hash.slice(1)));
  const headers = { Origin:first.endpoint,'Content-Type':'application/json','X-Km-Agent':'1' };
  const exchange = await fetch(first.endpoint+'/v1/connect/exchange',{method:'POST',headers,body:JSON.stringify({...Object.fromEntries(['ticket','state'].map(k=>[k,data[k]])),verifier:r.verifier,websiteOrigin:origin})});
  const result = await exchange.json(); assert.equal(exchange.status,200); assert.ok(result.data.reconnectToken);
  assert.equal((await stat(join(directory,'control.sock'))).mode&0o777,0o600);
  assert.equal((await fetch(first.endpoint+'/v1/health',{headers:{Origin:origin,'X-Km-Agent':'1'}})).status,200);
  const resume = o => fetch(first.endpoint+'/v1/connect/resume',{method:'POST',headers,body:JSON.stringify({websiteOrigin:o,reconnectToken:result.data.reconnectToken})});
  assert.equal((await resume('https://evil.example')).status,403); assert.equal((await resume(origin)).status,200);
  assert.equal((await fetch(first.endpoint+'/v1/connect/resume',{method:'POST',headers:{...headers,Origin:origin},body:JSON.stringify({websiteOrigin:origin,reconnectToken:result.data.reconnectToken})})).status,403);
  await control(directory,{action:'stop'}); await delay(300); await assert.rejects(readFile(join(directory,'connector.json')),{code:'ENOENT'});
  const records=(await readFile(join(directory,'service.log'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some(r=>r.event==='service.started'&&r.instanceId===first.instanceId&&r.endpoint===first.endpoint));
  assert.ok(records.some(r=>r.event==='service.stopped'&&r.instanceId===first.instanceId));
  assert.ok(records.some(r=>r.event==='http.request'&&r.path==='/v1/health'&&r.statusCode===200&&r.durationMs>=0));
});
test('重连授权仅在当前实例和已授权来源内有效且会到期',()=>{
  let now=0;const grants=createConnectGrants({reconnect:true,now:()=>now}),r=request(),parsed=decodeRequest(r.encoded),endpoint='http://127.0.0.1:19234',instanceId='fixture';
  const ticket=new URLSearchParams(new URL(grants.issue(parsed,{endpoint,instanceId}).callbackURL).hash.slice(1)).get('ticket');
  const {reconnectToken}=grants.consume({ticket,state:parsed.state,verifier:r.verifier,websiteOrigin:origin,requestOrigin:endpoint,endpoint,instanceId});
  const resume={reconnectToken,websiteOrigin:origin,requestOrigin:endpoint,endpoint,instanceId};
  assert.equal(grants.resume(resume).websiteOrigin,origin);assert.throws(()=>grants.resume({...resume,instanceId:'other'}));now=8*3600e3;assert.throws(()=>grants.resume(resume));
});
test('并发连接 HTTP 与 HTTPS 只启动一个后台，各来源独立领取、恢复和停止', { timeout: 30000 }, async t => {
  const directory = await mkdtemp('/private/tmp/km-code-shared-');
  t.after(async () => { await control(directory, { action: 'stop' }).catch(() => {}); await delay(200); await rm(directory, { recursive: true, force: true }); });
  const online = 'https://app.ltpass.com';
  const localRequest = request(origin, 'direct', Date.now() - 9 * 60 * 60 * 1000), onlineRequest = request(online, 'direct');
  const activation = request(origin, 'direct');
  const [local, prod] = await Promise.all([localRequest, onlineRequest].map(link => connectService(link.encoded, { directory })));
  assert.equal(local.pid, prod.pid);
  assert.equal(local.endpoint, prod.endpoint);
  assert.equal(local.instanceId, prod.instanceId);
  assert.equal(local.version, VERSION);
  for (const site of [origin, online]) {
    const status = await manageService('status', { directory, origin: site });
    assert.equal(status.origin, site);
    assert.deepEqual(new Set(status.origins), new Set([origin, online]));
  }
  const call = (site, route, body, token) => fetch(local.endpoint + '/v1/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: site, 'X-Km-Agent': '1', 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const claim = (site, { state, verifier }) => call(site, 'connect/claim', { state, verifier, instanceId: local.instanceId });
  const resume = (site, { reconnectToken }) => call(site, 'connect/direct-resume', { reconnectToken, instanceId: local.instanceId });
  assert.equal((await call('https://unknown.example', 'connect/discover')).status, 403);
  assert.equal((await claim(online, localRequest)).status, 403);
  assert.equal((await claim(origin, onlineRequest)).status, 403);
  const localGrant = (await (await claim(origin, localRequest)).json()).data;
  const onlineGrant = (await (await claim(online, onlineRequest)).json()).data;
  assert.equal((await call(online, 'snapshot', undefined, localGrant.token)).status, 401);
  assert.equal((await resume(origin, onlineGrant)).status, 403);
  assert.deepEqual(await manageService('stop', { directory, origin }), { stopped: true, serviceStopped: false });
  assert.equal(await manageService('status', { directory, origin }), null);
  assert.equal((await call(origin, 'connect/discover')).status, 403);
  assert.equal((await call(online, 'snapshot', undefined, onlineGrant.token)).status, 200);
  assert.equal((await connectService(activation.encoded, { directory })).pid, local.pid);
  assert.equal((await resume(origin, localGrant)).status, 403);
  assert.equal((await call(origin, 'snapshot', undefined, localGrant.token)).status, 401);
  assert.equal((await claim(origin, activation)).status, 200);
  const granted = [];
  for (let i = 0; i < 11; i++) {
    const link = request(origin, 'direct');
    await connectService(link.encoded, { directory });
    const response = await claim(origin, link);
    assert.equal(response.status, 200);
    granted.push((await response.json()).data);
  }
  const waiting = request(origin, 'direct'), newOnline = request(online, 'direct');
  await connectService(waiting.encoded, { directory });
  assert.equal((await claim(origin, waiting)).status, 409);
  await connectService(newOnline.encoded, { directory });
  assert.equal((await claim(online, newOnline)).status, 200);
  assert.equal((await call(origin, 'disconnect', {}, granted[0].token)).status, 200);
  assert.equal((await claim(origin, waiting)).status, 200);
  assert.equal((await resume(online, onlineGrant)).status, 200);
  assert.deepEqual(await manageService('stop', { directory, origin }), { stopped: true, serviceStopped: false });
  assert.deepEqual(await manageService('stop', { directory, origin: online }), { stopped: true, serviceStopped: true });
});
test('当前 CLI 复用兼容的较新后台，拒绝不兼容协议并升级旧后台', { timeout: 15000 }, async t => {
  const directory = await mkdtemp('/private/tmp/km-code-version-'), socketPath = join(directory, 'control.sock');
  let status = { version: '999.0.0', controlProtocol: 1, state: 'running', pid: process.pid };
  const actions = [];
  const server = createControlServer({ allowHalfOpen: true }, socket => {
    let bytes = '';
    socket.on('data', chunk => { bytes += chunk; });
    socket.on('end', () => {
      const { action } = JSON.parse(bytes);
      actions.push(action);
      socket.end(JSON.stringify({ ok: true, data: status }), () => {
        if (action === 'stop') server.close();
      });
    });
  });
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600);
  t.after(async () => { await control(directory, { action: 'stop' }).catch(() => {}); await delay(200); await rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await ensureService({ origin, directory }), { ...status, reused: true });
  status = { ...status, controlProtocol: 2 };
  await assert.rejects(ensureService({ origin, directory }), /本机控制协议不兼容/);
  assert.deepEqual(actions, ['status', 'status']);
  status = { ...status, version: '0.0.0', controlProtocol: 1 };
  await assert.rejects(ensureService({ origin, directory, requireWorkBuddy: true }), /待现有任务结束后升级/);
  assert.deepEqual(actions.slice(2), ['status']);
  status.workBuddySessionSelection = true;
  await assert.rejects(ensureService({ origin, directory, requireWorkBuddy: true }), /尚不支持 WorkBuddy 网页读取审批/);
  status.workBuddyWebFetchApproval = true;
  assert.deepEqual(await ensureService({ origin, directory, requireWorkBuddy: true }), { ...status, reused: true });
  assert.deepEqual(actions.slice(2), ['status', 'status', 'status']);
  const upgraded = await ensureService({ origin, directory });
  assert.equal(upgraded.version, VERSION);
  assert.notEqual(upgraded.pid, status.pid);
  assert.equal(upgraded.reused, false);
  assert.deepEqual(actions.slice(5), ['status', 'status', 'stop']);
});

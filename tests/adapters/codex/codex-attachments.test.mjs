import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, SESSION, THREAD, turn, agent, until } from '../../fixtures/codex-fixture.mjs';
import { createConnector } from '../../../src/http/server.mjs';
import { createNativeRegistry } from '../../../src/adapters/native-registry.mjs';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PDF_MINI = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n', 'ascii');

test('Codex 附件能力按协议探测动态开启，支持图片/文本/PDF 上传并干净回显文件标签', async t => {
  const f = await fixture(t, { attachments: true, pageContext: true });
  await f.bind();
  assert.equal(f.adapter.capabilities.attachments, true);
  assert.equal(f.adapter.capabilities.workspaceFiles, true);

  const uploads = [
    { name: 'mockup.png', mime: 'image/png', base64: PNG_1X1.toString('base64') },
    { name: 'orders.csv', mime: 'text/plain', base64: Buffer.from('orderId,amount\n1001,88\n').toString('base64') },
    { name: 'spec.pdf', mime: 'application/pdf', base64: PDF_MINI.toString('base64') },
  ];
  const receipt = await f.adapter.sendShared(SESSION, '按原型图和订单表搭建页面', { requestId: 'upload-1', uploads });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(receipt.payload.files, [
    { name: 'mockup.png', mime: 'image/png' },
    { name: 'orders.csv', mime: 'text/plain' },
    { name: 'spec.pdf', mime: 'application/pdf' },
  ]);

  const call = f.calls.find(c => c.method === 'turn/start');
  assert.equal(call.params.input[0].type, 'text');
  assert.equal(call.params.input[0].text, '按原型图和订单表搭建页面');
  assert.equal(call.params.input[1].type, 'localImage');
  assert.ok(call.params.input[1].path.startsWith(f.uploadDir));
  assert.deepEqual(await readFile(call.params.input[1].path), PNG_1X1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.uploadDir)).mode & 0o777, 0o700);
    assert.equal((await stat(call.params.input[1].path)).mode & 0o777, 0o600);
  }
  assert.equal(call.params.input[2].type, 'text');
  assert.match(call.params.input[2].text, /orders\.csv/);
  assert.match(call.params.input[2].text, /1001,88/);
  assert.equal(call.params.input[3].type, 'text');
  assert.match(call.params.input[3].text, /spec\.pdf/);

  const snap = await f.adapter.readShared(SESSION);
  const msg = snap.messages.find(m => m.role === 'user');
  assert.equal(msg.text, '按原型图和订单表搭建页面');
  assert.doesNotMatch(msg.text, /1001,88/);
  assert.deepEqual(msg.files, [
    { name: 'mockup.png', mime: 'image/png' },
    { name: 'orders.csv', mime: 'text/plain' },
    { name: 'spec.pdf', mime: 'application/pdf' },
  ]);
});

test('Codex 附件签名防篡改，明确 NOT_SUBMITTED 失败会清理暂存文件', async t => {
  const f = await fixture(t, { attachments: true });
  await f.bind();
  const upload = { name: 'a.png', mime: 'image/png', base64: PNG_1X1.toString('base64') };
  let stagedPath = null;
  f.handlers.set('turn/start', params => {
    stagedPath = params.input[1].path;
    throw Object.assign(Error('pre-wire reject'), { code: 'NOT_SUBMITTED' });
  });
  await assert.rejects(
    f.adapter.sendShared(SESSION, '带图失败', { requestId: 'cleanup-1', uploads: [upload] }),
    { code: 'NOT_SUBMITTED' },
  );
  assert.ok(stagedPath);
  await assert.rejects(access(stagedPath));

  f.handlers.delete('turn/start');
  await f.adapter.sendShared(SESSION, '带图成功', { requestId: 'idem-1', uploads: [upload] });
  await assert.rejects(
    f.adapter.sendShared(SESSION, '带图成功', { requestId: 'idem-1', uploads: [{ ...upload, name: 'b.png' }] }),
    { code: 'NOT_SUBMITTED' },
  );
});

test('Codex 工作区 @ 文件搜索与引用严格过滤隐藏/密钥/符号链接并支持工作区图片', async t => {
  const f = await fixture(t, { attachments: true });
  await mkdir(path.join(f.directory, 'src/views'), { recursive: true });
  await mkdir(path.join(f.directory, 'node_modules/pkg'), { recursive: true });
  await mkdir(path.join(f.directory, '.git'), { recursive: true });
  await mkdir(path.join(f.directory, '.agents/skills/demo'), { recursive: true });
  await writeFile(path.join(f.directory, 'src/views/dashboard.vue'), '<template>dashboard</template>');
  await writeFile(path.join(f.directory, 'dashboard-notes.md'), '# Notes');
  await writeFile(path.join(f.directory, 'src/logo.png'), PNG_1X1);
  await writeFile(path.join(f.directory, '.env'), 'SECRET=1');
  await writeFile(path.join(f.directory, 'credentials.json'), '{"secret":true}');
  await writeFile(path.join(f.directory, 'node_modules/pkg/index.js'), 'module.exports={}');
  await writeFile(path.join(f.directory, '.git/config'), '[core]');
  await writeFile(path.join(f.directory, '.agents/skills/demo/SKILL.md'), 'private skill');
  await symlink('/etc/hosts', path.join(f.directory, 'hosts.txt'));

  await f.bind();
  const all = await f.adapter.searchWorkspaceFiles(SESSION, '');
  const paths = all.map(x => x.path);
  assert.ok(paths.includes('src/views/dashboard.vue'));
  assert.ok(paths.includes('dashboard-notes.md'));
  assert.ok(paths.includes('src/logo.png'));
  for (const blocked of ['.env', 'credentials.json', 'node_modules/pkg/index.js', '.git/config', '.agents/skills/demo/SKILL.md', 'hosts.txt']) {
    assert.ok(!paths.includes(blocked), `should not expose ${blocked}`);
  }

  const filtered = await f.adapter.searchWorkspaceFiles(SESSION, 'dash');
  assert.equal(filtered[0].path, 'dashboard-notes.md');
  assert.equal(filtered[1].path, 'src/views/dashboard.vue');

  const receipt = await f.adapter.sendShared(SESSION, '参考这两个文件', {
    requestId: 'ref-1',
    references: ['src/views/dashboard.vue', 'src/logo.png'],
  });
  assert.equal(receipt.accepted, true);
  const call = f.calls.find(c => c.method === 'turn/start');
  assert.equal(call.params.input[1].type, 'text');
  assert.match(call.params.input[1].text, /src\/views\/dashboard\.vue/);
  assert.match(call.params.input[1].text, /<template>dashboard<\/template>/);
  assert.equal(call.params.input[2].type, 'localImage');
  assert.equal(call.params.input[2].path, path.join(f.directory, 'src/logo.png'));

  const snap = await f.adapter.readShared(SESSION);
  const msg = snap.messages.find(m => m.role === 'user');
  assert.equal(msg.text, '参考这两个文件');
  assert.deepEqual(msg.files, [
    { name: 'src/views/dashboard.vue', mime: 'text/plain' },
    { name: 'src/logo.png', mime: 'image/png' },
  ]);

  for (const badRef of ['../outside.txt', '.env', 'hosts.txt', 'credentials.json']) {
    await assert.rejects(
      f.adapter.sendShared(SESSION, '非法引用', { requestId: 'bad-' + badRef, references: [badRef] }),
      { code: 'NOT_SUBMITTED' },
    );
  }
});

test('HTTP /v1/files/search 与 /v1/run 端到端打通 Codex 附件与工作区引用', async t => {
  const f = await fixture(t, { attachments: true, pageContext: true });
  await writeFile(path.join(f.directory, 'readme.md'), 'hello codex');
  const origin = 'http://127.0.0.1:4173';
  const registry = createNativeRegistry({
    primary: { descriptor: { id: 'generic', status: 'publish-only' }, health: async () => ({ ready: true }), listSessions: async () => [] },
    additional: [f.adapter],
  });
  const connector = createConnector({ adapter: registry, allowedOrigins: [origin], autoTrust: { origin }, enableMultiAgentFollow: true });
  connector.server.listen(0, '127.0.0.1');
  await once(connector.server, 'listening');
  t.after(async () => { await connector.close(); await registry.close(); });

  const base = `http://127.0.0.1:${connector.server.address().port}`;
  let token = '';
  const req = async (url, body) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'X-Km-Agent': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ...await res.json() };
  };

  token = (await req('/v1/handshake', {})).data.token;
  const sources = (await req('/v1/sources')).data.sources;
  const codexSource = sources.find(s => s.provider === 'codex');
  assert.equal(codexSource.capabilities.attachments, true);
  assert.equal(codexSource.capabilities.workspaceFiles, true);

  const bound = await req('/v1/bind', { sessionId: SESSION, allowControl: true });
  assert.equal(bound.status, 200);
  assert.equal(bound.data.capabilities.attachments, true);
  assert.equal(bound.data.capabilities.workspaceFiles, true);

  const searched = await req('/v1/files/search', { sessionId: SESSION, query: 'read' });
  assert.equal(searched.status, 200);
  assert.equal(searched.data[0].path, 'readme.md');

  const run = await req('/v1/run', {
    sessionId: SESSION,
    requestId: randomUUID(),
    text: '结合图片和文档生成页面',
    uploads: [{ name: 'ui.png', mime: 'image/png', base64: PNG_1X1.toString('base64') }],
    references: ['readme.md'],
  });
  assert.equal(run.status, 202);
  assert.equal(run.data.accepted, true);
});

test('大体积 imageGeneration 结果不会触发 byteLimit 断线，且可通过 /v1/media/image 按需读取', async t => {
  const f = await fixture(t, { attachments: true, maxBytes: 16 * 1024 });
  const bigPng = Buffer.concat([PNG_1X1, Buffer.alloc(30 * 1024, 0x41)]);
  const bigBase64 = bigPng.toString('base64');
  const igItem = {
    type: 'imageGeneration',
    id: 'img-gen-1',
    status: 'completed',
    revisedPrompt: '朝霞背景柯基犬',
    result: bigBase64,
    savedPath: '/Users/admin/.codex/generated_images/secret.png',
  };

  // 1) Live stream: large imageGeneration event must not disconnect the watcher
  f.turns.push(turn('turn-img', 'inProgress'));
  await f.bind();
  const { events, states } = await f.watch();
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-img', item: structuredClone(igItem) });
  f.emit('item/completed', { threadId: THREAD, turnId: 'turn-img', item: agent('a-final', '朝霞版已完成。') });
  f.emit('turn/completed', { threadId: THREAD, turn: turn('turn-img', 'completed') });
  await until(() => events.some(e => e.type === 'session.execution.succeeded'));
  assert.ok(!states.includes('disconnected'));
  assert.ok(!JSON.stringify(events).includes(bigBase64.slice(0, 40)), 'SSE 不应推送 base64 原文');

  // 2) History hydration & HTTP /v1/media/image
  f.turns[0] = turn('turn-img', 'completed', [structuredClone(igItem), agent('a-final', '朝霞版已完成。')]);
  const snap = await f.adapter.readShared(SESSION);
  assert.equal(snap.status, 'completed');
  assert.equal(snap.messages.at(-1).text, '朝霞版已完成。');
  assert.ok(snap.activities.some(a => a.id === 'tool:img-gen-1' && a.toolName === 'image_generation'));
  assert.ok(!JSON.stringify(snap).includes(bigBase64.slice(0, 40)));

  const origin = 'http://127.0.0.1:4173';
  const registry = createNativeRegistry({
    primary: { descriptor: { id: 'generic', status: 'publish-only' }, health: async () => ({ ready: true }), listSessions: async () => [] },
    additional: [f.adapter],
  });
  const connector = createConnector({ adapter: registry, allowedOrigins: [origin], autoTrust: { origin }, enableMultiAgentFollow: true });
  connector.server.listen(0, '127.0.0.1');
  await once(connector.server, 'listening');
  t.after(async () => { await connector.close(); await registry.close(); });

  const base = `http://127.0.0.1:${connector.server.address().port}`;
  let token = '';
  const req = async (url, body) => {
    const res = await fetch(base + url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'X-Km-Agent': '1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, ...await res.json() };
  };
  token = (await req('/v1/handshake', {})).data.token;
  assert.equal((await req('/v1/bind', { sessionId: SESSION, allowControl: true })).status, 200);
  const media = await req('/v1/media/image', { sessionId: SESSION, imageId: 'img-gen-1' });
  assert.equal(media.status, 200);
  assert.equal(media.data.mime, 'image/png');
  assert.equal(media.data.base64, bigBase64);
  const detail = await req('/v1/tool/detail', { sessionId: SESSION, toolId: 'img-gen-1' });
  assert.equal(detail.status, 200);
  assert.equal(detail.data.image.mime, 'image/png');
  assert.equal(detail.data.image.base64, bigBase64);
});

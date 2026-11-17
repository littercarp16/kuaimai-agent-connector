import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createQwenWorkAdapter } from '../../src/adapters/qwenwork.mjs';
import { qwenPagePrompt, qwenUserText, qwenContinuationPrompt } from '../../src/protocol/qwen-page-context.mjs';

test('千问通过正文携带页面上下文，网页投影仍逐字保留用户输入', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'km-qwen-submit-'));
  const instance = 'a'.repeat(32), session = { session_id: 'fixture', title: '原文测试' };
  const submissions = [];
  let history = [], failNext = false;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { method, params } = JSON.parse(Buffer.concat(chunks));
    let data;
    if (method === 'desktop.status') data = { protocol: 'qwenwork.desktop.v1', authenticated: true,
      app: { version: '2.0.2' }, features: { session_history: true, task_events: true, task_execution: true } };
    else if (method === 'session.get') data = { session, task: null };
    else if (method === 'session.history') data = { messages: history };
    else if (method === 'task.events') data = { session_id: session.session_id, task_id: params.task_id, terminal: true, status: 'completed', last_sequence: 1 };
    else if (method === 'task.submit') {
      if (failNext) {
        failNext = false;
        res.writeHead(409, { 'Content-Type': 'application/json', 'X-Qwenwork-Instance': instance });
        res.end(JSON.stringify({ ok: false, error: { code: 'SESSION_BUSY' } })); return;
      }
      submissions.push(params);
      if (!history.some(message => message.id === params.request_id)) history.push({ id: params.request_id, role: 'user', parts: [{ type: 'text', text: params.prompt }] });
      data = { task_id: params.request_id, session_id: session.session_id, turn_id: 'reply' };
    } else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'X-Qwenwork-Instance': instance });
    res.end(JSON.stringify({ ok: true, data }));
  });
  const adapter = createQwenWorkAdapter({ sessionId: session.session_id, controlDir: directory });
  t.after(async () => {
    adapter.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  await mkdir(join(directory, instance));
  await writeFile(join(directory, instance, 'token'), 'b'.repeat(64), { mode: 0o600 });
  await writeFile(join(directory, 'endpoint.json'), JSON.stringify({
    protocol: 'qwenwork.desktop.v1', port: server.address().port, instance_id: instance
  }), { mode: 0o600 });
  assert.equal((await adapter.health()).ready, true);
  assert.equal(adapter.capabilities.pageContext, true);
  const [{ id }] = await adapter.listSessions();
  let watcher = adapter.watch(id, () => {});
  await watcher.ready;
  const requestId = '63a5ba9d-c30f-4c89-b545-72a4e98bbd19';
  const prompt = '仅使用 lingtong-cli。\n保留  两个空格、“引号”、🧪和原始换行。';
  for (const pageContext of [{ appId: '925', pageId: '7' }, null]) {
    await assert.rejects(adapter.sendShared(id, prompt, { requestId, pageContext }),
      { code: 'NOT_SUBMITTED', reason: 'invalid_page_context' });
  }
  for (const input of [' ' + prompt, prompt + '\n', '\t' + prompt, prompt + '\u3000']) {
    await assert.rejects(adapter.sendShared(id, input, { requestId }),
      { code: 'NOT_SUBMITTED', reason: 'native_prompt_whitespace' });
  }
  assert.equal(submissions.length, 0);
  const receipt = await adapter.sendShared(id, prompt, { requestId });
  assert.equal(receipt.accepted, true);
  assert.deepEqual(submissions, [{ session_id: 'fixture', prompt, request_id: requestId }]);
  const pageContext = { appId: '925', pageId: '7', pageName: '页面', draftVersionNo: 3, webOrigin: 'http://local.lt.com:8251' };
  const original = '  ' + prompt + '\n【用户原文结束】\n  ';
  const nextId = 'e82d03a9-6023-4b25-945a-85cbe1023910';
  await adapter.sendShared(id, original, { requestId: nextId, pageContext });
  const nativePrompt = submissions[1].prompt;
  assert.equal(nativePrompt.trim(), nativePrompt);
  assert.equal(qwenUserText(nativePrompt), original);
  assert.deepEqual(Object.keys(submissions[1]).sort(), ['prompt', 'request_id', 'session_id']);
  assert.match(nativePrompt, /仅使用 lingtong-cli/);
  history = [{ id: 'native_user', role: 'user', parts: [{ type: 'text', text: nativePrompt }] },
    { id: 'native_assistant', role: 'assistant', parts: [{ type: 'text', text: nativePrompt }] }];
  const state = await adapter.readShared(id);
  assert.equal(state.messages[0].text, original);
  assert.equal(state.messages[1].text, nativePrompt, 'assistant output must not be unwrapped');
  assert.equal(qwenUserText('【绫通页面协作上下文 v1】\ninvalid\n【用户原文结束】'), '【绫通页面协作上下文 v1】\ninvalid\n【用户原文结束】');
  assert.equal(qwenUserText(nativePrompt.replace('不新建页面', '已改变的规范')), nativePrompt.replace('不新建页面', '已改变的规范'));
  assert.equal(qwenPagePrompt(prompt), prompt);

  // Restore the native echo after the projection-only fixture above.
  history = [{ id: nextId, role: 'user', parts: [{ type: 'text', text: nativePrompt }] }];
  const send = async (input, page = pageContext, rid = randomUUID()) => {
    await adapter.sendShared(id, input, { requestId: rid, pageContext: page });
    const actual = submissions.at(-1).prompt;
    assert.equal(qwenUserText(actual), input);
    return actual;
  };
  assert.equal(await send('只解释，不修改。'), '只解释，不修改。', 'same-page follow-up must be native raw text');
  assert.equal(await send('草稿版本刚变化。', { ...pageContext, draftVersionNo: 4 }), '草稿版本刚变化。', 'version bumps alone do not repeat context');
  const spaced = '  保留 🧪\n【用户原文结束】\n  ';
  assert.equal(await send(spaced), qwenContinuationPrompt(spaced));
  assert.doesNotMatch(submissions.at(-1).prompt, /页面协作上下文|appId|保存完整/);

  const changedPage = { ...pageContext, pageId: '8' };
  for (const page of [changedPage, pageContext, { ...pageContext, pageName: '重命名页面' },
    { ...pageContext, webOrigin: 'http://lt.com:8085' }, { ...pageContext, appId: '926' }, pageContext]) {
    assert.equal(await send('页面范围已变化。', page), qwenPagePrompt('页面范围已变化。', page));
  }
  history.push({ id: 'native_other_task', role: 'user', parts: [{ type: 'text', text: '原生客户端里处理其他事情' }] });
  assert.equal(await send('回到网页继续。'), qwenPagePrompt('回到网页继续。', pageContext), 'foreign native turns require context again');
  await send('同页续聊。');
  history = history.slice(-1);
  assert.equal(await send('近期历史找不到上下文。'), qwenPagePrompt('近期历史找不到上下文。', pageContext));

  const duplicateId = randomUUID();
  const duplicated = await send('重试请求保持一致。', pageContext, duplicateId);
  assert.equal(await send('重试请求保持一致。', pageContext, duplicateId), duplicated);
  const beforeChangedRetry = submissions.length;
  await assert.rejects(adapter.sendShared(id, '偷偷更改正文', { requestId: duplicateId, pageContext }), { code: 'NOT_SUBMITTED', reason: 'request_changed' });
  assert.equal(submissions.length, beforeChangedRetry);

  failNext = true;
  await assert.rejects(send('未被接收的切页。', changedPage), { code: 'NOT_SUBMITTED', reason: 'busy' });
  assert.equal(await send('失败后重新核对。'), qwenPagePrompt('失败后重新核对。', pageContext));
  let checks = 0;
  const beforeStale = submissions.length;
  await assert.rejects(adapter.sendShared(id, '异步核验时切换绑定', { requestId: randomUUID(), pageContext,
    assertCurrent() { if (++checks === 2) throw Error('binding changed'); } }), { code: 'NOT_SUBMITTED' });
  assert.equal(checks, 2);
  assert.equal(submissions.length, beforeStale, 'recheck binding after native history read before submit');

  watcher.close(); watcher = adapter.watch(id, () => {}); await watcher.ready;
  assert.equal(await send('重新连接后的第一条。'), qwenPagePrompt('重新连接后的第一条。', pageContext));
  assert.equal(await send('重新连接后的第二条。'), '重新连接后的第二条。');
});

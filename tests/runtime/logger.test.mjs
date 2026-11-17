import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, stat, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileLogger } from '../../src/runtime/logger.mjs';

async function fixture(t) { const directory = await mkdtemp('/private/tmp/km-log-'); t.after(() => rm(directory, { recursive: true, force: true })); return { directory, path: join(directory, 'service.log') }; }
test('JSON 日志按大小轮转、限制份数、保留时间顺序与私有权限', async t => {
  const { directory, path } = await fixture(t), logger = createFileLogger({ path, maxBytes: 1024, backups: 2 });
  t.after(() => logger.close());
  for (let i = 0; i < 80; i++) assert.equal(logger.info('test.record', { exitCode: i }), true);
  logger.close();
  assert.deepEqual((await readdir(directory)).sort(), ['service.log','service.log.1','service.log.2']);
  const values = [];
  for (const name of ['service.log.2','service.log.1','service.log']) {
    const info = await stat(join(directory, name)); assert.ok(info.size <= 1024); assert.equal(info.mode & 0o777, 0o600);
    const rows = (await readFile(join(directory, name), 'utf8')).trim().split('\n').map(JSON.parse);
    for (const row of rows) { assert.ok(Number.isFinite(Date.parse(row.time))); assert.equal(row.level, 'info'); values.push(row.exitCode); }
  }
  assert.equal(values.at(-1), 79); assert.deepEqual(values, [...values].sort((a,b) => a-b));
});
test('日志字段白名单不会保存正文、令牌或原始异常消息', async t => {
  const { path } = await fixture(t), logger = createFileLogger({ path }); t.after(() => logger.close());
  const error = Object.assign(Error('private-prompt Bearer secret-token https://example.test/?token=secret-value'), { code: 'ECONNREFUSED' });
  logger.error('http.failed', { error, text: 'private-prompt', headers: { Authorization: 'secret-token' }, body: 'private-body', response: 'private-reply', token: 'secret-token', origin: 'https://example.test/?token=secret-value' });
  const text = await readFile(path, 'utf8'), value = JSON.parse(text);
  assert.equal(value.errorCode, 'ECONNREFUSED'); assert.equal(value.errorType, 'Error');
  assert.doesNotMatch(text, /private-prompt|secret-token|secret-value|private-body|private-reply/);
});
test('拒绝日志软链接和硬链接；轮转失败不会抛出或覆盖链接目标', async t => {
  const { directory, path } = await fixture(t), outside = join(directory, 'untouched'); await writeFile(outside, 'keep');
  await symlink(outside, path); assert.throws(() => createFileLogger({ path })); await rm(path);
  await link(outside, path); assert.throws(() => createFileLogger({ path })); await rm(path);
  let failures = 0; const logger = createFileLogger({ path, maxBytes: 1024, backups: 1, onError: () => { failures++; } });t.after(() => logger.close());
  await symlink(outside, path + '.1');
  for (let i=0;i<30;i++) assert.doesNotThrow(() => logger.info('test.record', { exitCode: i }));
  assert.equal(failures, 1); assert.equal(await readFile(outside, 'utf8'), 'keep'); assert.ok((await stat(path)).size <= 1024);
  assert.ok(logger.status().writeFailures>0);assert.equal(logger.status().lastError.errorCode,'EPERM');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createProductAdapters} from '../../src/adapters/product-adapters.mjs';
import {parseLaunchOptions} from '../../src/runtime/launch-options.mjs';

const native = id => ({descriptor: {id, status: 'native'}, health: async () => ({ready: true}), listSessions: async () => []});

test('产品注册三个原生来源，旧会话无法路由到其他 Agent', async () => {
  const workBuddy = native('workbuddy');
  const registry = createProductAdapters({
    workspace: '/project', codexWorkspace: '/codex', qwenEnabled: true, workBuddyServe: workBuddy,
  }, {codex: options => { assert.equal(options.directory, '/codex'); return native('codex'); }});
  assert.equal(registry.descriptor.id, 'generic');
  assert.equal(registry.forProvider('opencode'), undefined);
  const suffix = '0'.repeat(32);
  for (const [prefix, provider] of [['codex', 'codex'], ['qwen', 'qwen'], ['wb_native', 'workbuddy']]) {
    assert.equal(registry.forSession('ses_' + prefix + '_' + suffix).descriptor.id, provider);
  }
  await assert.rejects(registry.bindSession('ses_old'), /不支持共享绑定/);
  await registry.close();
});

test('默认启动 generic，显式指定退役适配器会直接报错', async () => {
  assert.equal(parseLaunchOptions([]).adapter, 'generic');
  assert.throws(() => parseLaunchOptions(['--adapter', 'opencode']), /重新选择/);
  assert.throws(() => createProductAdapters({adapter: 'opencode'}), /不支持此适配器/);
  const registry = createProductAdapters({codexEnabled: false});
  assert.throws(() => registry.forSession('ses_codex_' + '0'.repeat(32)));
  await registry.close();
});

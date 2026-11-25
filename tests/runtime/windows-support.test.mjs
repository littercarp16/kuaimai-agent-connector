import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { pskServer, connectPsk } from '../../src/headless/windows-control.mjs';
import { control, startService, privateDirectory } from '../../src/headless/service.mjs';
import { createCodexDesktopRuntime, createCodexDesktopManager } from '../../src/runtime/codex-desktop.mjs';
import { stdioTransport } from '../../src/adapters/codex/windows-stdio.mjs';
import { copiedRequest } from '../../desktop/windows-test.mjs';

test('Windows control accepts only clients proving the per-instance key', { timeout: 8000 }, async t => {
  const key = randomBytes(32);
  let accepted = 0;
  const server = pskServer(key, socket => { accepted++; socket.end('ready'); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const connect = secret => connectPsk(server.address().port, secret);
  const wrong = connect(randomBytes(32));
  await once(wrong, 'error');
  assert.equal(accepted, 0);
  const client = connect(key);
  const [message] = await once(client, 'data');
  assert.equal(message.toString(), 'ready');
  client.destroy();
  assert.equal(accepted, 1);
});

test('Windows Codex stdio preserves UTF-8 and splits multiple RPC frames', { timeout: 5000 }, async t => {
  const script = `
    process.stdin.once('data', request => {
      const bytes = Buffer.from('{"title":"中文"}\\n' + request);
      process.stdout.write(bytes.subarray(0, 12));
      setTimeout(() => process.stdout.end(bytes.subarray(12)), 20);
    });`;
  const channel = stdioTransport(process.execPath, ['-e', script], 1024);
  t.after(() => channel.terminate());
  const seen = [];
  channel.on('message', data => seen.push(JSON.parse(data.toString())));
  await once(channel, 'open');
  channel.send('{"id":2}', () => channel.close());
  await once(channel, 'close');
  assert.deepEqual(seen, [{ title: '中文' }, { id: 2 }]);
});

test('Windows Codex preparation reports readiness and never needs a desktop restart', async () => {
  const runtime = createCodexDesktopRuntime({ platform: 'win32', discover: async () => ({ ready: true }) });
  const manager = createCodexDesktopManager({ runtime });
  manager.restart({ requestId: randomUUID(), assertCanRestart: () => assert.fail() });
  for (let i = 0; i < 50 && manager.status().operation.state === 'running'; i++) await delay(5);
  assert.equal(manager.status().operation.transportAfter, 'stdio');
  assert.equal(manager.status().operation.state, 'completed');
  assert.equal(manager.status().operation.action, 'reuse');
  await manager.close();
});

test('test-kit reads only the request argument and requires one direct grant', () => {
  const origin = 'https://example.test';
  const url = new URL('km-agent://connect');
  url.search = new URLSearchParams({ origin, callback: origin + '/agent/connect-callback.html',
    state: 's'.repeat(43), challenge: 'c'.repeat(43), transport: 'direct', provider: 'codex', browser: 'default' });
  const encoded = Buffer.from(JSON.stringify({ url: url.href, created: Date.now() })).toString('base64url');
  const text = "运行以下命令\nnpx --yes kuaimai-agent-connector@0.8.0 connect --request '" + encoded + "'\n返回原标签页";
  const parsed = copiedRequest(text);
  assert.equal(parsed.encoded, encoded);
  assert.equal(parsed.request.origin, origin);
  assert.throws(() => copiedRequest(text + '\n' + text));
  assert.throws(() => copiedRequest("echo connected"));
});

test('Windows NTFS instance starts, reuses one process and stops over authenticated control',
  { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const directory = await privateDirectory(join(homedir(), '.kuaimai-agent', 'windows-test', 'check-' + randomUUID()));
    const origin = 'https://example.test';
    t.after(async () => {
      await control(directory, { action: 'stop' }).catch(() => {});
      await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 200 });
    });
    const first = await startService({ directory, origin });
    const second = await startService({ directory, origin });
    assert.equal(second.reused, true);
    assert.equal(second.pid, first.pid);
    assert.equal((await control(directory, { action: 'stop' })).serviceStopped, true);
    for (let i = 0; i < 100; i++) {
      try { process.kill(first.pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
      await delay(100);
    }
    assert.fail('test instance still running');
  });

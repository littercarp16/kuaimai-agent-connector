import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createCodexDesktopRuntime } from '../../src/runtime/codex-desktop.mjs';

test('desktop launch URL performs a real WebSocket upgrade over Unix, before any OS action', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-ws-'));
  const socketPath = join(root, 'daemon.sock');
  const server = createServer(), wss = new WebSocketServer({ noServer: true });
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    wss.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let upgraded = false, launched = false;
  server.on('upgrade', (req, socket, head) => {
    assert.equal(req.url, '/rpc'); assert.equal(req.headers.host, 'localhost');
    wss.handleUpgrade(req, socket, head, ws => {
      upgraded = true; wss.emit('connection', ws, req);
    });
  });
  server.listen(socketPath); await once(server, 'listening');
  const runtime = createCodexDesktopRuntime({
    env: { CODEX_APP_SERVER_WS_URL: 'ws://untrusted.invalid/', CODEX_HOME: '/test/home' },
    discover: async () => ({ ready: true, version: '0.169.0', socketPath }),
    run: async (file, args) => {
      assert.equal(file, '/usr/bin/open'); assert.ok(upgraded);
      assert.ok(args.includes(`CODEX_APP_SERVER_WS_URL=ws+unix://localhost${socketPath}:/rpc`));
      assert.ok(!args.some(a => a.includes('untrusted.invalid'))); launched = true;
      return { stdout: '' };
    },
  });
  await runtime.ensureDaemon(); assert.ok(upgraded); assert.equal(launched, false);
  await runtime.open(); assert.ok(launched);
});

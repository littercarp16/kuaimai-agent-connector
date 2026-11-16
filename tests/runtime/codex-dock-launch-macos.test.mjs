import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createCodexDockManager } from '../../src/runtime/codex-desktop-dock.mjs';

// Read-only with respect to the installed Dock setup and the real ChatGPT process.
// The isolated Cocoa app has no window/Dock icon and receives no explicit --env.
test('ordinary LaunchServices startup inherits Dock settings and reaches the shared App Server', {
  skip: process.platform !== 'darwin' || process.env.KM_DESKTOP_DOCK_TEST !== '1', timeout: 30000,
}, async t => {
  const status = await createCodexDockManager().status();
  assert.equal(status.enabled, true, 'enable the user Dock setup before opting in');
  const exec = promisify(execFile), root = await mkdtemp('/private/tmp/km-dock-launch-');
  const app = root + '/DockFixture.app', binary = app + '/Contents/MacOS/DockFixture';
  const output = root + '/environment.json'; let pid;
  t.after(async () => {
    if (pid) {
      const result = await exec('/bin/ps', ['-p', String(pid), '-o', 'comm=']).catch(() => ({ stdout: '' }));
      if (result.stdout.trim() === binary) process.kill(pid, 'SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(app + '/Contents/MacOS', { recursive: true });
  await writeFile(app + '/Contents/Info.plist', `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>local.agentconnector.dockfixture.${root.split('-').at(-1)}</string>
    <key>CFBundleExecutable</key><string>DockFixture</string><key>CFBundlePackageType</key><string>APPL</string>
    <key>LSUIElement</key><true/></dict></plist>`);
  await writeFile(root + '/fixture.m', `#import <Cocoa/Cocoa.h>
    #include <unistd.h>
    int main(void) { @autoreleasepool {
      NSApplication *app = [NSApplication sharedApplication];
      [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
      NSDictionary *env = [[NSProcessInfo processInfo] environment];
      NSDictionary *record = @{ @"pid": @(getpid()), @"url": env[@"CODEX_APP_SERVER_WS_URL"] ?: @"",
        @"home": env[@"CODEX_HOME"] ?: @"", @"flag": env[@"CODEX_APP_SERVER_USE_LOCAL_DAEMON"] ?: @"" };
      NSData *data = [NSJSONSerialization dataWithJSONObject:record options:0 error:nil];
      [data writeToFile:@${JSON.stringify(output)} atomically:YES];
      [app run]; return 0;
    }}
  `);
  await exec('/usr/bin/clang', ['-framework', 'Cocoa', root + '/fixture.m', '-o', binary], { timeout: 20000 });
  const clean = { ...process.env };
  for (const key of ['CODEX_APP_SERVER_WS_URL', 'CODEX_HOME', 'CODEX_APP_SERVER_USE_LOCAL_DAEMON']) delete clean[key];
  await exec('/usr/bin/open', ['-g', app], { env: clean, timeout: 5000 });
  const deadline = Date.now() + 5000; let record;
  while (!record && Date.now() < deadline) {
    record = await readFile(output, 'utf8').then(JSON.parse).catch(() => null);
    if (!record) await delay(25);
  }
  assert.ok(record, 'native app did not launch'); pid = record.pid;
  assert.equal(record.url, status.websocketUrl); assert.equal(record.flag, '1');
  assert.ok(record.home.startsWith('/'));
  const ws = new WebSocket(record.url, { handshakeTimeout: 5000, perMessageDeflate: false });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('initialize timeout')), 5000);
    ws.on('error', e => { clearTimeout(timer); reject(e); });
    ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'initialize', params: {
      clientInfo: { name: 'agent_connector_dock_probe', version: '0.1.0' }, capabilities: { experimentalApi: true },
    } })));
    ws.on('message', data => {
      const message = JSON.parse(data); if (message.id !== 1) return;
      clearTimeout(timer); if (message.error) reject(Error('initialize rejected')); else resolve();
    });
  });
  ws.close();
  t.diagnostic('No --env or parent Codex environment; native LaunchServices app inherited shared Unix socket URL and initialized successfully.');
});

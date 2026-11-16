import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createCodexDesktopRuntime } from '../../src/runtime/codex-desktop.mjs';

// Opt in on a logged-in macOS desktop. The fixture has no window, Dock icon or network access.
test('native LaunchServices relaunches an isolated app and preserves the shared-daemon environment', {
  skip: process.platform !== 'darwin' || process.env.KM_DESKTOP_NATIVE_TEST !== '1', timeout: 45000,
}, async t => {
  const exec = promisify(execFile), root = await mkdtemp('/private/tmp/km-native-relaunch-');
  const app = root + '/RelaunchFixture.app', binary = app + '/Contents/MacOS/RelaunchFixture', output = root + '/launches.txt';
  const launches = async () => { try { return (await readFile(output, 'utf8')).trim().split('\n').filter(Boolean).map(line => line.split('|')); } catch { return []; } };
  const alive = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };
  const until = async condition => { const deadline = Date.now() + 5000; while (!await condition()) { assert.ok(Date.now() < deadline, 'fixture did not reach its expected process state'); await delay(10); } };
  t.after(async () => {
    for (const [pid] of await launches()) if (alive(pid)) {
      const { stdout } = await exec('/bin/ps', ['-p', pid, '-o', 'comm=']);
      if (stdout.trim() === binary) process.kill(Number(pid), 'SIGTERM');
    }
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(app + '/Contents/MacOS', { recursive: true });
  await writeFile(app + '/Contents/Info.plist', `<?xml version="1.0"?><plist version="1.0"><dict>
    <key>CFBundleIdentifier</key><string>local.kuaimai.relaunch.${root.split('-').at(-1)}</string>
    <key>CFBundleExecutable</key><string>RelaunchFixture</string><key>CFBundlePackageType</key><string>APPL</string>
    <key>LSUIElement</key><true/></dict></plist>`);
  await writeFile(root + '/fixture.m', `#import <Cocoa/Cocoa.h>
    #include <unistd.h>
    int main(void) { @autoreleasepool {
      NSApplication *app = [NSApplication sharedApplication];
      [app setActivationPolicy:NSApplicationActivationPolicyProhibited];
      FILE *f = fopen(${JSON.stringify(output)}, "a");
      fprintf(f, "%d|%s|%s|%s\\n", getpid(), getenv("CODEX_APP_SERVER_USE_LOCAL_DAEMON") ?: "", getenv("CODEX_HOME") ?: "", getenv("CODEX_APP_SERVER_WS_URL") ?: "");
      fclose(f); [app run]; return 0;
    }}
  `);
  await exec('/usr/bin/clang', ['-framework', 'Cocoa', root + '/fixture.m', '-o', binary], { timeout: 20000 });
  const attempts = [], retries = [];
  const runtime = createCodexDesktopRuntime({ env: { CODEX_HOME: root + '/codex-home' },
    discover: async () => ({ ready: true, version: '0.169.0', socketPath: root + '/daemon.sock' }),
    probeSocket: async () => {},
    run: async (file, args, options) => {
      if (file === '/bin/ps') {
        const last = (await launches()).at(-1), running = last && alive(last[0]);
        return { stdout: running ? `${process.getuid()} ${last[0]} /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n` : '' };
      }
      assert.equal(file, '/usr/bin/open');
      const actual = args.map(value => value === '/Applications/ChatGPT.app' ? app : value);
      return exec(file, ['-g', ...actual], options);
    },
  });
  await runtime.ensureDaemon();
  for (let cycle = 0; cycle < 3; cycle++) {
    const prior = (await launches()).at(-1);
    if (prior) { process.kill(Number(prior[0]), 'SIGTERM'); await until(() => !alive(prior[0])); }
    await runtime.open({ onAttempt: attempt => attempts.push({ cycle, attempt }), onRetry: event => retries.push(event.code) });
    await until(async () => (await launches()).length === cycle + 1);
    const launched = (await launches()).at(-1);
    assert.equal(launched[1], '1'); assert.equal(launched[2], root + '/codex-home');
    assert.equal(launched[3], `ws+unix://localhost${root}/daemon.sock:/rpc`);
    assert.ok(alive(launched[0])); if (prior) assert.notEqual(launched[0], prior[0]);
  }
  assert.ok(attempts.length >= 3 && attempts.length <= 9); assert.ok(retries.every(code => code === -600));
  assert.equal((await launches()).length, 3, 'one process per launch, including retries');
  t.diagnostic(`native launch calls=${attempts.length}, recovered procNotFound errors=${retries.length}`);
});

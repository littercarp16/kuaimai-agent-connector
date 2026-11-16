import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { inspectCodexDesktopTransport } from '../../src/runtime/codex-desktop-transport.mjs';

const app = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT', cli = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const socketPath = '/private/tmp/codex-daemon-501/rpc';
const table = `501 10 1 ${app}\n501 20 1 /opt/codex\n501 30 10 ${cli}\n`;
const args = `20 /opt/codex app-server --listen unix:// --managed-daemon\n30 ${cli} -c features.code_mode_host=true app-server --analytics-default-enabled\n`;
const processFiles = (pid, files, uid = 501) => `p${pid}\0u${uid}\0\n` + files.map(([fd, address, name]) => `f${fd}\0tunix\0d${address}\0n${name}\0\n`).join('');
const sharedFiles = processFiles(10, [['9', '0xaa', '->0xbb']]) + processFiles(20, [['11', '0xcc', socketPath], ['32', '0xbb', socketPath]]);
const stdioFiles = processFiles(10, [['5', '0xa1', '->0xb1'], ['6', '0xa2', '->0xb2']])
  + processFiles(30, [['0', '0xb1', '->0xa1'], ['1', '0xb2', '->0xa2']]);
function inspect({ files = sharedFiles, processTable = table, argumentsText = args, daemon, fail = '', secondTable, secondDaemon } = {}) {
  let reads = 0, discoveries = 0;
  return inspectCodexDesktopTransport({ uid: 501,
    discover: async () => (++discoveries > 1 && secondDaemon) || daemon || { ready: true, socketPath, version: '0.169.0', instanceId: 'daemon-one' },
    run: async (file, argv, options) => {
      assert.equal(options.shell, false);
      if (file === fail) throw Error('private process inspection details');
      if (file.endsWith('lsof')) { assert.ok(argv.includes('-Fpuftdn0')); return { stdout: files }; }
      if (argv[0] === '-axo') return { stdout: ++reads > 1 && secondTable || processTable };
      return { stdout: argumentsText };
    },
  });
}
test('matches the desktop peer to the validated daemon socket, not a listening path alone', async () => {
  const result = await inspect(); assert.equal(result.mode, 'shared'); assert.deepEqual(result.daemon, { ready: true, version: '0.169.0' });
  assert.equal((await inspect({ files: processFiles(20, [['11', '0xcc', socketPath]]) })).mode, 'unknown');
  assert.equal((await inspect({ files: sharedFiles.replace('->0xbb', '->0xdd') })).mode, 'unknown');
  assert.equal((await inspect({ daemon: { ready: true, socketPath: '/different/socket' } })).mode, 'unknown');
});
test('a running daemon does not hide a private stdio app-server; stdin and stdout must connect to the desktop', async () => {
  assert.equal((await inspect({ files: stdioFiles })).mode, 'stdio');
  assert.equal((await inspect({ files: stdioFiles.replace('f1\0', 'f2\0') })).mode, 'unknown');
  assert.equal((await inspect({ files: stdioFiles, argumentsText: args.replace('app-server --analytics', 'exec-server --analytics') })).mode, 'unknown');
  assert.equal((await inspect({ files: stdioFiles, processTable: table.replace('30 10', '30 999') })).mode, 'unknown');
  assert.equal((await inspect({ files: stdioFiles, daemon: { ready: false } })).mode, 'stdio');
});
test('ambiguous transports, stale identities, unsupported inspection and other users remain unknown', async () => {
  for (const input of [
    { files: sharedFiles + stdioFiles }, { fail: '/usr/sbin/lsof' },
    { files: sharedFiles.replaceAll(socketPath, '/other/daemon.sock') + stdioFiles },
    { files: sharedFiles.replaceAll('u501', 'u502') }, { secondTable: table.replace('10 1', '10 2') },
    { secondDaemon: { ready: true, instanceId: 'replacement' } },
    { files: sharedFiles, argumentsText: args.replace('unix://', 'ws://localhost') },
  ]) assert.equal((await inspect(input)).mode, 'unknown');
  assert.equal((await inspect({ processTable: table.replace(app, '/Another.app/main') })).mode, 'not-running');
});

test('macOS lsof resolves a real established Unix connection between two test processes', { skip: process.platform !== 'darwin', timeout: 10000 }, async t => {
  const directory = await mkdtemp('/private/tmp/desktop-transport-'), path = directory + '/rpc.sock', connections = new Set();
  const server = createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  server.listen(path); await once(server, 'listening');
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    'import net from "node:net"; const socket=net.createConnection(process.argv[1],()=>process.send("connected")); process.on("disconnect",()=>{socket.destroy();process.exit(0);});', path],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { child.kill(); for (const socket of connections) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  await once(child, 'message');
  const uid = process.getuid(), exec = promisify(execFile);
  // Only executable labels are fixtures. Socket addresses and peers come from the real kernel.
  const result = await inspectCodexDesktopTransport({ uid,
    discover: async () => ({ ready: true, socketPath: path, version: '0.169.0', instanceId: 'fixture-socket' }),
    run: async (file, argv, options) => file.endsWith('lsof') ? exec(file, argv, options) : { stdout: argv[0] === '-axo'
      ? `${uid} ${child.pid} ${process.pid} ${app}\n${uid} ${process.pid} 1 /fixture/codex\n`
      : `${process.pid} /fixture/codex app-server --listen unix:// --managed-daemon\n` },
  });
  assert.equal(result.mode, 'shared'); assert.equal(result.desktopPid, child.pid);
});

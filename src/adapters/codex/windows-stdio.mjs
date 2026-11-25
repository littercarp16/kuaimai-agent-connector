import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { windowsPathAccess } from '../../runtime/windows.mjs';

const exec = promisify(execFile);
export async function windowsCodexIdentity(executable) {
  if (!path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'codex.exe') throw Error('需要 Codex 原生可执行文件');
  await windowsPathAccess(executable, { program: true, privateData: false });
  const file = await realpath(executable), info = await stat(file, { bigint: true });
  if (!info.isFile()) throw Error('无效的 Codex 程序');
  return { socketPath: file, instanceId: 'codex_stdio_' + createHash('sha256').update([file, info.dev, info.ino, info.size, info.mtimeNs].join(':')).digest('hex') };
}

let cached;
export async function discoverWindowsCodex() {
  if (cached && cached.until > Date.now()) return cached.result;
  const arch = process.arch, triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const candidates = [process.env.KM_AGENT_CODEX_EXE];
  for (const directory of (process.env.PATH || '').split(path.delimiter).filter(p => path.isAbsolute(p))) {
    candidates.push(path.join(directory, 'codex.exe'));
    const pkg = path.join(directory, 'node_modules', '@openai', 'codex');
    for (const base of [pkg, path.join(pkg, 'node_modules', '@openai', 'codex-win32-' + arch)]) {
      candidates.push(path.join(base, 'vendor', triple, 'codex', 'codex.exe'));
    }
  }
  let result = { ready: false, message: '未找到 Codex CLI，请设置 KM_AGENT_CODEX_EXE 或安装并登录 Codex CLI' };
  for (const file of candidates.filter(Boolean)) {
    if (!(await stat(file).catch(() => null))?.isFile()) continue;
    const identity = await windowsCodexIdentity(file);
    const output = await exec(identity.socketPath, ['--version'], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
    const version = /^codex-cli ([\w.+-]+)$/.exec(output.stdout.trim())?.[1];
    if (!version) continue;
    result = { ...identity, ready: true, version, schemaBinary: identity.socketPath };
    break;
  }
  cached = { until: Date.now() + 5000, result };
  return result;
}

// The Windows CLI exposes app-server JSON-RPC as newline-delimited UTF-8.
// Adapt framing only; request IDs, approvals, retries and budgets stay in codex-rpc.
export function stdioTransport(executable, args, maxBytes) {
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const transport = new EventEmitter();
  transport.readyState = WebSocket.CONNECTING;
  Object.defineProperty(transport, 'bufferedAmount', { get: () => child.stdin.writableLength });
  transport.send = (text, callback) => child.stdin.write(text + '\n', callback);
  transport.close = () => child.stdin.end();
  transport.terminate = () => { if (child.exitCode === null && !child.killed) child.kill(); };
  child.once('spawn', () => { transport.readyState = WebSocket.OPEN; transport.emit('open'); });
  child.on('error', error => transport.emit('error', error));
  child.stdin.on('error', error => transport.emit('error', error));
  child.once('close', () => { transport.readyState = WebSocket.CLOSED; transport.emit('close'); });
  let chunks = [], length = 0;
  child.stdout.on('data', chunk => {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start), part = chunk.subarray(start, end < 0 ? chunk.length : end);
      length += part.length;
      if (length > maxBytes) { transport.terminate(); return; }
      chunks.push(part);
      if (end < 0) return;
      transport.emit('message', Buffer.concat(chunks, length), false);
      chunks = []; length = 0; start = end + 1;
    }
  });
  return transport;
}

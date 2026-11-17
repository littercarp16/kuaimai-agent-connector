import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { connectQwenDesktop } from '../adapters/qwenwork.mjs';

const APP = '/Applications/QwenWorkCN.app';
const FLAG = 'QWENWORK_DESKTOP_CONTROL_ENABLED=1';
const exec = promisify(execFile);
export class QwenDesktopFailure extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = message => { throw new QwenDesktopFailure(409, message); };
export function createQwenDesktopRuntime({ run = exec, connect = connectQwenDesktop,
  platform = process.platform, uid = process.getuid?.() } = {}) {
  const command = (file, args, timeout = 10000) => run(file, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, shell: false });
  return {
    async check() {
      if (platform !== 'darwin') fail('自动准备千问目前仅支持 macOS');
      try { if (!(await stat(`${APP}/Contents/MacOS/QwenWorkCN`)).isFile()) throw Error(); }
      catch { fail('请先安装 /Applications/QwenWorkCN.app'); }
      let tail = '', supported = false;
      for await (const chunk of createReadStream(`${APP}/Contents/Resources/app.asar`)) {
        const value = tail + chunk.toString('latin1');
        if (value.includes('QWENWORK_DESKTOP_CONTROL_ENABLED')) { supported = true; break; }
        tail = value.slice(-64);
      }
      if (!supported) fail('此千问版本不支持已验证的本机 HTTP 启动方式');
    },
    async inspect() {
      try {
        const client = await connect();
        const status = await client.call('desktop.status');
        if (status.protocol !== 'qwenwork.desktop.v1' || !status.features?.session_history || !status.features?.task_events || !status.features?.task_execution)
          fail('千问本机 HTTP 接口版本或能力不兼容，请更新客户端');
        return { available: true, authenticated: status.authenticated === true, instanceId: client.instance, version: status.app?.version };
      } catch (error) {
        if (error instanceof QwenDesktopFailure) throw error;
        // Missing/stale endpoint and a stopped socket can be repaired by launch.
        // Permission, instance and protocol failures must not trigger a restart.
        if (error.code === 'ENOENT' || error.cause?.code === 'ECONNREFUSED' || error.name === 'TimeoutError') return { available: false };
        fail('千问本机接口校验失败，请检查接口文件权限或客户端状态');
      }
    },
    async isRunning() {
      const { stdout } = await command('/bin/ps', ['-axo', 'uid=,pid=,comm=']);
      return stdout.split('\n').some(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        return match && Number(match[1]) === uid && match[3] === `${APP}/Contents/MacOS/QwenWorkCN`;
      });
    },
    quit: () => command('/usr/bin/osascript', ['-e', `tell application "${APP}" to quit`], 15000),
    async open() {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await command('/usr/bin/open', ['-a', APP, '--env', FLAG]); return; }
        catch (error) { if (attempt === 2 || !/(?:error|Code)\s*[=:]?\s*-600\b/i.test(error.stderr || '')) throw error; await delay(500); }
      }
    },
  };
}

// One operation per bridge, shared by CLI bootstrap and authenticated web reuse.
// Checks run for every new request; a healthy desktop is never restarted.
export function createQwenDesktopManager({ runtime = createQwenDesktopRuntime(), now = Date.now,
  sleep = delay, quitWaitMs = 15000, readyWaitMs = 45000, pollMs = 500, cooldownMs = 30000 } = {}) {
  let operation = null, flight = null, closed = false, lastLaunch = -Infinity;
  const receipts = new Map();
  const snapshot = () => operation ? { ...operation } : { state: 'idle', phase: 'idle', message: '尚未检查千问办公' };
  const update = (phase, message, extra = {}) => Object.assign(operation, { phase, message, ...extra });
  async function prepare(assertAllowed) {
    let restoring = false;
    const allowed = () => { if (restoring) return; if (closed) fail('桥接服务已关闭'); assertAllowed(); };
    const ready = value => {
      update(value.authenticated ? 'ready' : 'login', value.authenticated ? '千问办公已就绪，可选择会话' : 'HTTP 接口已开启，请在千问办公中登录后重新检测',
        { state: 'completed', httpReady: true, authenticated: value.authenticated, nativeInstanceId: value.instanceId });
    };
    try {
      allowed(); await runtime.check(); allowed();
      let value = await runtime.inspect();
      if (value.available) { update('checking', '复用千问本机接口', { action: 'reuse' }); ready(value); return; }
      if (now() - lastLaunch < cooldownMs) fail('千问刚完成启动，请稍后重新检测，避免连续重启');
      // Recheck immediately before a disruptive action in case another process enabled HTTP.
      value = await runtime.inspect(); allowed();
      if (value.available) { update('checking', '复用千问本机接口', { action: 'reuse' }); ready(value); return; }
      const running = await runtime.isRunning(); allowed();
      update(running ? 'quitting' : 'starting', running ? '正在退出千问，以启用本机 HTTP 接口…' : '正在启动千问并启用本机 HTTP 接口…', { action: running ? 'restart' : 'start' });
      if (running) {
        try { await runtime.quit(); restoring = true; } catch { fail('千问未能正常退出，请处理客户端提示后重试'); }
        const until = now() + quitWaitMs;
        while (await runtime.isRunning()) { allowed(); if (now() >= until) fail('千问退出超时，请先结束当前任务后重试'); await sleep(pollMs); }
      }
      allowed(); update('starting', '正在启动千问并启用本机 HTTP 接口…'); lastLaunch = now();
      try { await runtime.open(); } catch { fail('千问启动失败，请检查客户端是否可正常打开'); }
      update('waiting', '正在等待千问 HTTP 接口就绪…');
      const until = now() + readyWaitMs;
      while (true) {
        allowed(); value = await runtime.inspect();
        if (value.available) { ready(value); return; }
        if (now() >= until) fail('千问已启动，但 HTTP 接口未就绪；请检查 .env 是否显式禁用了该接口');
        await sleep(pollMs);
      }
    } catch (error) { update('failed', error instanceof QwenDesktopFailure ? error.message : '千问准备失败，请检查客户端状态后重试', { state: 'failed' }); }
    finally { operation.finishedAt = now(); }
  }
  function ensure({ requestId = randomUUID(), assertAllowed = () => {} } = {}) {
    if (closed) fail('桥接服务已关闭');
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(requestId)) throw new QwenDesktopFailure(400, '准备请求标识无效');
    assertAllowed();
    if (receipts.has(requestId)) return { ...receipts.get(requestId) };
    if (!flight) {
      operation = { id: randomUUID(), state: 'running', phase: 'checking', message: '正在检查千问本机 HTTP 接口…', startedAt: now(), httpReady: false };
      // Return the accepted request before quitting the Agent that launched the CLI.
      flight = new Promise(resolve => setTimeout(resolve, 100)).then(() => prepare(assertAllowed)).finally(() => { flight = null; });
    }
    receipts.set(requestId, operation);
    if (receipts.size > 64) receipts.delete(receipts.keys().next().value);
    return snapshot();
  }
  return { ensure, status: snapshot, async close() { closed = true; await flight; } };
}

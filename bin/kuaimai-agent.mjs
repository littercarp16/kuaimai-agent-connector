#!/usr/bin/env node
import { ensureNpmRuntime } from '../src/headless/npm-runtime.mjs';
import { VERSION, decodeRequest } from '../src/headless/service.mjs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.length === 1 && ['--version','-v'].includes(args[0])) console.log(VERSION);
else if (!args.length || args.includes('--help')) console.log('快麦 Agent 连接器\n\nkuaimai-agent connect --request <网页自动生成的请求>\nkuaimai-agent status --origin <网页来源>\nkuaimai-agent stop --origin <网页来源>\n\n仅后台运行，不创建登录启动项；需要 macOS 或 Windows 10/11，且需要 Node.js 22+。');
else try {
  if (!['darwin', 'win32'].includes(process.platform) || Number(process.versions.node.split('.')[0]) < 22) throw Error('目前支持 macOS 或 Windows 10/11，且需要 Node.js 22+');
  if (!['connect','status','stop'].includes(args[0]) || args.length !== 3 || args[1] !== (args[0] === 'connect' ? '--request' : '--origin')) throw Error('参数无效，请运行 kuaimai-agent --help');
  if (args[0] === 'connect') decodeRequest(args[2]);
  const directory = await ensureNpmRuntime();
  const child = spawn(process.execPath, [join(directory, 'headless.mjs'), ...args], { stdio: 'inherit', shell: false });
  child.on('error', () => { console.error('连接器启动失败'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) { console.error(error.message); process.exitCode = 1; }

// Test-kit launcher. Clipboard text is parsed as data and never executed.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { connectService, control, decodeRequest } from '../src/headless/service.mjs';
import { windowsCommand } from '../src/runtime/windows.mjs';

export function copiedRequest(text) {
  const tokens = [...text.matchAll(/\bconnect\s+--request\s+['"]?([\w-]{1,10000})['"]?(?=\s|$)/g)];
  if (tokens.length !== 1) throw Error('请回到绫通点击「复制连接请求」，再打开 Connect.cmd。');
  const encoded = tokens[0][1], request = decodeRequest(encoded);
  if (request.transport !== 'direct') throw Error('请使用绫通网页生成的直连请求。');
  return { encoded, request };
}

async function main(action) {
  if (process.platform !== 'win32' || Number(process.versions.node.split('.')[0]) < 22) throw Error('请在 Windows 上使用 Node.js 22 或更高版本。');
  const directory = join(homedir(), '.kuaimai-agent', 'windows-test', 'instance');
  if (action === 'stop') {
    try { await control(directory, { action: 'stop' }); console.log('测试服务已收到停止请求。'); }
    catch (error) {
      if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
      console.log('测试服务已停止。');
    }
    return;
  }
  if (action !== 'connect') throw Error('请打开 Connect.cmd 或 Stop.cmd。');
  const { stdout: clipboard } = await windowsCommand('[Console]::Write([string](Get-Clipboard -Raw))');
  const { encoded, request } = copiedRequest(clipboard);
  const agent = { qwen: '千问办公', codex: 'Codex', workbuddy: 'WorkBuddy CLI' }[request.provider] || '本地 Agent';
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const yes = await prompt.question('授权 ' + request.origin + ' 连接 ' + agent + '？输入 Y 并回车确认：');
    if (yes.trim().toUpperCase() !== 'Y') return;
  } finally { prompt.close(); }
  const service = await connectService(encoded, { directory, registerExtension: true });
  console.log('连接请求已授权。请回到复制请求的原标签页，选择会话并确认。');
  console.log('后台 PID ' + service.pid + '，' + service.endpoint);
  if (service.browserExtension) console.log('若原网页提示缺少扩展，请加载此目录：' + service.browserExtension.extensionDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}

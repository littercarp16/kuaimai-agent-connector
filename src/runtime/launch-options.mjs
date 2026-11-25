import { isAbsolute } from 'node:path';
import { validWebOrigin, validAutoTrustOrigin } from './web-origin.mjs';
export function parseLaunchOptions(args) {
  const out = { adapter: 'generic', origin: process.env.KM_AGENT_ORIGIN || 'http://127.0.0.1:4173', sessionId: null, allowControl: false, auto: false, port: 17653, followSessions: true };
  const additionalOrigins = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--allow-control') { out.allowControl = true; continue; }
    if (key === '--pin-session') { out.followSessions = false; continue; }
    if (!['--adapter', '--session', '--trust-origin', '--origin', '--allow-origin', '--port', '--workspace'].includes(key) || !args[i + 1]) throw Error('启动参数无效，请使用--help');
    const value = args[++i];
    if (key === '--adapter') out.adapter = value;
    if (key === '--session') out.sessionId = value;
    if (key === '--workspace') out.workspace = value;
    if (key === '--allow-origin') additionalOrigins.push(value);
    if (key === '--trust-origin' || key === '--origin') {
      if (out.explicitOrigin) throw Error('来源参数不能重复或混用');
      out.explicitOrigin = true; out.origin = value; out.auto = key === '--trust-origin';
    }
    if (key === '--port') {
      if (!/^\d+$/.test(value)) throw Error('端口无效');
      out.port = Number(value);
    }
  }
  if (!Number.isSafeInteger(out.port) || out.port < 1024 || out.port > 65535) throw Error('端口须为明确的1024–65535整数');
  if (out.adapter !== 'generic') throw Error('旧启动入口仅支持 generic 发布适配器。请在网页重新选择 Codex、千问办公或 WorkBuddy CLI。');
  if (!validWebOrigin(out.origin) || out.auto && !validAutoTrustOrigin(out.origin)) throw Error('来源须为精确 HTTPS 或本地开发 Origin；自动授权仍仅限 127.0.0.1 显式端口');
  if (additionalOrigins.length > 15 || additionalOrigins.some(origin => !validWebOrigin(origin)) || new Set([out.origin, ...additionalOrigins]).size !== additionalOrigins.length + 1) throw Error('附加来源须为不重复的精确 HTTPS 或本地开发 Origin');
  if (additionalOrigins.length) out.additionalOrigins = additionalOrigins;
  delete out.explicitOrigin;
  if (out.sessionId && !/^ses[\w-]{1,120}$/.test(out.sessionId)) throw Error('会话标识无效');
  if (out.workspace !== undefined && (!isAbsolute(out.workspace) || out.workspace.includes('\0'))) throw Error('工作区须为明确绝对目录');
  if (out.allowControl) throw Error('通用适配器没有双向控制能力，请在网页选择原生会话并确认绑定');
  return out;
}

import { randomUUID } from 'node:crypto';
import { readRuntime, RUNTIME } from '../runtime/publisher.mjs';
import { createCodexDockManager } from '../runtime/codex-desktop-dock.mjs';

const args = process.argv.slice(2);
if (!args.length || args.includes('--help')) {
  console.log('由已运行的桥接服务切换 ChatGPT 桌面端到共享 daemon。\n'
    + 'node codex-desktop.mjs status [--runtime /绝对路径/connector.json]\n'
    + 'node codex-desktop.mjs restart [--runtime /绝对路径/connector.json]\n'
    + 'restart 先检查连接方式：共享 socket 直接复用，私有 stdio 才重启；用 status 查看异步结果。\n'
    + 'node codex-desktop.mjs dock-enable  启用当前用户 Dock 默认共享连接及登录启动项\n'
    + 'node codex-desktop.mjs dock-status  查看持久化设置\n'
    + 'node codex-desktop.mjs dock-disable 恢复原启动环境（不停止 daemon）');
} else {
  try {
    const dockActions = { 'dock-enable': 'enable', 'dock-status': 'status', 'dock-disable': 'disable', 'dock-apply': 'apply' };
    if (Object.hasOwn(dockActions, args[0])) {
      if (args.length !== 1) throw Error('Dock 配置命令不接受额外参数');
      const result = await createCodexDockManager()[dockActions[args[0]]]();
      console.log(JSON.stringify({ ok: true, data: result }, null, 2));
    } else {
      if (!['status', 'restart'].includes(args[0]) || ![1, 3].includes(args.length)
        || args.length === 3 && args[1] !== '--runtime') throw Error('参数无效，请使用 --help');
      const runtime = await readRuntime(args[2] || RUNTIME);
      const requestId = args[0] === 'restart' ? randomUUID() : undefined;
      const response = await fetch(`${runtime.endpoint}/v1/local/codex/desktop/${args[0]}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json', 'X-Km-Agent': '1', 'X-Km-Publisher': runtime.key },
        body: JSON.stringify({ instanceId: runtime.instanceId, requestId }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw Error(result.error?.message || '桌面端操作未确认');
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message?.slice(0, 240) || '连接器不可用' }));
    process.exitCode = 1;
  }
}

import { createHash } from 'node:crypto';
import { publicApproval } from '../session/shared-state.mjs';
import { redactText } from '../tools/display-safety.mjs';

const active = new Set(['starting', 'running', 'waiting_for_input']);
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const operations = { read: '读取', write: '写入', create: '创建', delete: '删除', rename: '重命名 / 移动', list: '列出目录', list_read: '列出并读取目录' };
const allowedFields = new Set(['mode', 'path', 'targetPath', 'operation', 'objectType', 'api', 'command', 'processId']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exactText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max &&
  !/[\x00-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(value) && redactText(value, false, { complete: true }) === value;
const path = value => exactText(value, 4096) && value.startsWith('/');

// This contract is verified against the desktop client's runtime filesystem
// broker, not the App SDK. Other permissions remain in the native client.
export function qwenFileApprovals(instance, target, sessionId, task) {
  if (!task || task.session_id !== sessionId || !identifier(task.task_id) ||
      !active.has(task.status) || task.terminal === true || !Array.isArray(task.actions)) return [];
  return task.actions.slice(0, 16).flatMap(action => {
    const input = action?.input;
    if (action?.kind !== 'permission' || action.tool_name !== 'SandboxFileAccess' ||
        !exactText(action.action_id, 512) || !Array.isArray(action.decisions) ||
        action.decisions.length !== 2 || !action.decisions.includes('approve') || !action.decisions.includes('deny') ||
        !input || Array.isArray(input) || input.mode !== 'sandbox_runtime_access' ||
        Object.keys(input).some(key => !allowedFields.has(key)) || !path(input.path) ||
        !Object.hasOwn(operations, input.operation) ||
        input.targetPath !== undefined && !path(input.targetPath) ||
        input.operation === 'rename' && !input.targetPath ||
        input.objectType !== undefined && !['file', 'directory', 'unknown'].includes(input.objectType) ||
        input.command !== undefined && !exactText(input.command, 6000) ||
        input.api !== undefined && !exactText(input.api, 100) ||
        input.processId !== undefined && !Number.isSafeInteger(input.processId)) return [];
    const scope = Object.keys(input).sort().map(key => [key, input[key]]);
    const id = 'qwen_approval_' + digest([instance, sessionId, task.task_id, task.turn_id, action.action_id, scope]);
    const approval = publicApproval({
      id, sessionId: target, turnId: task.task_id, itemId: 'qwen_action_' + digest(action.action_id),
      kind: 'fileChange', title: '千问办公请求文件访问权限',
      description: '允许后继续当前文件操作；千问可能在当前会话记住该路径与访问方式，每次执行仍使用临时沙箱权限。拒绝会阻止本次访问，不修改全局审批设置。',
      command: [`路径：${input.path}`, input.targetPath && `目标路径：${input.targetPath}`,
        `操作：${operations[input.operation]}${input.objectType === 'directory' ? '（目录）' : ''}`,
        input.command && `请求：${input.command}`].filter(Boolean).join('\n'),
      decisions: ['accept', 'decline']
    }, target);
    // Never offer an approval whose displayed scope differs after sanitization.
    if (!approval || approval.command !== [`路径：${input.path}`, input.targetPath && `目标路径：${input.targetPath}`,
      `操作：${operations[input.operation]}${input.objectType === 'directory' ? '（目录）' : ''}`,
      input.command && `请求：${input.command}`].filter(Boolean).join('\n')) return [];
    return [{ approval, taskId: task.task_id, actionId: action.action_id }];
  });
}

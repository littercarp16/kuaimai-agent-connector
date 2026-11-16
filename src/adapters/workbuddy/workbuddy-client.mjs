import { constants } from 'node:fs';
import { lstat, open as openFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import{pathToFileURL}from'node:url';
import { z } from 'zod';

const PROTOCOL = 'km-agent/1';
const MAX_RESPONSE = 1024 * 1024;
const MAX_TASKS = 32;
const identifier = z.string().regex(/^[\w:.-]{1,140}$/);
const eventId = z.string().regex(/^[\w:.-]{1,100}$/);
const artifactId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const nonempty = maximum => z.string().min(1).max(maximum).refine(value => value.trim().length > 0);
const shortText = z.string().max(1000);
const title = z.string().min(1).max(70).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const status = z.enum(['running', 'waiting', 'completed', 'failed']);
const kind = z.enum(['page', 'table', 'dashboard', 'task']);
const strict = shape => z.strictObject(shape);
const target = { artifactId };
const appearance = strict({ theme: z.enum(['paper', 'ink', 'forest']).optional(), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), layout: z.enum(['dashboard', 'editorial']).optional(), density: z.enum(['comfortable', 'compact']).optional() });
const cell = z.union([z.string().max(600), z.number().finite(), z.boolean(), z.null()]);
const rows = z.array(z.array(cell).max(16)).max(50);
const section = strict({ title: nonempty(70), text: nonempty(1000) });
const activity = { id: identifier, label: nonempty(120), status, detail: z.string().max(400).optional() };
const artifactBase = {
  id: artifactId, name: title, description: shortText.optional(), appearance: appearance.optional(),
  buildState: z.literal('building').optional()
};
const pageFields = {
  document: strict({ html: nonempty(12000), css: z.string().max(4000).optional() }).optional(),
  metrics: z.array(strict({ label: nonempty(40), value: nonempty(60), hint: z.string().max(90).optional() })).max(6).optional(),
  chart: strict({ type: z.enum(['bar', 'line']).optional(), labels: z.array(nonempty(40)).min(1).max(12), values: z.array(z.number().finite().min(0).max(1e12)).min(1).max(12) }).refine(chart => chart.labels.length === chart.values.length).optional(),
  sections: z.array(section).max(8).optional()
};
const artifact = z.discriminatedUnion('kind', [
  strict({ ...artifactBase, kind: z.literal('page'), ...pageFields }),
  strict({ ...artifactBase, kind: z.literal('dashboard'), ...pageFields }),
  strict({ ...artifactBase, kind: z.literal('table'), columns: z.array(nonempty(70)).min(1).max(16), rows,
    interactions: strict({ search: z.boolean().optional(), sort: z.boolean().optional() }).optional()
  }).refine(table => table.rows.every(row => row.length === table.columns.length)),
  strict({ ...artifactBase, kind: z.literal('task'), code: z.string().max(6000).optional() })
]);
const payloads = {
  'resource.create': strict({ id: artifactId, kind, name: title, appearance: appearance.optional() }),
  'resource.open': strict(target),
  'resource.edit': strict(target),
  'panel.open': strict({ mode: z.enum(['side', 'workspace']) }),
  'panel.close': strict({}),
  'work.status': strict({ ...target, status, label: z.string().max(120) }),
  'activity.updated': strict({ ...activity, kind: z.literal('phase'), visibility: z.literal('public').optional(), publicSummary: z.string().max(400).optional() }),
  'plan.updated': strict({ title, items: z.array(strict({ id: artifactId, kind, name: title })).min(1).max(12).refine(items => new Set(items.map(item => item.id)).size === items.length) }),
  'step.updated': strict(activity),
  'artifact.updated': artifact,
  'page.section.updated': strict({ ...target, section: section.extend({ id: artifactId }) }),
  'table.rows.append': strict({ ...target, rows }),
  'artifact.focus': strict(target),
  'artifact.ready': strict(target),
  'run.note': strict({ text: nonempty(3000) })
};
const eventSchema = z.discriminatedUnion('type', Object.entries(payloads).map(([type, payload]) => strict({ protocol: z.literal(PROTOCOL), id: eventId, type: z.literal(type), payload })));
export const INPUT_SCHEMAS = Object.freeze({
  km_task_open: strict({ taskKey: identifier, title }),
  km_task_publish: strict({ taskId: identifier, event: eventSchema }),
  km_task_receipt: strict({ taskId: identifier, eventId }),
  km_task_finish: strict({ taskId: identifier, status: z.enum(['completed', 'failed']), note: shortText.optional() }),
  km_agent_protocol: strict({})
});

const MESSAGES = Object.freeze({
  INVALID_INPUT: '工具参数或UI事件格式无效。', INVALID_CONFIG: '需要显式且有效的连接配置。',
  INVALID_RUNTIME: '运行清单无效，禁止推断端点。', UNSAFE_PATH: '路径含未经授权的符号链接或不是普通路径。',
  UNSAFE_RUNTIME: '运行清单须为当前用户0600文件，父目录须为0700。',
  UNSUPPORTED_SERVICE: '本机服务未声明受支持的WorkBuddy发布能力。',
  STALE_INSTANCE: '连接器实例已变化；请重新配置连接，不会重放旧任务。',
  HTTP_FAILED: '本机请求未确认；未自动重试，请核对回执。', HTTP_REJECTED: '本机服务拒绝请求，未自动重试。',
  RESPONSE_TOO_LARGE: '本机响应超过1MiB限制。', INVALID_RESPONSE: '本机响应合同无效。',
  TASK_KEY_CONFLICT: '同一taskKey不能更改标题。', TASK_LIMIT: '当前进程最多记录32个任务。',
  UNKNOWN_TASK: '只能操作当前进程已获得授权的任务。', TASK_FINISHED: '任务已明确结束，不能再发布。',
  TASK_FINISHING: '任务结束请求正在确认。', FINISH_CONFLICT: '结束请求与当前已记录的请求冲突。',
  TASK_NOT_READY: '完成请求明确未提交：仍有构建中的成果，请先上报ready或改为failed。',
  TASK_RETIRED: '该逻辑任务属于旧连接器实例；不会重建票据或重放旧任务。',
  PREPARE_FAILED: '本机运行时准备未完成；未自动重发旧任务。',
  EVENT_TOO_LARGE: '请将成果拆为小于19KB的独立事件。', CLIENT_CLOSED: '本客户端已关闭。',
  EXPORT_CONFLICT: '导出目录已有不同内容，未覆盖。', INTERNAL_ERROR: '本机操作失败；未披露原始错误。'
});

export class WorkBuddyError extends Error {
  constructor(code) { super(`${code}: ${MESSAGES[code] || MESSAGES.INTERNAL_ERROR}`); this.name = 'WorkBuddyError'; this.code = code; }
}
function fail(code) { throw new WorkBuddyError(code); }
export function publicError(error) {
  const code = error instanceof WorkBuddyError && Object.hasOwn(MESSAGES, error.code) ? error.code : 'INTERNAL_ERROR';
  return { code, message: MESSAGES[code] };
}
function validated(schema, value, code = 'INVALID_INPUT') {
  const parsed = schema.safeParse(value);
  if (!parsed.success) fail(code);
  return parsed.data;
}

// Only these verified macOS system aliases are allowed, never arbitrary user symlinks.
const SYSTEM_ALIASES = new Map([['/var', '/private/var'], ['/tmp', '/private/tmp'], ['/etc', '/private/etc']]);
export async function safePath(path, { allowMissing = false } = {}) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) fail('UNSAFE_PATH');
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && error.code === 'ENOENT') return join(await realpath(dirname(current)), ...parts.slice(i));
      fail('UNSAFE_PATH');
    }
    if (info.isSymbolicLink()) {
      if (process.platform !== 'darwin' || !SYSTEM_ALIASES.has(current) || await realpath(current) !== SYSTEM_ALIASES.get(current)) fail('UNSAFE_PATH');
    } else if (i < parts.length - 1 && !info.isDirectory()) fail('UNSAFE_PATH');
  }
  return realpath(absolute).catch(() => fail('UNSAFE_PATH'));
}

async function readJson(path, { runtime = false, limit = 16384 } = {}) {
  const canonical = await safePath(path);
  let handle;
  try {
    const parent = await stat(dirname(canonical));
    const owned = info => !process.getuid || info.uid === process.getuid();
    if (runtime && (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || !owned(parent))) fail('UNSAFE_RUNTIME');
    handle = await openFile(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit || runtime && ((info.mode & 0o777) !== 0o600 || !owned(info) || info.nlink !== 1)) fail(runtime ? 'UNSAFE_RUNTIME' : 'INVALID_CONFIG');
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > limit) fail(runtime ? 'INVALID_RUNTIME' : 'INVALID_CONFIG');
    await safePath(path);
    const after = await stat(dirname(canonical));
    if (parent.ino !== after.ino || parent.dev !== after.dev) fail('UNSAFE_PATH');
    return JSON.parse(content);
  } catch (error) {
    if (error instanceof WorkBuddyError) throw error;
    fail(runtime ? 'INVALID_RUNTIME' : 'INVALID_CONFIG');
  } finally { await handle?.close(); }
}

const absolutePath = z.string().min(1).refine(value => isAbsolute(value) && !value.includes('\0'));
const connectionSchema = strict({ version: z.literal(1), runtimeFile: absolutePath, origin: z.string().max(300), workspaceRoot: absolutePath.optional(), workspaceId: z.string().min(1).max(128).regex(/^[\w:.-]+$/).optional(),bootstrapFile:absolutePath.optional(),prepareEntry:absolutePath.optional() }).refine(value => Boolean(value.workspaceRoot) !== Boolean(value.workspaceId)&&Boolean(value.bootstrapFile)===Boolean(value.prepareEntry));
const runtimeSchema = strict({ instanceId: identifier, endpoint: z.string().max(200), protocol: z.literal(PROTOCOL), key: z.string().min(20).max(256).regex(/^[\x21-\x7e]+$/), bindings: z.array(z.unknown()).max(1000) });
function validOrigin(value, endpoint = false) {
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password && (endpoint
      ? url.protocol === 'http:' && url.hostname === '127.0.0.1' && Boolean(url.port)
      : ['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  } catch { return false; }
}
export async function validateConnection(value) {
  const config = validated(connectionSchema, value, 'INVALID_CONFIG');
  if (!validOrigin(config.origin)) fail('INVALID_CONFIG');
  const runtimeFile = await safePath(config.runtimeFile,{allowMissing:Boolean(config.bootstrapFile)});
  if(config.bootstrapFile){config.bootstrapFile=await safePath(config.bootstrapFile);config.prepareEntry=await safePath(config.prepareEntry);const info=await stat(config.prepareEntry);if(!info.isFile()||info.mode&0o022||process.getuid&&info.uid!==process.getuid()||!config.prepareEntry.endsWith('.mjs'))fail('INVALID_CONFIG');}
  let workspaceRoot;
  if (config.workspaceRoot) {
    workspaceRoot = await safePath(config.workspaceRoot);
    if (!(await stat(workspaceRoot)).isDirectory()) fail('INVALID_CONFIG');
  }
  return { ...config, runtimeFile, ...(workspaceRoot ? { workspaceRoot } : {}) };
}
export async function loadConnection(connectionFile) {
  return validateConnection(await readJson(connectionFile));
}
export async function validateRuntimeFile(path) {
  const runtime = validated(runtimeSchema, await readJson(path, { runtime: true, limit: 128 * 1024 }), 'INVALID_RUNTIME');
  if (!validOrigin(runtime.endpoint, true)) fail('INVALID_RUNTIME');
  return runtime;
}

async function httpJson(endpoint, path, { body, origin, publisher, token } = {}) {
  let response;
  try {
    response = await fetch(endpoint + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'X-Km-Agent': '1', ...(origin ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(publisher ? { 'X-Km-Publisher': publisher } : {}), ...(token ? { 'X-Km-Task-Token': token } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
    if (Number(response.headers.get('content-length')) > MAX_RESPONSE) { await response.body?.cancel(); fail('RESPONSE_TOO_LARGE'); }
    const chunks = [];
    let bytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_RESPONSE) { await reader.cancel(); fail('RESPONSE_TOO_LARGE'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
    }
    let result;
    try { result = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(response.ok ? 'INVALID_RESPONSE' : 'HTTP_REJECTED'); }
    if (!response.ok) {
      if(response.status===409&&result?.ok===false&&result.error?.code==='WORKBUDDY_NOT_READY')fail('TASK_NOT_READY');
      fail('HTTP_REJECTED');
    }
    if (result?.ok !== true) fail('HTTP_REJECTED');
    if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) fail('INVALID_RESPONSE');
    return result.data;
  } catch (error) {
    if (error instanceof WorkBuddyError) throw error;
    fail('HTTP_FAILED');
  }
}

export function agentProtocol() {
  return {
    protocol: PROTOCOL, provider: 'workbuddy', commands: Object.keys(payloads),
    limits: { eventBytes: 19000, responseBytes: MAX_RESPONSE, tasksPerProcess: MAX_TASKS, heartbeatMs: 20000 },
    activityKinds: ['phase'], capabilities: { publishUI: true, nativeToolSubscription: false, nativeSessionMirror: false, browserPrompt: false, nativeQuestions: false, businessWrite: false },
    delivery: { accepted: '连接器已接收，未证明展示', applied: '浏览器已应用，非平台保存或用户阅读证明', deferred: '前端暂未展示，或历史内容已超出保留范围', failed: '应用失败', unknown: '无可用回执' },
    boundaries: ['只主动发布公开阶段和预览成果，不订阅WorkBuddy全部工具。', '普通正文/HTML/CSS由服务统一过滤并在前端沙箱展示。', '进程重启不恢复旧ticket；断线不自动重发事件或结束请求。', '关闭客户端只停止自身心跳，不代表停止WorkBuddy。']
  };
}

export async function createWorkBuddyClient({ connectionFile, timers = { setInterval, clearInterval } } = {}) {
  const config = await loadConnection(connectionFile);
  let prepare=null,expectedEndpoint=null;
  if(config.bootstrapFile){const module=await import(pathToFileURL(config.prepareEntry).href);if(typeof module.ensureRuntime!=='function')fail('INVALID_CONFIG');prepare=module.ensureRuntime;}
  async function prepareConfigured(){if(!prepare)return;let result;try{result=await prepare({configFile:config.bootstrapFile,expectedOrigin:config.origin});}catch{fail('PREPARE_FAILED');}if(result?.ready!==true||await safePath(result.runtimeFile)!==config.runtimeFile||!validOrigin(result.endpoint,true))fail('INVALID_CONFIG');expectedEndpoint=result.endpoint;}
  await prepareConfigured();
  let runtime = await validateRuntimeFile(config.runtimeFile);
  if(expectedEndpoint&&runtime.endpoint!==expectedEndpoint)fail('INVALID_RUNTIME');
  const workspaceId = config.workspaceId || 'ws_' + createHash('sha256').update(config.workspaceRoot).digest('hex');
  const keys = new Map(), tasks = new Map(), secrets = new Set([runtime.key]);
  let closed = false, stale = false,refreshing=null;

  function assertLive() { if (closed) fail('CLIENT_CLOSED'); if (stale) fail('STALE_INSTANCE'); }
  function stopTimer(task) { if (task.timer) { timers.clearInterval(task.timer); task.timer = null; } }
  function markStale() { stale = true; for (const task of tasks.values()) stopTimer(task); fail('STALE_INSTANCE'); }
  function publicText(value) { for (const secret of secrets) value = value.split(secret).join('[已隐藏]'); return value; }
  function publicTask(task) { return { taskId: publicText(task.id), title: publicText(task.title), provider: 'workbuddy', status: task.status }; }
  function taskFor(id, { writable = false } = {}) {
    assertLive();
    const task = tasks.get(id);
    if (!task) fail('UNKNOWN_TASK');
    if(task.retired)fail('TASK_RETIRED');
    if (writable && task.status !== 'running') fail('TASK_FINISHED');
    if (writable && task.finishing) fail('TASK_FINISHING');
    return task;
  }
  async function checkHealth() {
    assertLive();
    const context=runtime;
    const currentContext=()=>{if(runtime!==context)fail('TASK_RETIRED');assertLive();};
    const current = await validateRuntimeFile(config.runtimeFile);
    currentContext();
    if (current.instanceId !== context.instanceId || current.endpoint !== context.endpoint || current.key !== context.key) markStale();
    const data = await httpJson(context.endpoint, '/v1/health', { origin: config.origin });
    currentContext();
    if (data.instanceId !== context.instanceId) markStale();
    if (data.service !== 'kuaimai-agent-connector' || data.protocolVersion !== 2 || data.interactionProtocol !== PROTOCOL || data.capabilities?.workbuddyPublish !== true) fail('UNSUPPORTED_SERVICE');
  }
  function checkInstance(data) { assertLive(); if (data.instanceId !== runtime.instanceId) markStale(); }
  async function taskRequest(task, action, fields = {}) {
    await checkHealth();
    assertLive();
    if(task.retired)fail('TASK_RETIRED');
    if (action === 'publish' && task.status !== 'running') fail('TASK_FINISHED');
    if (action === 'publish' && task.finishing) fail('TASK_FINISHING');
    const requestInstance=runtime.instanceId;
    const data = await httpJson(runtime.endpoint, '/v1/local/workbuddy/tasks/' + action, { token: task.token, body: { instanceId: requestInstance, taskId: task.id, ...fields } });
    if(task.retired||runtime.instanceId!==requestInstance)fail('TASK_RETIRED');
    checkInstance(data);
    if (data.taskId !== task.id) fail('INVALID_RESPONSE');
    return data;
  }
  function heartbeat(task) {
    task.timer = timers.setInterval(async () => {
      if (closed || stale || task.status !== 'running' || task.heartbeatPending) return;
      task.heartbeatPending = true;
      try { await taskRequest(task, 'heartbeat'); } catch { /* No event replay, model output or raw diagnostic. */ }
      finally { task.heartbeatPending = false; }
    }, 20000);
    task.timer.unref?.();
  }
  async function prepareNewTask(taskKey){
    if(!prepare||keys.has(taskKey)||closed||![...keys.values()].every(entry=>entry.task&&['completed','failed'].includes(entry.task.status)&&!entry.pending&&!entry.task.finishing))return;
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      await prepareConfigured();if(closed)fail('CLIENT_CLOSED');const next=await validateRuntimeFile(config.runtimeFile);
      if(next.endpoint!==expectedEndpoint)fail('INVALID_RUNTIME');
      if(next.instanceId!==runtime.instanceId||next.key!==runtime.key||next.endpoint!==runtime.endpoint){
        const data=await httpJson(next.endpoint,'/v1/health',{origin:config.origin});if(closed)fail('CLIENT_CLOSED');
        if(data.instanceId!==next.instanceId||data.service!=='kuaimai-agent-connector'||data.protocolVersion!==2||data.interactionProtocol!==PROTOCOL||data.capabilities?.workbuddyPublish!==true)fail('UNSUPPORTED_SERVICE');
        for(const entry of keys.values())entry.retired=true;for(const task of tasks.values()){stopTimer(task);task.retired=true;}
        runtime=next;secrets.add(next.key);stale=false;
      }
    })();try{return await refreshing;}finally{refreshing=null;}
  }
  async function openTask(input) {
    const { taskKey, title: taskTitle } = validated(INPUT_SCHEMAS.km_task_open, input);
    await prepareNewTask(taskKey);
    assertLive();
    let entry = keys.get(taskKey);
    if(entry?.retired)fail('TASK_RETIRED');
    if (entry && entry.title !== taskTitle) fail('TASK_KEY_CONFLICT');
    if (!entry) {
      if (keys.size >= MAX_TASKS) fail('TASK_LIMIT');
      entry = { title: taskTitle, requestId: randomUUID() };
      keys.set(taskKey, entry);
    }
    if (entry.pending) return entry.pending;
    if (entry.task) { await checkHealth(); return publicTask(entry.task); }
    entry.pending = (async () => {
      await checkHealth();
      const data = await httpJson(runtime.endpoint, '/v1/local/workbuddy/tasks/open', { publisher: runtime.key, body: { requestId: entry.requestId, title: taskTitle, workspaceId } });
      checkInstance(data);
      if (!identifier.safeParse(data.taskId).success || !title.safeParse(data.title).success || typeof data.taskToken !== 'string' || data.taskToken.length < 20 || data.taskToken.length > 256 || !/^[\x21-\x7e]+$/.test(data.taskToken) || data.status !== 'running' || tasks.has(data.taskId)) fail('INVALID_RESPONSE');
      secrets.add(data.taskToken);
      if (data.taskId.includes(runtime.key) || data.taskId.includes(data.taskToken)) fail('INVALID_RESPONSE');
      const task = { id: data.taskId, title: data.title, token: data.taskToken, status: 'running' };
      tasks.set(task.id, task);
      entry.task = task;
      heartbeat(task);
      return publicTask(task);
    })();
    try { return await entry.pending; } finally { entry.pending = null; }
  }

  return Object.freeze({
    open: openTask,
    async publish(input) {
      const { taskId, event } = validated(INPUT_SCHEMAS.km_task_publish, input);
      const task = taskFor(taskId, { writable: true });
      if (Buffer.byteLength(JSON.stringify(event)) >= 19000) fail('EVENT_TOO_LARGE');
      const data = await taskRequest(task, 'publish', { event });
       if (data.accepted !== true || !['accepted','applied','deferred','failed'].includes(data.delivery) || data.eventId !== undefined && data.eventId !== event.id) fail('INVALID_RESPONSE');
       return { ...publicTask(task), eventId: publicText(event.id), accepted: true, delivery: data.delivery };
    },
    async receipt(input) {
      const { taskId, eventId } = validated(INPUT_SCHEMAS.km_task_receipt, input);
      const task = taskFor(taskId);
      const data = await taskRequest(task, 'receipt', { eventId });
      if (!['accepted', 'applied', 'deferred', 'failed', 'unknown'].includes(data.delivery) || data.eventId !== undefined && data.eventId !== eventId) fail('INVALID_RESPONSE');
      return { ...publicTask(task), eventId: publicText(eventId), delivery: data.delivery };
    },
    async finish(input) {
      const args = validated(INPUT_SCHEMAS.km_task_finish, input);
      const task = taskFor(args.taskId);
      const signature = JSON.stringify({ status: args.status, note: args.note });
      if (task.finishRequest && task.finishRequest.signature !== signature) fail('FINISH_CONFLICT');
      if (task.status !== 'running') { await checkHealth(); return { ...publicTask(task), accepted: true }; }
      if (task.finishing) return task.finishing;
      task.finishRequest ??= { signature, requestId: randomUUID() };
      task.finishing = (async () => {
        try{
          const data = await taskRequest(task, 'finish', { requestId: task.finishRequest.requestId, status: args.status, ...(args.note !== undefined ? { note: args.note } : {}) });
          if (data.status !== args.status || data.accepted !== true) fail('INVALID_RESPONSE');
          task.status = args.status;
          stopTimer(task);
          return { ...publicTask(task), accepted: true };
        }catch(error){if(error?.code==='TASK_NOT_READY')task.finishRequest=null;throw error;}
      })();
      try { return await task.finishing; } finally { task.finishing = null; }
    },
    protocol() { return agentProtocol(); },
    close() { closed = true; for (const task of tasks.values()) stopTimer(task); }
  });
}

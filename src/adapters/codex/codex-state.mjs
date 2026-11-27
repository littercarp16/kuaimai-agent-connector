import { createProjection } from '../../session/shared-state.mjs';
import { redactText } from '../../tools/display-safety.mjs';
import { publicToolInfo, publicToolResult } from '../../tools/tool-public.mjs';
import { createDetailStore, detailPolicy, makeToolDetail } from '../../tools/tool-details.mjs';
import{nativeExternalTool,nativeTextPreview}from'./codex-native-tool-details.mjs';
import { parseAttachmentBlock, displayLocalImage, displayImageUrl } from './codex-files.mjs';

export const publicText = value => redactText(String(value ?? ''), false, { complete: true });
export const nativeKey = value => typeof value === 'string' && /^[\w:.-]{1,120}$/.test(value);
const terminalStatus = { completed: 'completed', failed: 'failed', interrupted: 'interrupted' };
const terminalEvent = { completed: 'session.execution.succeeded', failed: 'session.execution.failed', interrupted: 'session.execution.interrupted' };
const toolStatus = item => ['failed', 'declined', 'cancelled'].includes(item.status) || item.success === false || item.exitCode != null && item.exitCode !== 0 ? 'failed' : item.status === 'completed' ? 'completed' : 'running';

// Only genuine native item kinds are mapped. An arbitrary MCP/dynamic tool named
// "shell" or "skill" is NOT proof that it follows either tool's security contract.
export function nativeTool(item, directory) {
  const status = toolStatus(item), error = status === 'failed' ? '本地工具执行失败' : undefined;
  if (item.type === 'commandExecution') return { name: 'shell', input: { command: item.command, cwd: item.cwd || directory },
    content: [{ type: 'text', text: String(item.aggregatedOutput ?? '') }], status, error };
  if (item.type === 'fileChange') {
    const changes = item.changes;
    // This mapper supports complete, bounded, non-moving patches only. Never
    // truncate a changes array or silently omit a move/unknown destination: the
    // generic patch policy understands File headers, not native move metadata.
    const complete = Array.isArray(changes) && changes.length > 0 && changes.length <= 100 && changes.every(change =>
      change && typeof change.path === 'string' && !!change.path && !/[\x00-\x1f\x7f]/.test(change.path) &&
      typeof change.diff === 'string' && Object.keys(change).every(key => ['path', 'kind', 'diff'].includes(key)) &&
      change.kind && ['add', 'update', 'delete'].includes(change.kind.type) &&
      Object.keys(change.kind).every(key => ['type', 'move_path'].includes(key)) && change.kind.move_path == null);
    const blocked = () => ({ name: 'patch', input: { cwd: directory }, content: [], status, error,
      policy: { blocked: true, reason: '文件变更包含移动、未知或超限上下文；请在原生客户端查看完整变更' } });
    if (!complete) return blocked();
    const patchText = changes.map(change => `*** ${change.kind.type === 'add' ? 'Add' : change.kind.type === 'delete' ? 'Delete' : 'Update'} File: ${change.path}\n${change.diff}`).join('\n');
    if (Buffer.byteLength(patchText) > 128000) return blocked();
    return { name: 'patch', input: { cwd: directory, patchText }, content: [{ type: 'text', text: patchText }], status, error };
  }
  if (item.type === 'collabAgentToolCall' || item.type === 'collabToolCall') {
    const absent=reason=>({available:false,text:'',format:'text',redacted:false,truncated:false,totalChars:0,reason});
    const rawName=typeof item.tool==='string'&&item.tool.length<=1024?item.tool:'子Agent',nameView=nativeTextPreview(rawName),agent=nameView.available?nameView.text.slice(0,70):'子Agent';
    const policy=detailPolicy('subagent',{cwd:directory}),states=Object.values(item.agentsStates||{}),messages=states.filter(value=>typeof value?.message==='string').map(value=>value.message);
    const request=policy.blocked?absent(policy.reason):nativeTextPreview({agent:rawName,description:typeof item.prompt==='string'?item.prompt:''},{format:'json'});
    const bytes=messages.reduce((n,text)=>n+Buffer.byteLength(text)+1,0);
    const result=policy.blocked?absent(policy.reason):status==='running'?absent('子Agent尚未返回公开结果'):states.length>32||bytes>512000?absent('子Agent公开返回超过数量或512KB读取预算，请在原生客户端查看'):nativeTextPreview(messages.join('\n'));
    let description='';if(request.available)try{description=JSON.parse(request.text).description||'';}catch{}
    return{name:'subagent',input:{agent,cwd:directory},content:[],status,error,policy,publicInfo:{summary:[agent,description.slice(0,300)].filter(Boolean).join(' · '),detail:'展开读取子Agent公开任务及返回；不读取其内部推理或完整子线程。'},detail:{toolId:item.id,toolName:'subagent',status,request,result}};
  }
  return nativeExternalTool(item,directory);
}

const MAX_GEN_IMAGES = 8;
const MAX_GEN_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_GEN_IMAGES_TOTAL = 24 * 1024 * 1024;

function detectImageBase64(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const cleaned = raw.startsWith('data:') ? raw.slice(raw.indexOf(',') + 1) : raw;
  if (!cleaned || cleaned.length > Math.ceil(MAX_GEN_IMAGE_BYTES / 3) * 4 + 4) return null;
  const bytes = Buffer.from(cleaned, 'base64');
  if (!bytes.length || bytes.length > MAX_GEN_IMAGE_BYTES) return null;
  let mime = '';
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mime = 'image/png';
  else if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') mime = 'image/webp';
  else if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) mime = 'image/gif';
  if (!mime) return null;
  return { mime, base64: bytes.toString('base64'), bytes: bytes.length };
}

/** Bounded public projection plus private, bounded text accumulators, per binding. */
export function createCodexState({ sessionId, directory, makeEvent, publish, now = Date.now }) {
  const projection = createProjection(sessionId), items = new Map(), terminalTurns = new Map();
  const details = createDetailStore({ now });
  const generatedImages = new Map();
  let activeTurnId = null, latestTurnId = null, status = 'idle', model = null, revision = 0, turnRevision = 0, itemBytes = 0, generatedImageBytes = 0;
  function putGeneratedImage(id, raw) {
    if (!nativeKey(id)) return false;
    const parsed = detectImageBase64(raw);
    if (!parsed) return false;
    const prev = generatedImages.get(id);
    if (prev) { generatedImageBytes -= prev.bytes; generatedImages.delete(id); }
    generatedImages.set(id, parsed);
    generatedImageBytes += parsed.bytes;
    while (generatedImages.size > MAX_GEN_IMAGES || generatedImageBytes > MAX_GEN_IMAGES_TOTAL) {
      const first = generatedImages.keys().next().value;
      generatedImageBytes -= generatedImages.get(first).bytes;
      generatedImages.delete(first);
    }
    return true;
  }
  function readGeneratedImage(id) {
    const entry = generatedImages.get(id);
    return entry ? { imageId: id, mime: entry.mime, base64: entry.base64 } : null;
  }
  function event(type, data, broadcast = true) {
    const value = makeEvent(type, { sessionID: sessionId, ...data });
    projection.accept(value);
    if (broadcast) publish(value);
  }
  function remember(id, value) {
    itemBytes -= items.get(id)?.bytes || 0;
    value.bytes = Buffer.byteLength(JSON.stringify(value)) + 64;
    items.set(id, value); itemBytes += value.bytes;
    while (items.size > 256 || itemBytes > 1024 * 1024) {
      const first = items.keys().next().value; itemBytes -= items.get(first).bytes; items.delete(first);
    }
  }
  function setTurn(turn, { broadcast = true, historical = false, since = Infinity } = {}) {
    if (!nativeKey(turn?.id)) return false;
    if (historical && turnRevision > since) return false;
    if (terminalTurns.has(turn.id) && turn.status === 'inProgress') return false;
    if (terminalTurns.get(turn.id) === 'superseded') return false;
    if (historical && activeTurnId && activeTurnId !== turn.id && terminalTurns.has(turn.id)) return false;
    if (!historical && activeTurnId && activeTurnId !== turn.id && turn.status !== 'inProgress') return false;
    if (turn.status === 'inProgress') {
      if (activeTurnId && activeTurnId !== turn.id) {
        terminalTurns.set(activeTurnId, 'superseded');
      }
      activeTurnId = turn.id; latestTurnId = turn.id; status = 'running';
      if (broadcast) event('session.execution.started', {}, true);
    } else if (terminalStatus[turn.status]) {
      if (activeTurnId === turn.id) activeTurnId = null;
      latestTurnId = turn.id; status = terminalStatus[turn.status]; terminalTurns.set(turn.id, turn.status);
      if (broadcast) event(terminalEvent[turn.status], {}, true);
    } else return false;
    if (!historical) turnRevision = ++revision;
    while (terminalTurns.size > 128) terminalTurns.delete(terminalTurns.keys().next().value);
    return true;
  }
  function item(value, turnId, { broadcast = true, completed = false, historical = false, since = Infinity, snapshotOrder = null, receiptOrder = null } = {}) {
    if (!nativeKey(value?.id) || !nativeKey(turnId)) return;
    if (!historical && (activeTurnId && activeTurnId !== turnId || terminalTurns.has(turnId) && turnId !== latestTurnId)) return;
    const old = items.get(value.id);
    // Even a covered completed notification carries authoritative lifecycle
    // state: optional snapshot timestamps alone cannot prove item completion.
    if (!historical && !completed && receiptOrder && old?.snapshotOrder >= receiptOrder) return;
    if (historical && (old?.completed || old?.revision > since && !(snapshotOrder && old.receiptOrder && old.receiptOrder <= snapshotOrder)) || !completed && old?.completed) return;
    const version = historical ? old?.revision || 0 : ++revision;
    const store = data => remember(value.id, { ...data, snapshotOrder: snapshotOrder || old?.snapshotOrder || null,
      receiptOrder: historical ? old?.receiptOrder || null : receiptOrder });
    if (value.type === 'userMessage') {
      const textParts = [], files = [];
      for (const [index, part] of (value.content || []).entries()) {
        if (part?.type === 'text' && typeof part.text === 'string') {
          const attachment = index > 0 ? parseAttachmentBlock(part.text) : null;
          if (attachment) files.push({ name: publicText(attachment.name).slice(0, 180), mime: attachment.mime });
          else textParts.push(part.text);
        } else if (part?.type === 'localImage' && typeof part.path === 'string') {
          const info = displayLocalImage(part.path, directory);
          files.push({ name: publicText(info.name).slice(0, 180), mime: info.mime });
        } else if (part?.type === 'image' && typeof part.url === 'string') {
          files.push(displayImageUrl(part.url));
        }
      }
      const text = publicText(textParts.join('\n')).slice(0, 14000);
      store({ type: value.type, turnId, completed, revision: version, clientId: value.clientId });
      event('session.inbox.enqueued', { inboxID: value.id, item: { type: 'user', payload: { text, ...(files.length ? { files } : {}) } } }, broadcast);
      // UserMessage is input history, not a new send, nor evidence that a finished turn is queued.
      if (status !== 'running' && terminalEvent[status]) event(terminalEvent[status], {}, broadcast);
      return;
    }
    if (value.type === 'agentMessage') {
      const text = String(value.text ?? '').slice(0, 180000);
      // Stored active-turn pages may lag live notifications even when the read
      // starts later. Only an atomic resume snapshot may replace a live draft;
      // native item/completed (non-historical) remains authoritative, including
      // a final body that differs entirely from the streamed draft.
      if (historical && !completed && old?.liveText && !snapshotOrder) return;
      store({ type: value.type, turnId, text, completed, revision: version, liveText: !historical || old?.liveText === true });
      // Full replacements are deliberate: hub snapshot + buffered stream overlap
      // must never append already-hydrated delta text a second time.
      event('session.text.ended', { assistantMessageID: value.id, ordinal: 0, text: publicText(text) }, broadcast);
      return;
    }
    if (value.type === 'reasoning') {
      store({ type: value.type, turnId, completed, revision: version });
      event(completed ? 'session.reasoning.ended' : 'session.reasoning.started', { assistantMessageID: value.id, ordinal: 0 }, broadcast);
      return;
    }
    if (value.type === 'imageGeneration') {
      if (typeof value.result === 'string') putGeneratedImage(value.id, value.result);
      const imgStatus = toolStatus(value);
      const hasImage = generatedImages.has(value.id);
      const promptText = typeof value.revisedPrompt === 'string' ? publicText(value.revisedPrompt).slice(0, 2000) : '';
      const requestDetail = promptText
        ? { available: true, text: promptText, format: 'text', redacted: false, truncated: false, totalChars: promptText.length, reason: '' }
        : { available: false, text: '', format: 'text', redacted: false, truncated: false, totalChars: 0, reason: '未提供提示词详情' };
      const resultDetail = imgStatus === 'running'
        ? { available: false, text: '', format: 'text', redacted: false, truncated: false, totalChars: 0, reason: '图片仍在生成中' }
        : imgStatus === 'failed'
          ? { available: true, text: '图片生成失败', format: 'text', redacted: false, truncated: false, totalChars: 6, reason: '' }
          : { available: true, text: hasImage ? '图片已生成，可在对话中预览' : '图片已生成', format: 'text', redacted: false, truncated: false, totalChars: 12, reason: '' };
      details.put(sessionId, value.id, { toolId: value.id, toolName: 'image_generation', status: imgStatus, request: requestDetail, result: resultDetail });
      store({ type: value.type, turnId, completed, revision: version, toolName: 'image_generation' });
      if (!old) event('session.tool.input.started', { id: value.id, name: 'image_generation' }, broadcast);
      event('session.tool.called', {
        id: value.id,
        publicTool: {
          label: '生成图片',
          summary: imgStatus === 'completed' ? '已生成图片' : imgStatus === 'failed' ? '图片生成失败' : '正在生成图片…',
          hasDetails: true,
        },
      }, broadcast);
      if (imgStatus !== 'running' || completed) {
        event(imgStatus === 'failed' ? 'session.tool.failed' : 'session.tool.success', {
          id: value.id,
          publicResult: {
            summary: imgStatus === 'failed' ? '图片生成失败' : '已生成图片',
            hasDetails: true,
          },
        }, broadcast);
      }
      return;
    }
    const tool = nativeTool(value, directory); if (!tool) return;
    const previous = details.get(sessionId, value.id);
    const unsafeCommandContext=value.type==='commandExecution'&&(typeof value.command!=='string'||!value.command.trim()||value.command.length>8000||value.cwd!=null&&typeof value.cwd!=='string');
    const policy = tool.policy || (unsafeCommandContext?{blocked:true,reason:'命令上下文缺失或超过安全解析预算，请在原生客户端查看'}:detailPolicy(tool.name, tool.input));
    details.put(sessionId, value.id, tool.detail||makeToolDetail({ toolId: value.id, ...tool, policy, previous,complete:true,previewer:nativeTextPreview }));
    store({ type: value.type, turnId, completed, revision: version, toolName: tool.name,
      approvalContext: value.type === 'fileChange' ? { input: tool.input, policy } : undefined });
    if (!old) event('session.tool.input.started', { id: value.id, name: tool.name }, broadcast);
    event('session.tool.called', { id: value.id, publicTool: { ...(tool.publicInfo||publicToolInfo(tool.name, tool.input)), hasDetails: true } }, broadcast);
    if (tool.status !== 'running' || completed) event(tool.status === 'failed' ? 'session.tool.failed' : 'session.tool.success', {
      id: value.id, publicResult: { ...publicToolResult(tool.name, { error: tool.error }), hasDetails: true },
    }, broadcast);
  }
  function delta(params, receiptOrder = null) {
    if (!nativeKey(params.itemId) || params.turnId !== activeTurnId) return;
    const old = items.get(params.itemId); if (old?.completed || receiptOrder && old?.snapshotOrder >= receiptOrder) return;
    const text = (old?.text || '') + String(params.delta || '');
    item({ id: params.itemId, type: 'agentMessage', text }, params.turnId, { receiptOrder });
  }
  function hydrate(turns, { since = revision, preserveActive = false, snapshotOrder = null, snapshotItems = new Set() } = {}) {
    for (const turn of turns) {
      if (!nativeKey(turn?.id)) continue;
      if (turn !== turns.at(-1) && terminalStatus[turn.status] && !terminalTurns.has(turn.id)) terminalTurns.set(turn.id, turn.status);
      for (const entry of turn.items || []) item(entry, turn.id, { broadcast: false, historical: true,
        completed: turn.status !== 'inProgress' || entry.completedAtMs != null, since,
        snapshotOrder: snapshotItems.has(`${turn.id}\0${entry.id}`) ? snapshotOrder : null });
    }
    const latest = turns.at(-1);
    if (latest && !(preserveActive && activeTurnId && latest.status !== 'inProgress')) setTurn(latest, { broadcast: false, historical: true, since });
  }
  function snapshot(questions = [], approvals = []) {
    const value = projection.value;
    // This is an adapter-to-hub snapshot, not the browser transcript. Preserve
    // bounded public protocol blocks so a newly created hub can parse previews.
    // The outer projection removes those blocks before broadcasting chat text.
    const messages=value.messages.map(message=>{const source=items.get(message.id);return message.role==='assistant'&&source?.type==='agentMessage'?{...message,text:publicText(source.text)}:message;});
    return structuredClone({ messages, tools: value.tools, activities: value.activities,
      timeline: value.timeline, questions, approvals, status, model });
  }
  return { item, delta, setTurn, hydrate, snapshot,
    get revision() { return revision; }, get activeTurnId() { return activeTurnId; },
    get latestTurnId() { return latestTurnId; }, get status() { return status; },
    terminal: id => terminalTurns.get(id), itemContext: id => items.get(id)?.approvalContext,
    hasItem: id => items.has(id),
    readDetail(id) {
      const detail = details.get(sessionId, id);
      if (!detail) return null;
      const img = readGeneratedImage(id);
      return img ? { ...detail, image: { mime: img.mime, base64: img.base64 } } : detail;
    },
    putGeneratedImage, readGeneratedImage, hasGeneratedImage: id => generatedImages.has(id),
    coveredAt: (turnId, id, order) => { const value = items.get(id); return value?.turnId === turnId && (value.completed || value.snapshotOrder >= order); },
    userId: clientId => [...items].find(([id, item]) => item.type === 'userMessage' && (id === clientId || item.clientId === clientId))?.[0],
    runtimeError() { status = 'failed'; },
    setModel(thread) { model = thread.model ? publicText(`${thread.modelProvider || 'openai'}/${thread.model}`).slice(0, 200) : model; },
  };
}

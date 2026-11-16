import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { detailPolicy, protectedTarget } from '../../tools/tool-details.mjs';
import { secretKey } from '../../tools/display-safety.mjs';

const MAX_BYTES = 512000, MAX_NODES = 8192, MAX_DEPTH = 24, MAX_COMMAND = 8000, MAX_KEY = 1024;
const kinds = new Set(['mcpToolCall', 'dynamicToolCall', 'functionCallOutput']);
const targetKeys = new Set(['path', 'paths', 'filepath', 'filepaths', 'file', 'files', 'filename',
  'filenames', 'cwd', 'workdir', 'workingdirectory', 'directory', 'directories', 'uri', 'fileuri']);
const baseKeys = new Set(['cwd', 'workdir', 'workingdirectory', 'directory']);
const binaryKinds = new Set(['image', 'audio', 'blob', 'inputImage', 'inputAudio', 'input_image',
  'input_audio', 'encrypted_content']);
const canonical = key => key.replace(/[_-]/g, '').toLowerCase();
// `_meta` is the MCP-private transport field. Ordinary application metadata or
// business analysis is public data, not evidence of hidden model reasoning.
const metadataKey = key => /^_meta$/i.test(key)||/^privatemetadata$/.test(canonical(key));
const privateKey = key => /^(?:privateanalysis|privatereasoning|reasoning|chainofthought)$/.test(canonical(key));
const binaryKey = key => /^(?:base64|blob|image|audio|imageurl|audiourl|imagedata|audiodata|encryptedcontent)$/.test(canonical(key));
const absent = reason => ({ available: false, text: '', format: 'text', redacted: false,
  truncated: false, totalChars: 0, reason });
class Hidden extends Error {}
const fail = reason => { throw new Hidden(reason); };
const safeReason = error => error instanceof Hidden ? error.message : '无法安全读取此原生工具内容';
const context = () => ({ nodes: 0, bytes: 0, ancestors: new Set(), notes: new Set(), changed: false });
function touch(ctx, depth = 0) {
  if (++ctx.nodes > MAX_NODES) fail('内容超过节点读取预算，未展示；请在原生客户端查看');
  if (depth > MAX_DEPTH) fail('内容结构过深，超过安全读取上限，未展示');
}
function charge(ctx, text) {
  if (text.length > MAX_BYTES || (ctx.bytes += Buffer.byteLength(text)) > MAX_BYTES)
    fail('内容超过512KB完整详情读取上限，未展示；请在原生客户端查看');
}
function omit(ctx, kind) {
  ctx.changed = true;
  ctx.notes.add({ metadata: '已省略私有元信息（metadata）', binary: '已省略非文本或二进制内容',
    private: '内部推理或分析内容不展示', unknown: '已省略未知或不支持的字段/内容' }[kind]);
}
function fieldKind(key) {
  return metadataKey(key) ? 'metadata' : privateKey(key) ? 'private' : binaryKey(key) ? 'binary' : secretKey.test(key) ? 'secret' : null;
}
const placeholder = kind => ({ metadata: '[私有元信息已省略]', binary: '[非文本内容已省略]',
  private: '[内部推理内容不展示]', secret: '[已脱敏]' }[kind]);
function own(object, key) {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (descriptor && !('value' in descriptor)) fail('内容包含无法安全读取的访问器字段');
  return descriptor?.value;
}

// These are target checks, not filesystem reads or permission grants. In
// particular, query/text examples are not interpreted as actual tool targets.
function checkTarget(value, base) {
  if (typeof value !== 'string' || !value) return;
  let target = value;
  if (/^file:/i.test(target)) {
    try { target = fileURLToPath(target); } catch { fail('文件URI目标未知，不能确认正文可安全公开'); }
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(target)) return;
  if (protectedTarget(target, base) || /(?:^|[/\\])keychains?(?:[/\\]|$)|\.keychain(?:-db)?(?:$|[/\\])/i.test(target))
    fail('参数涉及受保护配置、凭据或技能资源，不同步请求及结果正文');
}
function checkCommand(value, base) {
  if (Array.isArray(value) && value.length > MAX_NODES) fail('命令参数超过节点读取预算，未展示');
  const command = Array.isArray(value) && value.every(part => typeof part === 'string') ? value.join(' ') : value;
  if (typeof command !== 'string') fail('命令参数结构未知，不能确认结果可安全公开');
  // The shared shell tokenizer is bounded to 8K; never treat an unchecked tail
  // as safe. This reuses its protection only, not shell's display permissions.
  if (command.length > MAX_COMMAND) fail('命令超过安全检查上限，未展示请求及结果正文');
  const policy = detailPolicy('shell', { command, cwd: base });
  if (policy.blocked) fail(policy.reason);
}
function directoryTarget(value, base) {
  checkTarget(value, base);
  let target = normalize(value).replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/, homedir()).replace(/\\/g, '/');
  if (/^file:/i.test(target)) {
    try { target = fileURLToPath(target); } catch { fail('工作目录文件URI未知，不能安全确认上下文'); }
  } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(target)) fail('工作目录不是本地路径，不能安全确认上下文');
  const directory = resolve(base, target);
  checkTarget(directory, '.');
  return directory;
}
function inheritedBase(value, base, ctx) {
  const candidates = new Set();
  for (const key in value) if (Object.hasOwn(value, key)) {
    touch(ctx); checkKey(key);
    if (!baseKeys.has(canonical(key))) continue;
    const candidate = own(value, key);
    if (candidate == null) continue;
    if (typeof candidate !== 'string') fail('工作目录参数结构未知，不能安全确认上下文');
    candidates.add(directoryTarget(candidate, base));
    if (candidates.size > 1) fail('工作目录别名不一致，无法安全确认结果可公开');
  }
  return candidates.size ? candidates.values().next().value : base;
}

const normalize = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
const wordCode = code => code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code === 95;
const segmentCode = code => wordCode(code) || code === 45;
function redactBareCredentials(text) {
  let at = 0, previous, beforePrevious, cuts;
  function cover(start, end) {
    // Lazy, bounded interval union avoids both sorting and overlapping suffix
    // rescans. Allocate only when a credential was actually recognized.
    cuts ??= new Uint32Array(text.length);
    if (end > cuts[start]) cuts[start] = end;
  }
  while (at < text.length) {
    if (!segmentCode(text.charCodeAt(at))) { at++; continue; }
    const start = at;
    let jwt = -1, sk = -1, lastWordEnd = start;
    while (at < text.length && segmentCode(text.charCodeAt(at))) {
      if (text.charCodeAt(at) === 45) { at++; continue; }
      const wordStart = at;
      do { at++; } while (at < text.length && wordCode(text.charCodeAt(at)));
      lastWordEnd = at;
      // A JS-regexp word boundary can begin a candidate only at the segment's
      // first word or just after '-'. Do not retry eyJ inside the same word.
      if (jwt === -1 && text.startsWith('eyJ', wordStart)) jwt = wordStart;
      if (sk === -1 && at - wordStart === 2 && text.startsWith('sk-', wordStart)) sk = wordStart;
      if (at - wordStart >= 16 && text.startsWith('gh', wordStart) &&
          'pousr'.includes(text[wordStart + 2]) && text[wordStart + 3] === '_') cover(wordStart, at);
    }
    if (sk !== -1 && lastWordEnd - sk - 3 >= 8) cover(sk, lastWordEnd);
    // Keep only two look-behind segments. Even a failed eyJ-... segment is read
    // once; valid JWTs still require two literal dots and nonempty payloads.
    if (beforePrevious?.jwt >= 0 && beforePrevious.end - beforePrevious.jwt > 3 &&
        text[beforePrevious.end] === '.' && beforePrevious.end + 1 === previous.start &&
        text[previous.end] === '.' && previous.end + 1 === start && lastWordEnd > start) {
      cover(beforePrevious.jwt, lastWordEnd);
    }
    beforePrevious = previous;
    previous = { start, end: at, jwt };
  }
  if (!cuts) return text;
  const chunks = []; let last = 0;
  for (let index = 0; index < text.length;) {
    if (!cuts[index]) { index++; continue; }
    const start = index; let end = cuts[index++];
    while (index < end) { if (cuts[index] > end) end = cuts[index]; index++; }
    chunks.push(text.slice(last, start), '[凭据已脱敏]'); last = end;
  }
  return chunks.join('') + text.slice(last);
}
const whitespace = char => char !== undefined && /\s/.test(char);
function skipSpace(text, index) { while (index < text.length && whitespace(text[index])) index++; return index; }
function checkKey(key) { if (key.length > MAX_KEY) fail('字段名超过1024字符安全读取预算，未展示'); }
function quoteEnd(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}
const decode = text => text[0] === '"' ? JSON.parse(text) : text.slice(1, -1)
  .replace(/\\(["'\\])/g, '$1').replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
const encode = (text, quote) => quote === '"' ? JSON.stringify(text) : "'" + text.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
function mark(ctx, kind) { if (kind === 'secret') ctx.changed = true; else omit(ctx, kind); }
function valueEnd(text, start, ctx) {
  if (text[start] === '"' || text[start] === "'") return quoteEnd(text, start);
  if (!['{', '['].includes(text[start])) {
    let end = start;
    while (end < text.length && !/[,;}\]\r\n]/.test(text[end])) end++;
    return end;
  }
  const stack = [];
  for (let i = start; i < text.length; i++) {
    if (text[i] === '"' || text[i] === "'") { i = quoteEnd(text, i) - 1; continue; }
    if (text[i] === '{' || text[i] === '[') { stack.push(text[i]); touch(ctx, stack.length); }
    else if (text[i] === '}' || text[i] === ']') {
      if (stack.pop() !== (text[i] === '}' ? '{' : '[')) return text.length;
      if (!stack.length) return i + 1;
    }
  }
  return text.length;
}

class InvalidJson extends Error {}
// Range-only JSON parser: no JSON number is converted to a JS Number, and no
// ordinary JSON document is reprinted. String values are decoded only when used.
function jsonRange(text, start, ctx, depth = 0) {
  let at = start;
  const invalid = () => { throw new InvalidJson(); };
  function string() {
    const begin = at, end = quoteEnd(text, at);
    if (text[end - 1] !== '"' || end === begin + 1) invalid();
    at = end; return { kind: 'string', start: begin, end };
  }
  function node(level) {
    touch(ctx, level); at = skipSpace(text, at);
    const begin = at, char = text[at];
    if (char === '"') return string();
    if (char === '{' || char === '[') {
      const fields = [], children = [], close = char === '{' ? '}' : ']';
      at = skipSpace(text, at + 1);
      if (text[at] !== close) for (;;) {
        if (char === '{') {
          if (text[at] !== '"') invalid();
          const keyNode = string(); checkKey(text.slice(keyNode.start + 1, keyNode.end - 1));
          let key; try { key = normalize(JSON.parse(text.slice(keyNode.start, keyNode.end))); } catch { invalid(); }
          checkKey(key); at = skipSpace(text, at);
          if (text[at++] !== ':') invalid();
          fields.push({ key, keyNode, value: node(level + 1) });
        } else children.push(node(level + 1));
        at = skipSpace(text, at);
        if (text[at] === close) break;
        if (text[at++] !== ',') invalid();
        at = skipSpace(text, at);
      }
      at++;
      return { kind: char === '{' ? 'object' : 'array', start: begin, end: at, fields, children };
    }
    for (const literal of ['true', 'false', 'null']) if (text.startsWith(literal, at)) {
      at += literal.length; return { kind: 'literal', start: begin, end: at };
    }
    if (text[at] === '-') at++;
    if (text[at] === '0') at++;
    else {
      if (!/[1-9]/.test(text[at] || '')) invalid();
      while (at < text.length && /\d/.test(text[at])) at++;
    }
    if (text[at] === '.') {
      at++; if (!/\d/.test(text[at] || '')) invalid();
      while (at < text.length && /\d/.test(text[at])) at++;
    }
    if (text[at] === 'e' || text[at] === 'E') {
      at++; if (text[at] === '+' || text[at] === '-') at++;
      if (!/\d/.test(text[at] || '')) invalid();
      while (at < text.length && /\d/.test(text[at])) at++;
    }
    return { kind: 'literal', start: begin, end: at };
  }
  return node(depth);
}
function checkJsonTextBudget(text, ctx) {
  if (!/^\s*[\[{]/.test(text)) return;
  // Invalid JSON still takes at most one parser pass, then the linear text path.
  try { jsonRange(text, skipSpace(text, 0), ctx); } catch (error) { if (!(error instanceof InvalidJson)) throw error; }
}
function isBinary(value) { return typeof value === 'string' && binaryKinds.has(normalize(value)); }
function renderJson(text, node, ctx, depth) {
  if (node.kind === 'string') {
    let value; try { value = JSON.parse(text.slice(node.start, node.end)); } catch { throw new InvalidJson(); }
    const filtered = scrubText(value, ctx, depth + 1);
    return filtered === value ? text.slice(node.start, node.end) : JSON.stringify(filtered);
  }
  if (node.kind === 'literal') return text.slice(node.start, node.end);
  if (node.kind === 'object') {
    const type = node.fields.find(field => field.key === 'type')?.value;
    if (type?.kind === 'string') {
      let value; try { value = JSON.parse(text.slice(type.start, type.end)); } catch { throw new InvalidJson(); }
      if (isBinary(value)) { omit(ctx, 'binary'); return JSON.stringify(placeholder('binary')); }
    }
  }
  const chunks = []; let last = node.start;
  for (const entry of node.kind === 'object' ? node.fields : node.children.map(value => ({ value }))) {
    if (entry.keyNode) {
      const keyText = renderJson(text, entry.keyNode, ctx, depth);
      chunks.push(text.slice(last, entry.keyNode.start), keyText); last = entry.keyNode.end;
    }
    const kind = entry.key === undefined ? null : fieldKind(entry.key);
    const value = kind ? JSON.stringify(placeholder(kind)) : renderJson(text, entry.value, ctx, depth + 1);
    if (kind) mark(ctx, kind);
    chunks.push(text.slice(last, entry.value.start), value); last = entry.value.end;
  }
  return chunks.join('') + text.slice(last, node.end);
}
function publicUrl(raw, ctx) {
  try {
    const url = new URL(raw), params = new URLSearchParams(); let changed = false, queryChanged = false;
    if (url.username || url.password) { url.username = ''; url.password = ''; changed = true; }
    // Build once; URLSearchParams.set per field repeatedly scans the whole
    // query and makes many unique credential keys quadratic.
    for (const [key, value] of url.searchParams) {
      touch(ctx); checkKey(key);
      const sensitive = secretKey.test(key);
      params.append(key, sensitive ? '[已脱敏]' : value);
      if (sensitive) { changed = true; queryChanged = true; }
    }
    if (!changed) return raw;
    if (queryChanged) url.search = params.toString();
    ctx.changed = true; url.hash = ''; return url.toString();
  } catch (error) {
    if (error instanceof Hidden) throw error;
    ctx.changed = true; return '[地址已隐藏]';
  }
}
function plainText(text, ctx, depth) {
  const chunks = []; let last = 0, at = 0, lower;
  function replace(start, end, value) { chunks.push(text.slice(last, start), value); last = end; at = end; ctx.changed = true; }
  while (at < text.length) {
    if (text[at] === '{' || text[at] === '[') {
      try {
        const node = jsonRange(text, at, ctx, depth), raw = text.slice(at, node.end), value = renderJson(text, node, ctx, depth);
        if (raw !== value) replace(at, node.end, value); else at = node.end;
        continue;
      } catch (error) { if (!(error instanceof InvalidJson)) throw error; }
    }
    if (text.startsWith('-----BEGIN ', at)) {
      const headerEnd = text.indexOf('-----', at + 11);
      if (headerEnd !== -1 && headerEnd - at < 120 && /PRIVATE KEY|CERTIFICATE/.test(text.slice(at, headerEnd))) {
        const end = text.indexOf('-----END ', headerEnd + 5), close = end === -1 ? -1 : text.indexOf('-----', end + 9);
        replace(at, close === -1 ? text.length : close + 5, '[密钥材料已隐藏]'); continue;
      }
    }
    if (text[at] === '<') {
      let end = at + 1; while (end < text.length && /[A-Za-z_]/.test(text[end])) end++;
      const tag = text.slice(at + 1, end).toLowerCase();
      if (['analysis', 'private_reasoning', 'reasoning', 'chain_of_thought'].includes(tag) && /[\s>]/.test(text[end] || '')) {
        lower ??= text.toLowerCase();
        const close = lower.indexOf('</' + tag, end), closeEnd = close === -1 ? -1 : text.indexOf('>', close);
        omit(ctx, 'private'); replace(at, closeEnd === -1 ? text.length : closeEnd + 1, placeholder('private')); continue;
      }
    }
    const begin = at, quoted = text[at] === '"' || text[at] === "'";
    let end = at;
    if (quoted) end = quoteEnd(text, at);
    else if (/[A-Za-z0-9_+.-]/.test(text[at])) { end++; while (end < text.length && /[A-Za-z0-9_+.-]/.test(text[end])) end++; }
    else { at++; continue; }
    const after = skipSpace(text, end);
    if (!quoted && text[end] === ':' && text.slice(end + 1, end + 3) === '//') {
      let stop = end + 3; while (stop < text.length && !/[\s"'<>]/.test(text[stop])) stop++;
      const raw = text.slice(begin, stop), value = publicUrl(raw, ctx);
      if (value !== raw) replace(begin, stop, value); else at = stop;
      continue;
    }
    const raw = text.slice(begin, end);
    if (!quoted && /^data$/i.test(raw) && text[end] === ':' && /^(?:image\/|audio\/|application\/octet-stream)/i.test(text.slice(end + 1, end + 40))) {
      let stop = end + 1; while (stop < text.length && !/[\s"'<>]/.test(text[stop])) stop++;
      omit(ctx, 'binary'); replace(begin, stop, placeholder('binary')); continue;
    }
    if (!quoted && /^Bearer$/i.test(raw) && after > end) {
      let stop = after; while (stop < text.length && !/[\s"',;}]/.test(text[stop])) stop++;
      if (stop > after) { replace(begin, stop, 'Bearer [已脱敏]'); continue; }
    }
    if (!quoted && raw.startsWith('--') && /(?:token|password|secret|key)$/i.test(raw) && (after > end || text[end] === '=')) {
      const start = text[end] === '=' ? end + 1 : after;
      let stop = start;
      if (text[start] === '"' || text[start] === "'") stop = quoteEnd(text, start);
      else while (stop < text.length && !/[\s;|&]/.test(text[stop])) stop++;
      replace(begin, stop, raw + ' [已脱敏]'); continue;
    }
    if (text[after] === ':' || text[after] === '=') {
      checkKey(raw);
      let key; try { key = quoted ? normalize(decode(raw)) : raw; } catch { key = raw.slice(1, -1); }
      const kind = fieldKind(key);
      if (kind) {
        touch(ctx, depth); mark(ctx, kind);
        const start = skipSpace(text, after + 1);
        let stop = valueEnd(text, start, ctx);
        if (/^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/i.test(key)) {
          const newline = text.indexOf('\n', start); stop = newline === -1 ? text.length : newline;
        }
        replace(start, stop, quoted ? JSON.stringify(placeholder(kind)) : placeholder(kind)); continue;
      }
    }
    if (quoted) {
      let value;
      try { value = decode(raw); } catch { value = raw.slice(1, raw.endsWith(text[begin]) ? -1 : undefined); }
      const filtered = scrubText(value, ctx, depth + 1);
      if (filtered !== value) replace(begin, end, encode(filtered, text[begin])); else at = end;
    } else at = end;
  }
  return chunks.length ? chunks.join('') + text.slice(last) : text;
}

// Normalize before every credential pass, including each decoded JSON string.
// Nothing is interned/restored after filtering. Numeric JSON spans are untouched.
function scrubText(raw, ctx, depth = 0) {
  touch(ctx, depth);
  let text = redactBareCredentials(normalize(raw));
  if (text !== raw) ctx.changed = true;
  const start = skipSpace(text, 0);
  if (text[start] === '{' || text[start] === '[') {
    try {
      const node = jsonRange(text, start, ctx, depth);
      return text.slice(0, start) + renderJson(text, node, ctx, depth) + plainText(text.slice(node.end), ctx, depth);
    } catch (error) { if (!(error instanceof InvalidJson)) throw error; }
  }
  return plainText(text, ctx, depth);
}

function prepare(value, ctx, { scan = false, base = '.', target = false, depth = 0 } = {}) {
  touch(ctx, depth);
  if (typeof value === 'string') {
    charge(ctx, value);
    if (scan && (target || /^file:/i.test(value))) checkTarget(value, base);
    return scan ? undefined : scrubText(value, ctx, depth);
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return scan ? undefined : value;
  if (!value || typeof value !== 'object') fail('内容不是受支持的JSON数据，不能安全展示');
  if (ctx.ancestors.has(value)) fail('内容包含循环结构，不能安全展示');
  ctx.ancestors.add(value);
  if (!scan && isBinary(own(value, 'type'))) { omit(ctx, 'binary'); ctx.ancestors.delete(value); return placeholder('binary'); }
  const localBase = scan && !Array.isArray(value) ? inheritedBase(value, base, ctx) : base;
  const result = scan ? null : Array.isArray(value) ? [] : Object.create(null);
  if (Array.isArray(value) && value.length > MAX_NODES) fail('内容超过节点读取预算，未展示');
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    touch(ctx, depth); checkKey(key); charge(ctx, key);
    const kind = fieldKind(key), canonicalKey = canonical(key);
    if (kind && !scan) {
      mark(ctx, kind);
      if (kind === 'secret' || kind === 'private') result[key] = placeholder(kind);
      continue;
    }
    const child = own(value, key);
    if (scan && ['command', 'cmd'].includes(canonicalKey)) checkCommand(child, localBase);
    const next = prepare(child, ctx, { scan, base: localBase, depth: depth + 1,
      target: Array.isArray(value) && target || targetKeys.has(canonicalKey) || baseKeys.has(canonicalKey) });
    if (!scan) result[key] = next;
  }
  ctx.ancestors.delete(value);
  return result;
}

function scanArguments(value, ctx, base) {
  base = directoryTarget(base, '.');
  const safety = context();
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    // The raw string and its safety-only parsed view are the same bytes, not
    // two public payloads. Account for either once, not their combined size.
    charge(context(), value);
    // Parse only for target safety; the original string is the displayed value.
    // Preflight nesting before JSON.parse so a malicious depth is not expanded.
    checkJsonTextBudget(value, safety);
    let parsed;
    try { parsed = JSON.parse(value); } catch { fail('请求参数JSON结构未知，不能确认结果可安全公开'); }
    prepare(parsed, safety, { scan: true, base });
    return scrubText(value, ctx);
  }
  // Security scanning traverses even hidden metadata/typed objects, but never
  // copies/sanitizes their binary bytes into a display value. Rendering is a
  // separate pass and may omit them without weakening the target scan.
  prepare(value, safety, { scan: true, base });
  return prepare(value, ctx);
}

function completeText(raw, ctx, format = 'text', filtered = false) {
  if (!raw.length) return { ...absent('工具已返回，但未提供可展示的文本结果'), reason: [...ctx.notes].join('；') || '工具已返回，但未提供可展示的文本结果' };
  if (raw.length > MAX_BYTES || Buffer.byteLength(raw) > MAX_BYTES) return absent('内容超过512KB完整详情读取上限，未展示；请在原生客户端查看');
  const text = filtered ? raw : scrubText(raw, ctx);
  if (Buffer.byteLength(text) > MAX_BYTES) return absent('脱敏后的内容超过512KB完整详情读取上限，未展示；请在原生客户端查看');
  return { available: true, format, text, redacted: text !== raw || ctx.changed, truncated: false,
    totalChars: text.length, reason: [...ctx.notes].join('；') };
}
function noteFields(value, allowed, ctx) {
  if (!value || typeof value !== 'object') return;
  for (const key in value) if (Object.hasOwn(value, key)) {
    touch(ctx);
    if (metadataKey(key)) omit(ctx, 'metadata');
    else if (!allowed.has(key)) omit(ctx, 'unknown');
  }
}
function contentTexts(items, textKind, ctx) {
  if (items == null) return [];
  if (!Array.isArray(items)) { omit(ctx, 'unknown'); return []; }
  if (items.length > MAX_NODES) fail('内容超过节点读取预算，未展示');
  const texts = [];
  for (const item of items) {
    touch(ctx);
    if (item?.type === textKind && typeof item.text === 'string') {
      noteFields(item, new Set(['type', 'text']), ctx);
      texts.push(prepare(item.text, ctx));
    } else omit(ctx, binaryKinds.has(item?.type) || item?.type === 'resource' ? 'binary' : 'unknown');
  }
  return texts;
}
function resultDetail(item, errorText) {
  const ctx = context(), parts = []; let format = 'text';
  try {
    if (errorText) parts.push(prepare(errorText, ctx));
    if (item.type === 'mcpToolCall') {
      noteFields(item.error, new Set(['message']), ctx);
      const result = item.result;
      noteFields(result, new Set(['content', 'structuredContent']), ctx);
      if (result) {
        parts.push(...contentTexts(result.content, 'text', ctx));
        if (result.structuredContent != null) {
          const value = prepare(result.structuredContent, ctx);
          const structured = typeof value === 'string' ? null : completeText(JSON.stringify(value, null, 2), ctx, 'json');
          if (structured && !structured.available) fail(structured.reason);
          if (structured?.redacted) ctx.changed = true;
          const text = typeof value === 'string' ? value : structured.text;
          if (parts.length) parts.push('[structuredContent]\n' + text);
          else { parts.push(text); format = typeof value === 'string' ? 'text' : 'json'; }
        }
      }
    } else if (item.type === 'dynamicToolCall') {
      parts.push(...contentTexts(item.contentItems, 'inputText', ctx));
    } else if (typeof item.output === 'string') parts.push(prepare(item.output, ctx));
    else parts.push(...contentTexts(item.output, 'input_text', ctx));
    // Each text/error/structured section already crossed the native boundary.
    // Joining sections only validates the combined byte cap.
    return completeText(parts.join('\n'), ctx, format, true);
  } catch (error) { return absent(safeReason(error)); }
}
function label(value, fallback) {
  if (typeof value !== 'string' || value.length > 1024) return fallback;
  try {
    return scrubText(value, context()).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) || fallback;
  } catch { return fallback; }
}
function publicError(text) {
  try {
    const ctx = context(), result = completeText(prepare(text, ctx), ctx, 'text', true);
    return result.available ? result.text.slice(0, 1000) : '';
  } catch { return ''; }
}

/** Complete public text for other genuine native items. Shares MCP's bounded,
 * range-preserving scanner; there is no opaque run shielding/restoration. */
export function nativeTextPreview(value,{format='text'}={}){
  try {
    if (value === undefined) return absent('工具未提供文本内容');
    const ctx = context(), raw = typeof value === 'string' ? value : JSON.stringify(prepare(value, ctx), null, 2);
    return completeText(raw, ctx, format);
  } catch (error) { return absent(safeReason(error)); }
}

/** Pure mapping for genuine Codex 0.166 item kinds, never a name-based allowlist. */
export function nativeExternalTool(item, directory = '.') {
  if (!kinds.has(item?.type)) return null;
  const isMcp = item.type === 'mcpToolCall', isOutput = item.type === 'functionCallOutput';
  const tool = label(isOutput ? item.name : item.tool, '原生工具');
  const source = label(isMcp ? item.server : item.namespace, isMcp ? 'MCP' : '');
  const toolName = [source, tool].filter(Boolean).join(' · ');
  const errorText = isMcp && typeof item.error?.message === 'string' ? item.error.message : '';
  const status = isOutput ? 'completed' : item.status === 'failed' || !isMcp && item.success === false || isMcp && item.error != null ? 'failed' :
    item.status === 'completed' ? 'completed' : 'running';
  let policy = { blocked: false, reason: '' }, request;
  try {
    checkTarget(directory, '.');
    if (isOutput) request = absent('原生function output不包含请求参数');
    else {
      if (!Object.hasOwn(item, 'arguments')) fail('缺少请求参数，不能确认结果可安全公开');
      const ctx = context(), arguments_ = scanArguments(item.arguments, ctx, directory);
      const input = isMcp ? { server: source, tool, arguments: arguments_ } : { namespace: source, tool, arguments: arguments_ };
      request = completeText(JSON.stringify(input, null, 2), ctx, 'json');
      if (!request.available) fail(request.reason);
    }
  } catch (error) { policy = { blocked: true, reason: safeReason(error) }; request = absent(policy.reason); }
  const result = policy.blocked ? absent(policy.reason) : status === 'running' ? absent(item.status === 'inProgress' ?
    '工具尚未返回结果' : '原生工具状态未知，尚未确认结果已返回') : resultDetail(item, errorText);
  const publicInfo = { summary: toolName, detail: policy.blocked ? policy.reason : status === 'running' ?
    '原生工具正在执行或状态待确认；请求及返回正文不进入广播。' : '原生工具已返回；展开读取已脱敏文本详情，正文不进入广播。' };
  // input intentionally contains identity only. Full bodies live solely in the
  // authenticated detail payload, not content/publicInfo or duplicate raw input.
  const input = isMcp ? { server: source, tool } : { namespace: source, tool };
  const output = { name: isMcp ? 'mcp' : 'native-tool', input, content: [], status, policy, publicInfo,
    detail: { toolId: typeof item.id === 'string' ? item.id : '', toolName, status, request, result } };
  if (status === 'failed') output.error = !policy.blocked && result.available && errorText ?
    publicError(errorText) || '原生工具执行失败；未提供公开错误' : '原生工具执行失败；详情受限或未提供公开错误';
  return output;
}

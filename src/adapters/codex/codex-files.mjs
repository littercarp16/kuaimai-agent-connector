import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, realpath, unlink, writeFile } from 'node:fs/promises';
import { FILE_LIMITS, normalizeUploads, workspacePath, readWorkspaceReference } from '../../tools/prompt-files.mjs';
import { detailPolicy } from '../../tools/tool-details.mjs';

export const INLINE_TEXT_MAX_BYTES = 128 * 1024;
const PREVIEW_CHARS = 32 * 1024;
const STAGED_PREFIX_RE = /^[0-9a-f]{16}-(.+)$/;
const ATTACHMENT_HEADER_RE = /^【(快麦附件|工作区文件)：([^\r\n]{1,260}) \(([^)\r\n]{1,70})\)】\n/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '__pycache__', 'target']);
const SUPPORTED_EXT = new Set([
  '.txt', '.md', '.csv', '.json', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.vue', '.css', '.html', '.xml', '.yaml', '.yml', '.log',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf',
]);
const IMAGE_MIMES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_STAGED_FILES = 100;
const MAX_STAGED_AGE_MS = 24 * 60 * 60 * 1000;

function defaultUploadDir() {
  const suffix = typeof process.getuid === 'function' ? String(process.getuid()) : 'user';
  return path.join(tmpdir(), `kuaimai-codex-uploads-${suffix}`);
}

function sanitizeFileName(name) {
  const base = path.basename(String(name || 'attachment')).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').trim();
  const ext = path.extname(base).slice(0, 16);
  const stem = base.slice(0, base.length - ext.length).replace(/^\.+/, '') || 'attachment';
  return stem.slice(0, 64) + ext;
}

function parseDataUri(uri) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(uri || ''));
  if (!match) throw Error('附件数据编码无效');
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
}

function formatAttachmentBlock(kind, name, mime, body) {
  return `【${kind}：${name} (${mime})】\n${body}`;
}

export function parseAttachmentBlock(text) {
  if (typeof text !== 'string') return null;
  const match = ATTACHMENT_HEADER_RE.exec(text);
  if (!match) return null;
  return { kind: match[1], name: match[2], mime: match[3] };
}

export function displayLocalImage(filePath, directory) {
  const raw = String(filePath || '');
  const base = path.basename(raw);
  const stripped = STAGED_PREFIX_RE.exec(base)?.[1];
  let name = stripped || base || '图片';
  if (!stripped && directory && path.isAbsolute(raw)) {
    const rel = path.relative(directory, raw);
    if (rel && !path.isAbsolute(rel) && !rel.startsWith('..')) name = rel.split(path.sep).join('/');
  }
  const mime = IMAGE_MIMES[path.extname(name).toLowerCase()] || 'image/png';
  return { name, mime };
}

export function displayImageUrl(url) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(String(url || ''));
  return { name: '图片', mime: match ? match[1].toLowerCase() : 'image/png' };
}

async function ensurePrivateUploadDir(target) {
  const dir = path.resolve(target || defaultUploadDir());
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    const info = await lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) {
      throw Error('附件暂存目录不安全');
    }
    await chmod(dir, 0o700);
  }
  return realpath(dir);
}

async function pruneUploadDir(dir, now = Date.now) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = [];
    const cutoff = now() - MAX_STAGED_AGE_MS;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const info = await lstat(full).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink()) continue;
      if (info.mtimeMs < cutoff) {
        await unlink(full).catch(() => {});
      } else {
        files.push({ full, mtimeMs: info.mtimeMs });
      }
    }
    if (files.length > MAX_STAGED_FILES) {
      files.sort((a, b) => a.mtimeMs - b.mtimeMs);
      for (const old of files.slice(0, files.length - MAX_STAGED_FILES)) {
        await unlink(old.full).catch(() => {});
      }
    }
  } catch { /* Opportunistic cleanup must not block sends. */ }
}

async function stageBytes(dir, name, bytes) {
  const safe = sanitizeFileName(name);
  const filePath = path.join(dir, `${randomBytes(8).toString('hex')}-${safe}`);
  await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
  return filePath;
}

export async function cleanupStagedFiles(paths = []) {
  await Promise.all((paths || []).map(filePath => unlink(filePath).catch(() => {})));
}

export async function buildCodexInput({ text, uploads = [], references = [], directory, uploadDir, now = Date.now }) {
  if (uploads.length + references.length > FILE_LIMITS.count) throw Error('最多添加5项附件或引用');
  const normalizedUploads = normalizeUploads(uploads);
  const input = [{ type: 'text', text, text_elements: [] }];
  const stagedPaths = [];
  const fileSummary = [];
  let totalBytes = 0;
  let resolvedUploadDir = null;

  const getUploadDir = async () => {
    if (!resolvedUploadDir) {
      resolvedUploadDir = await ensurePrivateUploadDir(uploadDir);
      void pruneUploadDir(resolvedUploadDir, now);
    }
    return resolvedUploadDir;
  };

  try {
    for (const item of normalizedUploads) {
      const { mime, bytes } = parseDataUri(item.uri);
      totalBytes += bytes.length;
      if (totalBytes > FILE_LIMITS.total) throw Error('附件合计不能超过20MiB');
      fileSummary.push({ name: item.name, mime });
      if (mime.startsWith('image/')) {
        const dir = await getUploadDir();
        const filePath = await stageBytes(dir, item.name, bytes);
        stagedPaths.push(filePath);
        input.push({ type: 'localImage', path: filePath });
      } else if (mime === 'text/plain') {
        const content = bytes.toString('utf8');
        if (bytes.length <= INLINE_TEXT_MAX_BYTES) {
          input.push({ type: 'text', text: formatAttachmentBlock('快麦附件', item.name, mime, content), text_elements: [] });
        } else {
          const dir = await getUploadDir();
          const filePath = await stageBytes(dir, item.name, bytes);
          stagedPaths.push(filePath);
          const body = `文件较大（${bytes.length} 字节），已保存到本地路径：${filePath}\n\n前 ${PREVIEW_CHARS} 字符预览：\n${content.slice(0, PREVIEW_CHARS)}`;
          input.push({ type: 'text', text: formatAttachmentBlock('快麦附件', item.name, mime, body), text_elements: [] });
        }
      } else {
        const dir = await getUploadDir();
        const filePath = await stageBytes(dir, item.name, bytes);
        stagedPaths.push(filePath);
        const body = `PDF 附件（${bytes.length} 字节），已保存到本地路径：${filePath}`;
        input.push({ type: 'text', text: formatAttachmentBlock('快麦附件', item.name, mime, body), text_elements: [] });
      }
    }

    for (const ref of references) {
      const checked = await workspacePath(directory, ref);
      const read = await readWorkspaceReference(directory, ref);
      const { mime, bytes } = parseDataUri(read.uri);
      totalBytes += bytes.length;
      if (totalBytes > FILE_LIMITS.total) throw Error('附件与引用合计不能超过20MiB');
      fileSummary.push({ name: checked.rel, mime });
      if (mime.startsWith('image/')) {
        input.push({ type: 'localImage', path: checked.file });
      } else if (mime === 'text/plain') {
        const content = bytes.toString('utf8');
        if (bytes.length <= INLINE_TEXT_MAX_BYTES) {
          const body = `工作区相对路径：${checked.rel}\n\n${content}`;
          input.push({ type: 'text', text: formatAttachmentBlock('工作区文件', checked.rel, mime, body), text_elements: [] });
        } else {
          const body = `工作区相对路径：${checked.rel}（共 ${bytes.length} 字节，超出直接内联上限，请直接读取该工作区文件）\n\n前 ${PREVIEW_CHARS} 字符预览：\n${content.slice(0, PREVIEW_CHARS)}`;
          input.push({ type: 'text', text: formatAttachmentBlock('工作区文件', checked.rel, mime, body), text_elements: [] });
        }
      } else {
        const body = `工作区 PDF 文件：${checked.rel}（${bytes.length} 字节）`;
        input.push({ type: 'text', text: formatAttachmentBlock('工作区文件', checked.rel, mime, body), text_elements: [] });
      }
    }

    return { input, stagedPaths, fileSummary };
  } catch (error) {
    await cleanupStagedFiles(stagedPaths);
    throw error;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function searchDirectoryFiles(directory, query = '', {
  maxDepth = 8,
  maxVisited = 5000,
  maxDirs = 600,
  maxMatches = 200,
  limit = 20,
} = {}) {
  if (typeof query !== 'string' || query.length > 200) throw Error('搜索关键词无效');
  const root = await realpath(directory);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory()) throw Error('工作区目录无效');
  const needle = query.trim().toLowerCase();
  const queue = [{ dir: root, depth: 0 }];
  const matches = [];
  let visited = 0;
  let dirsVisited = 0;

  while (queue.length && visited < maxVisited && matches.length < maxMatches) {
    const { dir, depth } = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (visited >= maxVisited || matches.length >= maxMatches) break;
      visited++;
      if (!entry.name || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth || dirsVisited >= maxDirs || SKIP_DIRS.has(entry.name)) continue;
        if (detailPolicy('read', { path: full }).blocked) continue;
        dirsVisited++;
        queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXT.has(ext)) continue;
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!rel || rel.startsWith('..')) continue;
      const lowerRel = rel.toLowerCase();
      const lowerBase = entry.name.toLowerCase();
      if (needle && !lowerRel.includes(needle)) continue;
      if (detailPolicy('read', { path: full }).blocked) continue;
      const info = await lstat(full).catch(() => null);
      if (!info || !info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > FILE_LIMITS.each) continue;
      const score = !needle ? 0 : lowerBase.startsWith(needle) ? 0 : lowerBase.includes(needle) ? 1 : 2;
      matches.push({ path: rel, hint: formatSize(info.size), score, depth });
    }
  }

  matches.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path));
  return matches.slice(0, limit).map(({ path: filePath, hint }) => ({ path: filePath, hint }));
}

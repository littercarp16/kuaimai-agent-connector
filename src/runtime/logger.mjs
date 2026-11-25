import { constants, openSync, closeSync, fstatSync, lstatSync, fchmodSync, readSync, writeSync, ftruncateSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_BACKUPS = 5;
export const nullLogger = Object.freeze({ info() {}, warn() {}, error() {}, close() {} });
const codes = new Set(['EACCES','EPERM','EIO','ENOSPC','ENOENT','EMFILE','ENFILE','EPIPE','ECONNREFUSED','ECONNRESET','ETIMEDOUT','EADDRINUSE','EADDRNOTAVAIL','ENOTFOUND','ABORT_ERR','ERR_STREAM_PREMATURE_CLOSE','ERR_HTTP_HEADERS_SENT','NOT_SUBMITTED','WORKBUDDY_NOT_READY']);

// Upstream error messages can contain prompts, URLs or credentials. Keep only
// diagnostics that do not copy their text, request bodies or response bodies.
export function errorFields(error) {
  const result = { errorType: ['Error','TypeError','RangeError','SyntaxError','AbortError','AggregateError'].includes(error?.name) ? error.name : 'Error' };
  if (codes.has(error?.code)) result.errorCode = error.code;
  const site = typeof error?.stack === 'string' && error.stack.split('\n').slice(1).map(line => line.match(/\/(src\/[\w/.-]+\.m?js:\d+:\d+)\)?$/)?.[1]).find(Boolean);
  if (site) result.errorSite = site.slice(0, 160);
  return result;
}
function fieldsForLog(fields) {
  const result = {};
  for (const key of ['instanceId','requestId','clientId','streamId']) if (/^[a-f\d-]{36}$/i.test(fields[key] || '')) result[key] = fields[key];
  for (const key of ['method','path','reason','action','transport','outcome','signal']) if (typeof fields[key] === 'string' && /^[\w/.-]{1,120}$/.test(fields[key])) result[key] = fields[key];
  for (const key of ['statusCode','durationMs','port','preferredPort','exitCode','maxBytes','backups']) if (Number.isFinite(fields[key])) result[key] = fields[key];
  for (const key of ['origin','endpoint']) if (typeof fields[key] === 'string') {
    try { const url = new URL(fields[key]); if (url.origin === fields[key] && ['http:','https:'].includes(url.protocol)) result[key] = url.origin; } catch {}
  }
  if (fields.error) Object.assign(result, errorFields(fields.error));
  return result;
}
function checkFile(info) {
  if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || info.nlink !== 1) throw Object.assign(Error('Unsafe log file'), { code: 'EPERM' });
}
function checkPath(path) {
  try { checkFile(lstatSync(path)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export function createFileLogger({ path, maxBytes = LOG_MAX_BYTES, backups = LOG_BACKUPS, onError = () => process.stderr.write('kuaimai-agent-connector: log write failed\n') }) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1024 || !Number.isInteger(backups) || backups < 1 || backups > 20) throw Error('Invalid log rotation limits');
  path = resolve(path);
  const directory = lstatSync(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (process.platform !== 'win32' && (directory.uid !== process.getuid() || (directory.mode & 0o022)))) throw Error('Unsafe log directory');
  checkPath(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try { checkFile(fstatSync(fd)); if (process.platform !== 'win32') fchmodSync(fd, 0o600); } catch (error) { closeSync(fd); throw error; }
  let closed = false, warned = false, writeFailures = 0, lastError;
  function rotate() {
    for (let i = 1; i <= backups; i++) checkPath(path + '.' + i);
    // Copy/truncate preserves the inode for tail -f and legacy stdout handles.
    // A pre-existing oversized file contributes only its bounded final lines.
    const size = fstatSync(fd).size, content = Buffer.alloc(Math.min(size, maxBytes));
    const count = readSync(fd, content, 0, content.length, Math.max(0, size - content.length));
    const start = size > maxBytes ? content.indexOf(10) + 1 : 0;
    try { unlinkSync(path + '.' + backups); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (let i = backups - 1; i >= 1; i--) {
      try { renameSync(path + '.' + i, path + '.' + (i + 1)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const archive = openSync(path + '.1', constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeAll(archive, content.subarray(start, count)); } finally { closeSync(archive); }
    ftruncateSync(fd, 0);
  }
  function report(error) { writeFailures++; lastError = errorFields(error); if (!warned) { warned = true; try { onError(lastError); } catch {} } }
  function write(level, event, fields = {}) {
    if (closed) return false;
    try {
      if (!/^[a-z][a-z._]{0,63}$/.test(event)) return false;
      const line = Buffer.from(JSON.stringify({ time: new Date().toISOString(), level, event, pid: process.pid, version, ...fieldsForLog(fields) }) + '\n');
      if (line.length > maxBytes) return false;
      if (fstatSync(fd).size + line.length > maxBytes) rotate();
      const size = fstatSync(fd).size;
      try { writeAll(fd, line); } catch (error) { try { ftruncateSync(fd, size); } catch {} throw error; }
      return true;
    } catch (error) { report(error); return false; }
  }
  const timer = setInterval(() => { if (!closed) try { if (fstatSync(fd).size > maxBytes) rotate(); } catch (error) { report(error); } }, 10000);
  timer.unref();
  return { path, maxBytes, backups,
    status: () => ({ path, maxBytes, backups, writeFailures, ...(lastError ? { lastError } : {}) }),
    info: (event, fields) => write('info', event, fields), warn: (event, fields) => write('warn', event, fields), error: (event, fields) => write('error', event, fields),
    close() { if (closed) return; closed = true; clearInterval(timer); try { closeSync(fd); } catch (error) { report(error); } },
  };
}
function writeAll(fd, buffer) {
  for (let offset = 0; offset < buffer.length;) {
    const count = writeSync(fd, buffer, offset, buffer.length - offset);
    if (!count) throw Object.assign(Error('Log write made no progress'), { code: 'EIO' });
    offset += count;
  }
}

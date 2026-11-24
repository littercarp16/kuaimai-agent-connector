import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile), cache = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => ({ pageContext: false });
const incompatible = () => Object.assign(Error('Codex 会话列表协议不兼容'), { code: 'CODEX_PROTOCOL_INCOMPATIBLE' });

// Inspect only local references. A schema is data, never code or a remote URL.
function resolve(schema, value, depth = 0) {
  if (!record(value) || depth > 12) return null;
  if (value.$ref) {
    const match = /^#\/definitions\/([\w]+)$/.exec(value.$ref);
    return match ? resolve(schema, schema.definitions?.[match[1]], depth + 1) : null;
  }
  if (value.allOf?.length === 1) return resolve(schema, value.allOf[0], depth + 1);
  return value;
}
const typed = (value, type) => value?.type === type || Array.isArray(value?.type) && value.type.includes(type);

export function supportsAdditionalContext(schema) {
  const root = resolve(schema, schema), map = resolve(schema, root?.properties?.additionalContext);
  const entry = resolve(schema, map?.additionalProperties);
  const kind = resolve(schema, entry?.properties?.kind), value = resolve(schema, entry?.properties?.value);
  // Both start and steer must accept the bridge's exact application-context shape.
  return Boolean(typed(map, 'object') && typed(entry, 'object') && typed(kind, 'string') &&
    Array.isArray(kind.enum) && kind.enum.includes('application') && typed(value, 'string') &&
    Array.isArray(entry.required) && entry.required.every(key => ['kind', 'value'].includes(key)));
}

async function binaryIdentity(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) throw Error('invalid binary');
  const actual = await realpath(file), uid = process.getuid?.();
  let current = actual;
  while (true) {
    const info = await lstat(current);
    const temporaryRoot = ['/tmp', '/private/tmp'].includes(current) && info.uid === 0 && (info.mode & 0o1000);
    if (![0, uid].includes(info.uid) || info.isSymbolicLink() ||
      (info.mode & 0o022) && !temporaryRoot || (current === actual ? !info.isFile() || !(info.mode & 0o111) : !info.isDirectory()))
      throw Error('unsafe binary');
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  const info = await lstat(actual, { bigint: true });
  return { actual, key: [actual, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':') };
}

/** Optional feature discovery; failures disable that feature, never the base connection. */
export async function readCodexCapabilities({ schemaBinary, version }, { run = exec } = {}) {
  let directory, identity, key;
  try {
    if (!schemaBinary || !version) return unavailable();
    identity = await binaryIdentity(schemaBinary);
    key = identity.key + ':' + version;
    // The alias may move during an auto-update; a cached result still needs identity verification.
    if (cache.has(key)) return cache.get(key);
    const options = { encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024, shell: false, windowsHide: true };
    const reported = await run(identity.actual, ['--version'], options);
    if (reported.stdout?.trim() !== 'codex-cli ' + version) return unavailable();
    directory = await mkdtemp(path.join(tmpdir(), 'kuaimai-codex-protocol-'));
    await run(identity.actual, ['app-server', 'generate-json-schema', '--experimental', '--out', directory], options);
    const schemas = await Promise.all(['TurnStartParams', 'TurnSteerParams'].map(async name => {
      const file = path.join(directory, 'v2', name + '.json'), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw Error('invalid schema');
      return JSON.parse(await readFile(file, 'utf8'));
    }));
    if ((await binaryIdentity(schemaBinary)).key !== identity.key) return unavailable();
    const result = Object.freeze({ pageContext: schemas.every(supportsAdditionalContext) });
    if (cache.size >= 8) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  } catch { return unavailable(); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {}); }
}

/** No resume, start, steer or approvals are sent while detecting compatibility. */
export async function probeCodexProtocol(rpc, discovery, { readCapabilities = readCodexCapabilities } = {}) {
  let page;
  try { page = await rpc.request('thread/list', { limit: 1, archived: false, useStateDbOnly: true }); }
  catch (error) {
    if (error?.code === 'CODEX_RPC_ERROR' && [-32601, -32602].includes(error.rpcCode)) throw incompatible();
    throw error;
  }
  if (!record(page) || !Array.isArray(page.data) || page.data.length > 1 ||
    !(page.nextCursor == null || typeof page.nextCursor === 'string')) throw incompatible();
  const capabilities = await readCapabilities(discovery).catch(unavailable);
  return Object.freeze({ pageContext: capabilities?.pageContext === true });
}

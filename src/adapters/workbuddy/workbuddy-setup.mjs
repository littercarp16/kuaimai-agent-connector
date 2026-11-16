import { mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safePath, validateConnection, validateRuntimeFile, WorkBuddyError } from './workbuddy-client.mjs';
import {exportAutomaticConfig} from './automatic-setup.mjs';

const json = value => JSON.stringify(value, null, 2) + '\n';
function fail(code) { throw new WorkBuddyError(code); }

export async function exportWorkBuddyConfig({ out, runtimeFile, origin, workspace, dryRun = false }) {
  if (Number(process.versions.node.split('.')[0]) < 22 || !out || !runtimeFile || !origin || !workspace || typeof dryRun !== 'boolean') fail('INVALID_CONFIG');
  const directory = await safePath(resolve(out), { allowMissing: true });
  const config = await validateConnection({ version: 1, runtimeFile: resolve(runtimeFile), origin, workspaceRoot: resolve(workspace) });
  const entry = await safePath(fileURLToPath(new URL('../../../mcp-workbuddy.mjs', import.meta.url)));
  const node = await realpath(process.execPath);
  const files = new Map([
    ['connection.json', json(config)],
    ['mcp.json', json({ mcpServers: { 'kuaimai-workbuddy': { command: node, args: [entry, '--config', join(directory, 'connection.json')] } } })]
  ]);
  let exists = false;
  try {
    const info = await stat(directory);
    if (!info.isDirectory()) fail('EXPORT_CONFLICT');
    exists = true;
    const names = await readdir(directory);
    // Never adopt an existing arbitrary folder, including an empty one.
    if (names.length !== files.size || names.some(name => !files.has(name))) fail('EXPORT_CONFLICT');
    for (const [name, content] of files) {
      const path = join(directory, name);
      await safePath(path);
      if (!(await stat(path)).isFile() || await readFile(path, 'utf8') !== content) fail('EXPORT_CONFLICT');
    }
  } catch (error) {
    if (error instanceof WorkBuddyError) throw error;
    if (error.code !== 'ENOENT') fail('EXPORT_CONFLICT');
  }
  // Runtime validation is local only: no health call, port scan, service start or remote settings write.
  // Reuse the same runtime-file permission checks without publishing anything.
  if (!exists) {
    const parent = dirname(directory);
    await safePath(parent);
    if (!(await stat(parent)).isDirectory()) fail('UNSAFE_PATH');
  }
  // Read the explicit manifest using the client loader, but never create a temporary config.
  await validateRuntimeFile(config.runtimeFile);
  if (!dryRun && !exists) {
    await safePath(directory, { allowMissing: true });
    await mkdir(directory, { mode: 0o700 });
    for (const [name, content] of files) {
      await safePath(directory);
      const handle = await open(join(directory, name), 'wx', 0o600);
      try { await handle.writeFile(content); } finally { await handle.close(); }
    }
  }
  return { exported: !dryRun, dryRun, unchanged: exists, files: [...files.keys()].map(name => join(directory, name)), artifact: 'WorkBuddy MCP可导入配置片段，未修改真实settings，未声称已接入；技能由统一分发流程另行导出。' };
}

export async function setupCli(args = process.argv.slice(2)) {
  const values = {};
  const fields = { '--out': 'out', '--runtime-file': 'runtimeFile', '--origin': 'origin', '--workspace': 'workspace', '--runtime-root':'runtimeRoot', '--skill-dir':'skillDirectory', '--endpoint':'endpoint' };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--dry-run' && !Object.hasOwn(values, 'dryRun')) { values.dryRun = true; continue; }
    if(flag==='--automatic'&&!Object.hasOwn(values,'automatic')){values.automatic=true;continue;}
    if (!fields[flag] || Object.hasOwn(values, fields[flag]) || !args[i + 1] || args[i + 1].startsWith('--')) fail('INVALID_CONFIG');
    values[fields[flag]] = args[++i];
  }
  if(values.automatic){if(values.runtimeFile)fail('INVALID_CONFIG');const{automatic,...options}=values;return exportAutomaticConfig(options);}
  if(values.runtimeRoot||values.skillDirectory||values.endpoint)fail('INVALID_CONFIG');
  return exportWorkBuddyConfig(values);
}

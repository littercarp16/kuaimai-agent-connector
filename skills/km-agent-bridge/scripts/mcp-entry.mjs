#!/usr/bin/env node
// Gateway only prepares the product runtime; the installed official SDK owns MCP stdio.
import { spawn } from 'node:child_process';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ensureRuntime, loadBootstrapConfig, readConfigFile, safeLocalPath, validLoopbackOrigin, RuntimePrepareError, publicErrorCode } from './prepare.mjs';

const fail = code => { throw new RuntimePrepareError(code); };
export async function runGateway(args = process.argv.slice(2)) {
  let child, temporary, identity, stopping = false, killTimer;
  const stop = () => {
    stopping = true;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      killTimer ||= setTimeout(() => child.kill('SIGKILL'), 1500);
      killTimer.unref();
    }
  };
  const cleanup = async () => {
    clearTimeout(killTimer);
    if (temporary && identity) {
      try { const info = await lstat(temporary); if (info.ino === identity.ino && info.dev === identity.dev && info.isFile()) await unlink(temporary); } catch {}
    }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    if (args.length !== 2 || args[0] !== '--config') fail('INVALID_CONFIG');
    const path = await safeLocalPath(args[1]), config = await readConfigFile(path);
    const allowed = ['version', 'bootstrapFile', 'origin', 'workspaceRoot', 'workspaceId'];
    if (!config || typeof config !== 'object' || Array.isArray(config) || config.version !== 1 || Object.keys(config).some(key => !allowed.includes(key)) || !validLoopbackOrigin(config.origin) || Object.hasOwn(config, 'workspaceRoot') === Object.hasOwn(config, 'workspaceId')) fail('INVALID_CONFIG');
    const bootstrap = await loadBootstrapConfig(config.bootstrapFile);
    if (bootstrap.origin !== config.origin) fail('INVALID_CONFIG');
    const effective = { version: 1, runtimeFile: bootstrap.runtimeFile, origin: config.origin,bootstrapFile:config.bootstrapFile,prepareEntry:fileURLToPath(new URL('./prepare.mjs',import.meta.url)) };
    if (Object.hasOwn(config, 'workspaceRoot')) {
      const workspace = await safeLocalPath(config.workspaceRoot);
      if (!(await lstat(workspace)).isDirectory()) fail('INVALID_CONFIG');
      const index = bootstrap.launchArgs.indexOf('--workspace');
      if (await safeLocalPath(bootstrap.launchArgs[index + 1]) !== workspace) fail('INVALID_CONFIG');
      effective.workspaceRoot = workspace;
    } else {
      if (typeof config.workspaceId !== 'string' || !/^[\w:.-]{1,128}$/.test(config.workspaceId)) fail('INVALID_CONFIG');
      effective.workspaceId = config.workspaceId;
    }
    const directory = dirname(path), parent = await lstat(directory);
    if (!parent.isDirectory() || (parent.mode & 0o777) !== 0o700 || process.getuid && parent.uid !== process.getuid()) fail('UNSAFE_PATH');
    const ensured = await ensureRuntime({ configFile: config.bootstrapFile, expectedOrigin: config.origin });
    if (stopping) return 0;
    const entry = await safeLocalPath(ensured.mcpEntry);
    if (!(await lstat(entry)).isFile()) fail('UNSAFE_PATH');
    effective.runtimeFile = ensured.runtimeFile;
    temporary = join(directory, `.km-effective-${randomUUID()}.json`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    try { identity = await file.stat(); await file.writeFile(JSON.stringify(effective)); } finally { await file.close(); }
    if (stopping) return 0;
    child = spawn(process.execPath, [ensured.mcpEntry, '--config', temporary], { stdio: 'inherit', cwd: dirname(ensured.mcpEntry), windowsHide: true });
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', () => reject(new RuntimePrepareError('SDK_FAILED')));
      child.once('exit', (value, signal) => resolveExit(stopping ? 0 : value ?? (signal ? 1 : 0)));
    });
    return code;
  } catch (error) { process.stderr.write(`KM_GATEWAY: ${publicErrorCode(error)}\n`); return 1; }
  finally { await cleanup(); process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => '') === fileURLToPath(import.meta.url)) process.exitCode = await runGateway();

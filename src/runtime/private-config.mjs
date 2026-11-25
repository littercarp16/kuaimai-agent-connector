import { lstat } from 'node:fs/promises';
import { readConfigFile } from '../../skills/km-agent-bridge/scripts/prepare.mjs';
import { windowsPathAccess } from './windows.mjs';

export async function readPrivateConfig(file, options = {}) {
  if (process.platform !== 'win32') return readConfigFile(file, { ...options, runtime: true });
  await windowsPathAccess(file);
  if ((await lstat(file)).nlink !== 1) throw Error('无效的运行文件');
  return readConfigFile(file, options);
}

import { readFile, lstat, rename, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { VERSION, dataRoot, privateDirectory } from './service.mjs';
import { claimService } from '../runtime/service-instance.mjs';
export const PACKAGE = 'kuaimai-agent-connector';
// npx's cache is not a durable service location. Install a versioned private
// copy before starting the detached process. No global install or login item.
export async function ensureNpmRuntime({ root = dataRoot(), spec = `${PACKAGE}@${VERSION}`, run = promisify(execFile) } = {}) {
  root = await privateDirectory(root);
  const installs = await privateDirectory(join(root, 'npm')), target = join(installs, VERSION), packageDir = join(target, 'node_modules', PACKAGE);
  async function installed() {
    try {
      for (const path of [target, join(target,'node_modules'), packageDir]) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('已有安装路径无效'); }
      const value = JSON.parse(await readFile(join(packageDir,'package.json'),'utf8'));
      if (value.name !== PACKAGE || value.version !== VERSION) throw Error('已有安装版本无效');
      return true;
    } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  if (await installed()) return packageDir;
  let release;
  try { release = await claimService(join(installs, VERSION + '.install'), VERSION); }
  catch { for (let i = 0; i < 120; i++) { await delay(500); if (await installed()) return packageDir; } throw Error('另一个安装任务尚未完成，请稍后重试'); }
  let staging;
  try {
    if (await installed()) return packageDir;
    staging = await mkdtemp(join(installs, '.install-'));
    await run('npm', ['install','--prefix',staging,'--registry=https://registry.npmjs.org','--ignore-scripts','--no-audit','--no-fund','--package-lock=false','--save-exact',spec], { timeout:180000, maxBuffer:2*1024*1024, shell:false });
    const value = JSON.parse(await readFile(join(staging,'node_modules',PACKAGE,'package.json'),'utf8'));
    if (value.name !== PACKAGE || value.version !== VERSION) throw Error('安装结果与要求的版本不匹配');
    await rename(staging,target); staging=null;
    if (!await installed()) throw Error('安装未完成');
    return packageDir;
  } catch (error) { if (error.code === 'EEXIST' || error.code === 'ENOTEMPTY') throw Error('已有版本目录未完成安装，请检查后再试'); throw error; }
  finally { if (staging) await rm(staging,{recursive:true,force:true}); await release(); }
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rename, lstat, readFile } from 'node:fs/promises';
import { dataRoot, privateDirectory } from '../headless/service.mjs';
import { HOST, EXTENSION_ID } from './policy.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export async function installExtensionHost({ directory = join(dataRoot(), 'browser'), profiles = [join(homedir(), 'Library/Application Support/Google/Chrome'), join(homedir(), 'Library/Application Support/Microsoft Edge')] } = {}) {
  directory = await privateDirectory(directory);
  const launcher = join(directory, 'native-host'), extension = join(directory, 'extension');
  async function replace(path, contents, mode) {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('已有扩展文件路径无效'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temporary = path + '.' + process.pid + '.next';
    await writeFile(temporary, contents, { mode, flag: 'wx' }); await rename(temporary, path);
  }
  await replace(launcher, '#!/bin/sh\nexec ' + quote(process.execPath) + ' ' + quote(join(root, 'native-host.mjs')) + ' "$@"\n', 0o700);
  await privateDirectory(extension);
  for (const name of ['manifest.json', 'background.js', 'content.js']) await replace(join(extension, name), await readFile(join(root, 'browser-extension', name)), 0o600);
  const manifest = JSON.stringify({ name: HOST, description: 'Kuaimai local Agent browser channel', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${EXTENSION_ID}/`] }, null, 2) + '\n';
  for (const profile of profiles) {
    // Do not chmod the browser profile or replace its preferences.
    const hosts = join(profile, 'NativeMessagingHosts');
    await mkdir(hosts, { recursive: true });
    const info = await lstat(hosts);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()) throw Error('浏览器本机通道目录无效');
    await replace(join(hosts, HOST + '.json'), manifest, 0o600);
  }
  return { extensionId: EXTENSION_ID, extensionDirectory: extension, extensionInstallRequired: true };
}

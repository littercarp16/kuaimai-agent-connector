// Windows has no Unix socket file permissions. Keep the per-instance TLS PSK
// in the user's protected NTFS directory; only authenticated loopback peers
// reach the existing control protocol, in either direction.
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, rename, unlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { windowsPathAccess } from '../runtime/windows.mjs';

const options = { minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: 'PSK-AES256-GCM-SHA384' };
const filename = directory => join(directory, 'control.json');
export async function windowsControlClient(directory) {
  const file = filename(directory);
  const info = await lstat(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 1024) throw Error('无效的后台控制通道');
  await windowsPathAccess(file);
  const { port, key, pid } = JSON.parse(await readFile(file, 'utf8'));
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/.test(key)) throw Error('无效的后台控制通道');
  try { process.kill(pid, 0); }
  catch (error) {
    if (error.code === 'ESRCH') throw Object.assign(Error('后台已退出'), { code: 'ENOENT' });
    throw error;
  }
  return connectPsk(port, Buffer.from(key, 'hex'));
}
export function connectPsk(port, key) {
  return tls.connect({ ...options, host: '127.0.0.1', port, rejectUnauthorized: false,
    pskCallback: () => ({ identity: 'km-control/1', psk: key }) });
}
export function pskServer(key, handler) {
  return tls.createServer({ ...options, handshakeTimeout: 5000,
    pskCallback: (_socket, id) => id === 'km-control/1' ? key : null }, handler);
}
export async function listenWindowsControl(directory, handler) {
  const key = randomBytes(32), server = pskServer(key, handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const file = filename(directory), temporary = file + '.' + randomBytes(8).toString('hex');
  try {
    await writeFile(temporary, JSON.stringify({ pid: process.pid, port: server.address().port, key: key.toString('hex') }), { flag: 'wx' });
    await rename(temporary, file);
  } catch (error) {
    server.close(); await unlink(temporary).catch(() => {}); throw error;
  }
  return server;
}

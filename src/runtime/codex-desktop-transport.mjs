import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { discoverCodexDaemon } from '../adapters/codex/codex-rpc.mjs';

const APP_PROCESS = '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT';
const exec = promisify(execFile);
const unknown = desktopPid => ({ mode: 'unknown', desktopPid });

function processes(stdout) {
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    return match ? [{ uid: Number(match[1]), pid: Number(match[2]), parent: Number(match[3]), executable: match[4] }] : [];
  });
}

// macOS lsof's device-character field is the Unix socket's kernel address.
// Its name is either the bound path or -><peer address>. NUL fields preserve paths.
function sockets(stdout) {
  const result = [];
  let pid, uid, file;
  for (const raw of stdout.split('\0')) {
    const field = raw.replace(/^\n+/, ''), key = field[0], value = field.slice(1);
    if (key === 'p') { pid = Number(value); uid = undefined; file = null; }
    else if (key === 'u') uid = Number(value);
    else if (key === 'f') { file = { pid, uid, fd: value }; result.push(file); }
    else if (file && key === 't') file.type = value;
    else if (file && key === 'd') file.address = value;
    else if (file && key === 'n') file.name = value;
  }
  return result.filter(f => f.type === 'unix' && /^0x[\da-f]+$/i.test(f.address || ''));
}

function appServerMode(process, args) {
  if (!args?.startsWith(process.executable + ' ')) return null;
  const tail = args.slice(process.executable.length);
  const match = /(?:^|\s)app-server(?:\s|$)/.exec(tail);
  if (!match || /(?:^|\s)(?:exec|exec-server|mcp-server)(?:\s|$)/.test(tail.slice(0, match.index))) return null;
  const options = tail.slice(match.index + match[0].length).trim();
  if (/^daemon(?:\s|$)/.test(options)) return null;
  const listen = /(?:^|\s)--listen(?:=|\s+)(\S+)/.exec(options);
  return !listen || listen[1] === 'stdio://' ? 'stdio' : listen[1].startsWith('unix://') ? 'unix' : 'other';
}

/** Read-only evidence from the desktop's actual file descriptors, never its env flag alone. */
export async function inspectCodexDesktopTransport({ run = exec, discover = discoverCodexDaemon,
  uid = process.getuid?.() } = {}) {
  let desktopPid;
  const command = (file, args) => run(file, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, shell: false });
  const readProcesses = async () => processes((await command('/bin/ps', ['-axo', 'uid=,pid=,ppid=,comm='])).stdout);
  try {
    const all = (await readProcesses()).filter(p => p.uid === uid);
    if (!all.length) return unknown();
    const desktops = all.filter(p => p.executable === APP_PROCESS);
    if (!desktops.length) return { mode: 'not-running', desktopPid: null };
    if (desktops.length !== 1) return unknown();
    desktopPid = desktops[0].pid;
    const candidates = all.filter(p => p.executable.endsWith('/codex'));
    if (!candidates.length || candidates.length > 128) return unknown(desktopPid);
    const [daemon, argumentResult, files] = await Promise.all([
      discover(),
      command('/bin/ps', ['-ww', '-p', candidates.map(p => p.pid).join(','), '-o', 'pid=,args=']),
      command('/usr/sbin/lsof', ['-nP', '-a', '-p', [desktopPid, ...candidates.map(p => p.pid)].join(','), '-U', '-Fpuftdn0']),
    ]);
    const args = new Map(argumentResult.stdout.split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line);
      return match ? [[Number(match[1]), match[2]]] : [];
    }));
    const descriptors = sockets(files.stdout).filter(f => f.uid === uid);
    const desktop = descriptors.filter(f => f.pid === desktopPid);
    const servers = candidates.map(p => ({ ...p, mode: appServerMode(p, args.get(p.pid)) }));
    const otherUnixServer = servers.find(p => p.mode === 'unix' && descriptors.some(f =>
      f.pid === p.pid && f.name?.startsWith('/') && (!daemon.ready || f.name !== daemon.socketPath)
      && desktop.some(d => d.name === '->' + f.address)));
    if (otherUnixServer) return unknown(desktopPid);
    const sharedServer = daemon.ready && servers.find(p => p.mode === 'unix' && descriptors.some(f =>
      f.pid === p.pid && f.name === daemon.socketPath && desktop.some(d => d.name === '->' + f.address)));
    const stdioServer = servers.find(p => p.parent === desktopPid && p.mode === 'stdio' && ['0', '1'].every(fd =>
      descriptors.some(f => f.pid === p.pid && f.fd === fd && desktop.some(d =>
        d.name === '->' + f.address && f.name === '->' + d.address))));
    // Recheck identity after the process/socket snapshot; a launch race is not a reason to quit.
    const latest = await readProcesses();
    if (![desktops[0], sharedServer, stdioServer].filter(Boolean).every(p => latest.some(n =>
      n.pid === p.pid && n.uid === p.uid && n.parent === p.parent && n.executable === p.executable))) return unknown(desktopPid);
    if (sharedServer && !stdioServer) {
      const current = await discover();
      if (!current.ready || !daemon.instanceId || current.instanceId !== daemon.instanceId) return unknown(desktopPid);
      return { mode: 'shared', desktopPid, daemon: { ready: true, version: current.version } };
    }
    if (stdioServer && !sharedServer) return { mode: 'stdio', desktopPid };
    return unknown(desktopPid);
  } catch { return unknown(desktopPid); }
}

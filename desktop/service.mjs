// The native app owns this pipe. Browser URLs are never interpreted as commands.
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { createDesktopHost } from '../src/desktop/host.mjs';
import { workBuddySessionOptions } from '../src/adapters/workbuddy/session-list.mjs';
import { createWorkBuddyServeManager } from '../src/runtime/workbuddy-serve.mjs';
process.title = 'kuaimai-agent-connector';
const directory = process.env.KM_AGENT_APP_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'Kuaimai Agent Connector');
if (!isAbsolute(directory)) throw Error('App data directory must be absolute');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const sessionOptions = workBuddySessionOptions();
delete process.env.KM_AGENT_WORKBUDDY_PASSWORD;
const workBuddyServeManager = sessionOptions ? null : createWorkBuddyServeManager({ directory });
const host = createDesktopHost({ directory, reconnect: true, direct: true, workBuddyServeManager, sessionOptions,
  onChange: status => emit({ event: 'status', data: status }) });
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve(), closing = false;
input.on('line', line => {
  if (line.length > 16384) return;
  queue = queue.then(async () => {
    let request;
    try {
      request = JSON.parse(line);
      if (!request || typeof request.id !== 'string' || !/^[\w-]{1,100}$/.test(request.id)) throw Error('Invalid request');
      let data;
      switch (request.action) {
        case 'status': data = host.status(); break;
        case 'start': data = await host.start(request.config); break;
        case 'stop': data = await host.stop(); break;
        case 'inspect-link': data = host.inspectLink(request.url); break;
        case 'authorize': data = host.authorize(request.requestId); break;
        case 'deny': host.deny(request.requestId); data = null; break;
        default: throw Error('Unknown native action');
      }
      emit({ id: request.id, ok: true, data });
    } catch (error) { emit({ id: request?.id, ok: false, error: String(error.message).slice(0, 220) }); }
  });
});
async function shutdown() { if (closing) return; closing = true; await queue; await host.stop(); process.exit(0); }
input.on('close', () => void shutdown());
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void shutdown());
emit({ event: 'ready' });

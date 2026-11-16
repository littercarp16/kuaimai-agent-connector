import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, chmod, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PUBLISHER = 'fixture-publisher-secret-0123456789';
export const TOKEN = 'fixture-task-secret-0123456789';
export const ORIGIN = 'http://127.0.0.1:4173';
export const INSTANCE = 'fixture-instance-1';
export const event = (id = 'evt-1') => ({ protocol: 'km-agent/1', id, type: 'run.note', payload: { text: '普通公开说明 <b>保留</b>' } });

export async function fixture(t, options = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'km-workbuddy-test-'));
  const runtimeDir = join(root, 'runtime');
  await mkdir(runtimeDir, { mode: 0o700 });
  const runtimeFile = join(runtimeDir, 'runtime.json');
  const connectionFile = join(root, 'connection.json');
  const requests = [];
  const state = { instanceId: INSTANCE, capability: true, handler: options.handler, openCount: 0 };
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    requests.push({ url: req.url, headers: req.headers, body });
    const reply = (data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: status === 200, data })); };
    if (state.handler && await state.handler({ req, res, body, reply, state })) return;
    if (req.url === '/v1/health') return reply({ service: 'kuaimai-agent-connector', protocolVersion: 2, interactionProtocol: 'km-agent/1', instanceId: state.instanceId, capabilities: { workbuddyPublish: state.capability } });
    if (req.url.endsWith('/open')) {
      if (req.headers['x-km-publisher'] !== PUBLISHER) return reply({}, 403);
      state.openCount++;
      return reply({ instanceId: state.instanceId, taskId: 'task-' + state.openCount, title: body.title, taskToken: TOKEN + '-' + state.openCount, status: 'running', publisherKey: PUBLISHER });
    }
    if (req.headers['x-km-task-token'] !== TOKEN + '-' + body.taskId?.split('-').at(-1)) return reply({}, 403);
    if (req.url.endsWith('/receipt')) return reply({ instanceId: state.instanceId, taskId: body.taskId, eventId: body.eventId, delivery: 'applied', taskToken: TOKEN });
    if (req.url.endsWith('/finish')) return reply({ instanceId: state.instanceId, taskId: body.taskId, status: body.status, accepted: true, taskToken: TOKEN });
    return reply({ instanceId: state.instanceId, taskId: body.taskId, eventId: body.event?.id, accepted: true, delivery: 'accepted', taskToken: TOKEN });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + server.address().port;
  const runtime = { instanceId: INSTANCE, endpoint, protocol: 'km-agent/1', key: PUBLISHER, bindings: [] };
  const connection = { version: 1, runtimeFile, origin: ORIGIN, workspaceRoot: root };
  const saveRuntime = async (value = runtime) => { await writeFile(runtimeFile, JSON.stringify(value), { mode: 0o600 }); await chmod(runtimeFile, 0o600); };
  const saveConnection = async (value = connection) => writeFile(connectionFile, JSON.stringify(value), { mode: 0o600 });
  await saveRuntime();
  await saveConnection();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, runtimeDir, runtimeFile, connectionFile, connection, runtime, saveRuntime, saveConnection, state, requests, endpoint };
}

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

// Never put arbitrary URLs, query strings, headers or bodies into logs.
const paths = new Set(['/connect','/connect-window.js','/connect-window.css','/v1/connect/discover','/v1/connect/claim','/v1/connect/direct-resume','/v1/connect/direct-revoke','/v1/connect/exchange','/v1/connect/resume','/v1/health','/v1/handshake','/v1/pair','/v1/snapshot','/v1/events','/v1/run','/v1/demo','/v1/stop','/v1/disconnect','/v1/reset','/v1/sessions','/v1/sources','/v1/bind','/v1/unbind','/v1/protocol','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/questions','/v1/question/reply','/v1/question/reject','/v1/approvals','/v1/approval/reply','/v1/codex/desktop','/v1/qwen/desktop','/v1/codex/desktop/restart','/v1/qwen/desktop/ensure','/v1/local/codex/desktop/status','/v1/local/codex/desktop/restart','/v1/local/publish','/v1/local/receipt', ...['open','publish','receipt','finish','heartbeat'].map(action => '/v1/local/workbuddy/tasks/' + action)]);
export function observeRequest(req, res, { logger, instanceId, origins }) {
  const requestId = randomUUID(), started = performance.now();
  const path = req.url?.split(/[?#]/, 1)[0];
  const metadata = { instanceId, requestId, path: paths.has(path) ? path : '/unknown', method: ['GET','POST','OPTIONS','HEAD','PUT','PATCH','DELETE'].includes(req.method) ? req.method : 'OTHER' };
  const endpoint = `http://127.0.0.1:${req.socket.localPort}`;
  if (origins.has(req.headers.origin) || req.headers.origin === endpoint) metadata.origin = req.headers.origin;
  let done = false, error;
  res.setHeader('X-Km-Request-Id', requestId);
  function finish() {
    if (done) return; done = true;
    const completed = res.writableFinished;
    const fields = { ...metadata, statusCode: completed || res.headersSent ? res.statusCode : 499, durationMs: Math.round((performance.now() - started) * 100) / 100, outcome: completed ? 'completed' : 'aborted', ...(error ? { error } : {}) };
    logger[fields.statusCode >= 500 || error && fields.statusCode < 400 ? 'error' : fields.statusCode >= 400 || !completed ? 'warn' : 'info']('http.request', fields);
  }
  res.once('finish', finish); res.once('close', finish);
  req.once('error', value => { error ||= value; }); res.once('error', value => { error ||= value; });
  return { requestId, metadata, error(value) { error ||= value; }, client(client) { metadata.clientId = client.logId; } };
}

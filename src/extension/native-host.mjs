import { once } from 'node:events';
import { EXTENSION_ID, MAX_BODY, validateRequest } from './policy.mjs';

// stdout is exclusively Chrome's length-prefixed native protocol. Never log
// tokens, prompts or application diagnostics here.
export async function runNativeHost({ input = process.stdin, output = process.stdout } = {}) {
  const requests = new Map(), credentials = new Map();
  let buffer = Buffer.alloc(0), closed = false, outputQueue = Promise.resolve();
  function send(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > 1024 * 1024) throw Error('本机消息过大');
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    outputQueue = outputQueue.then(async () => { if (!closed && !output.write(Buffer.concat([header, bytes]))) await once(output, 'drain'); });
    return outputQueue;
  }
  async function execute(value) {
    const { url, headers } = validateRequest(value);
    if (requests.has(value.id) || requests.size >= 40) throw Error('本机请求过多');
    const controller = new AbortController(), entry = { controller };
    requests.set(value.id, entry);
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      // Never send an authenticated request to an unrelated service occupying
      // a candidate port. No redirects, cookies, publisher keys or arbitrary URL.
      if (url.pathname !== '/v1/connect/discover') {
        const check = await fetch(url.origin + '/v1/connect/discover', { headers: { Origin: value.origin }, redirect: 'error', signal: controller.signal });
        const descriptor = await check.json();
        if (!check.ok || descriptor.data?.service !== 'kuaimai-agent-connector' || descriptor.data?.transport !== 'direct/1' || descriptor.data?.endpoint !== url.origin) throw Error('此端口不是连接器');
      }
      const response = await fetch(url, { method: value.method, headers, body: value.body, redirect: 'error', signal: controller.signal });
      const remember = authorization => credentials.set(value.origin + ' ' + authorization, { authorization, origin: value.origin, endpoint: url.origin });
      if (response.ok && headers.Authorization) remember(headers.Authorization);
      let grantBody = ['/v1/connect/claim', '/v1/connect/direct-resume'].includes(url.pathname) ? '' : null;
      clearTimeout(timeout);
      await send({ id: value.id, type: 'response', status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json' } });
      const reader = response.body.getReader();
      try {
        while (!controller.signal.aborted) {
          const { done, value: bytes } = await reader.read();
          if (done) break;
          if (grantBody !== null) grantBody = grantBody.length + bytes.length > 65536 ? null : grantBody + Buffer.from(bytes).toString('utf8');
          for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
            // One bounded chunk in flight per request, including SSE. Browser
            // consumption acknowledges it; stalled pages cannot grow queues.
            let timer, abort;
            const consumed = new Promise((resolve, reject) => {
              entry.ack = resolve;
              abort = () => reject(Error('请求已取消'));
              controller.signal.addEventListener('abort', abort, { once: true });
              timer = setTimeout(() => { controller.abort(); reject(Error('网页读取超时')); }, 30000);
            });
            try {
              await send({ id: value.id, type: 'chunk', data: Buffer.from(bytes.subarray(offset, offset + 48 * 1024)).toString('base64') });
              await consumed;
            } finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); entry.ack = null; }
          }
        }
      } finally { await reader.cancel().catch(() => {}); }
      if (grantBody) { try { const token = JSON.parse(grantBody).data?.token; if (/^[\w-]{43}$/.test(token || '')) remember('Bearer ' + token); } catch {} }
      await send({ id: value.id, type: 'end' });
    } finally { clearTimeout(timeout); controller.abort(); requests.delete(value.id); }
  }
  async function close() {
    if (closed) return;
    closed = true;
    for (const entry of requests.values()) entry.controller.abort();
    // Closing a tab releases only its clients. It never stops an Agent run or
    // revokes the tab's refresh grant.
    await Promise.allSettled([...credentials.values()].map(({ authorization, origin, endpoint }) => fetch(endpoint + '/v1/disconnect', {
      method: 'POST', headers: { Origin: origin, Authorization: authorization, 'Content-Type': 'application/json', 'X-Km-Agent': '1' },
      body: '{}', redirect: 'error', signal: AbortSignal.timeout(1500),
    })));
  }
  input.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (!length || length > MAX_BODY + 4096) { input.destroy(); void close(); return; }
      if (buffer.length < length + 4) return;
      let value;
      try { value = JSON.parse(buffer.subarray(4, length + 4)); } catch { input.destroy(); void close(); return; }
      buffer = buffer.subarray(length + 4);
      if (value.type === 'cancel') requests.get(value.id)?.controller.abort();
      else if (value.type === 'ack') requests.get(value.id)?.ack?.();
      else if (value.type === 'request') void execute(value).catch(() => send({ id: value.id, type: 'error', error: '本机请求失败，请检查连接器状态、授权和请求范围' }).catch(() => {}));
    }
  });
  input.once('end', () => void close()); input.once('error', () => void close()); output.once('error', () => void close());
  return { close };
}
export function validCaller(value) { return value === `chrome-extension://${EXTENSION_ID}/`; }

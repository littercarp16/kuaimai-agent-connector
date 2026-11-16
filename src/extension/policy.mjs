export const HOST = 'com.kuaimai.agent_connector';
export const EXTENSION_ID = 'ahibjmmejhcabodghbdmdihdgkncaeca';
export const ORIGINS = Object.freeze(['http://lt.com:8085', 'http://local.lt.com:8251']);
export const MAX_BODY = 16 * 1024 * 1024;
const get = new Set(['/v1/connect/discover','/v1/health','/v1/snapshot','/v1/events','/v1/sessions','/v1/sources','/v1/protocol','/v1/questions','/v1/approvals','/v1/codex/desktop']);
const post = new Set(['/v1/connect/claim','/v1/connect/direct-resume','/v1/connect/direct-revoke','/v1/run','/v1/stop','/v1/disconnect','/v1/reset','/v1/bind','/v1/unbind','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/question/reply','/v1/question/reject','/v1/approval/reply','/v1/codex/desktop/restart']);
export function validateRequest(value) {
  if (!value || !/^[\w-]{1,80}$/.test(value.id || '') || !ORIGINS.includes(value.origin)) throw Error('不受支持的网页来源或请求');
  const url = new URL(value.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || Number(url.port) < 17653 || Number(url.port) > 17684 || url.username || url.password || url.search || url.hash || value.url !== url.href) throw Error('仅允许连接本机连接器端口');
  if (!(value.method === 'GET' ? get : value.method === 'POST' ? post : new Set()).has(url.pathname)) throw Error('不允许访问此接口');
  if (value.body !== undefined && (value.method !== 'POST' || typeof value.body !== 'string' || Buffer.byteLength(value.body) > MAX_BODY)) throw Error('请求内容无效或过大');
  if (value.method === 'POST') { const body = JSON.parse(value.body); if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('需要 JSON 对象'); }
  const headers = { Origin: value.origin, 'X-Km-Agent': '1' };
  for (const [key, content] of Object.entries(value.headers || {})) {
    if (key === 'authorization' && /^Bearer [\w-]{43}$/.test(content)) headers.Authorization = content;
    else if (key !== 'content-type' && key !== 'x-km-agent') throw Error('不允许此请求头');
  }
  if (!url.pathname.startsWith('/v1/connect/') && !headers.Authorization) throw Error('需要本页授权');
  if (value.method === 'POST') headers['Content-Type'] = 'application/json';
  return { url, headers };
}

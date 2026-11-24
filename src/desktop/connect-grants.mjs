import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { validWebOrigin } from '../runtime/web-origin.mjs';
const secret = () => randomBytes(32).toString('base64url');
const code = /^[A-Za-z0-9_-]{43}$/;
const bad = () => { throw Error('接入请求无效、已过期或不属于当前网页'); };
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const challengeFor = verifier => createHash('sha256').update(verifier).digest('base64url');

export function parseConnectURL(value, allowedOrigins) {
  if (typeof value !== 'string' || value.length > 4096) bad();
  const url = new URL(value);
  if (url.protocol !== 'km-agent:' || url.hostname !== 'connect' || !['', '/'].includes(url.pathname) || url.username || url.password || url.port || url.hash) bad();
  const keys = ['origin', 'callback', 'state', 'challenge', 'browser'];
  if (keys.some(k => url.searchParams.getAll(k).length !== 1) || [...url.searchParams.keys()].some(k => ![...keys, 'transport', 'provider'].includes(k))) bad();
  if (url.searchParams.has('transport') && (url.searchParams.getAll('transport').length !== 1 || url.searchParams.get('transport') !== 'direct')) bad();
  if (url.searchParams.has('provider') && (url.searchParams.getAll('provider').length !== 1 || !['codex', 'qwen'].includes(url.searchParams.get('provider')))) bad();
  const request = Object.fromEntries(url.searchParams);
  if (!validWebOrigin(request.origin) || !allowedOrigins.includes(request.origin) || !code.test(request.state) || !code.test(request.challenge)) bad();
  const callback = new URL(request.callback);
  if (callback.origin !== request.origin || callback.pathname !== '/agent/connect-callback.html' || callback.search || callback.hash || callback.username || callback.password) bad();
  if (!['chrome', 'edge', 'firefox', 'safari', 'default'].includes(request.browser)) bad();
  return Object.freeze(request);
}

export function createConnectGrants({ now = Date.now, ttlMs = 120000, reconnect = false } = {}) {
  const grants = new Map(), resumptions = new Map();
  function sweep() { for (const [key, value] of grants) if (value.expires <= now()) grants.delete(key); }
  return {
    issue(request, { endpoint, instanceId }) {
      sweep(); if (grants.size >= 32) throw Error('待确认连接过多，请稍后重试');
      const ticket = secret(); grants.set(ticket, { ...request, instanceId, expires: now() + ttlMs });
      const callback = new URL(request.callback);
      callback.hash = new URLSearchParams({ state: request.state, endpoint, instanceId, ticket }).toString();
      return { callbackURL: callback.href, browser: request.browser };
    },
    consume({ ticket, state, verifier, websiteOrigin, requestOrigin, endpoint, instanceId }) {
      sweep(); const grant = grants.get(ticket);
      if (!grant || grant.instanceId !== instanceId || !equal(grant.state, state) || !code.test(verifier || '') || !equal(grant.challenge, challengeFor(verifier))) bad();
      // The local connection window is a top-level, secure loopback page. It must
      // prove the website's PKCE verifier before receiving any bridge permission.
      if (requestOrigin !== endpoint || websiteOrigin !== grant.origin) bad();
      grants.delete(ticket);
      if (!reconnect) return { websiteOrigin: grant.origin };
      for (const [key, value] of resumptions) if (value.expires <= now()) resumptions.delete(key);
      if (resumptions.size >= 32) bad();
      const reconnectToken = secret();
      resumptions.set(reconnectToken, { origin: grant.origin, instanceId, expires: now() + 8 * 3600e3 });
      return { websiteOrigin: grant.origin, reconnectToken };
    },
    resume({ reconnectToken, websiteOrigin, requestOrigin, endpoint, instanceId }) {
      const grant = reconnect && resumptions.get(reconnectToken);
      if (!grant || grant.expires <= now() || grant.origin !== websiteOrigin || grant.instanceId !== instanceId || requestOrigin !== endpoint) bad();
      return { websiteOrigin: grant.origin };
    },
    revokeOrigin(origin) {
      for (const map of [grants, resumptions]) {
        for (const [token, grant] of map) if (grant.origin === origin) map.delete(token);
      }
    },
    clear() { grants.clear(); resumptions.clear(); },
  };
}

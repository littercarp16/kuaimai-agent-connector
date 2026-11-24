import { randomBytes, timingSafeEqual } from 'node:crypto';
import { challengeFor } from './connect-grants.mjs';

export const DIRECT_REQUEST_TTL_MS = 10 * 60 * 60 * 1000;
const MAX_PENDING_PER_ORIGIN = 32;
const MAX_SESSIONS_PER_ORIGIN = 32;
const MAX_REQUEST_RECORDS_PER_ORIGIN = 4096;
const MAX_REQUEST_RECORDS = 65536;
const code = /^[\w-]{43}$/;
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const bad = () => { throw Error('本页接入授权无效或已过期，请重新复制连接请求'); };

// Agent authorizes only a website + PKCE challenge. No browser launch or bearer
// credential is returned to the Agent. A grant never authorizes a conversation.
export function createDirectGrants({ now = Date.now } = {}) {
  const pending = new Map(), sessions = new Map();
  function sweep() {
    for (const map of [pending, sessions]) for (const [key, value] of map) if (value.expires <= now()) map.delete(key);
  }
  function session(token, origin, instanceId) {
    sweep(); const grant = sessions.get(token);
    if (!grant || grant.origin !== origin || grant.instanceId !== instanceId) bad();
    return grant;
  }
  return {
    issue(request, { instanceId, expiresAt = now() + DIRECT_REQUEST_TTL_MS }) {
      sweep(); if (expiresAt <= now()) bad();
      const old = pending.get(request.state);
      if (old && (old.origin !== request.origin || old.challenge !== request.challenge)) bad();
      if (!old) {
        const requests = [...pending.values()].filter(grant => grant.origin === request.origin);
        // Keep spent challenges until expiry without counting them as pending.
        if (pending.size >= MAX_REQUEST_RECORDS || requests.length >= MAX_REQUEST_RECORDS_PER_ORIGIN ||
            requests.filter(grant => !grant.consumed).length >= MAX_PENDING_PER_ORIGIN)
          throw Error('此网页来源的接入请求过多，请稍后重试');
        pending.set(request.state, { ...request, instanceId, expires: expiresAt, consumed: false });
      }
      return { transport: 'direct' };
    },
    claim({ state, verifier, origin, instanceId }) {
      sweep(); if (!code.test(state || '') || !code.test(verifier || '')) bad();
      const grant = pending.get(state);
      if (!grant) return null;
      if (grant.consumed || grant.origin !== origin || grant.instanceId !== instanceId || !equal(grant.challenge, challengeFor(verifier))) bad();
      if ([...sessions.values()].filter(value => value.origin === origin).length >= MAX_SESSIONS_PER_ORIGIN) bad();
      grant.consumed = true;
      const reconnectToken = secret(), expiresAt = now() + 8 * 3600e3;
      sessions.set(reconnectToken, { origin, instanceId, expires: expiresAt });
      return { reconnectToken, expiresAt };
    },
    resume({ reconnectToken, origin, instanceId }) {
      const grant = session(reconnectToken, origin, instanceId);
      return { previousClient: grant.client, expiresAt: grant.expires };
    },
    attach(reconnectToken, client) { const grant = sessions.get(reconnectToken); if (grant) grant.client = client; },
    revoke({ reconnectToken, origin, instanceId }) {
      const grant = session(reconnectToken, origin, instanceId);
      sessions.delete(reconnectToken); return grant.client;
    },
    revokeOrigin(origin) {
      for (const grant of pending.values()) if (grant.origin === origin) grant.consumed = true;
      for (const [token, grant] of sessions) if (grant.origin === origin) sessions.delete(token);
    },
    clear() { pending.clear(); sessions.clear(); },
  };
}

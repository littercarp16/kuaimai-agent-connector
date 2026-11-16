import { randomBytes, timingSafeEqual } from 'node:crypto';
import { challengeFor } from './connect-grants.mjs';

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
    issue(request, { instanceId }) {
      sweep(); if (pending.size >= 32) bad();
      const old = pending.get(request.state);
      if (old && (old.origin !== request.origin || old.challenge !== request.challenge)) bad();
      if (!old) pending.set(request.state, { ...request, instanceId, expires: now() + 1800000, consumed: false });
      return { transport: 'direct' };
    },
    claim({ state, verifier, origin, instanceId }) {
      sweep(); if (!code.test(state || '') || !code.test(verifier || '')) bad();
      const grant = pending.get(state);
      if (!grant) return null;
      if (grant.consumed || grant.origin !== origin || grant.instanceId !== instanceId || !equal(grant.challenge, challengeFor(verifier))) bad();
      if (sessions.size >= 32) bad();
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
    clear() { pending.clear(); sessions.clear(); },
  };
}

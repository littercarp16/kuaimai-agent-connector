/* In-page HTTP/SSE transport. No popup, iframe, browser callback or URL launch.
 * Only the connector's documented loopback port range is probed. */
(() => {
  const ports = Array.from({ length: 32 }, (_, i) => 17653 + i);
  const endpointKey = 'km-agent.code.endpoint', grantKey = 'km-agent.code.direct-grant', pendingKey = 'km-agent.code.pending';
  const paths = new Set(['/v1/health','/v1/snapshot','/v1/events','/v1/run','/v1/stop','/v1/disconnect','/v1/reset','/v1/sessions','/v1/sources','/v1/bind','/v1/unbind','/v1/protocol','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/questions','/v1/question/reply','/v1/question/reject','/v1/approvals','/v1/approval/reply','/v1/codex/desktop','/v1/codex/desktop/restart']);
  const code = /^[\w-]{43}$/;
  const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const validEndpoint = value => { try { const u = new URL(value); return u.origin === value && u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) >= 1024 && !u.username && !u.password; } catch { return false; } };
  const validGrant = value => value && validEndpoint(value.endpoint) && typeof value.instanceId === 'string' && code.test(value.reconnectToken || '') && value.expiresAt > Date.now();
  const validPending = value => value && code.test(value.state || '') && code.test(value.verifier || '') && Date.now() - value.created < 1800000;
  const unavailable = () => Error('未能连接本机服务。请确认 Agent 已执行最新连接请求；若浏览器提示访问本地网络，请允许。远程 HTTP 页面请使用 HTTPS。');
  async function request(endpoint, path, body, signal, timeout = 10000) {
    const response = await fetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', 'X-Km-Agent': '1' }, body: JSON.stringify(body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)) });
    const result = await response.json();
    if (!response.ok || !result.ok) { const error = Error(result.error?.message || '本机连接请求失败'); error.status = response.status; throw error; }
    return result.data;
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason || Error('连接已取消')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    });
  }
  async function discover(signal, saved) {
    const candidates = [...new Set([...(validEndpoint(saved?.endpoint) ? [saved.endpoint] : []), ...ports.map(port => 'http://127.0.0.1:' + port)])];
    // Bounded discovery, no authenticated request is sent to a foreign service.
    const found = [];
    for (let offset = 0; offset < candidates.length && !signal.aborted; offset += 8) {
      const batch = await Promise.all(candidates.slice(offset, offset + 8).map(async endpoint => {
        try { const value = await request(endpoint, '/v1/connect/discover', undefined, signal, 1500);
          return value.service === 'kuaimai-agent-connector' && value.transport === 'direct/1' && value.endpoint === endpoint && /^[\w.-]{1,140}$/.test(value.instanceId) ? value : null;
        } catch { return null; }
      }));
      found.push(...batch.filter(Boolean));
    }
    return found;
  }
  function create({ onStatus = () => {} } = {}) {
    let pending, controller, session;
    function accept(descriptor, data, existingGrant) {
      if (!code.test(data?.token || '') || data.snapshot?.instanceId !== descriptor.instanceId) throw Error('连接器实例校验失败');
      const grant = { endpoint: descriptor.endpoint, instanceId: descriptor.instanceId, reconnectToken: data.reconnectToken || existingGrant?.reconnectToken, expiresAt: data.expiresAt };
      if (!validGrant(grant)) throw Error('本页恢复授权无效');
      // Access token remains in memory. Only the limited 8h restore grant is kept
      // in this tab's sessionStorage, never in the copied request or localStorage.
      sessionStorage.setItem(grantKey, JSON.stringify(grant)); sessionStorage.removeItem(pendingKey);
      localStorage.setItem(endpointKey, JSON.stringify({ endpoint: grant.endpoint, instanceId: grant.instanceId }));
      const lifetime = new AbortController(); let closed = false;
      const end = () => {
        if (closed) return Promise.resolve(); closed = true; lifetime.abort(); removeEventListener('pagehide', detach);
        return fetch(grant.endpoint + '/v1/disconnect', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true,
          headers: { 'Content-Type':'application/json','X-Km-Agent':'1',Authorization:'Bearer '+data.token }, body:'{}', signal:AbortSignal.timeout(2000) }).catch(() => {});
      };
      const detach = () => { void end(); };
      addEventListener('pagehide', detach);
      session = { endpoint: grant.endpoint, instanceId: grant.instanceId, token: data.token,
        get closed() { return closed; }, detach, close: end,
        fetch(value, init = {}) {
          const url = new URL(value), method = (init.method || 'GET').toUpperCase();
          if (closed || url.origin !== grant.endpoint || url.search || url.hash || !paths.has(url.pathname) || !['GET','POST'].includes(method)) return Promise.reject(Error('本页连接已关闭或请求路径不受支持'));
          const headers = new Headers(init.headers); headers.set('X-Km-Agent','1'); headers.set('Authorization','Bearer '+data.token);
          return fetch(value, { ...init, method, headers, credentials:'omit', cache:'no-store', redirect:'error', signal:AbortSignal.any([lifetime.signal,init.signal].filter(Boolean)) });
        },
      };
      onStatus('本机连接器已接入'); return session;
    }
    async function waitForGrant(value, signal) {
      onStatus('请将连接请求交给本地 Agent，安装启动后会在本页自动连接');
      const saved = read(localStorage, endpointKey); let candidates = [], nextDiscovery = 0;
      while (!signal.aborted && validPending(value)) {
        if (Date.now() >= nextDiscovery) { candidates = await discover(signal, saved); nextDiscovery = Date.now() + 5000; }
        for (const descriptor of candidates) {
          // A failed mutating response is never blindly resent. Ask for a fresh
          // request if acknowledgement was lost instead of creating duplicate clients.
          const data = await request(descriptor.endpoint, '/v1/connect/claim', { state:value.state, verifier:value.verifier, instanceId:descriptor.instanceId }, signal);
          if (!data.pending) return accept(descriptor, data);
        }
        await delay(1500, signal);
      }
      throw signal.aborted ? Error('连接准备已取消') : Error('连接请求已过期，请重新复制');
    }
    function track(work) {
      pending = work.finally(() => { if (pending === tracked) pending = null; }); const tracked = pending;
      pending.catch(() => {}); return pending;
    }
    function prepare({ onRequest = () => {} } = {}) {
      controller?.abort(); session?.detach(); session = null; controller = new AbortController();
      const value = { state:random(), verifier:random(), created:Date.now() }, origin = location.origin;
      const url = 'km-agent://connect?' + new URLSearchParams({ origin, callback:origin+'/agent/connect-callback.html', state:value.state,
        challenge:globalThis.KmDesktopConnector.challengeFor(value.verifier), browser:'default', transport:'direct' });
      const request = btoa(JSON.stringify({url,created:value.created})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      onRequest(request); sessionStorage.setItem(pendingKey,JSON.stringify(value));
      return { request, connection:track(waitForGrant(value,controller.signal)) };
    }
    function connect({ passive = false } = {}) {
      if (pending) return pending;
      if (session && !session.closed) return Promise.resolve(session);
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const waiting = read(sessionStorage,pendingKey);
      if (validPending(waiting)) return track(waitForGrant(waiting,signal));
      const grant = read(sessionStorage,grantKey);
      if (!validGrant(grant)) return Promise.reject(Error('请先复制最新连接请求给本地 Agent；准备完成后将在本页自动接入，无需连接窗口'));
      onStatus('正在恢复本页的本机连接…');
      return track((async () => {
        let descriptor;
        if (passive) {
          try { descriptor = await request(grant.endpoint,'/v1/connect/discover',undefined,signal,4000); } catch { throw unavailable(); }
        } else descriptor = (await discover(signal,grant)).find(item => item.instanceId === grant.instanceId);
        if (!descriptor || descriptor.endpoint !== grant.endpoint || descriptor.instanceId !== grant.instanceId || descriptor.transport !== 'direct/1') throw Error('后台服务已变化，请重新复制连接请求；网页会自动识别新端口');
        const data = await request(descriptor.endpoint,'/v1/connect/direct-resume',{reconnectToken:grant.reconnectToken,instanceId:grant.instanceId},signal);
        return accept(descriptor,data,grant);
      })());
    }
    function hasSaved() { return !!(validGrant(read(sessionStorage,grantKey)) || validPending(read(sessionStorage,pendingKey))); }
    function close({ forget = false } = {}) {
      controller?.abort(); const current = session; session = null;
      if (forget) {
        const grant = read(sessionStorage,grantKey); sessionStorage.removeItem(grantKey); sessionStorage.removeItem(pendingKey); localStorage.removeItem(endpointKey);
        if (validGrant(grant)) void request(grant.endpoint,'/v1/connect/direct-revoke',{reconnectToken:grant.reconnectToken,instanceId:grant.instanceId},undefined,2000).catch(() => {});
      }
      current?.detach();
    }
    return { prepare, connect, close, hasSaved };
  }
  globalThis.KmCodeConnector = Object.freeze({ create });
})();

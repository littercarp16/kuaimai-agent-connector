/* In-page HTTP/SSE transport. No popup, iframe, browser callback or URL launch.
 * Only the connector's documented loopback port range is probed. */
(() => {
  const ports = Array.from({ length: 32 }, (_, i) => 17653 + i);
  const endpointKey = 'km-agent.code.endpoint', grantKey = 'km-agent.code.direct-grant', pendingKey = 'km-agent.code.pending';
  const paths = new Set(['/v1/health','/v1/snapshot','/v1/events','/v1/run','/v1/stop','/v1/disconnect','/v1/reset','/v1/sessions','/v1/sources','/v1/bind','/v1/unbind','/v1/protocol','/v1/ui/ack','/v1/follow','/v1/tool/detail','/v1/files/search','/v1/session/new','/v1/questions','/v1/question/reply','/v1/question/reject','/v1/approvals','/v1/approval/reply','/v1/codex/desktop','/v1/qwen/desktop','/v1/codex/desktop/restart','/v1/qwen/desktop/ensure']);
  const code = /^[\w-]{43}$/;
  const requestTtlMs = 10 * 60 * 60 * 1000;
  const read = (storage, key) => { try { return JSON.parse(storage.getItem(key)); } catch { return null; } };
  const random = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const validEndpoint = value => { try { const u = new URL(value); return u.origin === value && u.protocol === 'http:' && u.hostname === '127.0.0.1' && Number(u.port) >= 1024 && !u.username && !u.password; } catch { return false; } };
  const validGrant = value => value && validEndpoint(value.endpoint) && typeof value.instanceId === 'string' && code.test(value.reconnectToken || '') && value.expiresAt > Date.now();
  const validPending = value => value && code.test(value.state || '') && code.test(value.verifier || '') && Date.now() - value.created < requestTtlMs;
  const needsExtension = ['http://lt.com:8085', 'http://local.lt.com:8251'].includes(location.origin);
  const extensionHint = '此 HTTP 页面需要“快麦本地 Agent 连接”扩展。请让 Agent 执行最新连接请求，安装扩展后刷新本页。';
  let extensionConnection;
  function extensionTransport() {
    if (extensionConnection) return extensionConnection;
    extensionConnection = new Promise((resolve, reject) => {
      const channel = new MessageChannel(), requests = new Map(); let ready = false, sequence = 0;
      const send = value => channel.port1.postMessage(value);
      const fail = message => {
        clearTimeout(timer); extensionConnection = null; channel.port1.close();
        for (const item of requests.values()) item.fail(Error(message));
        requests.clear(); if (!ready) reject(Error(message));
      };
      const timer = setTimeout(() => fail(extensionHint), 800);
      channel.port1.onmessage = event => {
        const value = event.data;
        if (value.type === 'unavailable') { fail(value.error); return; }
        if (value.type === 'ready') {
          clearTimeout(timer); ready = true;
          resolve((url, init = {}) => new Promise((accept, decline) => {
            if (init.signal?.aborted) { decline(init.signal.reason); return; }
            const id = 'r' + (++sequence), headers = Object.fromEntries(new Headers(init.headers));
            let stream, acknowledged = true;
            const cleanup = () => { requests.delete(id); init.signal?.removeEventListener('abort', abort); };
            const abort = () => { send({ type: 'cancel', id }); item.fail(init.signal.reason || Error('请求已取消')); };
            const ack = () => { if (!acknowledged) { acknowledged = true; send({ type: 'ack', id }); } };
            const item = {
              fail(error) { cleanup(); if (stream) stream.error(error); else decline(error); },
              message(message) {
                if (message.type === 'error') { item.fail(Error(message.error)); return; }
                if (message.type === 'response') {
                  const body = new ReadableStream({
                    start(controller) { stream = controller; }, pull() { ack(); },
                    cancel() { send({ type: 'cancel', id }); cleanup(); },
                  }, { highWaterMark: 2 });
                  accept(new Response(body, { status: message.status, headers: message.headers }));
                } else if (message.type === 'chunk') {
                  acknowledged = false;
                  stream.enqueue(Uint8Array.from(atob(message.data), char => char.charCodeAt(0)));
                  if (stream.desiredSize > 0) ack();
                } else if (message.type === 'end') { cleanup(); stream.close(); }
              },
            };
            requests.set(id, item); init.signal?.addEventListener('abort', abort, { once: true });
            send({ type: 'request', id, url: String(url), method: (init.method || 'GET').toUpperCase(), headers, ...(init.body === undefined ? {} : { body: init.body }) });
          }));
          return;
        }
        requests.get(value.id)?.message(value);
      };
      channel.port1.start();
      window.postMessage({ type: 'km-agent-extension/1' }, location.origin, [channel.port2]);
    });
    return extensionConnection;
  }
  async function localFetch(url, init) {
    return needsExtension ? (await extensionTransport())(url, init) : fetch(url, init);
  }
  const unavailable = () => Error(needsExtension ? extensionHint : '未能连接本机服务。请确认 Agent 已执行最新连接请求；若浏览器提示访问本地网络，请允许。');
  async function request(endpoint, path, body, signal, timeout = 10000) {
    const response = await localFetch(endpoint + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
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
    function accept(descriptor, data, existingGrant, provider = existingGrant?.provider) {
      if (!code.test(data?.token || '') || data.snapshot?.instanceId !== descriptor.instanceId) throw Error('连接器实例校验失败');
      const grant = { endpoint: descriptor.endpoint, instanceId: descriptor.instanceId, reconnectToken: data.reconnectToken || existingGrant?.reconnectToken, expiresAt: data.expiresAt, ...(provider && { provider }) };
      if (!validGrant(grant)) throw Error('本页恢复授权无效');
      // Access token remains in memory. Only the limited 8h restore grant is kept
      // in this tab's sessionStorage, never in the copied request or localStorage.
      sessionStorage.setItem(grantKey, JSON.stringify(grant)); sessionStorage.removeItem(pendingKey);
      localStorage.setItem(endpointKey, JSON.stringify({ endpoint: grant.endpoint, instanceId: grant.instanceId }));
      const lifetime = new AbortController(); let closed = false;
      const end = () => {
        if (closed) return Promise.resolve(); closed = true; lifetime.abort(); removeEventListener('pagehide', detach);
        return localFetch(grant.endpoint + '/v1/disconnect', { method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true,
          headers: { 'Content-Type':'application/json','X-Km-Agent':'1',Authorization:'Bearer '+data.token }, body:'{}', signal:AbortSignal.timeout(2000) }).catch(() => {});
      };
      const detach = () => { void end(); };
      addEventListener('pagehide', detach);
      session = { endpoint: grant.endpoint, instanceId: grant.instanceId, token: data.token, transport: needsExtension ? 'extension/1' : 'direct/1',
        get closed() { return closed; }, detach, close: end,
        fetch(value, init = {}) {
          const url = new URL(value), method = (init.method || 'GET').toUpperCase();
          if (closed || url.origin !== grant.endpoint || url.search || url.hash || !paths.has(url.pathname) || !['GET','POST'].includes(method)) return Promise.reject(Error('本页连接已关闭或请求路径不受支持'));
          const headers = new Headers(init.headers); headers.set('X-Km-Agent','1'); headers.set('Authorization','Bearer '+data.token);
          return localFetch(value, { ...init, method, headers, credentials:'omit', cache:'no-store', redirect:'error', signal:AbortSignal.any([lifetime.signal,init.signal].filter(Boolean)) });
        },
      };
      onStatus('本机连接器已接入', { phase: 'connected' }); return session;
    }
    async function waitForGrant(value, signal) {
      const waitingMessage = value.desktopApp ? '请在快麦连接器中允许此次接入' : '请将连接请求交给本地 Agent，安装启动后会在本页自动连接';
      onStatus(waitingMessage, { phase: 'waiting-for-agent' });
      const deadline = value.desktopApp ? value.created + 120000 : Infinity;
      const saved = read(localStorage, endpointKey); let candidates = [], nextDiscovery = 0, found = false;
      while (!signal.aborted && validPending(value) && Date.now() < deadline) {
        if (needsExtension) {
          try { await extensionTransport(); }
          catch (error) { if (!signal.aborted) onStatus(error.message, { phase: 'waiting-for-agent' }); await delay(2000, signal); continue; }
        }
        if (Date.now() >= nextDiscovery) { candidates = await discover(signal, saved); nextDiscovery = Date.now() + 5000; }
        if (signal.aborted) break;
        for (const descriptor of candidates) {
          // A failed mutating response is never blindly resent. Ask for a fresh
          // request if acknowledgement was lost instead of creating duplicate clients.
          let data;
          try { data = await request(descriptor.endpoint, '/v1/connect/claim', { state:value.state, verifier:value.verifier, instanceId:descriptor.instanceId }, signal); }
          catch (error) {
            // The Agent can replace an older service after discovery. A 409
            // is rejected before consuming the grant; rediscover its identity.
            // Lost/ambiguous responses still fail instead of replaying a claim.
            if (error.status !== 409) throw error;
            candidates = []; nextDiscovery = 0; break;
          }
          if (signal.aborted) throw Error('连接准备已取消');
          if (!data.pending) return accept(descriptor, data, undefined, value.provider);
          if (!found && !signal.aborted) {
            found = true;
            onStatus(value.desktopApp ? waitingMessage : '已找到本机连接器，等待本地 Agent 执行连接请求以完成本页授权', { phase: 'waiting-for-agent' });
          }
        }
        await delay(1500, signal);
      }
      if (signal.aborted) throw Error('连接准备已取消');
      if (value.desktopApp) {
        sessionStorage.removeItem(pendingKey);
        throw Error('连接未完成。请确认已安装快麦连接器，再点击打开。');
      }
      throw Error('连接请求已过期，请重新复制');
    }
    function track(work) {
      pending = work.catch(error => {
        if (pending === tracked) onStatus(error.message, { phase: 'error' });
        throw error;
      }).finally(() => { if (pending === tracked) pending = null; }); const tracked = pending;
      pending.catch(() => {}); return pending;
    }
    function prepare({ onRequest = () => {}, provider, desktopApp = false } = {}) {
      if (provider !== undefined && !['codex', 'qwen', 'workbuddy'].includes(provider)) throw Error('不支持的 Agent');
      controller?.abort(); session?.detach(); session = null; controller = new AbortController();
      const value = { state:random(), verifier:random(), created:Date.now(), ...(provider && { provider }), ...(desktopApp && { desktopApp: true }) }, origin = location.origin;
      const url = 'km-agent://connect?' + new URLSearchParams({ origin, callback:origin+'/agent/connect-callback.html', state:value.state,
        challenge:globalThis.KmDesktopConnector.challengeFor(value.verifier), browser:'default', transport:'direct', ...(provider ? { provider } : {}) });
      const request = btoa(JSON.stringify({url,created:value.created})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      onRequest(request); sessionStorage.setItem(pendingKey,JSON.stringify(value));
      return { url, request, connection:track(waitForGrant(value,controller.signal)) };
    }
    function connect({ passive = false } = {}) {
      if (pending) return pending;
      if (session && !session.closed) return Promise.resolve(session);
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      const waiting = read(sessionStorage,pendingKey);
      if (validPending(waiting)) return track(waitForGrant(waiting,signal));
      const grant = read(sessionStorage,grantKey);
      if (!validGrant(grant)) return Promise.reject(Error('请先复制最新连接请求给本地 Agent；准备完成后将在本页自动接入，无需连接窗口'));
      onStatus('正在恢复本页的本机连接…', { phase: 'connecting' });
      return track((async () => {
        let descriptor;
        if (passive) {
          try { descriptor = await request(grant.endpoint,'/v1/connect/discover',undefined,signal,4000); } catch { throw unavailable(); }
        } else descriptor = (await discover(signal,grant)).find(item => item.instanceId === grant.instanceId);
        if (!descriptor || descriptor.endpoint !== grant.endpoint || descriptor.instanceId !== grant.instanceId || descriptor.transport !== 'direct/1') throw Error('后台服务已变化，请重新复制连接请求；网页会自动识别新端口');
        const data = await request(descriptor.endpoint,'/v1/connect/direct-resume',{reconnectToken:grant.reconnectToken,instanceId:grant.instanceId},signal);
        if (signal.aborted) throw Error('连接准备已取消');
        return accept(descriptor,data,grant);
      })());
    }
    function hasPendingRequest() { return !!validPending(read(sessionStorage, pendingKey)); }
    function hasSaved() { return !!validGrant(read(sessionStorage, grantKey)) || hasPendingRequest(); }
    function savedProvider() {
      const waiting = read(sessionStorage, pendingKey);
      const provider = (validPending(waiting) ? waiting : read(sessionStorage, grantKey))?.provider;
      return ['workbuddy', 'codex', 'qwen'].includes(provider) ? provider : 'codex';
    }
    function close({ forget = false } = {}) {
      controller?.abort(); pending = null; const current = session; session = null;
      if (forget) {
        const grant = read(sessionStorage,grantKey); sessionStorage.removeItem(grantKey); sessionStorage.removeItem(pendingKey); localStorage.removeItem(endpointKey);
        if (validGrant(grant)) void request(grant.endpoint,'/v1/connect/direct-revoke',{reconnectToken:grant.reconnectToken,instanceId:grant.instanceId},undefined,2000).catch(() => {});
      }
      current?.detach();
    }
    return { prepare, connect, close, hasSaved, hasPendingRequest, savedProvider };
  }
  globalThis.KmCodeConnector = Object.freeze({ create });
})();

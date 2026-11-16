/* No custom URL launch or direct website-to-loopback fetch. Download preparation
 * uses the same origin-bound PKCE callback and local relay as the desktop build. */
(() => {
  function create({ onStatus = () => {} } = {}) {
    const key = 'km-agent.code.endpoint'; let pending, controller, session;
    const remember = result => { session = result; localStorage.setItem(key, JSON.stringify({ endpoint: result.endpoint, instanceId: result.instanceId })); return result; };
    function prepare({ onRequest = () => {} } = {}) {
      controller?.abort(); session?.close(); session = null;
      controller = new AbortController(); let request;
      const connection = globalThis.KmDesktopConnector.connect({ onStatus, signal: controller.signal, timeoutMs: 1800000,
        beforeOpen(url) { request = btoa(JSON.stringify({ url, created: Date.now() })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); onRequest(request); },
        launch() { onStatus('请将连接请求发送给本地 Agent，完成后会自动连接'); },
      }).then(remember).finally(() => { if (pending === connection) pending = null; });
      pending = connection;
      pending.catch(() => {});
      if (!request) throw Error('请允许此网站打开连接窗口后再复制请求');
      return { request, connection: pending };
    }
    function connect() {
      if (pending) return pending;
      let saved; try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
      if (!saved) return Promise.reject(Error('请先复制连接请求给本地 Agent，准备完成后会自动接入'));
      controller = new AbortController();
      return globalThis.KmDesktopConnector.connect({ onStatus, resume: saved, signal: controller.signal, timeoutMs: 15000 }).then(remember).catch(error => { localStorage.removeItem(key); throw Error('后台服务未连接，请重新复制连接请求给本地 Agent。' + error.message); });
    }
    function close() { controller?.abort(); session?.close(); session = null; }
    return { prepare, connect, close };
  }
  globalThis.KmCodeConnector = Object.freeze({ create });
})();

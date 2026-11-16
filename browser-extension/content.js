(() => {
  if (window !== window.top || !['http://lt.com:8085', 'http://local.lt.com:8251'].includes(location.origin)) return;
  let channel, runtime;
  addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'km-agent-extension/1' || event.ports.length !== 1) return;
    // One channel per document; replacement closes every old native request.
    runtime?.disconnect(); channel?.close();
    const current = event.ports[0], connection = chrome.runtime.connect({ name: 'km-agent-local/1' });
    channel = current; runtime = connection;
    connection.onMessage.addListener(value => current.postMessage(value));
    connection.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      current.postMessage({ type: 'unavailable', error: '浏览器扩展已断开，请刷新网页后重试' });
    });
    current.onmessage = message => { try { connection.postMessage(message.data); } catch {} };
    current.start();
  });
  addEventListener('pagehide', () => { runtime?.disconnect(); channel?.close(); });
})();

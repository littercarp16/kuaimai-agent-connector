// The origin comes from Chrome's sender, never from a web-page message.
const origins = new Set(['http://lt.com:8085', 'http://local.lt.com:8251']);
chrome.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  let origin;
  try { origin = new URL(sender.url).origin; } catch { port.disconnect(); return; }
  if (port.name !== 'km-agent-local/1' || sender.id !== chrome.runtime.id || sender.frameId !== 0 || !sender.tab || !origins.has(origin)) {
    port.disconnect(); return;
  }
  let native, closed = false;
  const post = value => { if (!closed) try { port.postMessage(value); } catch {} };
  port.onMessage.addListener(message => {
    if (!message || !['request', 'cancel', 'ack'].includes(message.type)) return;
    if (!native) {
      native = chrome.runtime.connectNative('com.kuaimai.agent_connector');
      native.onMessage.addListener(post);
      native.onDisconnect.addListener(() => {
        void chrome.runtime.lastError;
        native = null;
        post({ type: 'unavailable', error: '本机通道尚未就绪，请让 Agent 执行最新连接请求；若刚安装扩展，请刷新网页。' });
      });
    }
    try { native.postMessage({ ...message, origin }); } catch { post({ type: 'unavailable', error: '本机通道已断开，请重新连接' }); }
  });
  port.onDisconnect.addListener(() => { closed = true; native?.disconnect(); });
  post({ type: 'ready', version: chrome.runtime.getManifest().version });
});

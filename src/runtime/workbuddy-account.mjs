import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { openWebUrl } from './windows.mjs';

const hosts = new Set(['copilot.tencent.com', 'www.workbuddy.cn', 'workbuddy.cn', 'open.workbuddy.cn',
  'www.workbuddy.ai', 'workbuddy.ai', 'open.weixin.qq.com', 'codebuddy.ai', 'www.codebuddy.ai']);
const accountError = message => Object.assign(new Error(message), { publicMessage: message });
const openBrowser = url => process.platform === 'win32' ? openWebUrl(url) : promisify(execFile)('/usr/bin/open', [url], { timeout: 10000 });

// Use the account API of the bridge-owned CLI process. The CLI selects the
// login method for its product and confirms the signed-in account itself.
export function createWorkBuddyAccountLogin({ endpoint, password, signal, open = openBrowser, now = Date.now }) {
  let pendingPage;
  const canReopen = () => !!pendingPage && !pendingPage.reopenClaimed && now() >= pendingPage.availableAt;
  async function request(action, guard, timeout = 20000) {
    signal.throwIfAborted(); guard();
    const start = action === 'login';
    const response = await fetch(endpoint + '/api/v1/auth/account/' + action, {
      method: start ? 'POST' : 'GET', redirect: 'error',
      headers: { Authorization: 'Bearer ' + password, 'X-CodeBuddy-Request': '1', ...(start && { 'Content-Type': 'application/json' }) },
      ...(start && { body: '{}' }), signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw accountError('WorkBuddy CLI 账号接口返回 HTTP ' + response.status); }
    const payload = await response.json();
    return payload.data ?? payload;
  }
  async function reopen(guard) {
    signal.throwIfAborted(); guard();
    if (!canReopen()) return;
    const page = pendingPage;
    page.reopenClaimed = true;
    try { await open(page.url); }
    catch {
      page.reopenClaimed = false;
      throw accountError('系统未能打开浏览器，请重试。');
    }
  }
  async function readStatus(guard = () => {}, timeout) {
    const state = await request('status', guard, timeout);
    if (typeof state?.authenticated !== 'boolean' || state.unavailable) throw accountError('当前 WorkBuddy CLI 未提供账号登录。');
    return state;
  }
  async function authenticate(guard, setPhase) {
    let state = await readStatus(guard);
    if (state.authenticated) return;
    try {
      if (!state.loginPending) {
        const started = await request('login', guard);
        if (!started.success || started.loginError) throw accountError('WorkBuddy CLI 未能启动官方登录，请重新登录。');
        if (started.authUrl) {
          let url;
          try { url = new URL(started.authUrl); } catch {}
          if (!url || url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.host)) throw accountError('WorkBuddy CLI 返回了无法验证的官方登录地址。');
          // The official CLI opens the original page. Offer one recovery open
          // only after the browser has had time to display it.
          pendingPage = { url: url.href, availableAt: now() + 5000, reopenClaimed: false };
        }
      }
      setPhase('authenticating', '请在已打开的 WorkBuddy 官方登录页完成授权。');
      const until = Date.now() + 300000;
      do {
        state = await readStatus(guard);
        if (state.authenticated === true) return;
        if (state.loginError || !state.loginPending) throw accountError('WorkBuddy CLI 登录已结束，但账号尚未登录，请重新登录。');
        await delay(1000, undefined, { signal });
      } while (Date.now() < until);
      throw accountError('等待 WorkBuddy CLI 登录超时，请重新登录。');
    } finally { pendingPage = undefined; }
  }
  return { isAuthenticated: async () => (await readStatus(undefined, 2000)).authenticated,
    authenticate, reopen, canReopen };
}

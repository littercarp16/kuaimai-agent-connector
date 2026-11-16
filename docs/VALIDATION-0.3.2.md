# 0.3.2 HTTP 扩展连接验收

日期：2026-11-16。环境：macOS、Node.js 22+、Google Chrome 157.0.8103.51。

## 结果

- Node 回归：537 通过、0 失败、12 个可选环境测试跳过。包含扩展身份/精确来源/端口/接口、真实 Native Messaging 帧、PKCE、跨来源凭据隔离及关页清理。
- 浏览器：2 个 HTTPS 直连来源、2 个 HTTP 扩展来源均通过。HTTP 页面的 `isSecureContext` 为 false；CSP `connect-src 'none'` 禁止网页直接联网，仍能通过真实扩展与本机 Node 子进程完成端口发现、授权、发送、SSE 回复、刷新和断开。
- 同域错误端口 `http://lt.com:8086` 不会收到扩展通道。HTTP 用例全程只有原页面、没有 iframe，没有调用 `window.open`。
- Vue 实际组件：分别以 `http://lt.com:8085` 与 `http://local.lt.com:8251` 为来源，验证复制请求、自动发现端口、最近 10 条会话和项目标签、明确选择后绑定、双向消息、刷新 3 次、主动断开。安装回调不重启 Codex、不创建登录项、不重复发送 prompt。
- 前端相关单元测试：12 通过。
- npm 候选包：2 通过。从 tarball 安装依赖，验证独立后台运行、复用服务以及打包后的扩展和 Native Messaging 启动器注册。

浏览器测试采用独立临时配置，通过 CDP 加载待测扩展。仅该临时浏览器使用扩展调试开关；没有关闭同源、混合内容或本地网络访问检查。测试结束关闭临时浏览器、服务并删除临时配置，不修改当前用户浏览器设置。

## 验证边界

HTTP 来源页面和 Agent 响应为测试夹具；Vue 使用当前项目的真实组件，浏览器扩展、本机消息进程、连接器 HTTP/SSE 与授权代码均真实运行。本次没有向用户的现有 Codex 会话发送测试内容，也没有重启 Codex。真实模型双向链路已在 0.3.1 验证；本次验证新增的传输通道。

测试环境网站尚未部署新的前端。Chrome 扩展测试包为 0.1.0，尚未上架商店；需要首次安装确认。Edge 注册路径已实现，尚未做 Edge 浏览器验收。

## 复现

```sh
npm test
PWB_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node --test tests/desktop/direct-browser.test.mjs tests/desktop/extension-browser.test.mjs
KM_NPM_TARBALL=/absolute/path/to/kuaimai-agent-connector-0.3.2.tgz KM_AGENT_DISABLE_CODEX=1 node --test tests/desktop/npm-runtime.test.mjs
npm run build:extension
```

前端在 `lingtong-app-view` 运行：

```sh
KM_AGENT_HTTP_ORIGIN=http://lt.com:8085 KM_ESBUILD_MODULE=/absolute/path/to/esbuild PWB_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/browser/kmPageCodex.cjs
KM_AGENT_HTTP_ORIGIN=http://local.lt.com:8251 KM_ESBUILD_MODULE=/absolute/path/to/esbuild PWB_PLAYWRIGHT_MODULE=/absolute/path/to/playwright node tests/browser/kmPageCodex.cjs
```

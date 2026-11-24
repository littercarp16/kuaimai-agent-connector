# npm 后台运行版

当前支持 macOS 与 Node.js 22+。网页复制请求，让本地 Agent 从 npm 官方源安装并后台启动。不需要 `.app`、登录启动项、项目目录、手动端口或配对码。

## 原页面连接流程

1. 网页生成 state 和 PKCE verifier。复制请求包含 state、challenge 与精确网站来源，自生成起 10 小时内有效。verifier 留在当前标签页。
2. Agent 执行网页生成的 `npx` 命令，使用其中指定的 npm 版本与连接请求。
3. CLI 将对应版本安装到 `~/.kuaimai-agent/code/npm/<版本>/`，忽略安装脚本。服务从持久目录独立运行。
4. 同一用户的各个来源共用 `~/.kuaimai-agent/code/instances/shared/` 中的后台。CLI 复用控制协议兼容的同版或更高版本。执行更新版本的 CLI 时，通过私有控制 socket 升级旧的共享后台，完成后各网页重新领取授权。
5. 服务优先监听 17653，被占用则在 17653–17684 中选择可用端口；全部占用时明确报错。网页只向该范围和曾经保存的 loopback 端点请求无凭据的发现接口，不扫描任意端口。
6. Agent 通过私有 IPC 登记短期 challenge。不会运行 `open`、打开 URL Scheme 或浏览器回调。原页面发现服务后用 verifier 单次领取当前实例的授权。
7. HTTPS 网页直接通过 HTTP/SSE 加载最近 10 条会话、项目名和双向消息；两个指定 HTTP 环境通过浏览器扩展和本机消息通道传输，不使用 popup、iframe 或中转窗口。
8. 选择并确认会话后才允许输入。安装准备不会重启 Codex；需要切换共享 socket 时仍由后续显式选择/检测触发。不会安装登录任务。

## 授权与恢复

监听仅限 127.0.0.1。CLI 通过当前用户的私有控制通道登记精确来源，服务验证 Host、Origin 和 CORS。领取、恢复和撤销授权都绑定网站与实例。`stop --origin` 撤销该来源的授权，最后一个来源移除后后台退出。

访问 token 仅在内存。8 小时有效的恢复凭据仅放当前标签页的 sessionStorage；localStorage 只放 endpoint 和 instanceId。复制请求和 CLI 输出均不含这些凭据。刷新会用恢复凭据替换旧网页客户端，不继承会话绑定、控制权限或重发 prompt。

关闭业务网页会释放本页客户端，后台服务继续运行。主动断开会撤销恢复授权并清理缓存。浏览器新标签页、授权过期或服务重启后需要新的复制请求，网页仍自动识别端口，无须填写配置。

旧版 macOS 应用的顶层连接窗口和授权接口继续兼容；新的代码版 SDK 不调用这条路径。

从按来源运行的旧版迁移时，用新版命令分别连接各网页。旧实例若仍在运行，可以用原版本的 `stop --origin` 关闭对应实例。

## 浏览器和部署

正式与灰度网页使用 HTTPS。浏览器首次可能提示允许访问本地网络，这是浏览器权限，不会打开我们的连接页面。测试已通过正常 Chrome 网络权限完成，未关闭同源、混合内容或本地网络保护。

`http://lt.com:8085` 与 `http://local.lt.com:8251` 保留 HTTP，使用[浏览器扩展本机通道](BROWSER-EXTENSION.md)。首次需要安装扩展；连接请求会自动注册本机通道，后续原页面自动连接，不经过服务器中继。不依赖浏览器对 HTTP 页面访问 loopback 的放行策略。

HTTPS 直连网站若设置 CSP，`connect-src` 需包含 `http://127.0.0.1:*`。若业务网页嵌在跨站 iframe 中，上层还需按浏览器规则委派本地网络权限。参考 [Chrome Local Network Access](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)。

前端同步：`node desktop/sync-code.mjs /absolute/path/to/lingtong-app-view`。同步 npm 版本和 SDK；历史回调静态文件保留兼容。先发布 npm，再发布引用新版本的网页。

## 验证

`tests/desktop/direct.test.mjs` 验证来源/实例/PKCE、错误 Host、单次领取、过期、恢复回收和主动撤销。

`tests/desktop/direct-browser.test.mjs` 使用正式/灰度来源的浏览器夹具和真实本机 HTTP/SSE，验证单页面、消息收发、刷新与断开。`lingtong-app-view/tests/browser/kmPageCodex.cjs` 使用实际 Vue 组件、复制操作和本机网络，验证最近 10 条、项目标签、显式绑定、消息和刷新；其中 Agent 执行与模型响应是夹具，真实 Codex 另作人工链路验收。

`tests/desktop/extension.test.mjs` 验证固定扩展身份、完整来源、端口/接口限制、消息帧和凭据隔离；`extension-browser.test.mjs` 在两个 HTTP 来源使用真实 Chrome 扩展与 Native Messaging，并在 `connect-src 'none'` 下验证双向流、刷新和断开。

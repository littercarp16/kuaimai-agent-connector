# macOS 连接器与线上网页接入（0.2.2）

## 安装与使用

构建产物位于 `dist/macos/`：`.app`、DMG、ZIP、`SHA256SUMS` 和 `build-info.json`。当前构建面向 Apple Silicon，最低 macOS 13，内置 Node.js，用户无需安装 Node 或打开终端。

1. 打开 DMG，将 `Kuaimai Agent Connector.app` 拖入“应用程序”，再打开它。
2. 打开后自动启动桥接，无需选择项目目录。在绫通快麦多维表格的会话设置中，选择 Agent → ChatGPT / Codex。
3. 程序注册登录自启动，实际状态显示在设置窗口；系统要求允许时，在“系统设置 → 通用 → 登录项”中处理。菜单栏“登录时自动启动”可以关闭它。
4. 关闭设置窗口后服务继续运行。菜单栏可停止桥接、修改网站来源、退出程序。停止桥接的选择会保留到下次启动；网页再次唤起并接入时会恢复服务。
5. Agent 选择后自动唤起并连接。允许浏览器打开连接器，在本机核对网站后确认。网页自动获得实际端口，复用共享 socket（仅私有 stdio 时切换），按最近活动显示 10 条主会话。选定会话后确认进入协作；列表加载不会自动绑定或发送 prompt。

现有 ChatGPT 共享 socket 检查、私有 stdio 切换、Dock 持久配置沿用已有接口；单独打开连接器不会重启 ChatGPT。参见 [Codex 接入](./CODEX.md)。

**当前产物为 ad-hoc 签名的本机测试版，尚无 Developer ID 签名与 Apple 公证，不能作为已完成正式分发的安装包。** 正式下载给客户前，使用下方签名、公证构建流程。不建议通过关闭系统安全机制来分发测试包。

## 可配置的网站来源

默认值来自 `desktop/origins.json`，首次运行写入应用配置。后续在菜单栏“允许的网站…”中修改，更新程序不会覆盖用户的已保存配置。修改网站前需停止桥接，现有连接随之失效。

| 环境 | 精确来源 |
| --- | --- |
| 线上 | `https://app.ltpass.com` |
| 灰度 | `https://app1.ltpass.com` |
| 测试 | `http://lt.com:8085` |
| 本地开发 | `http://local.lt.com:8251` |
| 本机原型 | `http://127.0.0.1:4173` |

协议、域名、端口必须完全一致。不接受通配符、URL 路径或凭据。HTTPS 可增加其他精确域名；HTTP 限定为显式支持的开发主机（`127.0.0.1`、`localhost`、`*.localhost`、`local.lt.com`、`lt.com`），仍须加入白名单。白名单让网站有资格申请接入，每次新连接仍会在本机显示确认。

## 网页部署

此仓库提供接入组件，**不会自动修改或发布线上、灰度、测试站点**。正式前端仓库 `lingtong-app-view` 已在真实 Vue 配置弹窗中接入 SDK 和 `ConnectorClient.attachDesktop()`，移除了独立的“接入 ChatGPT”按钮。`public/agent/connect-callback.html` 与同目录 JS 随前端发布；SDK 作为业务模块打包。线上仍需要发布该仓库的改动。旧原型 `lingtong-prototypes/kmMDTable` 的按钮流程继续兼容。

将以下三个文件发布到每个网站的固定路径（不能重定向至其他来源，也不能返回 SPA 首页）：

| 仓库文件 | 网站路径 |
| --- | --- |
| `web/desktop-connect.js` | `/agent/desktop-connect.js` |
| `web/connect-callback.html` | `/agent/connect-callback.html` |
| `web/connect-callback.js` | `/agent/connect-callback.js` |

页面加载 SDK 后，在**用户点击的同步调用栈**中调用 `connect()`；不要先等待网络请求，否则浏览器可能拦截连接窗口。

```html
<script src="/agent/desktop-connect.js" defer></script>
<script src="/app-agent.js" defer></script>
```

```js
// app-agent.js：现有 KmAgentClient 已包含 attachDesktop 方法时
let desktop;
document.querySelector('#connectChatGPT').onclick = async () => {
  try {
    desktop?.close();
    desktop = await KmDesktopConnector.connect({ onStatus: showConnectionStatus });
    await client.attachDesktop(desktop);
    // 此后调用既有 ChatGPT 接入/会话选择流程。
  } catch (error) {
    showConnectionStatus(error.message);
  }
};
```

其他前端可以直接使用返回的 `desktop.fetch(desktop.endpoint + '/v1/...', options)`，支持 JSON 和流式 SSE `Response.body`。只允许固定的桥接业务路径；不开放 `/v1/local/*`。HTTP 开发页面生成请求 ID 时可使用 `KmDesktopConnector.randomUUID()`，无需依赖仅安全上下文提供的 `crypto.randomUUID()`。

断开连接调用 `desktop.close()`。网页刷新、连接窗口关闭、服务重启后，需要重新点击接入；不持久保存跨站可用的桥接授权。连接窗口须保留打开，关闭 macOS 程序的设置窗口不影响连接。

### 浏览器与响应头

当前验收使用 macOS Chrome，四个来源均完成真实浏览器的 JSON 请求和 SSE 测试。Safari、Edge、Firefox 的原生回跳路由已提供，但尚未逐个浏览器实测。

- 本机程序通过 `km-agent://connect` 唤起，由系统处理；浏览器可能要求确认“打开应用”。WorkBuddy 的直接授权由原网页领取，两个 HTTP 开发来源沿用连接窗口。未安装时 SDK 最多等待两分钟并显示安装/重试提示。
- 接入页需要保留与连接弹窗的 `window.opener` 关系。支持默认 COOP 或 `Cross-Origin-Opener-Policy: same-origin-allow-popups`。若现有产品采用严格 `same-origin`/`noopener`，请设计独立的接入页面并评估隔离需求，不要直接移除全站隔离策略。
- 网站 CSP 只需允许本站 SDK/回调脚本；网站不直接 fetch 本机 HTTP。连接窗口是顶层 `http://127.0.0.1:<实际端口>` 页面，使用自己的同源 fetch，再通过准确匹配来源、窗口和 state 的 `postMessage` 传递响应。
- 回调页与原始页面必须处于同一浏览器配置文件/存储分区。应用按浏览器类型回跳，无法可靠选择浏览器的隐私窗口或多个用户配置。回跳到不同配置时会明确提示返回原浏览器重试。
- 回调页面使用片段传递短期票据，读取后立即清理 URL。不要给回调页注入统计脚本、第三方脚本或把完整 URL 收集到日志。

## 端口发现与授权流程

1. 网页创建随机 state 与 PKCE verifier，只保留 verifier 在当前页内存中；生成其 SHA-256 challenge。
2. 唤起链接仅包含网站来源、固定同源回调路径、state、challenge、浏览器枚举。原生端拒绝未知参数、重复字段、任意回跳和命令参数。
3. App 启动自己的后台进程，优先监听 `127.0.0.1:17653`。若被占用，则由系统选择空闲端口。已有 CLI 桥接继续运行，App 不接管其他实例。
4. 用户在本机确认后，App 通过**私有 stdin/stdout**签发绑定来源、challenge、state、实例的一次性票据，有效期两分钟；HTTP 无签发接口。
5. App 将真实端口、实例和短期票据带回该网站固定回调页。回调页使用同源 BroadcastChannel / storage 通知原始网页。
6. 原始页把预先打开的窗口导航至实际本机端口。这个窗口用票据和 verifier 换取授权，将授权只保留在本机窗口内存。网页端得到的是专属传输及不具备 HTTP 鉴权能力的标记。
7. 业务请求与 SSE 经本机窗口中转。错误来源、错实例、过期或重复票据不能交换授权。网页侧传输不接受本机发布、启动命令等私有接口。

因此不用扫描端口、写死端口或把端口同步到远端服务器。连接授权与会话控制授权分别处理；选择只读绑定时不能发送 prompt。

## 运行文件

默认目录为 `~/Library/Application Support/Kuaimai Agent Connector/`（0700）：

- `settings.json`：来源白名单、服务和登录启动偏好，0600。
- `connector.json` 和租约：当前实例的私有运行信息，0600；含发布凭据，不应上传或放入网页资源。
- `service.log`：后台错误，限定大小，网页票据和授权 token 不写入此日志。

会话中的成果发布指令使用应用内置 Node，并携带 `publish.mjs --runtime <本实例 connector.json>`；不依赖用户的系统 Node 或开发仓库 `.runtime`，也不会误投递给另一个 CLI 实例。

App 登录项与已有 `local.agent-connector.codex-dock` 是独立配置。退出连接器会停止它自己启动的服务，不终止其他 CLI 桥接或 ChatGPT。移除程序前先在菜单栏关闭登录启动；也可用应用内的 `Contents/MacOS/KuaimaiAgentConnector --unregister-login` 移除自身登录项。`--login-status` 可查看系统实际注册状态。

## 构建和验证

```sh
npm ci --ignore-scripts
npm run build:macos
# 具备 Developer ID Application 证书及已有 Keychain 公证配置时：
npm run build:macos -- --identity 'Developer ID Application: YOUR COMPANY (TEAMID)' --notary-profile YOUR_PROFILE
```

构建依赖 macOS 的 Xcode Command Line Tools、`codesign`、`ditto`、`hdiutil`。构建脚本核验 Node 不依赖 Homebrew 动态库，拷贝 Node 对应版本的许可及运行依赖，签名内部 Node 和 `.app`，生成 DMG/ZIP。正式模式使用 hardened runtime，提交 DMG 公证并装订票据。证书/公证配置保留在本机钥匙串，不放进仓库。

`--node /absolute/path/to/node` 可指定独立 Node 二进制；需要在 `desktop/licenses/` 提供该精确版本的官方 LICENSE。Intel 构建需要 x64 Node，当前产物未覆盖 Intel。

```sh
npm test
# 已有 Playwright 环境时，显式启用真实浏览器验收：
PWB_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs npm run test:desktop
# 可选：PWB_AGENT_CLIENT_ROOT=/absolute/path/to/kmMDTable/agent 一并验证现有业务客户端
# 构建后解压 ZIP，在临时目录使用包内 Node 检查独立运行与清理：
node tests/desktop/verify-package.mjs
```

浏览器测试使用隔离宿主、模拟 Agent 和本机模拟网页响应，不把测试 prompt 发给真实模型，不修改线上站点。原生确认边界在浏览器自动化测试中模拟；原生 App、系统 URL 分发和登录项状态须另外实机核验。测试不执行注销或重启整个 macOS 会话。

参考：[Apple SMAppService](https://developer.apple.com/documentation/servicemanagement/smappservice)、[Apple 登录项迁移](https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos)、[MDN postMessage](https://developer.mozilla.org/en-US/docs/Web/API/Window/postMessage)、[MDN COOP](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy)。

## Agent 会话范围

桌面宿主以 `sessionScope: agent` 请求 Codex 当前账号下各项目的最近 10 条未归档主会话，按 `updated_at desc` 排序，排除子代理。发现阶段只读取元数据；选择后才读取会话历史并订阅事件。绑定时从所选会话继承真实目录，目录发生变化会使旧绑定失效，不扩大 Codex 的原始权限。CLI 显式 `--workspace` 模式仍维持原来的目录范围。

正式前端的自动接入使用 `discoverOnly`，即使只有一条会话也等待用户明确选择，不自动绑定或新建。保留网页输入授权及已有业务页面的权限、版本核验与草稿保存规则。

### 会话所属项目

0.2.2 起最近会话携带可选 `projectName`。优先读取 Codex 明确的项目归属；对没有项目 ID 的旧会话，使用 Codex `project/list` 中已登记的项目根目录匹配，选择最具体的根目录，读取实际项目名称。无法匹配、归属冲突或项目接口不可用时保持原会话标题，不用任意目录名代替项目。前端在会话标题后显示浅色项目标签，选中值也包含项目名称。

# 快麦 Agent 连接器

本机 Agent 桥接服务，通过 `km-agent/1` 提供会话发现、选择、实时消息和授权后的网页输入。代码版支持 **macOS + Node.js 22 或更新版本**，已验证 ChatGPT / Codex 与千问办公的网页页面协作。

## 网页接入

在绫通快麦多维表格网页选择 ChatGPT / Codex 或千问办公，点击“复制连接请求”，交给本地 Agent 执行：

```sh
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.4.0 connect --request '<网页自动生成的请求>'
```

命令安装或复用当前用户目录中的固定版本，启动独立后台进程，并将实际端口返回原网页。无需选择项目目录、填写端口或配对码。在原页面直接连接，无需弹窗、回调页或保留连接窗口；接入请求有效期 30 分钟。

- 不安装 macOS App，不创建登录启动项，不修改原 Agent 的模型和工具审批设置。
- 首选端口 17653 占用时在 17653–17684 内自动选择可用端口，网页自动发现，不终止占用进程。
- 展示当前 Agent 最近活动的 10 条主会话及项目名称。
- 明确选择会话并授权后才能输入 prompt；Codex 安装接入不会重启正在执行准备任务的 Agent。千问 HTTP 未开启时，由独立后台桥接正常退出并重新启动千问，可能中断当前任务；网页连接请求会明确说明。
- 服务仍运行时可直接重连；退出登录、电脑重启或停止服务后，再次复制请求启动。
- Codex 需要共享 app-server socket，私有 stdio 的切换见 [Codex 接入](docs/CODEX.md)。

## 0.4.0 页面协作

- 千问办公 2.0.2：首次连接与复用桥接都会检测 HTTP 接口。需要时通过启动环境变量启用接口，不写入 `.env`、不安装 Skill 或 Hook；正常退出失败时不强杀。
- 网页显式绑定会话后发送原始用户输入和当前页面元数据。Codex 0.169.0 使用 `additionalContext`；千问使用已验证的正文上下文分区，首次发送、切换页面或上下文失效时才补充，同页续聊避免重复。用户原文单独保留。
- 千问运行时文件访问审批同步网页，支持允许和拒绝；提交前校验实例、会话、任务和完整访问范围，未知权限仍在原客户端处理。千问可能在当前会话记住路径和访问方式，不修改全局审批设置。
- 支持 Agent 读取原页面、保存草稿和网页自动预览；发布页面仍由用户确认操作。网页需同步本版本 SDK 与页面协作组件。
- 改善 Codex 较长会话的历史读取边界，并增加带轮转的脱敏运行日志。

## 服务管理

```sh
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.4.0 status --origin https://app.ltpass.com
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.4.0 stop --origin https://app.ltpass.com
```

以实际网页来源替换示例。代码保存在 `~/.kuaimai-agent/code/npm/`，运行信息与日志位于 `~/.kuaimai-agent/code/instances/`。运行文件包含本机凭据，不应上传或公开。

从 0.3.3 起，桥接服务进程名为 `kuaimai-agent-connector`，可在 macOS「活动监视器」中搜索该名称，并用 `status` 返回的 PID 区分不同网站的实例。已有旧版实例在执行新版连接请求时自动升级并重启，随后显示新名称。

0.4.0 增加[运行日志与自动轮转](docs/LOGGING.md)：记录服务启动/停止、网页授权、实时连接断开、请求状态码与耗时，以及脱敏后的错误诊断。后台 `status` 的 `logging` 字段给出日志路径、轮转限制和写入失败次数。

## 开发

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --dry-run
```

`src/adapters/` 实现 Agent 适配，`src/http/` 实现 HTTP/SSE，`src/headless/` 实现后台运行，`web/` 提供原页面直连 SDK（旧 macOS 应用的连接窗口保留兼容），`tests/` 是回归测试。原有 CLI、技能和 macOS 应用分发方式保留。

线上/灰度 HTTPS 网页直接连接本机，并按浏览器提示允许本地网络访问；如设置 CSP，`connect-src` 需允许 `http://127.0.0.1:*`。

`http://lt.com:8085` 和 `http://local.lt.com:8251` 使用浏览器扩展通道，无需改 HTTPS，不打开连接窗口。Agent 执行 0.3.2+ 的连接请求时自动注册本机通道；首次需在 Chrome 中安装扩展并刷新原网页，之后直接复用。端口发现、最近会话和双向流式消息仍由本机连接器提供，不经过服务器中继。见 [扩展安装说明](browser-extension/README.md) 和 [通信说明](docs/BROWSER-EXTENSION.md)。

前端发布前执行 `node desktop/sync-code.mjs /absolute/path/to/lingtong-app-view` 同步 npm 版本、SDK 和回调页；不需将运行包复制进网页静态目录。

[代码版说明](docs/CODE-RUNTIME.md) · [协议](docs/PROTOCOL.md) · [macOS 应用](docs/MACOS-APP.md) · [技能](skills/README.md)

# 快麦 Agent 连接器

本机 Agent 桥接服务，通过 `km-agent/1` 提供会话发现、选择、实时消息和授权后的网页输入。代码版支持 **macOS + Node.js 22 或更新版本**，优先测试 ChatGPT / Codex。

## 网页接入

在绫通快麦多维表格网页选择 ChatGPT / Codex，点击“复制连接请求”，交给本地 Agent 执行：

```sh
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.3.1 connect --request '<网页自动生成的请求>'
```

命令安装或复用当前用户目录中的固定版本，启动独立后台进程，并将实际端口返回原网页。无需选择项目目录、填写端口或配对码。在原页面直接连接，无需弹窗、回调页或保留连接窗口；接入请求有效期 30 分钟。

- 不安装 macOS App，不创建登录启动项，不修改原 Agent 的模型和工具审批设置。
- 首选端口 17653 占用时在 17653–17684 内自动选择可用端口，网页自动发现，不终止占用进程。
- 展示当前 Agent 最近活动的 10 条主会话及项目名称。
- 明确选择会话并授权后才能输入 prompt；安装接入不会重启正在执行准备任务的 Agent。
- 服务仍运行时可直接重连；退出登录、电脑重启或停止服务后，再次复制请求启动。
- Codex 需要共享 app-server socket，私有 stdio 的切换见 [Codex 接入](docs/CODEX.md)。

## 服务管理

```sh
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.3.1 status --origin https://app.ltpass.com
npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.3.1 stop --origin https://app.ltpass.com
```

以实际网页来源替换示例。代码保存在 `~/.kuaimai-agent/code/npm/`，运行信息与日志位于 `~/.kuaimai-agent/code/instances/`。运行文件包含本机凭据，不应上传或公开。

## 开发

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org
npm test
npm pack --dry-run
```

`src/adapters/` 实现 Agent 适配，`src/http/` 实现 HTTP/SSE，`src/headless/` 实现后台运行，`web/` 提供原页面直连 SDK（旧 macOS 应用的连接窗口保留兼容），`tests/` 是回归测试。原有 CLI、技能和 macOS 应用分发方式保留。

线上网页使用 HTTPS，并允许浏览器的本地网络访问权限；如设置 CSP，`connect-src` 需允许 `http://127.0.0.1:*`。指向 loopback 的 HTTP 本地开发域名已验证；位于局域网的 HTTP 测试站点需要 HTTPS。

前端发布前执行 `node desktop/sync-code.mjs /absolute/path/to/lingtong-app-view` 同步 npm 版本、SDK 和回调页；不需将运行包复制进网页静态目录。

[代码版说明](docs/CODE-RUNTIME.md) · [协议](docs/PROTOCOL.md) · [macOS 应用](docs/MACOS-APP.md) · [技能](skills/README.md)

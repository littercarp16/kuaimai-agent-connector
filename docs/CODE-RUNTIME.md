# npm 后台运行版（0.3.0）

当前支持 macOS 与 Node.js 22+。网页复制的请求让本地 Agent 从 npm 官方源安装并启动 `kuaimai-agent-connector`，不需要 `.app`、登录自启动、项目目录、手动端口或配对码。

## 运行流程

1. 点击复制：先复制完整指令，再打开等待连接的窗口。指令含固定 npm 版本与 30 分钟有效的接入参数。
2. Agent 执行 `npx --yes --registry=https://registry.npmjs.org kuaimai-agent-connector@0.3.0 connect --request '…'`。缺少 Node 时由 Agent 从官方来源准备环境。
3. CLI 将固定版本安装到 `~/.kuaimai-agent/code/npm/0.3.0/`，跳过 npm 安装脚本；已安装直接复用，后台服务不依赖 npx 缓存。
4. 启动独立 Node 进程，相同来源和版本复用；17653 占用时自动分配空闲端口。
5. CLI 通过当前用户私有 Unix socket 签发短期 PKCE 票据，用浏览器打开原网站固定回调页。网页自动获得实际端口并读取最近 10 条主会话与项目名。
6. 用户选择会话后进入协作。安装回调不调用桌面重启接口，避免中断执行安装的 Codex。若仍使用私有 stdio，待 Agent 完成后由用户选择/刷新触发现有切换；本版本不注册 Codex Dock 登录任务。

不注册 `km-agent://`，不新建登录项，不修改旧桌面版的既有设置。服务停止时网页无法执行本机命令，会提示再次复制请求。浏览器中转窗口需要保留。

## 发现与授权

每个网站对应独立用户进程，目录为 `~/.kuaimai-agent/code/instances/<origin-hash>/`，权限 0700；控制 socket 与运行清单为 0600。网页不能调用私有安装/停止操作，不会收到发布密钥。

网页只缓存 endpoint 和实例标识。重连凭据留在本机端口的浏览器存储中，绑定网站与实例，8 小时失效；刷新后可重连，但不会自动绑定会话或继承输入控制。服务重启后旧凭据失效，由新请求回传新端口。无端口扫描或云端凭据同步。

正式网站使用 HTTPS；明确的 HTTP 开发域名也受支持。JSON/SSE 经本机顶层连接窗口中转，网页不直接跨站请求 loopback。首次可能需允许弹窗；回调必须使用原浏览器配置文件，隐私窗口或其他配置无法共享此次接入。

## 发布与验证

```sh
npm test
npm pack --dry-run
npm publish --registry=https://registry.npmjs.org --access public
node desktop/sync-code.mjs /absolute/path/to/lingtong-app-view
```

前端发布 SDK、npm 版本配置和 `/agent/connect-callback.html`、`/agent/connect-callback.js`。回调不能重定向到 SPA 首页或加入 URL 采集、第三方统计。不再托管运行压缩包和自有下载器。

先发布 npm，再发布引用它的前端。版本更新同时修改 package.json、锁文件和 src/headless/service.mjs。测试覆盖后台启动/关闭、端口冲突、复用、来源隔离、过期票据和重连。前端 tests/browser/kmPageCodex.cjs 使用真实 Vue、复制操作、SDK、HTTP/SSE；本地 Agent 的请求执行与模型响应使用合成夹具。

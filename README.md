# 快麦 Agent 连接器

在绫通快麦多维表格的自定义页面里，选择本机的 ChatGPT / Codex、千问办公或 WorkBuddy CLI，即可新建或继续一个会话、收发消息，并处理 Agent 支持的审批。三个 Agent 共用当前系统用户的同一个后台连接器。

## 系统要求

从 `kuaimai-agent-connector@0.9.0` 起，macOS 和 Windows 共用同一个 npm 包。两端都需要 **Node.js 22 或更高版本及其随附的 npm**，并在当前系统用户下安装要接入的 Agent。可先运行 `node --version` 确认环境。

| 系统 | 验证情况 |
| --- | --- |
| macOS | 已验证 Codex、千问办公和 WorkBuddy CLI 的新建会话、绑定及消息收发。 |
| Windows 11 | 桥接后台真机自检 5 项全部通过，覆盖启动、进程复用、控制通道和停止。三个 Agent 的网页协作仍待真机验收。 |
| Windows 10 | 已纳入适配范围，待真机验证。 |

Windows 上的 Codex 需要安装并登录 Windows 原生 CLI。非默认安装目录和本地测试包的操作见 [Windows 验收说明](https://github.com/littercarp16/kuaimai-agent-connector/blob/main/docs/WINDOWS.md)。

## 网页接入

1. 在绫通自定义页面选择 Agent，点击 **复制连接请求**，把整段文案发给所选的本地 Agent 执行。已有兼容的桥接服务时也用这一步为新标签页授权，命令会复用正在运行的服务。
2. Agent 返回 `ok: true` 后，回到**生成请求的原标签页**。网页领取授权并打开会话选择框；如果已经显示「本地连接器已连接」，可直接在会话设置中继续。
3. 在所选 Agent 最近的 10 条会话中选一条，点击「确认并进入协作」，也可以选择**新建会话**，点击「新建并进入」。三个 Agent 都在确认后开启网页输入，无需另勾「允许网页输入」。WorkBuddy 提示登录时，按下表完成 CLI 授权。
4. 在网页发送第一条消息。Agent 的回复会出现在对话中。遇到支持的原生审批时，在对话中的审批卡上点「允许」或「拒绝」。

使用 npm 版时，三份连接请求都用 `npx` 从 npmjs 获取网页指定版本的 `kuaimai-agent-connector`，执行 `connect --request`。请求里带有目标 Agent、网页来源和本标签页的授权信息，有效期为 **10 小时**。直接复制网页生成的文案即可，无需填写端口、项目目录或配对码。

点击「新建并进入」会建立一个空会话。发送需求时，绫通会附上当前页面的上下文。Agent 保存草稿后可以在原网页预览，再由用户确认发布。

托管的 WorkBuddy CLI 默认在对话中逐次确认 Bash 命令。本机用户可以为共享桥接显式开启 Bash 信任模式；它适用于该桥接上的所有 WorkBuddy 会话。在启动桥接的终端设置 `KM_AGENT_WORKBUDDY_BASH_MODE=trusted`，使用 `status` 返回的 `workBuddyBashMode` 确认启动模式。切换模式需要重启桥接。[开启与关闭示例](docs/WORKBUDDY.md#bash-信任模式)

### 各 Agent 的接入差异

| Agent | 首次使用和会话来源 |
| --- | --- |
| ChatGPT / Codex | Windows 通过本机原生 Codex CLI 的 app-server 获取会话。macOS 通过共享 app-server socket 获取会话。执行复制请求时可以继续当前的 Codex 任务。桌面端使用私有 stdio 时，见 [Codex 接入说明](https://github.com/littercarp16/kuaimai-agent-connector/blob/main/docs/CODEX.md)。 |
| 千问办公 | 桥接会检查千问的本机 HTTP 接口。接口已开启时直接复用；已运行的千问未开启接口时，桥接会正常退出千问，再以启用 HTTP 的环境变量重新启动。**这会中断千问当前的任务**，刷新绫通恢复连接时也可能触发检查。 |
| WorkBuddy CLI | 使用 WorkBuddy 应用内置的 CLI。绫通显示「登录 WorkBuddy CLI」时，点击按钮完成官方登录。如果绑定或新建时已经打开官方登录页，直接在该页授权。回到绫通后，以「WorkBuddy CLI 已登录」为准。列表只展示连接器工作目录对应的 CLI 会话，后续在绫通里选回会话续聊。CLI 进程退出后可能需要再次登录。 |

### 哪些网页需要浏览器扩展

| 绫通网页来源 | 用户操作 |
| --- | --- |
| 正式或灰度 HTTPS 网页 | 网页直接连接本机服务，无需安装扩展。若浏览器询问是否允许访问本地网络，请允许。 |
| `http://local.lt.com:8251`、`http://lt.com:8085` | 这两个 HTTP 开发来源通过「快麦本地 Agent 连接」扩展访问本机服务。若网页提示缺少扩展，在 Chrome 或 Edge 的扩展管理页加载命令返回的 `browserExtension.extensionDirectory`，再刷新原标签页。已加载的扩展可以复用。 |

扩展负责在网页和本机服务之间转发请求和实时消息。命令输出中的 `extensionInstallRequired: true` 表示该网页来源使用扩展通道；是否需要安装，以原网页的提示为准。加载已解压扩展的步骤见[扩展安装说明](https://github.com/littercarp16/kuaimai-agent-connector/blob/main/browser-extension/README.md)。

## 重连与服务管理

- **刷新原标签页**时，网页可凭有效的恢复授权重新连接。恢复授权有效期为 8 小时；恢复连接后，需要重新确认会话才能发送消息。换到新标签页、授权过期或服务重启后，重新复制连接请求。
- **关闭网页**后，共享后台继续运行。「断开本页连接」撤销当前标签页的恢复授权。需要撤销整个网页来源的授权时，再使用下面的 `stop` 命令。
- **检查运行状态**时，使用网页连接请求里的包版本和实际来源。来源包含协议、域名和端口，省略页面路径。以下以 `0.9.0` 和正式站为例。Windows PowerShell 可用 `npx.cmd` 执行相同命令。

```sh
npx --yes --registry=https://registry.npmjs.org/ kuaimai-agent-connector@0.9.0 status --origin https://app.ltpass.com
```

`status` 返回共享后台的 `pid`、`version`、实际监听地址 `endpoint`、已授权来源 `origins` 和日志位置 `logging.path`。服务优先监听 `127.0.0.1:17653`，端口被占用时会在 17653–17684 内选择可用端口。连接命令返回 `reused: true` 表示已复用现有后台。

要撤销上述来源，在同一终端执行以下命令。其他已授权来源可继续使用；移除最后一个来源时，共享后台退出。

```sh
npx --yes --registry=https://registry.npmjs.org/ kuaimai-agent-connector@0.9.0 stop --origin https://app.ltpass.com
```

macOS 的数据目录为 `~/.kuaimai-agent/code/`，Windows 为 `%USERPROFILE%\.kuaimai-agent\code\`。其中 `npm/` 存放各版本的运行包，`instances/shared/service.log` 记录共享后台日志。Windows 任务管理器的「详细信息」中，可用 `status` 返回的 PID 定位对应的 `node.exe`。[运行日志说明](https://github.com/littercarp16/kuaimai-agent-connector/blob/main/docs/LOGGING.md)

## 开发

在本项目根目录运行以下命令安装依赖、测试并检查 npm 包内容。

```sh
npm ci --ignore-scripts --registry=https://registry.npmjs.org/
npm test
npm pack --dry-run
```

本地联调可从仓库根目录执行 `node ./headless.mjs connect --request '<网页生成的请求>'`。如果本机已有兼容的 npm 后台，这条命令也会复用它。要单独验证当前源码，可将 `KM_AGENT_CODE_INSTANCE_DIR` 设为当前用户新建的临时绝对目录，再执行连接请求。

`src/adapters/` 实现 Agent 适配，`src/http/` 提供 HTTP/SSE 接口，`src/headless/` 管理后台进程，`web/` 提供网页 SDK。前端发布前，在本仓库运行以下命令，将包版本、SDK 和回调页同步到绫通工作区；前端连接请求使用同步后的 `code-release.json` 指定的版本。

```sh
node desktop/sync-code.mjs /absolute/path/to/lingtong-app-view
```

部署 HTTPS 页面时，若配置了 CSP，`connect-src` 需允许 `http://127.0.0.1:*`。来源授权、端口发现与恢复协议见[运行机制](https://github.com/littercarp16/kuaimai-agent-connector/blob/main/docs/CODE-RUNTIME.md)。

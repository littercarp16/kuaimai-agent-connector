# Codex CLI原生共享会话

## 范围

网页通过 Connector HTTP/SSE 接入 **已经运行的 Codex 共享 App Server**。版本号仅用于诊断，不再限制具体版本、版本上限或 CLI/服务端的版本组合。是否可用取决于实际 Unix socket、WebSocket / RPC 初始化以及只读 `thread/list` 响应的协议校验。

Desktop、IDE、远端和`--no-daemon`会话只有在连接器能访问承载该会话的受支持共享服务时，才能同步运行中的事件。

## 由连接器切换桌面端

macOS 主入口支持桌面端条件接入，目标固定为 `/Applications/ChatGPT.app`。本机桌面版本 `26.1111.21308` 的安装包支持显式 `CODEX_APP_SERVER_WS_URL` 和 `ws+unix` 连接；应用升级后仍需核验。正常启动连接器、刷新健康检查或发现来源都不会重启桌面端。

该版本单独设置 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 不足以切换：自动 daemon 分支要求 `getConfigOverrides()` 为空，但桌面调用方始终加入 `plugins.codex-app-tools@openai-bundled.mcp_servers.codex_app.enabled=…`，因此仍回退 stdio。连接器改用更早选择的显式 WebSocket 分支，将 `CODEX_APP_SERVER_WS_URL=ws+unix://localhost<已校验的规范 socket 路径>:/rpc` 传给桌面。`localhost` 避免桌面的 SOCKS 代理分支；实际连接直接走 Unix socket，没有额外 TCP 代理，不修改安装包或用户配置。

网页「会话 / 本地 Agent」选择 **ChatGPT → 接入 ChatGPT**，连接器先检查实际通信方式，然后自动确保当前用户的 Dock 持久化设置已启用：首次安装登录启动项，已有配置进行验证和复用，未启用的已有配置尝试恢复。安装完成后，已连接同一个共享 Unix socket 的桌面直接复用；确认使用私有 stdio 时才退出并重新打开桌面端；未运行时直接启动。无法确认通信方式或持久化配置失败时保留桌面运行并提示失败，不静默降级为临时接入。网页展示安装和检查进度并刷新来源。绫通会话选择器支持选择已有会话或新建会话，用户确认后绑定并启用网页输入。无需用户执行终端命令。

页面切到后台或刷新后，凭本页保存的请求 ID 继续查询同一次操作，不再次发起重启。成功状态必须经过真实会话绑定确认，单纯启动应用不会显示为接入成功。

调试时仍可从本机调用：

```sh
npm run codex:desktop -- restart
npm run codex:desktop -- status
```

该命令读取当前连接器的私有运行凭据，请求**已运行的连接器进程**执行操作。连接器应在独立终端或通过 `start.mjs` 后台运行，避免退出桌面端时一起退出。不同端口可加 `--runtime /绝对路径/connector-端口.json`。客户端命令自身不退出桌面端、不启动模型。

检测使用同一用户的进程关系及 macOS `lsof` Unix socket 地址/对端：桌面主进程的连接必须指向已校验 daemon 路径的服务端 socket，单纯存在 daemon、环境变量或普通 IPC socket 不算共享接入。私有 stdio 要同时确认桌面的 app-server 子进程及其 stdin/stdout 与桌面相连。多种通信方式并存、其他 daemon、权限不足或检测期间进程/daemon 更换均视为未确认，不据此退出应用。

仅私有 stdio 分支执行：确认或 `codex app-server daemon start` 启动共享服务 → 从 daemon 状态及所有权/权限检查得到规范 socket 路径 → 验证该 `ws+unix` URL 的 WebSocket 握手 → 再次核验桌面通信方式 → 正常退出桌面端 → 确认进程退出 → 用 `open -a /Applications/ChatGPT.app --env …` 携带显式 `CODEX_APP_SERVER_WS_URL` 重开 → 核验实际共享 socket 连接。准备失败时不退出桌面。若准备期间桌面已自行切为共享连接，则直接复用。启动时一并传入 `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 和连接器使用的 `CODEX_HOME`。不会 restart/update 已有 daemon。

退出使用 macOS 正常退出事件，可能需要系统自动化权限。拒绝退出或退出超时会保留失败状态，不强杀、不重复退出。macOS LaunchServices 可能在旧 PID 消失后短暂保留旧应用记录，使 `open` 返回 `-600 (procNotFound)`：仅针对这个明确失败，在确认应用未运行后等待 500/1000ms，最多共尝试打开 3 次，参数和环境保持不变；每次等待后再次检查应用是否已被用户打开，不创建额外实例。其它启动错误或超时不自动重试。已绑定的 Codex 会话执行中、待答或状态未知时拒绝重启，但允许直接复用共享连接；未绑定的桌面任务无法由连接器完整判断，网页提示私有连接需在任务结束后切换。

网页宿主可在用户明确选择“接入 ChatGPT”时调用以下接口，沿用现有精确 Origin、`X-Km-Agent: 1` 和 Bearer 鉴权。保留原有 `restart` 路径以兼容客户端，其行为已改为上述条件接入。操作不要求先绑定会话，也不授予后续 prompt 控制权。

- `POST /v1/codex/desktop/restart`，JSON 为 `{ "instanceId": "当前连接器实例", "requestId": "新的 UUID" }`，返回 `202` 和操作记录。
- `GET /v1/codex/desktop`，读取最近操作的 `state`、`stage` 和 `message`。
- `/v1/health` 的 `capabilities.codexDesktopRestart` 表示该入口是否启用。非 macOS 或禁用 Codex 来源时为 false。
- `capabilities.codexDesktopDockPersistence` 表示接入流程包含 Dock 默认共享配置；新版网页要求此能力，旧连接器会提示更新。正常健康检查、来源发现及状态轮询均不会安装启动项。
- 同一 `requestId` 返回原操作，进行中拒绝另一操作；实际退出/启动后 30 秒内拒绝再次切换，直接复用不受重启冷却限制。响应丢失时用原 ID 查验或读取状态，不生成新 ID 自动重试。
- 操作记录的 `action` 为 `reuse`、`restart` 或 `start`，`transportBefore` / `transportAfter` 记录检测结果；检查失败时字段可能为 null。
- `launchAttempts` 记录实际打开次数，`launchErrorCode` 仅保留解析出的 macOS 数字错误码；等待系统清理期间的阶段为 `waiting-for-launch-service`，不向网页暴露原始 stderr 或环境。
- 持久化阶段为 `checking-dock` / `configuring-dock`；`operation.dock` 仅返回 `{ enabled, action }`，action 为 `install` / `repair` / `reuse`，不返回本机配置路径或环境值。新版网页必须确认 `dock.enabled=true` 后才继续绑定。

本机客户端使用 `POST /v1/local/codex/desktop/restart` / `status`，禁止 Origin，要求本机 `X-Km-Publisher`，以及 JSON `instanceId`；restart 另需 `requestId`。凭据不能放进网页。

`completed` 表示已确认桌面使用共享 socket，主入口还会确认 Dock 持久化设置已启用；`sharedSessionVerified` 仍保持 false，网页还需绑定目标会话。重开后若仍走 stdio 或无法确认连接，会报告失败而不显示切换成功，也不重复退出应用。首次网页接入自动完成下面的持久化安装，后续从 Dock 重开会继承共享连接配置。

### Dock 默认共享连接（macOS 当前用户）

网页按钮已包含启用操作，以下命令用于本机维护。`restart` 本机命令使用与网页相同的接入流程，同样确保持久化配置。

```sh
node codex-desktop.mjs dock-enable
node codex-desktop.mjs dock-status
# 恢复启用前的登录环境，不停止共享 daemon 或现有会话：
node codex-desktop.mjs dock-disable
```

启用时先校验安装包、daemon 状态、权限和 WebSocket 握手，再通过 `launchctl setenv` 设置 `CODEX_HOME`、`CODEX_APP_SERVER_USE_LOCAL_DAEMON=1`、`CODEX_APP_SERVER_WS_URL`。URL 使用经过同一 daemon 身份核验的固定入口 `$CODEX_HOME/app-server-control/app-server-control.sock`，不持久化临时 socket 的规范路径。之后由 LaunchServices（包括 Dock）启动的新 ChatGPT 进程会继承这些设置；已经运行的桌面不被退出或重启。

安装的用户级启动项为 `~/Library/LaunchAgents/local.agent-connector.codex-dock.plist`，仅在 Aqua 登录会话运行。每次登录先幂等启动/确认 daemon，再发布环境；准备失败时不发布地址，launchd 以 30 秒节流重试。该设置不替换 Dock 图标、不修改 ChatGPT 安装包、不重启或升级已有 daemon，也不启用远程控制。它作用于当前用户的 GUI 启动环境中的这三个 Codex 变量。

独立运行文件和原环境备份保存在 `~/Library/Application Support/Agent Connector/`，登录任务使用安装时的 Node 绝对路径和 Codex CLI 绝对路径，不依赖项目目录、终端 PATH 或网页桥接服务正在运行。关闭时卸载自己的登录任务、删除运行文件并恢复原环境；用户随后手动修改的变量保留。修改过的同名启动项不会被覆盖或删除。查看登录任务输出可读取同目录的 `codex-dock.log`。

刚登录时需等待这个启动项准备完成；它不会强制重启比它更早启动的 ChatGPT。此设置保证桌面连接方式，网页仍需运行桥接服务并绑定目标会话。配置生效和桌面实际连接是两个独立状态，不用环境变量冒充 socket 核验。

## 使用

1. 在绫通的会话设置中选择 ChatGPT / Codex，完成本机连接器授权。
2. 选择已有会话并确认，或选择「＋ 新建会话」并点击「新建并进入」。新建使用连接器的专用工作目录，绑定后可直接输入。第一条消息由用户发送。
3. 绑定后原生输入、公开回复与工具状态自动同步，不需要手工镜像聊天。网页补充信息使用当前原生turn，不另开第二个Agent执行相同任务。
4. 问题与审批显示独立入口；原客户端处理后自动收起。未知结果保留不确定态，不自动重试或扩大权限。

首版**不自动发现/抢切Codex新线程**，全局status不足以证明新用户意图，明确声明followSessions=false。原有OpenCode/WorkBuddy来源的自动跟随保留；Codex绑定后实时双向不受此限制。

## 能力矩阵

| 能力 | 当前实现 |
| --- | --- |
| 工作区会话列表/历史 | 原生thread/list/read，规范目录精确匹配，过滤子Agent/未知来源/归档 |
| 接入同线程 | thread/resume及初始分页，不覆盖模型/审批/权限 |
| 新轮次文字 | turn/start，稳定clientUserMessageId与有界幂等墓碑 |
| 运行中补充 | turn/steer + expectedTurnId；冲突不自动改为新turn |
| 停止 | 精确threadId/turnId，仅原生终态确认interrupted |
| 公开回复/工具过程 | item与turn事件、规范快照；不转reasoning正文或summary |
| 工具详情 | genuine command/file/MCP/dynamic/function output及子Agent公开内容按需脱敏读取；不凭名字冒充shell/skill |
| 原生问题 | item/tool/requestUserInput，答案回原RPC；私密问题不进网页 |
| 单次审批 | 普通命令的本次accept/decline/cancel；文件只可拒绝/取消，批准回原生；其它权限留原生 |
| 网页新建 | `thread/start` 创建持久会话，确认后绑定，首次发送前允许空历史 |
| 附件/文件搜索 | 尚未开放 |
| 自动发现Codex新任务 | 尚未开放，不靠状态广播或历史轮询伪造新意图 |

技能包规范源1.4.0新增[Codex指引](../skills/km-agent-bridge/references/codex.md)。不为此修改现行WorkBuddy用户级技能或MCP配置；Codex已通过官方skills/list确认能发现项目`.agents/skills/km-agent-bridge`，仅证明元数据发现，不等于技能执行或模型验收。

## 实现与授权

- [`codex-rpc.mjs`](../src/adapters/codex/codex-rpc.mjs) 负责只读发现 daemon 版本与 Unix Socket 上的 WebSocket 通信。规范路径核对owner/权限/实例；官方私有control末级别名有窄兼容，其它链接不放行。128请求、消息字节及ID墓碑预算，答复写背压有deadline，断开/未知不重放。
- 接收序元信息：RPC的`orderOf(rootEventOrResult)`在解码时用WeakMap标记每连接单调顺序，不修改原JSON；用原子resume快照边界区分已覆盖与后到delta，缺少可靠证据就断开核验，不猜测丢弃。
- [`src/adapters/codex/`](../src/adapters/codex/) 中的 `codex.mjs` 和 `codex-state.mjs` 处理原生thread/turn/item及问题/审批Map。对外`ses_codex_<UUID去横线>`，binding.nativeThreadId是真实thread.id，不冒充OpenCode或会话树sessionId。异步前后检查工作区/实例，服务重启废弃旧pending。
- [`src/adapters/`](../src/adapters/) 中的 `native-registry.mjs` 和 `product-adapters.mjs` 负责注册 OpenCode 和 Codex。每hub保留确切adapter及能力，OC离线不禁用健康CD，空generic入口也可列出附加来源。
- [`shared-hub.mjs`](../src/session/shared-hub.mjs) 与 [`server.mjs`](../src/http/server.mjs) 处理受控审批列表及 `/v1/approval/reply`。仅当前实例/来源/代次/transport/control可提交pending单次决定。停止在body等待前后、调用前及返回后核验来源，旧请求不能误停新轮次。
- `agent/approval-panel.js`：紧凑待审批入口、点击展开、明确单次操作、观察禁答、普通事件不重建按钮或丢键盘焦点，不把resolved称业务成功。

问题/审批使用原生服务端request ID，不把答复作为聊天prompt；serverRequest/resolved只确认请求已清除，不证明工具成功或用户阅读。文件变更可能含移动目标或超过展示预算，本版不提供网页accept；移动、未知字段、超限的详情整项阻断，不截断后假称完整。生物验证、额外权限、网络策略、动态客户端工具不自动响应。预览仍须明确ready与用户“使用”，不创建线上资源。

## 生命周期

关闭观察连接不会停止Codex，原有任务不自动重跑。公开历史、详情、待答及发送幂等均有预算，超限拒绝而非无限缓存。协议块在适配器→hub快照中保留受限公开原文，重建hub可恢复预览，浏览器聊天不显示协议块。

目录别名发现使用只读 `thread/list` 元数据，默认最多 4 页、2 MiB，并用 `realpath` 精确核验工作区。全局历史超出预算时，改按已知工作区路径查询。这个查询也超出预算或没有命中时，返回 `CODEX_DISCOVERY_LIMIT`。未登记的目录别名依赖全局发现。

所有版本的接入及刷新历史均每页读取 1 轮，以适配长会话的单帧大小，不再根据版本号切换分页大小。保留现有分页、字节和公开快照上限。`attachedToThreadId` 附属线程按原有主线程范围排除。

本次有效turn/start或匹配turn/steer ACK确认输入已接收，不再等待整轮事件队列或历史userMessage落盘；accepted不表示模型/业务成功或前端applied。Codex仅使用原生UUID消息回流，不把client correlation合成第二条聊天。ACK未知/写后abort等仍保留UNKNOWN墓碑，不能用其它读取的NOT_SUBMITTED释放重发；后续scope核验独立保护观察范围，不撤回此前已知接收事实。撤权/换源在预检等待期间会中止本owner控制器，不停止原Agent。

普通公开工具正文在512000字节预算内完整展示，genuine MCP的arguments、text、structuredContent及安全错误不再因unknown工具名整体隐藏。私有`_meta`、明确binary、私有推理有省略原因；普通业务analysis/metadata与JSON大整数原文/空白/无凭据URL保真。原生调用名出现在摘要，参数和完整返回不进广播。详情过滤预算与收尾验证见[CLOSEOUT.md](CLOSEOUT.md)。

主入口注册可用Codex，日常发现时未运行就显示不可用而不代启动；上述显式桌面端切换操作及用户启用的 Dock 登录任务可以启动 daemon。测试/明确禁用可设置`KM_AGENT_DISABLE_CODEX=1`，同时禁用发现与桌面端切换；已独立安装的 Dock 登录任务需用 `dock-disable` 关闭。启动参数仍保留opencode/generic主适配器合同。

### 原生来源使用不同工作区

当用户明确Codex运行在另一项目时，不应要求重开任务，也不能把OC/WB的工作区一起改掉。产品自有私有配置`~/.config/kuaimai-agent/native-sources.json`可声明独立范围（不是厂商配置，不由网页任意写入）：

```json
{"version":1,"profiles":[{"endpoint":"http://127.0.0.1:17653","origin":"http://127.0.0.1:4173","workspaceRoot":"<原Connector规范工作区>","codexWorkspace":"<用户明确的Codex规范目录>"}]}
```

只匹配精确endpoint、origin和workspaceRoot；其它profile保持原样。文件须自有普通0600、父0700，拒绝链接/未知字段/重复profile/非本机端点/无效目录；未配置保留原默认，非法配置只禁用Codex，不回退错误目录或阻断OC/WB。main在启动时加载，环境`KM_AGENT_NATIVE_SOURCES_FILE`可由本机操作者显式指定配置文件；测试禁Codex时不读取用户真实配置。保持原bootstrap/MCP种子启动合同，不为此改厂商设置或全局技能。

## 验证分层

`npm run test:agent:codex`包含临时自有UnixSocket真实Upgrade/RPC、假模型turn数据、HTTP/SSE及独立Chrome完整链路，覆盖来源/权限/迟到/原生问题/审批/停止/预览恢复。不是用户Codex终端真实模型验收。

本机模块实际discovery/initialize、限定工作区thread/list及skills/list已通过；当前工作区列表为0，未创建/resume线程、未发turn/approval，没有替用户发任务。用户确认后已备份两项WorkBuddy来源并应用新版，实际三来源均available、旧MCP协议回归通过，见[维护记录](../../lingtong-prototypes/kmMDTable/agent/codex-notes.md)。真实用户网页选择/applied另验，不能用隔离浏览器或运维握手冒充。

设计、截图及部署见[接入记录](../../lingtong-prototypes/kmMDTable/agent/codex-notes.md)。代码未提交/推送。

参考：[官方App Server](https://learn.chatgpt.com/docs/app-server)、[0.166.0实现](https://github.com/openai/codex/tree/rust-v0.166.0/codex-rs/app-server)。


### 0.171.0 桌面兼容

已依据本机官方 `0.171.0` 可执行文件生成的实验 JSON Schema 核对初始化、线程列表、历史分页与 `turn/start` / `turn/steer` 的 `additionalContext` 参数；保留原有消息大小、分页及授权限制。当时使用具体版本白名单；2026-11-24 起由下面的协议与能力检测替代。

新版桌面可能由主进程的直接 Node utility 辅助进程持有共享 socket。通信检测同时检查主进程和该辅助进程的真实文件描述符，仍要求当前用户、固定应用包路径、直接父子关系、Node utility 参数、daemon socket 对端匹配，并在判定前复核进程身份。普通渲染进程、其他应用和同用户的独立 Node 进程不会被当作桌面连接。

2026-11-23 本机只读验收：CLI `0.168.0` + app-server `0.171.0`，检测结果 `shared`，RPC 初始化成功，最近 10 条会话读取成功。真实验收未发送 prompt，也未重启 Codex；页面上下文发送由协议 Schema 与回归夹具核验。

### 按协议与能力接入（2026-11-24）

- `daemon version` 仅发现已运行服务和记录版本；CLI 与 daemon 版本不同、未来版本或未提供版本元数据均不单独阻断连接。socket 的当前用户所有权、目录权限、实例身份校验保持有效。
- `initialize` 必须返回有效的 `userAgent`；随后只读请求 `thread/list`（limit=1），校验分页结构。方法缺失、参数不兼容或响应结构变化会明确报告协议验证失败。检测阶段不 resume 会话，不发送 prompt，不更改模型/审批，不启动或重启 Codex。
- 网页上下文不再由版本推断。仅使用 daemon 报告的同版本受管可执行文件，核验文件权限与 `--version` 后，执行 `app-server generate-json-schema --experimental`，读取 `turn/start` 和 `turn/steer` 的 `additionalContext` 定义，确认二者支持 application 类型的 kind/value。它只导出协议定义，不启动 app-server。能力结果按规范文件路径及 inode/mtime 等身份缓存，临时文件立即清理；自动升级会失效旧缓存。
- 无法读取协议定义、文件身份变化或缺少上下文字段时，仅禁用网页上下文，保留基础连接和会话列表。不会为了探测能力发送测试 prompt，也不会静默把上下文拼进用户输入。
- 发送、停止、审批、问题答复继续校验真实响应；写入结果未知时不自动重发。没有版本上限不代表保证任何破坏性协议变更都能兼容，实际破坏性变更仍需适配。

2026-11-24 本机只读验收：CLI `0.168.0` + app-server `0.172.0`，实际桌面通信 `shared`，初始化和线程列表通过，最近 10 条会话读取成功，`pageContext=true`。未来版本和预发布版本由回归夹具验证，不冒充真实版本实测。

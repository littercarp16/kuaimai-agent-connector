# WorkBuddy 本机协作

## 在自定义页面绑定 CLI 会话

1. 在快麦多维表格自定义页面选择 **WorkBuddy CLI**。首次接入时，将「复制连接请求」的内容粘贴给本地 Agent 执行，保留原网页。授权完成后网页自动显示会话选择框。已连接的网页可直接选择会话。
2. 从列表选择已有 CLI 会话并点「确认并进入协作」，或选择「＋ 新建 CLI 会话」并点「新建并进入」。绑定后可从网页发送消息。
3. 输入第一条消息后，CLI 会把会话写入历史。重启连接器后重新连接页面，可以选择原会话、查看历史并继续发送。新建后尚未发言的会话只在当前连接中有效。

macOS 连接器使用 WorkBuddy 桌面安装包内的 CLI，以 `--serve` 启动一个使用密码认证的本机服务。每次启动选择可用的回环端口，使用连接器数据目录下固定的 `workbuddy-cli/settings` 和 `workbuddy-cli/workspace`。启动参数省略 `--session-id`，由每一次 ACP `session/new` 分配独立 ID。读取列表使用 `GET /api/v1/sessions?cwd=…`，绑定已有会话时按原 ID 执行 `session/load`。列表范围是这个 CLI 工作目录，桌面侧栏中的聊天不在当前接入范围内。CLI 在创建或加载时要求登录，连接器会打开官方授权页。也可以在「会话 / 本地 Agent」里点击「登录 WorkBuddy CLI」，授权完成后回到当前页面。默认模型返回 `refusal` 时页面显示本轮拒绝状态；可先核对该 CLI 配置的登录状态。

也可以接入自行启动的本机 CLI 服务。提供 `KM_AGENT_WORKBUDDY_ENDPOINT`、`KM_AGENT_WORKBUDDY_PASSWORD` 和工作目录（源码 CLI 的 `--workspace`，桌面或后台服务的 `KM_AGENT_WORKBUDDY_WORKSPACE`）。这种接法从该服务选择已有会话。可用 `KM_AGENT_WORKBUDDY_APPROVAL_FILE` 指定目录内允许在网页单次审批的草稿文件。

项目托管的 CLI 使用本机账号接口发起官方登录，并以该接口确认账号已登录后继续绑定。请在 CLI 已打开的官方登录页完成授权。如果等了几秒仍未看到，可以点「未看到登录页？重新打开」。当前源码中的连接器对同一次登录只接受一次成功的补开操作，多个绫通标签页共享这个状态。账号凭据保存在 CLI 进程内。关闭并重新启动该进程后，可能需要重新登录，原 CLI 会话仍可选择。

从 0.6.0 起，WorkBuddy CLI 的网页连接请求使用 npmjs 上的连接器。用户可以在自己的工作目录执行页面复制的 `npx` 命令。开发者验证 npm 版时，请在连接器源码目录外执行，避免 npx 将当前同名同版本项目当作安装来源。两个 HTTP 开发来源复用千问和 Codex 的浏览器扩展通道。

从 0.6.1 起，CLI 的 WebFetch 工具需要批准时，网页的「原生待审批」会显示目标网址。点击「允许」仅批准本次读取。多个网址分别审批。若本机仍运行 0.6.0，请在当前任务结束后停止旧服务，再执行网页复制的新连接请求，可重新选择原会话。

绫通前端的 `node tests/browser/kmPageAgent.cjs --run --workbuddy-login` 使用无头浏览器、本机模拟账号和开页计数器，覆盖两个网页并发登录及补开。需要真实 CLI 的人工验收使用 `--run --workbuddy-live --allow-system-browser`，官方 CLI 可能打开系统浏览器。该模式使用本机测试模型核验会话创建、重启续聊及文件审批。

## MCP 成果上报

> **1.3.0源码已增加自动跟随/准备：**新版不再要求每次手选WB候选，默认自动查看、手选锁定可恢复，按Agent分组；稳定网关可自动准备运行时，见[AUTOMATIC.md](AUTOMATIC.md)。下文首版手选流程是旧部署兼容；本机旧实例及已有缓存尚未擅自换版，不能把源码实现当作已上线。

## 能做什么

用户在WorkBuddy发起快麦任务，由本机stdio MCP将计划、公开阶段、表格、页面与仪表盘渐进发送到已有`agent-connector`。网页出现任务候选，用户明确选择后显示，不抢占原OpenCode来源。网页只接收；继续输入、补充信息、Questions、审批与停止执行留在WorkBuddy。

这不是WorkBuddy原生聊天镜像，也不自动订阅全部技能、工具、子Agent或内部推理。没有调用WorkBuddy云端OpenAPI、私有IPC、聊天数据库或模型请求。

## 安装前提与检查点

**本机当前状态（已获用户授权）：**17653连接器已沿原参数换版；`~/.workbuddy/mcp.json`仅新增`kuaimai-workbuddy`，技能1.2.0已复制到本机技能目录。实际配置的stdio握手/五工具枚举/协议读取通过，但尚无WorkBuddy原生任务或用户网页回执，详见[安装记录](../../lingtong-prototypes/kmMDTable/agent/workbuddy-notes.md)。没有重启OpenCode、修改模型/审批或发送模型/业务任务。

- 当前交付针对macOS；本机仅只读确认`WorkBuddy.app`为5.9.3。真实客户端导入/执行还须单独验收，不能用SDK模拟客户端代替。
- 连接器依赖安装：在本目录执行`npm ci --ignore-scripts`；官方`@modelcontextprotocol/server/client`固定2.4.0、Zod4.6.7，Node.js ≥22。不需要安装CodeBuddy CLI。
- **已有17653服务必须在用户同意后换版**。不启动第二实例、不停止OpenCode本身、不发送模型需求。保持原启动参数，换版后刷新原型网页并重新握手。
- 新版main的原生或generic观察入口均支持WorkBuddy发布，明确Origin可无session只观察，MCP不要求OpenCode模型就绪；工作区通过--workspace指定。旧部署仍可高级配对/手选，不把独立逻辑任务当厂商原生会话。
- 当前服务须声明`capabilities.workbuddyPublish:true`。旧服务会被MCP客户端拒绝，不能仅凭导出配置成功称已连通。
- 技能与运行时分开分发；不把依赖、运行凭据、宿主配置放进技能包。规范技能源在[skills/](../skills/README.md)，版本1.2.0，WorkBuddy指引见[reference](../skills/km-agent-bridge/references/workbuddy.md)。

## 导出MCP配置（不安装到客户端）

先换版连接器，再在本目录执行。以下目录只是本机导出产物，不是WorkBuddy设置目录：

```sh
node workbuddy-setup.mjs \
  --out .runtime/workbuddy-config \
  --runtime-file .runtime/connector.json \
  --origin http://127.0.0.1:4173 \
  --workspace ../../.. \
  --dry-run
```

确认后去掉`--dry-run`。导出全新目录中的：

- `mcp.json`：一个`kuaimai-workbuddy` stdio服务器配置，引用安装时实际Node、MCP入口与connection文件绝对路径。
- `connection.json`：`{version:1,runtimeFile,origin,workspaceRoot}`；也支持明确`workspaceId`替代workspaceRoot，由实际宿主/产品配置。

不包含真实key或任务票据。已有不同内容、未知目录或符号链接拒绝覆盖；相同导出保持幂等；dry-run零写入。不自动读取或改写WorkBuddy全局settings。

**客户端接入仍是单独步骤**：核对当前WorkBuddy的自定义MCP入口，将生成的`mcpServers`条目添加进去，不全文覆盖已有配置。技能需通过客户端支持的方式导入完整`skills/km-agent-bridge/`目录；若使用标准安装器，必须用`--target`明确本机已核实的技能父目录，不猜`~/.workbuddy`中的版本相关路径。WorkBuddy市场上架不是本轮范围。

当前已从[官方MCP指南](https://www.workbuddy.cn/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/MCP-Guide)核实用户级为`~/.workbuddy/mcp.json`，项目级为`<project>/.workbuddy/mcp.json`；界面入口为MCP服务器/配置MCP。外部新增文件后，仍须在客户端确认已读取、保存或刷新并显示已连接；没有客户端发现证据就不宣称已加载。技能可在“专家·技能·连接器 → 技能 → 已安装”确认，关闭状态不能用文件存在代替启用证据。

换版或迁移运行时后，应重新加载MCP。MCP进程启动时捕获实例，实例/端点/key改变将停止旧任务发布，**不**自动重建或重放。

## 五个MCP工具

| 工具 | 输入 | 说明 |
| --- | --- | --- |
| `km_agent_protocol` | `{}` | 指令目录、schema限制、公开能力 |
| `km_task_open` | `{taskKey,title}` | 建立本进程逻辑协作任务；重复key/标题幂等 |
| `km_task_publish` | `{taskId,event}` | 发布一项km-agent/1事件；仅公开phase活动 |
| `km_task_receipt` | `{taskId,eventId}` | 核验实际前端回执 |
| `km_task_finish` | `{taskId,status,note?}` | 报告completed/failed，不控制WorkBuddy执行 |

taskId由服务生成，**不是WorkBuddy原生session ID**。每个MCP客户端只操作自己持有票据的任务。界面元信息/工具返回不带publisherKey/taskToken；stdout只输出SDK协议，错误和stderr使用固定安全诊断。

建议在WorkBuddy输入：

> 使用快麦协作技能，创建一个商品补货分析表和库存仪表盘。先发布计划，逐步同步公开过程和成果到快麦网页。样例数据请标为模拟；先不要创建线上资源。

需要`plan.updated`→创建/更新→逐块成果→`artifact.ready`→查回执→finish。未ready不能用finish补就绪；明确返回`WORKBUDDY_NOT_READY`时客户端允许更正为failed或补ready后重新完成；超时、断连和未知500不解除幂等保护、不自动重发。

## 网页与回执

1. 打开原型的本地Agent协作区，看到WorkBuddy候选后点击“选择查看”。切换不发prompt、不停止旧任务，原OpenCode草稿保留。
2. 查看公开阶段与渐进预览；WorkBuddy来源隐藏网页发送、附件、原生新建、停止和Questions入口。
3. `accepted`仅表示连接器接收/缓存；未选择任务时不会自动冒称已展示。`applied`由当前绑定网页实际回传，不表示用户阅读或平台保存。
4. 缓存文字/阶段超出投影窗口时，前端对未渲染的历史回执报`deferred`；不能把delivery ID仍在当作正文仍可见。其他目标未展示也可能deferred。
5. 明确ready的表格/页面/仪表盘可由用户点击“使用”，保存本浏览器同源localStorage快照并新增菜单；刷新可恢复，不跨设备、不绑定数据源、不创建线上表，不部署task。

高级连接面板使用`GET /v1/sources`取得`{sessions,sources}`及来源失败诊断；旧`GET /v1/sessions`仍返回数组，保留旧网页兼容。

## 缓存与安全限制

- 服务默认最多16个任务、每任务512事件/累计1MiB、事件小于19KB；到上限明确拒绝，不偷偷丢事件/替换任务。客户端进程上限32，并不覆盖服务端更小上限。
- 内存缓存TTL24小时，服务重启清空；已有“使用”快照仍在浏览器本机。列表不意味着可恢复原生会话或跨设备读取。
- 活跃任务每20秒心跳，90秒无上报标记unknown/连接中断，不代表WorkBuddy已停止；同票据可恢复。明确结束后停本客户端心跳。
- 精确loopback Host、Origin白名单与本机header鉴权；只有注册可用全局发布key，后续必须每任务作用域票据。网页token不能调用本机发布接口。
- 每次客户端请求重新核验0600运行清单/0700父目录、所有祖先链接、实例与服务能力；禁止重定向、有限超时与响应体，不扫描端口或猜服务。
- 普通字符串、ID、大整数文本、HTML/CSS/安全URL保持原样，仅过滤密钥、私有块等实际敏感片段；无私有reasoning广播。HTML只进原有沙箱，不在宿主执行。
- Windows ACL、真实WorkBuddy技能发现/自定义MCP导入、真实用户网页回执均不能由当前隔离测试替代，须后续实机确认。

## 验证

宿主目录执行`npm run test:agent:workbuddy`。使用随机端口和独立Chrome、官方SDK真实stdio子进程，覆盖过程/成果/回执/保存恢复、390px、token/Origin/实例、缓存窗口、未知结果不重发及普通文本不损坏。不会发送WorkBuddy模型或线上业务请求。

浏览器截图需显式`KM_AGENT_SCREENSHOTS=1`，落在`../assets/agent-workbuddy-*.png`；均为**原型隔离截图，非用户WorkBuddy实际执行证据**。

官方参考：[WorkBuddy Connector规范](https://open.workbuddy.cn/docs/connector)、[Skill包规范](https://open.workbuddy.cn/docs/skill)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。

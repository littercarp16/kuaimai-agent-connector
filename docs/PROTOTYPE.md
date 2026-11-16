# 快麦 Agent 连接器 · 本地原型

交付总览、最新提交确认/工具全文修复及可复验命令见[CLOSEOUT.md](CLOSEOUT.md)。运行凭据、临时缓存和维护备份不属于代码交付。

**Codex 原生共享。** 支持 `0.166.x` 和 `0.167.2` 的共享 App Server，CLI 与服务版本须完全一致。选定会话后默认观察，可同步文字、公开工具详情、原生问题与单次审批。见[接入说明](CODEX.md)。

**1.3.0源码更新：**多Agent新任务默认自动查看、旧订阅各自缓存、按Agent分组的紧凑面板、AI/MCP/本机宿主自动准备运行时，见[AUTOMATIC.md](AUTOMATIC.md)。已装仅启动、未装才从明确可信源下载；没有正式发布URL不伪造下载。当前实例数据仍保留，换版需空闲及结果保护，不自动清空。

**WorkBuddy首版：**现有OpenCode主服务可接收独立WorkBuddy逻辑协作任务，网页手动选源，只接收公开过程与成果，不反向输入或原生镜像。见[接入与配置导出](WORKBUDDY.md)；真实安装、17653换版与实机验收须单独确认，不把隔离SDK/浏览器测试当成已接入。

独立运行在 `127.0.0.1:17653`，为kmMDTable提供**km-agent/1标准交互**、受信来源自动握手、明确会话、原生事件、鉴权SSE和前端应用回执。OpenCode适配器使用本机匹配的 `@opencode/client@2.0.30`；generic适配器为其他可执行本机命令的Agent提供UI发布，不宣称原生双向接入。

## 原型时期的启动方式

独立连接器的当前启动方式见[项目 README](../README.md)。本节命令对应 kmMDTable 原型仓库。

需要 Node.js 22+、npm；真实对话另需已运行且已登录模型的 OpenCode V2 服务。

在 `prototypes/kmMDTable/` 目录：

```sh
# 首次或换机器时安装本模块依赖；不改现有CLI和全局配置
npm ci --prefix agent-connector --ignore-scripts

# 终端1：多维表格原型
npm start

# 本地Agent启动后台连接器；明确当前真实会话
node agent-connector/start.mjs --adapter opencode --session <ses...> --trust-origin http://127.0.0.1:4173

# 只有明确要求网页向原会话输入时才加 --allow-control
# 不支持原生订阅的Codex等使用 --adapter generic（仅发布，不加--allow-control）
```

访问 <http://127.0.0.1:4173/>，前端发现本机预先授权的服务后自动握手、绑定并点亮“本地已连接”，不弹连接设置、不输入配对码。明确新建/打开/编辑指令才呼出工作区并导航目标。浏览器本地网络权限仍需正常允许。

- `npm run agent:start`不带受信参数时保留高级手动配对备用，配对码10分钟单次有效；这不是新默认体验。
- 自动授权仅限明确启动的loopback Origin和session，不取消鉴权；默认只观察。授权只存当前标签页sessionStorage，最长8小时；连接器重启后重新握手，不自动输入需求。
- 默认只允许 `http://127.0.0.1:4173`。`localhost` 与 `127.0.0.1` 是不同 Origin。换本机原型端口时，可显式设置 `KM_AGENT_ORIGIN` 为精确来源；不使用通配符。
- 旧服务占用端口时启动器拒绝接管，不杀进程、不改变其授权；请在原终端停止旧连接器后换版。不需要重启OpenCode。
- 程序不自动启动/停止共享 OpenCode 服务，不设置开机自启，不写全局 Agent/模型/CLI 配置。

## 共享会话（主流程）

自动模式先连接启动会话，并默认跟随同一共享OpenCode服务、本设计工作区根目录中的绫通相关新会话。新输入提及lingtong-cli/绫通CLI或实际shell执行CLI才触发，空会话、其他工作区、子Agent或文档关键词不触发。原任务运行中先排队；新会话默认观察，不继承旧控制授权。网页可“自动跟随/已锁定”，启动`--pin-session`固定。高级「会话设置」手动选择会锁定当前源。

执行记录已改成类似OpenCode的无边框行、多工具分组：可看脱敏命令、文件路径/范围、URL路径与分类错误；内部reasoning正文不转发，只显示真实状态/耗时与显式公开阶段摘要。实际效果与安全边界见[本轮记录](../../lingtong-prototypes/kmMDTable/agent/auto-follow-log-notes.md)。

**工具真实详情补齐：**点击原生工具行后单独鉴权读取脱敏请求和真实返回正文，不再展开固定提示，也不把executed:false误判为本地未执行。长结果明确截断，受保护内容明确说明；同阶段公开回复/动作可关联到思考并标来源，无来源则没有空展开箭头。见[详情修复记录](../../lingtong-prototypes/kmMDTable/agent/tool-detail-notes.md)。

绑定保留原有工具权限，不创建另一份聊天。明确允许网页输入后，网页原文使用唯一消息ID向**同一session**入队；模型额度勾选已移除，点击发送默认调用本机模型。本地输入事件仅同步，不再次提交。原生文字delta、工具开始/结束和执行终态实时呈现，前端可在任务未结束时逐步显示组件。

**输入区补充：**`/new`显式创建真实新会话、复制原权限和模型，绑定新会话但不停止旧执行、不自动发送prompt；自动跟随其他会话仍默认观察。`@`走授权工作区原生文件搜索；文件引用在发送时限量读取。支持图片/文件粘贴、选择和拖入，最多5项、单项2MiB、合计6MiB；仅点击发送后提交原生附件，SSE只传文件名/MIME。详见[输入区合同与验收](../../lingtong-prototypes/kmMDTable/agent/composer-notes.md)。

绑定会增加一条具名的会话级协作说明，使当前Agent知道本机发布命令；不改全局或项目配置，不提升原权限。危险操作仍遵循本地权限确认。关闭网页/共享连接器停止同步，不默认停止本地已有执行；「停止请求」只请求中断当前执行，不回滚、不承诺取消所有排队输入。

## 演示与隔离兼容

### 交互演示（不调用模型）

未绑定共享会话时可点击“体验构建演示”，明确模拟数据且不调用模型或业务CLI。共享会话中不混入模拟过程，需先解除绑定。

### 旧隔离预览分支

兼容适配器仍可新建 `workspace/` 内拒绝所有工具的专用预览会话。它不是本轮主流程，不能代表已验证现有本地聊天同步。真实共享模式不统一禁用工具，但连接器自身没有平台业务写接口；真实保存、发布等仍依赖原CLI/API及用户授权。健康检查也不能保证模型登录、额度或生成始终成功。

## 传输与恢复

- 网页 → 连接器：固定HTTP指令和经工作区核验的会话ID；不提供任意终端、URL或目录参数。
- 连接器 → 网页：`fetch` SSE，使用认证头而非 URL Token；保留完整当前快照和单调修订号。
- 连接器 → OpenCode：共享模式使用官方原生事件和绑定快照，旧隔离分支才轮询。私有reasoning不转发；完整工具结果不进入SSE，用户可按需查看脱敏限长副本。服务级事件先按会话过滤，不全局广播。
- 断线后禁用新指令；重新连接读取当前快照，不重发模型需求。无法确认接收/中断结果时明确显示未知，不冒报失败或已停止。
- 客户端10秒检查连接，未连接时约15秒起、逐步退避至60秒；标签隐藏/独立发布预览时暂停传输，返回后重新核验和读取快照。
- 连接器快照在进程内保留，不是云端历史；原生事件断开不保证历史delta重放，恢复时读取当前消息。OpenCode自己保留聊天，程序不删除原会话。
- 共享会话不因网页收起或连接器关闭而被自动中断；旧隔离预览才有3分钟的中断请求。授权过期停止共享观察；会话移动后暂停并核验范围。

## 当前本地Agent的UI发布命令

```sh
node agent-connector/publish.mjs status
node agent-connector/publish.mjs --help
node agent-connector/publish.mjs commands
node agent-connector/publish.mjs --session <ses...> --file <event.json>
node agent-connector/publish.mjs receipt --session <ses...> --id <事件ID>
```

事件为 `{protocol:"km-agent/1",id,type,payload}`，小于19KB；支持resource.create/open/edit、panel.open/close、work.status、activity.updated及已有成果命令。唯一ID幂等，accepted与浏览器applied分离；完整映射、校验、回执和适配器合同见[标准协议](./PROTOCOL.md)。

### 可分发技能（与运行时分离）

规范源位于 [`skills/`](../skills/README.md)，可整体搬迁；`skills/km-agent-bridge/`自带完整协议、Node轻量客户端、15类指令目录及离线联调事件生成器，不导入原型目录。安装脚本支持明确的项目/用户级目标、dry-run、同内容no-op和冲突拒绝；其他Agent用自定义目标，不猜目录。

```sh
node skills/install.mjs --agent opencode --scope project --project <目标项目> --dry-run
node skills/install.mjs --agent claude-code --scope user --dry-run
```

还有Shell/PowerShell入口。技能从独立产品配置读取运行清单/启动器/Origin，不携带密钥或服务依赖；安装不启动服务、不修改全局配置，也不自动覆盖现有项目技能。未来并入lingtong-cli时复制完整技能目录，运行时仍需单独部署/改造。本轮未改CLI源码、未安装到真实全局Agent目录，不宣称上一轮网页回执阻断已修复。测试：在宿主目录执行`npm run test:agent:skills`。

本机发布凭据自动写入Git忽略的 `.runtime/connector.json`（当前用户0600、目录0700），脚本读取后只连接固定loopback。凭据不会写入网页、模型提示词或日志；`status`仅输出已绑定会话信息。没有网页授权绑定则拒绝广播。

## 预览协议

模型输出独立的 `kmmdtable` JSON代码块：清单使用 `type: 'plan'`，成果使用 `type: 'artifact'`，成果类型为 `table`、`page` 或 `task`。

解析器与显示模块在 `../agent/`。结构化页面和表格有独立Shadow DOM主题、布局和密度，不复用外层快麦样式。客户自定义HTML/CSS使用受限无脚本/网络/同源能力iframe，危险元素和事件属性会清除，不在宿主eval。任务脚本仍只作转义文本展示。任何预览完成都不等于平台保存。

“导出方案”仅下载当前结构化 JSON 到用户电脑；没有导入、部署或平台写入动作。

## 测试

在独立连接器的仓库根目录运行 `npm test`。如需单独运行真实 OpenCode 模型联调，可显式启用以下用例。

```sh
KM_AGENT_LIVE=1 node --test tests/adapters/opencode/live.test.mjs
```

以下是原型仓库的测试命令，在其 kmMDTable 目录运行。

```sh
npm run test:agent
npm run test:agent:ui
npm run test:agent:startup

# 可选，真实调用模型并可能产生费用；不写平台、不调用工具
KM_AGENT_LIVE=1 node --test agent-connector/live.test.mjs
# 共享会话真实浏览器联调：可能产生模型费用
KM_SHARED_LIVE=1 node --test agent/shared-live.browser.test.mjs
# 相关新会话发现联调：resume:false，仅入队，不调用模型或CLI
KM_FOLLOW_LIVE=1 node --test agent/follow-live.browser.test.mjs
```

浏览器沿用主README的 `PWB_BROWSER_EXECUTABLE` / `PWB_PLAYWRIGHT_MODULE`。常规测试使用真实连接器和模型/API夹具；共享真实测试使用自己创建、拒绝工具的会话验证原生链路，不触碰用户已有聊天。所有浏览器测试在17654隔离端口串行运行，不占用用户17653服务。

启动器进程测试也使用显式`--port 17654`，须与浏览器测试串行。它真实启动并自动握手generic后台服务，测试结束只停止自己刚创建的PID；不停止现有OpenCode或用户连接器。非默认端口使用单独的`.runtime/connector-<port>.json`，不覆盖17653运行凭据；前端通过受信本机宿主读取实际端口，不扫描端口。

## 尚未验证或未提供

生产HTTPS/TLS、跨浏览器/ERP权限、其他Agent的厂商原生双向消息、任意终端全局观察、平台业务保存/回滚及持久审计未提供。generic通道不等于这些能力已实现。验收中的本地输入由官方API模拟同一入口，物理TUI手工走查仍待。CORS不替代操作系统安全，不关闭浏览器沙箱或安全策略。

## 千问办公桌面会话（macOS）

已验证 QwenWorkCN 2.0.2。先退出千问办公，再用以下命令启动已安装的桌面客户端。

```sh
open -a /Applications/QwenWorkCN.app --env QWENWORK_DESKTOP_CONTROL_ENABLED=1
```

在本机连接器的 [来源配置](CODEX.md#原生来源使用不同工作区) `~/.config/kuaimai-agent/native-sources.json` 中，为匹配网页、端口和工作区的 profile 添加 `"qwenEnabled": true`，重启连接器后就能列出当前千问办公身份的最近会话。也可在启动时设置 `KM_AGENT_QWEN_SESSION`，仅开放指定会话。

在快麦网页的会话设置中选择「千问办公」和需要绑定的会话。绑定后默认同步提问、公开回复及生成状态。勾选「允许网页输入」并确认后，网页可向同一会话发送文字，等本轮结束后可继续发下一条。适配器使用客户端自带但未公开文档化的本机 HTTP 接口，升级后需重新验证。凭据只在本机连接器内使用。

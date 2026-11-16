# 多Agent自动连接与准备（1.3.0）

## 用户流程

无需在会话弹窗复制`npm run agent:start`。完成一次获授权的产品接入后，本机Agent、MCP稳定网关或受信本机宿主会自动准备连接器：已运行复用，已安装未启动则启动，未安装才从已配置可信源下载。不是自动安装OpenCode/WorkBuddy本体，不改模型、审批或系统权限。

网页默认跟随新任务。切换只改变查看，原Agent继续运行、成果在自己的来源中缓存；手动选源即锁定，可恢复自动。会话按已接入provider分组，不能把“电脑已装”当成“已连接”。原生OpenCode和WorkBuddy协作上报仍是不同能力，新来源不继承输入控制，仍不自动“使用”或发布资源。

弹框520px、最大70dvh，默认约353px高；没有教程卡片与长段风险说明，点击ⓘ查看说明、⚙查看诊断/旧部署配对。只查询不调用模型；浏览器网络权限与宿主工具审批不能绕过。

## 源路由规则

主服务启用`enableMultiAgentFollow`并在health声明`capabilities.multiAgentFollow`。旧fixture默认为false，保持旧排队/手选兼容；不能把旧服务运行就绪误报为新版自动路由生效。

- 当前只看一个完整投影，其它来源只推元信息。每网页最多保留8个已授权原生订阅，切离仍可发布；结束来源可释放，忙碌来源不偷偷停止。WorkBuddy缓存独立，离开它不丢结果。
- 新任务按服务端**观测顺序**优先，不按异步校验/body完成顺序。原生事件在scope核验前捕获序号，WB在已授权请求body读取前捕获；同轮旧工具、心跳、重复open不抢切。缓存seed也按原观测序而非Map插入顺序。
- 普通执行running不阻止切查看；原生问题待答、提交/新建在途、绑定或来源容量阻塞时短暂等待。手选锁定，恢复后处理最新候选，不重发任务。
- 断开/过期释放所有订阅；迟到的详情、问题、ack和发送清稿均核对当前来源/代次。分组选择器保留未确认选择，不被列表迟到返回覆盖。
- `onBindings`含subscribed/selected，已订阅不等于正在展示；applied仍必须实际当前前端回传。当前slot内容不混入后台完整消息。

## 自动准备配置（由产品/获授权AI生成）

规范种子随独立[技能1.3.0](../skills/README.md)分发：`scripts/prepare.mjs`与`scripts/mcp-entry.mjs`只用Node22内置库，无仓库上级导入。种子与配置放在运行时目录外，运行时缺失仍可启动准备器。

开发/安装器入口示例（不是需要用户执行的UI教程）：

```sh
node workbuddy-setup.mjs --automatic \
  --out <运行时目录外的独立产品profile目录> \
  --runtime-root <明确产品运行时根目录> \
  --skill-dir <完整已安装技能目录> \
  --origin http://127.0.0.1:4173 \
  --endpoint http://127.0.0.1:17653 \
  --workspace <明确授权工作目录> --dry-run
```

确认后由AI安装器执行去掉dry-run的同一操作，生成：

| 文件 | 用途 |
| --- | --- |
| bootstrap.json | 首选端点/Origin、launcher/runtimeFile/mcpEntry与启动参数，allowPortFallback，可选release |
| connection.json | 稳定网关配置，引用bootstrap而非易丢失的SDK入口 |
| mcp.json | WorkBuddy的单条MCP配置片段，不包含key |
| host-pointer.json | 同源本机宿主可用的准备入口，引用已安装seed与bootstrap |

默认启动参数只观察，不写死旧session、不含--allow-control。`--workspace`决定原生相关工作区与WB namespace，不从安装库目录误推。宿主可通过`createServer({agentBootstrapPointer})`或`KM_AGENT_BOOTSTRAP_POINTER`指定host-pointer；开发默认工作区`.runtime/agent-bootstrap.json`只在安装器明确写入后生效。

新配置默认 `allowPortFallback: true`：首选端口冲突时运行时用 `listen(0)` 申请空闲端口，并将实际地址写入固定位置的私有运行清单。清单文件名、原生工作区授权仍以首选端点为标识；不用修改来源配置或扫描端口。旧配置未声明该字段时，准备器保留固定端点校验。

宿主`GET /api/agent/prepare`只读状态，并返回 `discovery: true` 和经私有清单/健康实例匹配核验的 `connection: {endpoint, instanceId}`（未运行则 `null`）；不会返回 key、路径或命令。网页先发现再连接，地址/实例改变时清理旧 token 与 SSE 并重新握手。CSP 仅放开 `http://127.0.0.1:*`，没有开放其他网络地址。`POST`仅接受同源Origin/精确Host/受控header和requestId，不接收下载地址、启动参数或文件路径。配置Origin及目标endpoint须匹配当前宿主；并发合并、请求幂等。网页只请求本机执行器，不是任意shell入口；线上SaaS仍须用户电脑上的Agent/种子，不能在云服务器替本机安装。

MCP网关ensure后创建0600临时有效连接配置，继承stdio启动官方SDK。stdout不夹准备日志；退出只收尾自己的SDK子进程/临时文件，不停止连接器或厂商Agent，不自动恢复旧票据/重发未知任务。

有效配置另带受控的bootstrapFile/prepareEntry钩子，SDK在**全体旧逻辑任务明确结束且没有未知open/在途请求**时，为全新taskKey再次ensure。服务停止可自动启动，实际端口可随可信清单变化，并发新任务共用一次准备；新实例验证通过后旧keys/票据标retired，不能用旧key重播。活动或结果未知任务仍严格阻断迁移，不把自动连接当任务自动重跑。旧版无钩子配置保持原stale行为；新版种子应配套新版运行时SDK，不混用旧worker配置合同。

## 下载与安全边界

未安装必须显式提供release：固定HTTPS URL、version、sha256、私有installRoot；源码中的可选API支持生成带release的配置。**当前没有正式发布地址，不会编造公网包/URL或暗中npm安装。** 本机已装运行时可实际自动启动；缺失且无源报告INSTALL_SOURCE_REQUIRED。

准备器最多64MiB下载/48MiB解码/10000文件；先校验整体SHA256，再解`km-runtime-bundle/1`的相对base64文件清单。拒绝重定向、越界/重复/大小写冲突路径、凭据/运行清单、符号链接和任意安装脚本。只原子新版本目录，不覆盖已有未知内容。摘要/TLS失败不得由Agent自己改hash/关闭校验赶工。

进程锁按用户和端点共享，启动结果未知保留锁而不再启动第二实例；正确服务仅复用，不为新版本偷偷重启。运行清单0600/父0700，读取上限128KiB可承载多网页来源元数据；密钥不进UI/配置片段/技能或日志。macOS已验证系统规范别名，Windows ACL与真实各厂商发现需另行实机验证。

## 验证与当前部署

`npm run test:agent:automatic`包含随机端口HTTP、真实子进程/下载流与摘要、官方SDK网关、真实独立Chrome的自动启动→新任务自动查看→分组→锁定恢复→旧源缓存。无模型/业务请求。图在`../assets/agent-compact-*.png`和`agent-auto-prepared-workspace.png`，均为原型隔离截图，不是用户页面实机回执。

**本机已获授权应用新版：**用户回复“请继续”后，确认WB任务已明确结束、旧预览已作只读维护备份，再仅退出旧连接器并用安装后的prepare自动启动新版。multiAgentFollow已验证true，MCP/技能为稳定网关1.3.0，宿主准备入口可用；未重启厂商客户端、未发模型/业务请求。详见[应用记录](../../lingtong-prototypes/kmMDTable/agent/automatic-connection-notes.md)。

维护换版会重置未“使用”的内存预览及旧票据；已保存本机资源不受影响。当前已保留公开预览备份，不自动伪造为新Workbench任务。MCP客户端可能需保存/刷新一次新配置，原型需刷新重连；之后日常不要求手工agent:start。真实用户新任务切换/回执仍需实际验收，不能拿隔离测试或运维握手假称已展示。

# km-agent/1｜本地Agent与前端标准交互

在仓库根目录运行 `node publish.mjs commands` 可查看机器可读目录。各适配器共用 [`src/protocol/protocol.mjs`](../src/protocol/protocol.mjs) 定义的数据协议，厂商消息不直接操作 DOM。

## 1. 封装与生命周期

```json
{"protocol":"km-agent/1","id":"唯一事件ID","type":"resource.create","payload":{"id":"report","kind":"page","name":"销售分析","appearance":{"theme":"ink","layout":"editorial","accent":"#d6f36a"}}}
```

本机传输另附明确的`sessionId`，浏览器授权会话与发布会话必须一致；事件内可附同一sessionId，跨会话拒绝。`id`在连接器当前会话内幂等（有限去重窗口）；同ID重试不能表示新的编辑。未知版本、动作、目标、无效字段类型拒绝，事件小于19KB；旧`{id,type,payload}`兼容受限成果命令。不是平台事务或持久审计日志。

`resource.create`只建立**未保存预览**，不会调用平台建页API。独立`artifact.updated`不强迫业务界面跳转；用户明确创建/打开/编辑动作才呼出。普通消息、心跳、等待状态不反复抢焦点。

## 2. 指令映射

| 指令 | payload | 前端行为 |
| --- | --- | --- |
| `resource.create` | `id,kind,name,appearance?` | 创建本地未保存页/表/任务，呼出非模态工作区并导航新资源，等待内容 |
| `resource.open` / `resource.edit` | `artifactId` | 导航已存在的成果；编辑意图不等于提交平台 |
| `panel.open` | `mode: side/workspace` | 非模态呼出侧栏/工作区，保留输入 |
| `panel.close` | `{}` | 收起，不中断执行 |
| `work.status` | `artifactId,status,label` | `running/waiting/completed/failed`，真实进度反馈，无虚构百分比 |
| `activity.updated` | `id,kind,label,status,detail?` | 单滚动时间线，可折叠的phase/skill/tool/thinking/permission卡片；状态同上 |
| `plan.updated` | `title,items:[{id,kind,name}]` | 构建清单，不创建平台目录 |
| `artifact.updated` | 成果对象 | 独立成果预览；默认`buildState:building` |
| `page.section.updated` | `artifactId,section:{id,title,text}` | 按键替换/补充说明区块，保留其他区块 |
| `table.rows.append` | `artifactId,rows` | 追加受限预览行 |
| `artifact.focus` | `artifactId` | 仅跟随模式切换成果，不强制呼出 |
| `artifact.ready` | `artifactId` | 预览组件就绪，不是保存/发布 |
| `step.updated` | `id,label,status,detail?` | 兼容公开阶段，进入混合时间线 |
| `run.note` | `text` | 公开过程文字 |

成果共同字段：`id,kind:page/table/dashboard/task,name,description?,appearance?`。表格`columns,rows`；页面/仪表盘`metrics,chart,sections`或`document`；任务`code`仅文本，不执行。

## 3. 宿主与成果隔离

`appearance`：`theme:paper/ink/forest`、`accent:#RRGGBB`、`layout:dashboard/editorial`、`density:comfortable/compact`。只影响该成果Shadow DOM，不换肤外层快麦界面。图表支持`type:bar/line`。

表格可按需要声明`interactions:{search:true,sort:true}`，由受信渲染器提供当前预览搜索和列排序。未声明就不出现对应控件；不会改变平台数据或聊天输入。这是声明式交互，不执行模型提供的JS。

客户需要完全不同排版时用`document:{html,css}`。渲染至无allow标记的`sandbox` iframe，清除脚本、远端图像、导航、iframe/meta刷新与事件处理器；CSP禁止脚本/网络/表单。CSS只存在子文档。它支持展示与原生表单控件，不提供任意JS、网络、数据写回或第三方库。需要业务交互必须另行增加声明式动作能力，不能偷偷扩大沙箱权限。

## 4. 接收与应用回执

本机POST `/v1/local/publish`（0600运行凭据鉴权）→连接器投影与广播。返回`accepted:true,delivery:accepted`表示连接器接收，**不能说用户已看见**。前端渲染后POST `/v1/ui/ack`，包含`eventId,status,detail`；本机通过以下命令查询：

```sh
node publish.mjs receipt --session <ses...> --id <事件ID>
```

- `applied`：该前端已应用/渲染，非平台保存，也不等于证明用户阅读。
- `deferred`：成果已保留，当前未展示对应目标（后台资源/窗口收起）。
- `failed`：目标/渲染失败；`accepted`仍未收到前端回执；`unknown`未记录/窗口已过期。
- 回执有限内存保存，多个页面以最近回执为准，不是所有标签页一致性确认。断线不自动重发业务或模型指令。

## 5. 自动握手与本地权限

启动时`--trust-origin`明确授权精确loopback来源，`--session`指定唯一会话。前端仅发现服务后POST `/v1/handshake {}`获得短期、Origin绑定token，并自动订阅预定会话。前端不能在握手body指定另一会话。无Origin/陌生网站/Host不匹配均拒绝。

这是授权位置从网页配对码迁移到本机启动命令，**不是无鉴权本地HTTP服务**。任何控制该受信网页的脚本同样具有网页授权，应避免加载不受信脚本。默认观察，OpenCode网页反向输入需`--allow-control`或用户高级设置确认；平台危险操作仍遵守原会话权限。浏览器网络权限、安全沙箱、访客视图隔离不绕过。

## 6. 适配器合同与兼容程度

统一方法：`health / bindSession / readShared / watch`；可选`sendShared / interruptShared / installBridge / removeBridge`。`descriptor`声明真实能力，服务和前端根据能力启用按钮。

| 适配器 | 输入/公开回复 | 活动来源 | UI指令 |
| --- | --- | --- | --- |
| OpenCode | 已实接2.0.30原生双向会话 | 广播只发工具/技能摘要与思考耗时；完整公开详情按需鉴权读取 | 全部白名单 |
| generic | 无厂商原生聊天订阅、无网页反向prompt | Agent主动发布公开活动，不冒充自动探测 | 全部白名单 |
| WorkBuddy | 本机MCP主动上报，无网页反向prompt，不是原生会话镜像 | 仅公开phase/说明，不自动订阅全部技能/工具/subagent | 独立逻辑任务、作用域票据；新版自动查看/手选锁定；activity仅phase |
| Codex CLI共享daemon | 0.166.x、0.167.2、0.168.0、0.169.0 原生同thread双向，默认观察；需先明确绑定 | 公开item/turn事件、受控工具详情及原RPC问题/单次审批；不含私有reasoning | 全部预览白名单；附件/网页新建/自动发现暂不开放 |
| 千问办公 macOS | 通过本机桌面 HTTP 接口同步指定会话，网页默认观察，授权后可在空闲时发送文字 | 按任务游标轮询回复增量 | 未接入 |
| Claude Code 等 | 可执行本机 Node 命令时使用 generic | Agent 主动发布公开活动 | 通用白名单 |

OpenCode原生事件在会话作用域内转为标准投影，恢复时先订阅再核验快照；不广播其他聊天、完整输入JSON或原始工具结果。工具可带受限公开展示字段，见下文；思考正文不转发。

## 7. 技能发现与安装范围

独立分发规范源在 [`skills/`](../skills/README.md)，包含完整技能、协议、轻量脚本及安装器，通过独立产品配置连接运行时，不推导开发仓库目录。没有自动修改用户全局目录或厂商配置；技能导入能力不等于原生适配完成。

## 8. 相关新会话跟随（11-03补充）

原生自动连接默认开启相关会话发现。限定同一共享OpenCode服务、当前设计工作区、未归档的顶层会话；新鲜用户输入提及`lingtong-cli/绫通CLI`或实际shell工具执行该命令才作为候选。文档读取、echo字符串、私有推理或其他项目不触发，发现只传会话元信息，不转发候选的完整消息。

空闲时接入并呼出侧栏；原任务`queued/running/stopping/unknown`时保留并排队。点“现在查看”属于明确切换，仍不停止旧任务。`POST /v1/follow {enabled:boolean}`控制自动跟随，手动绑定/解绑会锁定；启动`--pin-session`可默认锁定。快照`routing`包含mode、pending、switching、discovery与lastSwitch。关闭最后一个授权后停止发现。

新会话默认只观察，不继承旧会话的网页输入控制授权；切换尚未完成或失败时原会话保留。网页未发送草稿保留原会话归属，不会自动发往新目标。只有旧绑定时，不允许Agent借旧session发布另一任务；应等待候选接入或由用户明确切换。

## 9. 扁平执行记录与公开内容

UI采用无边框记录行：工具名+灰色公开摘要，思考+耗时；相邻三个以上工具折叠为“使用了N个…”，展开态和阅读位置保持。错误是行内文本，不再是彩色边框卡片。

原生`publicTool`/`publicResult`在适配器边界产生，不转发原始`input/content/error`：

- Shell：受限可展示命令与公开标识参数；环境赋值、敏感/未知参数、请求体、多行脚本隐藏。
- Read/Glob/Grep：目标路径与范围；受保护路径隐藏，不传正文或匹配内容。Patch仅列出文件名。
- Webfetch：仅源站+路径，去掉用户名、密码、查询与片段；Skill仅受限标识。
- 广播只给已返回/失败提示或分类错误，不根据executed:false推导“本地未执行”。用户展开后的脱敏返回内容见第10节，不塞入广播流。

活动字段可带`summary/detail/errorSummary/toolName`（均有长度上限）。原生reasoning只映射开始/结束与耗时。需要具体行动说明时，由Agent在公开通道提供phase，或`activity.updated`显式`visibility:"public",publicSummary:"核对订单日期与退款口径"`；这是为用户编写的简短阶段说明，不能截取、压缩或转述内部思维链来填充。没有公开摘要就显示“未收到公开摘要”，不伪造内容。

验收会话可使用`metadata.kmAgentChannel`隔离标记；普通连接器忽略这些会话，测试适配器须指定相同channel，避免真实API测试触发用户页面切换。

## 10. 按需工具真实详情（修复补充）

`POST /v1/tool/detail {sessionId,toolId}`，使用已有Origin绑定token。观察模式可读当前绑定会话的原生工具记录；请求body前后与native查询后核验授权、hub/bindingEpoch、工作区和记录。换源、撤销、移动、旧实例迟到结果不返回给新来源。未知工具ID拒绝，不提供任意文件/命令读取接口。

响应为`{toolId,toolName,status,request,result}`；request/result包含available、text、format、redacted、truncated、totalChars、reason。普通Shell请求、普通文件内容、工具文本结果可读；明确的`skill/subagent/task`展示完整正常请求、技能正文与子Agent公开返回，不再整段替换成占位句。未知工具不通过read/shell等后缀冒充原生工具。直接读取凭据配置、密钥/技能文件、受保护目录和明确敏感命令仍不公开正文；技能调用自身的返回与任意磁盘读取不是同一权限。非HTTP连接URL同样去除userinfo凭据，内部逐字推理不展示。未知/隐藏/无文本结果都给明确原因，不冒充“没有执行”。

普通工具每段原文大于128KB不直接展示，其余先过滤密钥再截为最多12000字符；技能/subagent/task的正常请求与正文在512KB原文上限内完整保留，不因长文件名/会话ID被整体隐藏。超限明确提示本地查看，不冒称完整。详情不存平台或文件；缓存上限64条/2MB、30分钟有效；有限历史不可用时明确提示。工具状态由success/failed及历史state.status决定，表示工具已返回而非业务成功；executed字段不作为“本地未执行”的判断依据。

前端点击展开才获取详情，running转为returned后刷新且保留展开态。详情状态按实例+会话隔离；重连同一session也不复用旧实例的在途结果。返回HTML只以文字展示，不执行或加载外部资源。

思考可关联同一条消息的公开助手文本（source=assistant-public-text）或脱敏执行动作（tool-action），不能声称其为内部推理。按用户11-03输入区要求，隐藏可见的来源解释标签，来源仍保留在数据与DOM属性；明确publicSummary优先于自动关联的动作。无公开来源的记录不再提供空详情箭头。原始reasoning正文仍不进入详情缓存或接口。

## 11. 网页输入区与附件（11-03补充）

- `/new`、`/sessions`、`/stop`、`/help`是本地确定性动作，不将指令文本当prompt发送。`/new`通过`POST /v1/session/new {sessionId,requestId}`创建真实同工作区会话，复制原agent/model/permissions并绑定；需要当前网页canControl，不中断/删除旧聊天、不自动发送模型。明确新建与自动跟随区分，后者仍默认观察。
- `POST /v1/files/search {sessionId,query}`只返回授权工作区搜索路径，选择引用时不读正文，发送前再次核验realpath、隐藏/敏感资源、普通文件和大小。原生索引可有更新延迟，不提供任意磁盘读取。
- `/v1/run`新增可选`uploads:[{name,mime,base64}]`、`references:[相对路径]`，只支持原生共享会话。最多5项、单项2MiB、合计6MiB；类型为受限图片、PDF和UTF-8文本/代码。内容归一化后经2.0.30 `prompt.files`的data URI实际提交，选择/粘贴/拖入不自动发送。
- SSE/快照只带附件name/mime，不带base64或正文；唯一消息ID与包含附件的签名防重复/冲突。成功清理、失败保留；草稿包含附件时同样保留原会话归属。新建迟到结果必须核验实例、实时绑定和草稿版本后才清理/持久化，不能影响其他会话。
- 费用勾选移除，已允许网页控制时点击发送默认进入原生模型流程；未授权/离线/在途仍禁用，不放宽工具审批或平台保存发布授权。完整状态、测试及已知范围见[输入区记录](../../lingtong-prototypes/kmMDTable/agent/composer-notes.md)。

## 12. 原生Questions（当前绑定会话）

V2接口为`session.form.list/get/reply/cancel`，不是V1的question API，也不通过prompt伪装回答。`capabilities.nativeQuestions`为真时，`run.questions`包含受控公开表单：`{id,sessionId,title,questions:[{key,header,question,options:[{value,label,description}],multiple,custom,required,minItems?,maxItems?}]}`。选项用value提交，label只显示。未知字段、metadata、回答、私有推理、密码字段及隐藏/条件表单不广播；不擅自猜测不支持表单的填法。

- `GET /v1/questions`：当前绑定会话的待回答列表，观察模式也可读。
- `POST /v1/question/reply {instanceId,sessionId,questionId,answers:string[][]}`：按题顺序提交，服务再转换成原生field-keyed answer。
- `POST /v1/question/reject {instanceId,sessionId,questionId}`：用户明确跳过后调用原生cancel；关弹框只是暂缓。

只有已授权网页控制、绑定代次/实例/工作区/transport均一致且原生问题仍pending时才能写入；观察模式禁答，不增加permission授权。重复提交合并，确认未提交或校验失败才允许新尝试；不确定结果不得自动重发。原生created/replied/cancelled同步列表，重连先订阅再快照核验。当前只接入明确绑定会话，未实现任意子Agent关联链或generic原生表单控制。

## 13. 默认成果跟随、使用与宽度

顶部无成果跟随开关，收到新的成果焦点默认跟随；用户查看已有成果后，普通聊天/增量不反复切回，新的明确焦点仍生效。日志保留阅读位置，不强迫滚到底部。会话固定设置移到会话设置，不再占聊天标题。

“使用”是用户动作，不是自动UI指令：当前就绪表格/仪表盘/页面保存到原型本机资源目录并新增菜单项，刷新可恢复，不调用线上创建接口。保存失败不报成功，同会话/轮次/类型/成果ID重复使用返回旧快照；后续生成不覆盖已保存内容。任务草案不可因此运行/部署；ready、ack与保存仍分开。

侧栏提供指针/触屏拖拽和键盘分隔条，桌面360–720px且最大55%视口；全工作区聊天320–640px且为预览保留空间。小屏不超视口，宽度偏好仅当前浏览器本机保存。

## 14. WorkBuddy单向MCP发布

完整安装、配置和能力见[WORKBUDDY.md](WORKBUDDY.md)。五工具为`km_agent_protocol/km_task_open/km_task_publish/km_task_receipt/km_task_finish`。主服务须声明`capabilities.workbuddyPublish`；每任务ID由服务生成，不是厂商原生session。新候选只进鉴权snapshot.incomingSources，不自动抢占；snapshot.adapter/capabilities按当前绑定输出，WB全部原生控制能力为false。

本机POST `/v1/local/workbuddy/tasks/open`只用于全局publisher key注册，之后`publish/receipt/finish/heartbeat`都要求每任务票据及instanceId/taskId，无Origin、精确Host、受控JSON。不能用网页token或全局key代替任务票据。私有票据不进SSE/日志/工具返回，正常正文不重序列化；敏感字段区间、私有JSON/标签、已知裸凭据均过滤，敏感ID直接拒绝而不改写碰撞。

## 15. 多Agent跟随与自动准备（1.3.0）

`capabilities.multiAgentFollow`声明跨来源自动查看，当前完整run与后台元信息分离；最多8个已授权原生订阅可各自缓存/继续发布。新任务观测序在原生异步scope核验/本机open body读取前捕获，缓存seed也取原始最大序，不因迟到旧结果/同轮工具/心跳抢切。普通running不阻塞查看；问题/提交/绑定暂缓；手选锁定、恢复自动。全部新来源只观察，不继承输入授权。

`autoTrust`可只给明确Origin、不指定session的观察入口；allow-control仍须明确原生会话。启动参数支持workspace，不从运行库目录推工作区；未知WB namespace拒绝。AI/MCP稳定种子按独立bootstrap配置复用/安装/启动，主网页不执行系统命令。可信下载源/摘要未配置报阻断，已运行不重启，未知启动保留锁。详见[AUTOMATIC.md](AUTOMATIC.md)。

未绑定可缓存accepted；绑定后由实际前端回传applied，历史未渲染报deferred。artifact.ready只代表预览就绪，finish不补ready；明确WORKBUDDY_NOT_READY拒绝才释放完成请求，未知结果不重发。租约失效只报unknown，不称WorkBuddy停止。旧`/v1/sessions`保留数组；新版`/v1/sources`返回sessions/sources诊断。网页输入、Questions、权限审批与停止留在WorkBuddy，使用仍是用户手动本机快照。

## 16. Codex原生来源与单次审批（1.4.0）

详见[CODEX.md](CODEX.md)。连接器通过 Unix Socket WebSocket 接入已运行的共享 daemon。支持同版本的 `0.166.x`、`0.167.2`、`0.168.0`、`0.169.0`，以及 CLI `0.167.2` 搭配 daemon `0.168.0`、CLI `0.168.0` 搭配 daemon `0.169.0`。Codex 来源使用 `ses_codex_` 命名空间，`binding.nativeThreadId` 对应原生 `thread.id`。

macOS 可显式调用 `POST /v1/codex/desktop/restart {instanceId,requestId}`。连接器先核验桌面实际通信方式：共享 Unix socket 直接复用，私有 stdio 才切换重启，未运行则启动，未确认则保留应用。沿用网页鉴权，GET `/v1/codex/desktop` 读取异步状态和 `action: reuse|restart|start`。`capabilities.codexDesktopRestart` 声明入口可用。日常发现不触发该操作。`completed` 确认桌面共享连接，目标会话仍需绑定；详见桌面端切换说明。

每hub.adapter与capabilities/agent属于当前真实来源。发送明确走turn/start或带expectedTurnId的turn/steer，不确定结果/冲突不重发。附件、文件搜索、网页新建与Codex新任务自动发现明确false，手选绑定后的原生实时双向可用。

`GET /v1/approvals`返回当前绑定受控列表；`POST /v1/approval/reply {instanceId,sessionId,approvalId,decision}`只支持本次accept/decline/cancel。原RPC ID/参数留本机闭包，不提供浏览器任意RPC透传；检查控制授权、绑定/transport代次及pending作用域。问题沿用Questions，不能拿prompt伪装问答/审批；额外权限/不支持上下文留原生客户端。resolved不表示工具/业务成功。

accept只对完整公开上下文的普通命令开放，文件变更本版只拒绝/取消；移动/未知/超限文件详情整体阻断。有效提交ACK确认accepted，不以事件队列清空或即时历史为前提；ACK未知的已写请求仍保留UNKNOWN墓碑，不释放重发。Codex原生消息回流独立于client correlation，不合成重复用户消息；撤权/绑定代次guard贯穿预检。历史与delta通过RPC解码接收序和原子resume边界协调，不凭hasItem猜覆盖。目录别名使用有界元数据发现后realpath筛选，超预算明确失败。

genuine MCP/dynamic/function output、Shell和子Agent普通公开详情有独立有界过滤，不按未知工具字符串继承权限，不把完整参数/结果放SSE。普通文本在512000字节内完整，业务analysis/metadata保留，私有_meta/binary/推理和凭据过滤；不支持或超预算明确说明，不把状态摘要伪装原始返回。完整收尾说明见[CLOSEOUT.md](CLOSEOUT.md)。

新版停止附instanceId/sessionId，兼容旧空body；等待、调用前及确认后均检查代次，重连后的旧请求不能误停新turn。关闭网页只释放观察连接，不停止厂商Agent。reasoning正文/summary都不转发；工具详情沿用受保护路径与有界缓存。

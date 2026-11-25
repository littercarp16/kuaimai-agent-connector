# km-agent/1 完整UI协议

## 封装与顺序

每个文件一个对象`{protocol:"km-agent/1",id:"全新唯一ID",type:"指令",payload:{...}}`。body连同session小于19000字节；事件ID1–100字符，本客户端支持字母数字/下划线/冒号/点/横线。资源ID使用1–64字符字母数字/下划线/横线。每轮复用资源ID进行编辑，**不可复用事件ID表示新操作**。去重有限，不是持久事务或业务幂等保障。

先plan，再create、等待/构建、局部填充、ready。每一步提供真实阶段说明，不虚构完成百分比。只有用户明确的新建/打开/编辑才呼出窗口；普通更新/心跳不抢焦点。

## 15类指令

| type | payload | 效果及限制 |
| --- | --- | --- |
| plan.updated | title,items:[{id,kind,name}] | 构建清单；最多12项，ID唯一；不创建平台目录 |
| resource.create | id,kind:page/table/dashboard/task,name,appearance? | 原子建立未保存预览并呼出编辑；已有ID拒绝，不覆盖 |
| resource.open | artifactId | 打开已有成果 |
| resource.edit | artifactId | 修改已有成果，原ID保留；不提交平台 |
| panel.open | mode:side/workspace | 协作侧栏/工作区 |
| panel.close | {} | 收起窗口，不中断Agent或回滚 |
| work.status | artifactId,status,label | running/waiting/completed/failed；只描述该目标实际阶段 |
| activity.updated | id,kind,label,status,detail? | kind=phase/skill/tool/thinking/permission；status同上；只实际/公开活动 |
| step.updated | id,label,status,detail? | 兼容公开阶段，进入混合时间线 |
| artifact.updated | id,kind,name及成果字段 | 默认building，装配完整成果；相同资源ID替换内容，区块增量另用下两项 |
| page.section.updated | artifactId,section:{id,title,text} | 按稳定区块ID追加/替换，保留其他区块 |
| table.rows.append | artifactId,rows | 向已有表格追加受限行，不更新真实表 |
| artifact.focus | artifactId | 跟随模式切换成果，阅读保护可能deferred；不等于强制打开 |
| artifact.ready | artifactId | 本地预览已就绪，不是保存或发布 |
| run.note | text | 简短公开说明，最多3000字符，不传私有推理 |

## 成果格式

共同字段：`id,kind,name,description?,appearance?`；名称最多70字符。

- 表格：`columns:[字段名], rows:[[单元格...]]`，最多12列/15行、行宽一致。可选`interactions:{search:true,sort:true}`使预览可搜索/排序，不改变平台数据。
- 页面：`metrics:[{label,value,hint?}], chart?:{type:"bar"|"line",labels,values}, sections:[{title,text}]`。指标、趋势及说明须标来源；模拟/历史快照不能冒充实时查询。详情数量与内容大小仍受运行时校验限制，不把长明细全量塞入事件。
- 任务：`code`仅转义文本，不执行、不调度、不部署。
- appearance：`theme:paper|ink|forest,accent:#RRGGBB,layout:dashboard|editorial,density:comfortable|compact`，只作用于成果，不换肤外层产品。
- 独立文档页面可用`document:{html,css}`。HTML/CSS在无脚本、网络、同源、表单能力的受限iframe中展示，清除危险节点与事件。不为演示加allow-scripts、外链脚本或宿主eval。结构化成果使用隔离渲染。

## 公开活动

phase用于简短公开行动；技能/工具仅记录实际发生的调用，不能把示意流程冒充工具已执行。thinking正文不会转发内部reasoning，需要阶段说明时显式使用`visibility:"public",publicSummary:"核对日期范围与退款口径"`，仅是为用户撰写的公开行动说明。无公开内容仅显示状态/真实耗时，不能编造推理展开内容。

工具广播只能包含脱敏白名单摘要。受保护文件、凭据、技能资源及原始请求/结果不塞入SSE；按需详情接口由运行时鉴权、会话隔离和限长脱敏。`executed:false`不能单独推导工具未执行；工具已返回也不等于业务成功。

## 发布及回执合同

客户端用安全运行清单进行本机POST：`/v1/local/publish {sessionId,event}`和`/v1/local/receipt {sessionId,eventId}`；loopback、无Origin、受控JSON及运行时随机发布key鉴权。网页自己的Origin绑定授权与本机key不是同一种凭据，技能不读取网页token。

| 状态 | 只能得出什么 |
| --- | --- |
| accepted | 连接器已接收；不能说网页已显示 |
| applied | 某授权前端已导航/渲染；不保证所有标签一致或用户阅读 |
| deferred | 成果保留，但当前未显示目标或保护了阅读位置 |
| failed | 前端应用报告失败，不冒称完成 |
| unknown | 没有记录、过期或未确认；不推断未执行 |

回执/预览为有限内存状态，断线读取快照而非自动重发模型。不能通过打开另一个测试浏览器、代发ack或切换会话，把测试端的回执当成用户页面证据。需要纯发送联调时必须明确记录“接收已确认、展示未确认”。任何状态均不表示平台保存、发布、任务运行或授权增加。

## 网页输入能力（不是本机发布指令）

在支持这些命令的原生适配器中，`/new`显式创建同工作区真实新会话，`/sessions`切换，`/stop`请求停止，`/help`帮助；不把这些词原文发给模型。新建不停止/删除旧聊天、不自动发prompt，保留原权限；自动跟随其他会话仍默认观察。

`@`搜索授权工作区文件，仅发送时读取所选正文；图片/文件支持选择、粘贴、拖入、移除。上传+引用最多5项、单项2MiB、合计6MiB，支持受限图片、PDF、UTF-8文本/代码；不宣称所有Office文件可解析。拒绝敏感/隐藏/越界/目录及外部符号链接。文件只在用户点击发送后提交原生模型，SSE仅名称/MIME。费用勾选移除不等于工具自动授权；模型格式支持/额度及解读质量另行核验。generic不因此获得网页反向输入。

## Questions与“使用”（运行时/网页能力，不是本机发布指令）

原生来源支持时，`capabilities.nativeQuestions`声明表单能力：`run.questions`带`{id,sessionId,title,questions:[{key,header,question,options:[{value,label,description}],multiple,custom,required}]}`。多题用选项卡，单选/多选/自由输入；选项提交value，不是label。网页`POST /v1/question/reply {instanceId,sessionId,questionId,answers:string[][]}`，拒绝为`/v1/question/reject`；需要原网页控制授权、同实例同绑定且原生仍pending。关闭只暂缓，不自动拒绝；不同实例/会话的迟到回调不改变新问题。当前不覆盖任意子Agent关联链，不给generic虚构原生问答。技能bridge.mjs没有新增问答子命令，Agent可在本机原生端正常询问，不绕过用户网页回答。

技能/subagent/task详情按需鉴权读取正常完整请求、技能正文和公开返回（512KB原文上限内），不再整段用占位句代替；密钥/内部逐字推理仍过滤，不进入SSE。其他普通工具仍有预览上限；超限明确提示，不宣称完整。

顶部默认跟随AI成果，新焦点自动展示；查看历史记录不强迫滚到底部。用户点击“使用”后，当前就绪table/page/dashboard保存到原型自己的本机资源目录，菜单可打开、刷新可恢复，失败不报成功。保存快照不被后续流式内容覆盖；task不可部署。没有点击时仍只是预览；本机保存不是线上创建/保存/发布，更不是模型执行完成的凭据。不能通过自动发布UI事件代替用户点击“使用”。

## WorkBuddy本机MCP与自动准备（1.3.0）

已配置MCP时优先按[WorkBuddy流程](workbuddy.md)用五个工具建立独立逻辑任务，不起第二generic服务，不借其他来源的 sesID。网页只接收公开phase/过程与渐进成果，不是原生全量镜像；输入、问答、审批、停止留在WorkBuddy。每任务私有票据由MCP客户端管理，不加进工具参数或对话。accepted不等于applied；历史超出窗口可deferred，不能冒称全部正文可见。明确ready后才可finish或手动“使用”；finish不会自动补ready，不表示平台保存。

按[自动准备](automatic.md)由稳定种子先探测、安装或启动运行时；浏览器不直接执行系统命令。新版multiAgentFollow支持跨来源自动查看，不因普通执行繁忙阻塞，但问题/提交在途暂缓；原生订阅有限保留，旧Agent继续独立发布，不混入当前时间线。手选锁定、可恢复，按已接入Agent分组。新源不继承写权限；未配置可信下载源不伪造成功，启动未知不重试。

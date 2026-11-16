# 自动准备与多Agent跟随

只针对用户明确的快麦协作：由具备本机执行权限的AI Agent、配置好的MCP网关或受信本机宿主执行准备器；浏览器不直接执行系统命令。纯CLI查询、云端Agent无法访问本机、未授权厂商配置时，不强行安装，不宣称已接入。

## 准备顺序

1. 使用产品提供的独立`bootstrap.json`。本机Agent运行**本技能自身目录内**的`node scripts/prepare.mjs --config <bootstrap.json绝对路径>`；不是用户手动启动。不要从技能目录向上猜原型/仓库，不猜包名、端口、旧session或下载URL。
2. 准备器按私有清单核验实例：正确服务已运行则复用；已安装未启动则启动。配置 `allowPortFallback: true` 时首选端口被占用会自动分配空闲端口，实际地址以私有清单为准；未声明该字段的旧配置仍严格核验固定端点；不重启正确服务、不起第二个连接器。
3. 未安装且配置了固定HTTPS发布源、版本、sha256才下载，校验后原子安装，不运行安装脚本。没有release配置报`INSTALL_SOURCE_REQUIRED`，不要猜npm包/降级generic或让用户复制shell命令。摘要/TLS失败不得自行改预期摘要、关闭校验、换未授权源或执行包内脚本来“修好”。
4. 错服务、来源拒绝、超时未知、旧实例、路径/权限或摘要异常均停止准备，返回安全错误。启动结果未知保留锁，不反复尝试；已有Agent任务不停止、不重发。安装只覆盖产品新版本目录，不覆盖用户修改。
5. `ready`仅表示连接器已核验，不表示模型登录/任务成功、MCP客户端已加载或网页已应用。旧兼容服务缺少`multiAgentFollow`时不要假装自动路由就绪，也不要为升级擅自停服务。

## 产品配置合同（无密钥）

配置由安装器或产品CLI生成，运行时与种子/配置分开；不是需要用户手工填写的表单。字段：

| 字段 | 含义 |
| --- | --- |
| version | 固定1 |
| endpoint/origin | 固定loopback连接器端点/受信网页Origin |
| launcher/runtimeFile/mcpEntry | 明确运行时启动器、私有运行清单、官方SDK入口绝对路径 |
| launchArgs | 明确adapter、trust-origin、port、workspace；允许无session观察，不允许自动--allow-control |
| release（可选） | 固定HTTPS url、sha256、version、installRoot；已安装环境无需下载 |

运行清单包含私密key，须0600/父0700，不能复制到技能、聊天或事件。bootstrap.json不含key；两者不是同一种文件。现有CLI桥接配置`runtimeFile/launcher/origin`与bootstrap配置不同，不混传。下载包仅受限`km-runtime-bundle/1`文件清单，无脚本安装、无符号链接/越界路径/凭据，下载有摘要/字节/数量上限；没有真实发布源不能说已经从公网下载安装。

首次种子/完整技能由产品或获授权AI安装器按白名单落入指定Agent目录。已存在不同内容不强制覆盖，需核对自管版本、备份或请求确认；不扫描其它账号/聊天目录，不修改模型、审批、系统权限，不下载OpenCode/WorkBuddy客户端本体。

## WorkBuddy/MCP自动入口

配置MCP指向本技能的`scripts/mcp-entry.mjs --config <独立connection.json>`，而不是容易随运行时缺失的SDK文件。connection为`{version:1,bootstrapFile,origin,workspaceRoot}`，或用workspaceId替代workspaceRoot。

网关先ensure，再创建0600临时有效配置并启动官方SDK子进程；stdout只保留MCP协议，退出只清理自身临时配置/子进程，不停止连接器、Agent或模型。配置/种子必须放在运行时替换目录外，才能在缺失时恢复。MCP工具仍是[WorkBuddy五工具](workbuddy.md)，不开放任意系统命令或原生会话控制。

配套1.3 worker在所有旧任务明确结束、没有未知open/在途请求时，可为**全新taskKey**再次自动准备停止的服务；同实例复用，新实例将旧票据/key退役，不重放旧任务。活动/未知结果不迁移，不能靠换key绕过。若旧配置没有钩子或版本不配套，应如实请求接入升级，不假称已自动恢复。

## 自动查看、分组、锁定

- 新版`capabilities.multiAgentFollow`与`routing.supported`声明跨Agent跟随。默认自动跟随最新已核实任务；OpenCode与WB各有投影，切换只是查看，不停止旧任务、不混入后台完整内容、不扩大权限。
- 后台Agent可继续发布；心跳、普通增量、旧任务重复open不触发抢切。原生异步范围校验之前记录观测顺序，同轮次工具不重复当新任务，迟到旧候选不得抢走新来源。
- 当前原生问题待答/提交在途会短暂等待；不为了看新来源丢掉问题草稿。新源始终只观察，不继承旧输入授权；不自动点“使用”。
- 用户手动选源会锁定，直到其恢复自动。按已接入Agent分组选择，不伪造“电脑已装即已连接”的会话；原生双向与MCP协作上报能力各自声明。
- 如果用户锁定、来源核验失败或确为旧部署，说明实际状态，不能借另一个已绑定session发布。`accepted`不等于`applied`，如实查回执；未知结果不重发。

## 提示与边界

会话设置默认不展示安装教程/大段警告，状态点和点击信息图标提供细节。安装、启动、来源接入、前端应用、用户阅读、平台保存分开报告；下载/启动通过隔离测试不等于真实客户端已识别。浏览器本地网络权限或宿主工具审批仍由用户确认，不能绕过。

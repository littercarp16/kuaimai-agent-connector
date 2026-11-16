# 本地Agent协作原型收尾

本交付仅包括kmMDTable的本机Agent连接器、协作界面、技能规范源、模拟验收和设计记录，不修改参考源码仓库或线上业务。

## 交付与能力边界

| 来源 | 已接入 | 明确边界 |
| --- | --- | --- |
| OpenCode V2 | 原生共享会话、公开事件/工具详情、Questions、网页输入/停止、附件和新会话 | 保留原模型/工具权限，新来源不继承控制授权 |
| Codex CLI 0.166.x、0.167.2 | 连接已运行共享daemon，同thread文字双向、公开原生工具详情、问题、单次命令审批和精确停止 | 首版需明确选源；附件/文件搜索/网页新建/新任务自动发现未开放；文件批准回原生 |
| WorkBuddy | 独立逻辑任务的五工具MCP主动上报、渐进预览与回执 | 只接收，不冒充全量原生镜像；输入/问答/审批/停止留原客户端 |
| generic | 标准公开活动和UI预览发布 | 没有厂商原生双向能力 |

会话按已接入Agent分组。自动查看不停止旧任务，各自缓存、手选锁定/恢复。连接器/技能由已授权本机Agent或准备器复用/启动；未安装只有明确可信发布源和摘要才可下载，不编造安装包地址。

## 提交确认修复

Codex成功的turn/start或匹配expectedTurnId的turn/steer ACK，仅确认本次输入已接收，不是模型执行成功或前端applied。HTTP不再等待整轮事件队列或历史落盘，当前实例/会话/草稿版本未变时可清理已提交草稿。

真实用户消息只由原生event/history进入聊天，不能把client correlation当作原生UUID再合成一条；未知ACK仍保留幂等墓碑，绝不自动重发。预检等待期间撤权或切源会中止该owner的控制器，保留观察连接，不中断原Agent；重新授权后的明确未提交请求可重试，已写/未知请求不可因此释放。

## 工具详情与隐私

genuine native item类型是详情依据，工具名叫shell/skill并不会获得对应权限。普通MCP参数、text/structuredContent、安全错误、Shell及子Agent公开正文按需鉴权读取；广播只含有界摘要，正文不执行、不注入宿主。

- 详情上限512000字节，结构8192节点/24层、字段名1024字符；文件变更还受完整上下文/128KB限制，不能截掉移动目标或第101项后批准。
- 原生Shell命令超过8000字符解析预算、受保护路径/凭据配置或无法核验的上下文不公开正文。
- 秘密字段、裸凭据、明确私有推理过滤；普通业务analysis/metadata、大整数JSON文本、空白和无凭据URL保真。MCP私有`_meta`、类型明确的binary及不支持内容省略并说明原因。
- 过滤为有界扫描；控制字符/转义字符串解码后仍检查凭据，不恢复绕过过滤的长串。长字段名、点号文本、JWT式重复前缀均需要进性能回归。

工具“已返回”不等于业务成功；accepted不等于applied；ready不等于平台保存。“使用”仍须用户主动点击，仅保存同源本机就绪快照，task不可据此部署。

## 配置、运行与仓库范围

详见[自动准备](AUTOMATIC.md)、[WorkBuddy](WORKBUDDY.md)、[Codex](CODEX.md)。明确的Codex独立目录通过产品私有native-sources配置绑定到精确endpoint/origin/workspaceRoot，不改变OC/WB根目录，不由网页任意选择磁盘范围。

`.runtime/`、运行票据、维护备份、node_modules、用户级产品/厂商配置均不入库。技能规范源可分发，实际客户端加载、服务健康、用户网页渲染及平台保存分别验证；正式公网下载源尚未配置。工作区外的历史实施计划不是运行依赖。

## 可复验命令

独立连接器的回归测试在仓库根目录执行 `npm test`。以下命令对应原型仓库的 `kmMDTable/` 目录。

```sh
npm run test:agent:codex
npm run test:agent
npm run test:agent:automatic
npm run test:agent:workbuddy
npm run test:agent:refinements
npm run test:agent:ui
npm run test:agent:skills
npm run test:agent:startup
npm test
```

浏览器回归需要既有Playwright及Chrome；其它机器应通过`PWB_PLAYWRIGHT_MODULE`、`PWB_BROWSER_EXECUTABLE`明确依赖，不将本机默认路径当作已打包组件。测试使用独立socket/随机端口与假模型，不执行真实模型/业务任务；live验收不得自动开启。

用户已实际验证CLI↔网页简单文字同步；长任务提交/完整工具正文的修复需以新增延迟ACK/echo、撤权、隐私及性能用例为准，不把之前简单文字UAT扩大成全部能力真人验收。真实界面/历史只读检查和隔离浏览器也不能伪造用户applied。

提交/合并前须全量回归、独立重要问题复核关闭、语法/差异和凭据检查通过。分支和提交记录以git log为准；本地合并与远端推送分开授权。

## 本轮最终验证

2026-11-04：上述9个入口合计 **649项通过**（Codex201、核心102、自动准备87、WorkBuddy54、细化94、界面36、技能18、后台启动1、基础56），无真实模型或业务任务。

独立复核已关闭提交撤权保护、工具过滤的控制字符/转义凭据、目录别名、typed binary及正则CPU退化问题；最后JWT式200KB重复前缀经native/MCP/collab路径约50ms完成，凭据仍隐藏。测试与检查失败时不得以此历史记录替代重新验证。

确认当前任务结束后，仅重载Connector应用修复；实际旧MCP记录通过生产鉴权详情接口只读验证可恢复（含失败调用安全错误），没有重跑工具或模型。用户后续新消息仍需自行确认真实输入区行为，不把模拟用例或服务健康冒称真人DOM验收。

补充[展开MCP详情原型截图](../../lingtong-prototypes/kmMDTable/assets/agent-codex-mcp-details.png)：模拟协议后端，滚动至完整正文末尾及结构化返回；不代表用户真实网页或平台保存回执。

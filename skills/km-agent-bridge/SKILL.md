---
name: km-agent-bridge
description: Use when 快麦多维表格需要本地Agent自动准备连接器、跨Agent自动跟随、WorkBuddy MCP任务上报、会话绑定、渐进预览、公开执行阶段及前端回执核验。支持独立产品配置，不依赖开发仓库目录。
---

# 快麦本地Agent协作

**Codex CLI原生共享会话：**新版Connector提供Codex原生来源时，优先按[Codex流程](references/codex.md)核对已运行共享daemon与真实threadId；不是generic/MCP单向发布，不再另起Codex服务。默认观察，实际控制按来源能力与用户授权；缺少原生来源就报告未接入，不借OpenCode会话或自动降级generic冒充双向。

## 自动准备与跟随（优先）

明确的快麦协作任务先按[自动准备](references/automatic.md)处理，由本机Agent或已配置的MCP网关执行`prepare.mjs`。已运行复用、已安装未启动自动启动，未安装才用已配置的可信源下载并校验；不要让用户手动执行npm启动命令。不安装厂商客户端、不停旧Agent、不重发任务。没有可信源/本机权限时如实阻断，不假装下载。纯CLI查询且无协作意图不强启。

`multiAgentFollow`就绪时新任务自动查看，旧来源继续执行并独立缓存；用户手选即锁定，可恢复自动。不要求每次手选WorkBuddy候选，也不因旧心跳/工具增量来回抢切；未知来源不冒充原生双向。以下脚本status/doctor/start保留诊断与旧部署兼容，优先用已配置准备器，不借旧session启动新任务。

**WorkBuddy 已配置快麦 MCP 时，优先按[WorkBuddy协作流程](references/workbuddy.md)操作**：使用`km_agent_protocol/km_task_open/publish/receipt/finish`，不按下方脚本路线另起generic服务，也不借用OpenCode会话。首版网页只接收过程与成果，输入、问答、审批和停止留在WorkBuddy。没有这些MCP工具时明确提示配置未完成，不自动替换现有连接器。

本技能目录可整体搬迁。相对路径均以本文件所在目录为基准，不以当前终端目录为基准。Node.js需22+；无需npm依赖。**安装技能不等于安装/启动连接器、厂商原生接入或授予控制权限。**

## 入口

将下列`<技能目录>`替换为Agent加载本技能时给出的真实目录：

```sh
node "<技能目录>/scripts/bridge.mjs" commands
node "<技能目录>/scripts/bridge.mjs" status --config "<产品提供的连接配置JSON>"
```

配置也可通过`KM_AGENT_BRIDGE_CONFIG`指定。缺少配置时读取[连接说明](references/connection.md)并询问产品安装位置，**不回找原开发仓库、不猜CLI命令、不扫描端口或借用其他会话**。完整[指令协议](references/protocol.md)、[Agent兼容表](references/agent-compatibility.md)均在本技能内。

## 操作顺序

1. `commands`离线查指令。`status`只读运行清单，不能证明网页在线；`doctor --config ...`核验来源、协议和实例。已有服务不重启、不启动第二个连接器。无活动网页且仅业务CLI查询时不强启协作服务。
2. 只使用用户明确指定/当前真实会话的ID。多个同名或旧绑定需确认，不能任选一个。原生OpenCode自动跟随只在运行时明确支持时使用；忙碌排队、锁定不切换，新来源不继承控制授权。
3. 先发`plan.updated`，再`resource.create`→`work.status`→逐块`artifact.updated/page.section.updated/table.rows.append`→`artifact.ready`。已有成果用`resource.edit`，不create覆盖；用户明确打开/编辑才呼出。每个事件唯一ID、单独JSON文件、小于19KB；禁止发送事件数组。
4. 发布及核验：
   ```sh
   node "<技能目录>/scripts/bridge.mjs" publish --session <真实目标sesID> --file <单个事件JSON> --config <连接配置JSON>
   node "<技能目录>/scripts/bridge.mjs" receipt --session <真实目标sesID> --id <同一事件ID> --config <连接配置JSON>
   ```
   `accepted`只表示连接器接收；`applied`才是某前端已应用，也不证明人已阅读。`deferred/failed/unknown`分别如实报告。**无回执不能声明已展示，不能自动换会话、改用generic、重发模型或反复重跑全流程**；先核对目标/来源/连接。明确要求仅测试发送时，可记录“已发送但未确认展示”，不能算界面通过。
5. `demo --out <全新目录>`仅生成带唯一ID的15类联调事件；不访问网络，逐项发送前需用户要求联调。模拟数据和模拟失败始终标明，不调用业务接口制造失败。

## 权限与内容

- 技能与运行时分开部署；启动需明确要求并按[连接说明](references/connection.md)提供产品启动入口、Origin、session。安装不启动模型、服务或改Agent全局配置。
- OpenCode与已核对版本的Codex CLI共享daemon可走各自原生适配，能力不可互相继承；Codex见上方专用流程。Claude Code/Cursor/Qoder等仅在能运行本机脚本时使用generic发布UI，**不加`--allow-control`，不声称原生聊天订阅或反向输入已接通**。无本机终端能力时只提供步骤说明。
- 公开阶段由Agent撰写简短行动说明；只展示实际发生的技能/工具动作，禁止私有思维链、密钥、原始工具请求/返回广播。详情仅由运行时鉴权按需脱敏提供。
- 页面/表格/任务都是本地未保存预览；ready不等于平台创建、保存、发布或任务运行。独立样式只作用成果，HTML/CSS保持沙箱，不能为演示放宽脚本/网络权限。
- 保留原会话工具权限，不自动审批危险操作；平台业务读写需另有明确用户授权与对应业务工具。健康成功不保证模型认证、额度或生成成功。

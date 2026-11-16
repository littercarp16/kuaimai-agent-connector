# WorkBuddy本机MCP协作

用户在WorkBuddy发起明确的快麦任务，本机MCP桥将计划、公开阶段与渐进成果交给已配置的连接器。网页只接收，**不是原生会话镜像**，没有订阅全部聊天、技能、工具或subagent。补充输入、Questions、审批与停止都在WorkBuddy中处理，不从网页代答或提权。

本流程使用当前WorkBuddy的快麦MCP工具。新版入口先按[自动准备](automatic.md)由稳定网关自动核验、必要时安装/启动运行时；运行时与技能分开，配置由产品安装程序生成。不猜文件目录、账户配置、厂商CLI或私有接口；工具未加载且没有获授权本机执行入口时如实请求接入，不伪造已安装。

## 工具与顺序

| 工具 | 参数 | 作用 |
| --- | --- | --- |
| `km_agent_protocol` | `{}` | 读取km-agent/1指令、限制和真实能力 |
| `km_task_open` | `{taskKey,title}` | 当前MCP进程中建立独立协作任务；保存返回的taskId |
| `km_task_publish` | `{taskId,event}` | 发单个UI事件，不是平台保存；event含protocol/id/type/payload |
| `km_task_receipt` | `{taskId,eventId}` | 核验同一任务、同一事件的网页应用状态 |
| `km_task_finish` | `{taskId,status,note?}` | 明确报告completed/failed；不执行或停止WorkBuddy本身 |

1. 先`km_agent_protocol`核对能力，再`km_task_open`。taskKey为本次用户任务自定的稳定ASCII唯一标识（如`replenish-20261103-1`，不要直接使用中文标题），title为简短中文任务名；同一任务不要反复换key创建副本。用户明确发起另一项新任务时用新的唯一key，不复用已结束任务的key。taskId是本桥分配的**逻辑协作ID**，不是WorkBuddy原生聊天ID；首版不验证厂商原生聊天归属。
2. 使用返回taskId发布`plan.updated`；随后`resource.create`、公开`activity.updated`（kind仅phase）、逐块`artifact.updated/page.section.updated/table.rows.append`。不要把原始工具请求/返回或私有思维链塞进phase或run.note；只上报真实动作与为用户撰写的简短公开阶段。
3. 每事件唯一ID，不发数组；保持资源ID稳定。同一ID只重查回执，不用它表示另一次编辑。已有资源用`resource.edit`，不create覆盖；数据、来源和模拟范围须如实说明。
4. 确认内容完成才发`artifact.ready`，不能把空壳、部分数据或失败标成ready。存在building成果时，不能用finish绕过就绪检查。
5. `km_task_receipt`核验关键事件。`multiAgentFollow`就绪且未锁定时，网页自动查看新任务，不要求用户每次点击候选；锁定、旧部署或问题待答时可能暂未展示。`accepted`仅表示接收/缓存；**不借用旧OpenCode会话、不自动重跑整批事件**。`applied`才表示某授权前端应用，仍不证明人已阅读或平台已保存；deferred/failed/unknown按实际报告。
6. 所有需要生成的成果明确ready后，将已上报阶段按实际结果更新结束，再用`km_task_finish`报告完成。最终答复区分：内容已生成、网页应用是否确认、是否由用户点击“使用”。不得把“已报告完成”当作WorkBuddy原生终态证据。

## 单事件示例

先完成open，以下taskId须替换为工具真实返回值：

```json
{
  "taskId": "<km_task_open返回的taskId>",
  "event": {
    "protocol": "km-agent/1",
    "id": "wb-plan-001",
    "type": "plan.updated",
    "payload": {
      "title": "商品补货分析",
      "items": [{"id": "products", "kind": "table", "name": "商品分析表"}]
    }
  }
}
```

同一任务继续resource.create→内容更新→artifact.ready；完整15类指令和成果字段见[协议](protocol.md)或工具`km_agent_protocol`，不把本示例误当成只有plan就完成。

## 权限和失败

- **不启动第二个连接器**、不杀17653进程、不扩大OpenCode权限；**不借用OpenCode** sesID发布WorkBuddy任务。新版按新任务观测顺序自动切换查看，但不停止旧任务，原来源仍独立缓存；用户可锁定/恢复自动，手动选源按Agent分组。
- 本机发布key与每任务私有票据由MCP客户端管理，不读取、输出、粘贴到技能/对话/事件里，也不要在工具参数添加token。只能操作本MCP进程持有票据的taskId。
- 网页无反向prompt、新建原生会话、附件提交、原生Questions、工具审批或停止能力。不伪造这些功能已接通。
- 工具不存在、实例变化、票据失效或连接不可达时，停止发布并说明阻断；不降级generic、不扫描端口、不从厂商聊天数据库或私有IPC恢复。不确定的open/publish/finish结果不自动重发，先核验已有任务/事件。
- 心跳只描述桥接通道是否还在；失联不等于WorkBuddy已停。MCP进程重启后不假称已恢复旧票据/全部聊天，也不自动重放未确认事件。
- 正常文字、JSON示例、HTML/CSS按协议保留；具体密钥与私有推理仍过滤。成果在沙箱中展示，不能通过脚本、网络或宿主样式绕过隔离。
- 用户点击网页“使用”只保存当前明确ready的表格/页面/仪表盘快照到本机资源目录，刷新可恢复；不是线上落库，task不可部署。业务读写仍需对应业务工具与明确授权。

## 安装验证边界

“配置已导出”“技能已复制”“MCP已加载”“任务已接收”“网页已应用”分别核验，不能混称已接入。没有WorkBuddy实际工具调用及用户网页回执前，只能报告代码/隔离测试结果；不得代发ack或拿另一个测试浏览器当用户页面证据。

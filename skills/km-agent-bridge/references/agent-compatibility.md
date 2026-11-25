# Agent安装与能力边界

目录安装只解决技能发现，不改变连接器适配能力。Codex CLI 共享 daemon 支持原生双向通信（[Codex边界](codex.md)）；千问办公和 WorkBuddy CLI 支持在网页绑定原生会话并收发消息。WorkBuddy 的独立 MCP 入口用于协作发布；其余Agent在具备本机Node执行能力时可通过generic发布UI。云端/远程Agent不能访问用户电脑loopback时，不能声称本地接入完成。Codex Desktop/IDE不能仅凭共享历史就当作同daemon。

本页的`--agent/--target`指**外层分发包安装器**参数，不是bridge.mjs子命令。已安装的技能目录不携带安装器；若只有技能目录，由宿主CLI/客户端导入，或复制完整目录到其技能位置，不编造安装命令。

| 安装器agent | 项目级skills目录 | 用户级skills目录 | 发现依据/限制 |
| --- | --- | --- | --- |
| claude-code | .claude/skills | ~/.claude/skills | 官方文档；终端本机技能，不等于Cowork或云端已同步 |
| cursor | .cursor/skills | ~/.cursor/skills | 官方文档；不自动同步到云端 |
| qoder | .qoder/skills | ~/.qoder/skills | Qoder CLI官方文档；其其他产品版本单独核验 |
| codex | .agents/skills | ~/.agents/skills（用户级安装仍单独核对） | 0.166.0官方App Server skills/list已只读发现本工作区项目级km-agent-bridge，repo scope/enabled；不是用户级安装或模型调用验收 |
| WorkBuddy | 必须--target明确实际skills目录，或通过客户端导入完整技能 | 同左 | 首版本机MCP协作；按[WorkBuddy流程](workbuddy.md)用明确工具发布，不是原生聊天镜像/网页反向输入。未配置MCP时不自动切generic或重启现有服务 |
| 其他，如TRAE/千问办公 | 必须--target明确实际skills目录 | 同左 | 不猜版本相关路径；仅支持标准技能或本机脚本的客户端可用，不能自动变成厂商原生双向 |

官方参考（核对于2026-11-03，不等于在每款客户端实机验收）：

- Claude Code：https://code.claude.com/docs/en/skills
- Cursor：https://cursor.com/docs/context/skills
- Qoder CLI：https://docs.qoder.com/cli/Skills
- Codex：https://developers.openai.com/codex/skills （此前网页403；11-04另经0.166.0官方skills/list完成本工作区项目级发现核验）
- TRAE：https://docs.trae.ai/ide/skills （本次访问超时，使用自定义目标）

重新发现/加载本技能后，用其离线`commands`确认资源可读，再按连接配置`doctor`核验服务；没有厂商会话事件/双向输入验收时，只能说“技能文件已安装”，不能说“该Agent已原生接入”。同名多个技能可能覆盖或重复出现，请人工决定保留哪份，不自动删除用户已有技能。

# 快麦本地Agent协作 · 可分发技能包

**1.4.0 Codex原生：**新增[Codex共享daemon指引](km-agent-bridge/references/codex.md)，区分原生双向与generic/MCP上报，不借旧OC、不另起Codex、不伪造Desktop同步。规范包13文件；项目级发现已由0.166官方API只读核验，用户级安装/真实模型任务仍分开确认。

本目录是后续并入lingtong-cli skills的规范源。**技能与运行时分离**：`km-agent-bridge/`可独立复制到支持Agent Skills的客户端，入口、协议、命令目录、轻量Node调用脚本和演示生成器全部随包，不导入上级源码、不携带node_modules、服务代码、运行凭据或会话状态。

**1.3.0 自动连接：**新增无第三方依赖的`prepare.mjs`与稳定MCP种子`mcp-entry.mjs`，按[自动准备](km-agent-bridge/references/automatic.md)由AI/MCP核验、复用、安装或启动；不让用户执行npm启动步骤，未安装才从已配置可信发布源下载。默认自动查看新任务、后台源缓存、手选锁定/恢复、按已接入Agent分组。WorkBuddy仍为五工具协作上报，不是原生镜像；配置/运行时继续与技能分离，不能编造未发布的下载地址。

```text
skills/
├── install.mjs / install.sh / install.ps1
├── manifest.json                 # 安装文件白名单与版本
└── km-agent-bridge/
    ├── SKILL.md
    ├── scripts/bridge.mjs         # 无第三方依赖，Node 22+
    ├── scripts/demo.mjs           # 生成唯一ID的15类事件，仅写新目录
    ├── references/               # 协议、配置、兼容表、离线命令目录
    └── examples/connection.example.json
```

## 安装

在任意工作目录运行本包`install.mjs`的真实路径，不要求进入开发工程。`--project`为目标项目根目录；`--target`为实际skills父目录，安装器在下面创建`km-agent-bridge/`。

```sh
# 先预览，不产生目录或写入
node <本包目录>/install.mjs --agent codex --scope project --project <目标项目> --dry-run
# 确认后执行同一命令，去掉--dry-run
node <本包目录>/install.mjs --agent codex --scope project --project <目标项目>

# 用户级安装必须明确指定；不是默认行为
node <本包目录>/install.mjs --agent claude-code --scope user --dry-run
node <本包目录>/install.mjs --agent cursor --scope project --project <目标项目>
node <本包目录>/install.mjs --agent qoder --scope project --project <目标项目>
node <本包目录>/install.mjs --agent codex --scope project --project <目标项目>

# 其他客户端：按其当前版本提供的实际目录安装，不猜路径
node <本包目录>/install.mjs --agent workbuddy --target <其实际skills目录> --dry-run
```

Shell等价入口：`sh <本包目录>/install.sh ...`。PowerShell：`powershell -File <本包目录>/install.ps1 ...`。两者仅转发参数给同一个Node安装器，不下载/执行远程脚本、不修改执行策略。Windows/各厂商UI须在目标环境另行验收。

安装器只复制manifest白名单；完全相同的目标为`unchanged`。已有不同内容、额外文件或符号链接均拒绝，不提供强制覆盖/删除。升级时先由用户备份/迁移旧目录，或选择其他目标，不擅自删除旧技能。异常时可能留下本次创建的未完成目录，错误会提示人工核对，不递归删除不确定内容。程序只检查普通受信本机文件系统，不宣称防御拥有本机写权限的并发攻击者。

安装目标的祖先路径也会检查，拒绝用户自定义链接绕行；macOS仅允许经真实目标核验的`/var → /private/var`、`/tmp → /private/tmp`、`/etc → /private/etc`系统规范别名，不把任意符号链接作为例外。

所有输出是JSON，失败JSON写stderr且退出码非0；安装成功只表示文件已落位。实际Agent需重新发现/加载，兼容目录与未验证项见[兼容表](km-agent-bridge/references/agent-compatibility.md)。本轮不自动改用户真实Agent目录，也不改settings、权限、MCP、AGENTS.md或模型配置。

## 安装后使用

明确快麦协作任务应优先由AI执行`node <已安装技能>/scripts/prepare.mjs --config <产品提供bootstrap.json>`，或配置MCP使用`mcp-entry.mjs --config <独立gateway配置>`自动准备。种子和产品配置放在运行时目录外。下方status/doctor/start是旧部署兼容/诊断，不是要求用户执行的主流程；bootstrap与CLI bridge配置格式不同，不混传。

```sh
node <已安装技能目录>/scripts/bridge.mjs commands
node <已安装技能目录>/scripts/bridge.mjs demo --out <一个尚不存在的输出目录>
node <已安装技能目录>/scripts/bridge.mjs status --config <产品提供的连接配置>
node <已安装技能目录>/scripts/bridge.mjs doctor --config <产品提供的连接配置>
node <已安装技能目录>/scripts/bridge.mjs publish --session <明确真实sesID> --file <单个事件JSON> --config <产品提供的连接配置>
node <已安装技能目录>/scripts/bridge.mjs receipt --session <同一sesID> --id <同一事件ID> --config <产品提供的连接配置>
```

配置由部署方提供`runtimeFile/launcher/origin`，相对路径以配置文件为基准；不能把凭据写进技能或聊天。`status`只是绑定元信息；`doctor`只是服务核验。`accepted`不等于`applied`，均不等于平台保存。生成演示事件不会自动发送；逐项发布前要有明确联调意图，并将模拟数据/模拟失败与真实工具动作分开。

## 交给lingtong-cli打包时

1. 保留整个`km-agent-bridge/`目录和内部相对路径，不只提取SKILL.md。沿用CLI已有安装器时，按manifest.files复制完整技能即可；无需运行本目录安装器。
2. 不把运行清单、密钥、依赖、测试临时目录或用户本地配置打进技能。独立产品运行时另行提供并安装，本包不会下载或安装它。
3. CLI负责把真实运行清单/启动器/受信Origin写到**独立产品配置**，或告知Agent配置路径；用`KM_AGENT_BRIDGE_CONFIG`或`--config`连接。不要给技能注入开发者绝对路径，也不要创造未实现的CLI子命令。
4. 本包启动命令只按已有启动器参数合同调用，不意味着当前运行时已完成生产安装路径、任意工作区和HTTPS接入改造；这些需要后续产品运行时单独实现/验收。
5. 修改协议时同步技能命令目录与文档并提升manifest.version。[`tests/skills/skills.test.mjs`](../tests/skills/skills.test.mjs) 会核对当前运行时的15类指令。

当前工作区旧的项目级技能保留兼容，未自动覆盖；分发请以本目录为准。安装到同名目录发生冲突应由用户明确迁移，而非扩大安装脚本权限。

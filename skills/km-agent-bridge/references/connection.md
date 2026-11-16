# 产品连接配置与运行时合同

配置与技能目录互相独立；技能可以安装到任意Agent目录，再整体搬走。运行清单和启动入口必须由产品安装程序/管理员提供，不能根据技能目录向上推导，也不要猜测未来CLI子命令。

## 配置

复制技能内`examples/connection.example.json`到产品配置位置，并替换所有示意值。`origin`是用户已授权的网页精确Origin，不把示例端口当成产品固定值。相对路径相对于**连接配置JSON**，不是技能或当前工作目录。

| 字段 | 规则 |
| --- | --- |
| version | 固定1 |
| runtimeFile | 本机安全运行清单路径，status/doctor/publish/receipt必需 |
| launcher | 可选，本机产品启动器mjs入口；仅start使用 |
| origin | 已授权网页的精确HTTP/HTTPS Origin，不含路径/通配符/用户名密码 |

配置只存以上公开定位信息，**不能添加key/token/cookie等密钥字段**。用`--config <文件>`或环境变量`KM_AGENT_BRIDGE_CONFIG`显式选择；脚本不自动搜索家目录、仓库或网络服务。

```sh
node "<技能目录>/scripts/bridge.mjs" status --config "<产品连接配置>"
node "<技能目录>/scripts/bridge.mjs" doctor --config "<产品连接配置>"
```

status返回有限绑定元信息，`browserVerified:false`；这不是在线客户端列表。doctor只核验服务Origin、km-agent/1和实例，不创建网页授权、不发送模型请求。

## 安全运行清单（由运行时生成，不手工把密钥贴给Agent）

清单合同为`instanceId, endpoint, protocol, key, bindings:[{id,title}]`。endpoint只接受明确的`http://127.0.0.1:端口`，不允许任意URL、URL凭据或重定向远程服务。运行时自己生成随机发布key，文件当前用户0600、父目录0700；不应提交、复制进技能、作为聊天附件或输出正文。Windows需产品单独核验ACL，不能把POSIX检查当作Windows验证。

客户端读取有大小上限，拒绝符号链接；发布前先无凭据核验Origin和instanceId，私有发布key只放在loopback本机请求头，不进入日志或输出。运行清单失效、实例变化或授权失败时停止，不自动换源。产品打包可以改运行清单存放位置，只要配置给出真实路径；技能包不需要改写。

## 显式启动（不安装运行时）

仅在用户要求本地协作、服务未运行且产品已提供启动器时：

```sh
node "<技能目录>/scripts/bridge.mjs" start --config "<产品连接配置>" --adapter opencode --session <当前真实sesID> --origin <用户确认的精确Origin>
```

只有用户明确允许网页反向输入时加`--allow-control`；可用`--pin-session`锁定，端口用显式`--port`。generic使用独立唯一任务标识且不加control；这不是其他厂商原生会话同步。

产品启动器参数合同：`--adapter opencode|generic --session ... --trust-origin ... --port ...`，可选`--allow-control/--pin-session`。启动器负责后台运行、依赖和运行清单生命周期；技能不安装依赖，不修改模型服务，不杀端口进程。返回只表示启动命令已结束，仍须doctor和网页实际握手。

启动前只对指定loopback端口做TCP占用探测，不发送HTTP、不跟随重定向；只有明确连接拒绝才允许继续。已连接、超时或其他不确定错误均阻止启动，不能把HTTP断开/错误当成端口空闲。探测与启动之间仍可能发生端口竞争，产品启动器必须保留自身的端口独占检查，不能接管已有服务。

此合同适配现有连接器启动方式；**并不意味着当前运行时已具备正式产品安装、任意工作区、HTTPS部署或所有Agent原生适配**。当前启动器若拒绝某Origin/参数，应如实提示产品运行时尚不支持，不降级安全策略或猜CLI替代命令。后续CLI打包需单独提供/改造运行时，保持本技能接口稳定。

## 故障边界

- CONFIG_REQUIRED：尚无产品配置；询问真实配置位置，不回找开发目录。
- RUNTIME_PERMISSION：凭据文件权限不符合要求；请产品正确生成，不输出密钥或自动chmod他人文件。
- RUNTIME_STALE：当前服务与清单实例不同；由产品更新清单，不读取旧会话内容或重发请求。
- SESSION_NOT_BOUND：明确目标尚未被网页授权；由用户在网页选择，不借用其他绑定。
- ALREADY_RUNNING：已有端口服务；保留，不自动停止/重启。
- accepted且无applied：可能是未订阅、前台/来源/客户端问题，原因尚未确认；不是“肯定页面在后台”，也不是展示成功。一次明确的诊断后记录阻断，不反复盲发。

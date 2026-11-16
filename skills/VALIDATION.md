# 可分发技能验证记录

范围：本技能包与安装入口，不是正式运行时或所有厂商客户端认证。测试只使用自己创建的临时目录、无害Node启动器和独立HTTP夹具，不访问17653用户连接器、不发送模型请求或业务指令。

## 基线 → 可搬迁版本

旧技能基线由独立Agent应用测试确认`portablePass:false`：目录只有SKILL.md，缺少协议、publish/start脚本，并约定从技能目录向上寻找工程目录，因此复制到另一台无源码的机器后从status即阻断。其“无applied不宣称展示、不能借用其他会话、generic不提供厂商原生双向”安全边界正确，新版保留。

新版将入口、协议、命令目录、轻量客户端及演示生成器一同分发；运行时由独立产品配置提供。根目录manifest只允许复制8份技能文件，不包含凭据、服务、依赖、历史会话或项目状态。

新版应用测试由另一个仅可读取技能目录的Agent完成，`portablePass:true`：能运行无配置help/commands，status准确返回CONFIG_REQUIRED；正确给出新安装位置下的status/doctor/publish/receipt命令，拒绝无applied时的换会话/切generic/伪称展示，明确Codex仅有条件的generic发布能力。所有本地链接存在。其指出安装器不在已安装技能内：这是分发层入口，由外层包或CLI提供，不能编造bridge的--target参数；使用时需区分安装命令与协作客户端命令。

## 失败回归与修复

- 新增安装/配置/HTTP/搬迁测试，首先观察缺少分发包与脚本导致失败，再实现。
- 搬迁测试发现macOS的`/var`与`/private/var`规范路径差异使ESM入口检查失效、程序无输出；以realpath核对入口后修复。测试先搬走整个分发包，在另一目录安装，删除临时分发源后直接运行已安装客户端commands，验证不依赖源码。
- 追加HTTP重定向测试先复现发布被重定向，随后禁止health/publish重定向，确保私有发布key不跟随302到其他目标。
- 演示仅生成新目录中的独立唯一ID事件，覆盖15类指令；所有事件由现有投影模型验证，最终三个成果ready，无网络请求。
- 独立审查复现3项MEDIUM后，主会话新增3条回归先确认全失败：祖先路径链接绕行、启动HTTP探测跟随302、HTTP中断被当空闲执行launcher。随后修复为完整祖先链/目标真实边界检查，以及固定loopback单端口TCP探测（只ECONNREFUSED允许启动，其他结果阻断），三项及全套测试通过。macOS系统规范别名单独核验允许，任意用户链接仍拒绝。

## 已执行命令

在宿主目录执行：

```sh
npm run test:agent:skills
npm run test:agent
npm test
sh -n agent-connector/skills/install.sh
sh agent-connector/skills/install.sh --agent opencode --scope project --project <独立临时目标> --dry-run
```

首次全绿：技能13/13、既有Agent101/101、宿主56/56。测试覆盖：dry-run零写入、项目/用户目录、未知端显式target、已安装技能自包含、同内容no-op、拒绝冲突和符号链接、无额外Agent配置写入、安全运行文件权限、loopback、过期实例、明确session、禁止在连接配置存key、真实HTTP发布/回执、generic控制拒绝及显式产品启动参数。

补齐文档自包含链接和三项审查回归后，技能最终测试为17/17。额外离线检查8份payload、全部本地文档链接及5份JS/MJS语法；`git diff --check`通过。Agent应用测试已确认新包可搬迁，但这不是各厂商UI或Windows实机验收。

独立审查者已复核3项MEDIUM全部关闭，并再次运行指定测试17/17通过；三项无明确遗留缺口。验证未访问实际运行端口或用户全局安装位置。

## 边界

- 实际安装只发生在临时测试目录；用户真实Agent目录、全局配置、CLI源码与运行服务均未改动。
- PowerShell入口提供但未在Windows实机执行；Windows ACL和各厂商真实技能发现/会话交互需目标环境单独验收。Codex官方网页本次403、TRAE网页超时，兼容表如实标注，不把目录复制当成客户端认可或原生控制。
- 上一轮网页无applied回执的问题仍独立存在；本轮不靠另开浏览器回执或测试HTTP回执冒充其修复。
- 当前连接器运行时仍有既有部署/工作区约定，需要产品化时单独改造；本包仅移除技能对开发目录的依赖，未把运行时复制进技能。
- 未提交、推送、修改PRD或钉钉文档。

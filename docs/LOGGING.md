# 运行日志

从 npm 0.4.0 起提供逐行 JSON 日志。执行新版连接请求会升级已有后台服务并加载日志功能。

## 文件位置

- npm / headless 后台：`~/.kuaimai-agent/code/instances/<网站标识>/service.log`。运行 `node headless.mjs status --origin <网页来源>`，查看返回的 `logging.path`。
- 直接 CLI / 技能启动器：项目 `.runtime/connector.log`，指定其他首选端口时为 `.runtime/connector-<首选端口>.log`。
- macOS App 宿主：应用运行目录下的 `service.log`。

例如本地开发环境：

```sh
tail -f ~/.kuaimai-agent/code/instances/351fe5bd4282ac2f/service.log
```

`time` 是 UTC ISO 时间，`pid`、`version` 标识运行进程；请求和连接另带 `instanceId`。HTTP 响应头 `X-Km-Request-Id` 与日志的 `requestId` 对应，可用于定位一次请求。

## 记录内容

| 事件 | 诊断信息 |
| --- | --- |
| `service.launching` / `service.starting` / `service.started` | 启动、首选端口、实际端口和实例标识 |
| `service.stopping` / `service.stopped` / `service.signal` | 正常退出或停止信号 |
| `web.authorized` / `control.request` | 本机接入授权及控制操作耗时 |
| `client.connected` / `client.disconnected` | 网页授权建立、主动断开、授权过期、重连替换或服务停止 |
| `stream.opened` / `stream.closed` | SSE 消息流建立、关闭及连接持续时间；关页或网络断开不等于撤销授权 |
| `http.request` | 方法、已知接口路径、状态码、毫秒耗时、完成/中断、关联客户端编号 |
| `agent.health_failed` / `agent.sessions_failed` | 原生 Agent 健康检查或会话读取异常 |
| `service.start_failed` / `service.launch_failed` / `service.stop_failed` / `process.uncaught_exception` | 生命周期错误、进程启动退出码或未捕获异常 |

HTTP 请求仅在完成或中断时记录一次；SSE 的请求耗时是整个流的持续时间。4xx 和中断为 `warn`，5xx 为 `error`，正常请求为 `info`。错误诊断保留错误类型、已知系统错误码和源码位置，原始异常消息不写入日志，避免上游异常夹带对话或凭据。

不记录请求体、回复正文、prompt、页面上下文、附件、请求头、授权 token、配对码或 URL 查询参数。未知路径记为 `/unknown`，非受信来源不写入其原始值。日志客户端编号是单独生成的 UUID，不是访问令牌。

## 轮转与故障处理

- 当前文件上限默认 **5 MiB**，保留 **5 份**历史文件：`.1` 最新，`.5` 最旧，超过数量自动删除最旧文件。
- 当前文件加历史文件最多约 **30 MiB**。按大小轮转，不按天数保留；已有超大日志轮转时仅保留最后至多 5 MiB。
- 轮转采用复制后截断，`tail -f` 能继续跟踪当前文件。日志和归档权限为 `0600`，拒绝日志软链接和硬链接。
- 日志同步写入，无无界内存队列。写入或轮转失败不会中断 HTTP 请求；后台 `status.logging.writeFailures` 和 `lastError` 可用于发现磁盘满、权限问题等。
- 后台进程直接写结构化日志，不把原始 stdout/stderr 追加到日志中。未捕获异常只记录脱敏诊断，不改变 Node 的退出行为。启动代码尚未加载就退出时，启动器记录 `service.launch_failed` 和退出码。

日志仍含网站域名、进程和接口信息，对外分享前应检查内容；不要同时分享运行目录中的 `connector.json`，它包含本机授权信息。

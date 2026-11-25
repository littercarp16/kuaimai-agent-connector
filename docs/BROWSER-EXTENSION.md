# HTTP 页面本机扩展通道

连接器 0.3.2 / 测试扩展 0.1.0。支持的精确来源：`http://lt.com:8085`、`http://local.lt.com:8251`。正式、灰度 HTTPS 页面继续使用已有直连 SDK。

## 用户流程

网页复制请求 → Agent 从 npm 安装并执行 `connect` → 后台连接器启动，同时为当前用户注册 Chrome/Edge 本机消息通道。命令返回扩展目录 `~/.kuaimai-agent/code/browser/extension`。

首次由用户在浏览器扩展管理页加载该目录，刷新原网页。待接入请求自生成起 10 小时内有效，扩展安装期间刷新无需重新复制。此后选择 ChatGPT / Codex 即在原页面恢复连接、加载最近 10 条会话；明确选择会话后才绑定和发送消息。扩展本身不持久保存凭据或会话。

测试包通过 `npm run build:extension` 生成 ZIP。尚未上架扩展商店，不能承诺客户静默安装。Chrome 验收通过；Edge 使用对应注册路径，尚需单独浏览器验收。0.9.0 已支持在 Windows 当前用户的注册表中注册 Chrome 和 Edge 本机通道，Windows 浏览器端到端验收待完成。

## 本机通信链路

```text
绫通 HTTP 原页面
  ↕ MessageChannel（当前顶层页面）
扩展 content script → service worker
  ↕ Chrome Native Messaging（操作系统 stdio）
Node 本机消息进程
  ↕ http://127.0.0.1:17653–17684 / JSON + SSE
连接器后台服务
  ↕ 原有 Agent 适配器
ChatGPT / Codex 共享 app-server
```

此处 stdio 是浏览器与本机辅助进程的标准通信协议，与 Codex 桌面端的 app-server 通信模式无关。没有外网消息中继、局域网监听、网页弹窗、隐藏 iframe 或关闭浏览器安全检查。

HTTP 页面自身对 loopback 的访问行为会受浏览器版本、策略和网络地址空间影响。本方案不依赖该能力：两个指定 HTTP 来源使用扩展，本机消息进程执行限定的 HTTP/SSE 请求，网站 CSP 无需开放 loopback。

## 权限和生命周期

- 扩展只有 `nativeMessaging` 权限；content script 限定两个域名，并再次校验完整 Origin。后台从 Chrome 提供的顶层 `sender.url` 读取来源，不采信网页声明的来源。
- 固定扩展 ID 与本机 `allowed_origins` 匹配。商店分发前必须校验商店 ID，不能直接承诺测试包的 ID 会被商店沿用。
- 本机进程只允许固定 loopback 端口范围、接口和 GET/POST。禁止重定向、任意 URL、Cookie、Origin 伪造及 publisher/local 接口；发送授权凭据前验证端口的连接器发现协议。
- 现有 PKCE、Origin、实例校验及 8 小时本页恢复授权保持不变；扩展不会自动配对、授予会话控制或越过 Agent 工具审批。
- 每个页面独立 native port。消息按 48 KiB 分块、读取确认限流；取消、关页和刷新清理本页请求与客户端，不停止 Agent 任务。HTTP 写入失败不自动重发。
- 扩展不是 HTTP 页面的加密升级；网页仍按原 HTTP 方式加载。通信内容不经中继，仅说明新增传输链路在本机，不能替代网页本身的内容完整性保护。

实现依据：[Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)、[扩展消息通信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)。

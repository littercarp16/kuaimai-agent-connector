# Windows 真机验收

日常接入请使用绫通网页复制的 npm 连接请求，并确认其连接器版本为 0.9.0 或更高。以下 ZIP 流程供开发和真机验收使用。包内带有连接器和 JavaScript 依赖。请使用安装三个 Agent 的同一 Windows 用户，将 ZIP **全部解压**到本机用户目录，测试期间保留解压目录。

## 验收记录

2026 年 11 月 25 日，Windows 11 测试机运行 `Check.cmd`，5 项全部通过，0 项跳过。已确认桥接后台可以启动、复用同一进程，并通过本机认证通道正常停止。Windows 11 已列为桥接服务可运行的平台。

Codex、千问办公和 WorkBuddy CLI 在 Windows 11 上的网页新建会话、绑定和收发消息仍待真机验收。Windows 10 也待真机验证。

## 开始前

- 在 Windows 终端运行 `node -v`，确认是 v22 或更高版本。请使用 Windows 版 Node.js。
- Codex 使用 Windows 原生 CLI。运行 `codex --version`，并用 `codex login status` 检查登录状态。若只在 WSL 安装了 CLI，需要在 Windows 用户下另外配置原生 CLI。
- 千问办公需要支持本机 HTTP 接口的 Windows 桌面版。先保存正在进行的工作。若客户端已运行但未启用 HTTP，桥接会请求它退出，再带启用参数启动。若关闭窗口后千问仍驻留托盘，请在托盘中退出千问，再回绫通重试。
- WorkBuddy 使用桌面应用随附的 CLI。官方网页授权由用户在绫通会话流程中完成。

先双击 **Check.cmd**。它会检查本机控制通道、Codex 消息传输和独立测试进程的启动、复用、停止。Windows 上应显示 `fail 0` 和 `skipped 0`。自检结束后再测试真实会话。

## 首次连接和复测

1. 在这台电脑打开绫通自定义页面，选定 Agent 后点「复制连接请求」。保持原标签页打开。
2. 双击解压目录里的 **Connect.cmd**。它会从剪贴板读取该请求。核对站点和 Agent，输入 **Y** 并回车。后台启动后会显示 PID 和监听地址。测试包直接使用解压的版本。网页文案里的 npm 命令无需另外执行。
3. 回到原标签页。若使用 HTTP 开发站且网页提示缺少扩展，在 Chrome 或 Edge 的扩展管理页开启开发者模式，加载启动器输出的扩展目录，然后刷新原标签页。开发站的本机通道会在当前用户的 Chrome 和 Edge 下注册，注册指向解压目录内的程序。HTTPS 站点可直接连接。
4. 若 WorkBuddy 提示登录，点击「登录 WorkBuddy CLI」，在官方页面完成授权。以绫通显示「WorkBuddy CLI 已登录」作为就绪标志。
5. 选「新建会话」，确认进入协作，发送「请记住代号 WIN-731，只回复收到」。收到回复后重新打开会话选择框，再从已有会话中选回刚才的一条，发送「刚才的代号是什么？」。应返回 `WIN-731`。分别对 Codex、千问办公、WorkBuddy CLI 重复验证。自定义页面若已连接，可直接切换 Agent；需要重新授权时从第 1 步开始。
6. 测完双击 **Stop.cmd** 关闭测试后台。实例和服务日志位于 `%USERPROFILE%\.kuaimai-agent\windows-test\instance\`。反馈失败时请提供 Agent 名称、卡住的步骤和错误文字。

若软件不在默认位置，可在 PowerShell 指定以下变量，然后从**同一窗口**运行 `.\Connect.cmd`。后台已启动时先运行 `.\Stop.cmd`，再用新设置启动。请使用当前用户目录或 Program Files 下的实际安装路径。

| 环境变量 | 指向的位置 |
| --- | --- |
| `KM_AGENT_CODEX_EXE` | 原生 `codex.exe` 文件 |
| `KM_AGENT_QWEN_EXE` | 千问办公主程序的 exe 文件 |
| `KM_AGENT_QWEN_CONTROL_DIR` | 千问实际使用的 `cli-control` 目录 |
| `KM_AGENT_WORKBUDDY_DIR` | WorkBuddy 安装目录，内含 `resources` |

开发者可在装好锁定依赖的 macOS 构建机运行 `python3 desktop/build-windows-test.py` 重新生成本地 ZIP。

import AppKit
import ServiceManagement
import Foundation

struct Settings: Codable {
    var origins: [String] = []
    var loginEnabled: Bool = false
    var serviceEnabled: Bool = true
}

final class ConnectorApp: NSObject, NSApplicationDelegate {
    var item: NSStatusItem!
    var window: NSWindow!
    var statusLabel = NSTextField(labelWithString: "正在启动…")
    var endpointLabel = NSTextField(labelWithString: "")
    var sessionsLabel = NSTextField(wrappingLabelWithString: "在网页选择 Agent，即可获取最近 10 条会话")
    var loginLabel = NSTextField(wrappingLabelWithString: "")
    var pairingLabel = NSTextField(labelWithString: "")
    var toggleButton = NSButton(title: "启动桥接", target: nil, action: nil)
    var worker: Process?
    var input: FileHandle?
    var output: FileHandle?
    var outputBuffer = Data()
    var callbacks: [String: ([String: Any]?, String?) -> Void] = [:]
    var readyActions: [() -> Void] = []
    var isReady = false
    var quitting = false
    var consentShowing = false
    var urlQueue: [URL] = []
    var lastStatus: [String: Any] = [:]
    var settings = Settings()
    var restartCount = 0
    var lastRestart = Date.distantPast
    var loginError: String?
    let dataDirectory: URL = {
        if let custom = ProcessInfo.processInfo.environment["KM_AGENT_APP_DATA_DIR"], custom.hasPrefix("/") { return URL(fileURLWithPath: custom, isDirectory: true) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Kuaimai Agent Connector", isDirectory: true)
    }()
    var settingsFile: URL { dataDirectory.appendingPathComponent("settings.json") }
    var isRunning: Bool { lastStatus["state"] as? String == "running" }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        let firstLaunch = !FileManager.default.fileExists(atPath: settingsFile.path)
        do {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            if let data = try? Data(contentsOf: settingsFile) { settings = try JSONDecoder().decode(Settings.self, from: data) }
            else if let file = Bundle.main.url(forResource: "origins", withExtension: "json"),
                let object = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any] {
                settings.origins = object["origins"] as? [String] ?? []
            }
            try saveSettings()
        } catch { alert("配置读取失败", error.localizedDescription) }
        buildWindow(); buildMenu(); updateLoginRegistration(); launchWorker()
        if firstLaunch { showWindow(nil) }
    }

    func saveSettings() throws {
        let bytes = try JSONEncoder().encode(settings)
        try bytes.write(to: settingsFile, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: settingsFile.path)
    }

    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 540, height: 390), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "快麦 Agent 连接器"; window.isReleasedWhenClosed = false; window.center()
        let title = NSTextField(labelWithString: "让网页连接本机 Agent")
        title.font = .systemFont(ofSize: 22, weight: .semibold)
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        endpointLabel.font = .monospacedSystemFont(ofSize: 12, weight: .regular); endpointLabel.isSelectable = true
        sessionsLabel.font = .systemFont(ofSize: 12); sessionsLabel.textColor = .secondaryLabelColor; sessionsLabel.maximumNumberOfLines = 3
        loginLabel.font = .systemFont(ofSize: 12); loginLabel.textColor = .secondaryLabelColor
        pairingLabel.font = .monospacedSystemFont(ofSize: 15, weight: .medium); pairingLabel.isSelectable = true
        let originsButton = NSButton(title: "允许的网站…", target: self, action: #selector(editOrigins))
        toggleButton.target = self; toggleButton.action = #selector(toggleService); toggleButton.bezelStyle = .rounded
        let row = NSStackView(views: [toggleButton, originsButton]); row.orientation = .horizontal; row.spacing = 10
        let description = NSTextField(wrappingLabelWithString: "回到绫通网页选择 Agent 和会话。关闭此窗口后，连接器继续在菜单栏后台运行。")
        description.font = .systemFont(ofSize: 12); description.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [title, statusLabel, endpointLabel, sessionsLabel, pairingLabel, row, loginLabel, description])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 16; stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 28), stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -28), stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 28)])
        render()
    }

    func buildMenu() {
        if item == nil { item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength) }
        item.button?.image = NSImage(systemSymbolName: isRunning ? "link.circle.fill" : "link.circle", accessibilityDescription: "快麦 Agent 连接器")
        let menu = NSMenu()
        func add(_ title: String, _ action: Selector) -> NSMenuItem {
            let entry = NSMenuItem(title: title, action: action, keyEquivalent: ""); entry.target = self; menu.addItem(entry); return entry
        }
        _ = add("打开快麦连接器", #selector(showWindow(_:)))
        let state = NSMenuItem(title: isRunning ? "桥接运行中" : "桥接已停止", action: nil, keyEquivalent: ""); menu.addItem(state)
        menu.addItem(.separator())
        let login = add("登录时自动启动", #selector(toggleLogin)); login.state = settings.loginEnabled ? .on : .off
        _ = add("允许的网站…", #selector(editOrigins))
        _ = add(isRunning ? "停止桥接" : "启动桥接", #selector(toggleService))
        menu.addItem(.separator()); _ = add("退出连接器", #selector(quitApp)); item.menu = menu
    }

    func render() {
        guard window != nil else { return }
        statusLabel.stringValue = isRunning ? "● 本机桥接正在运行" : "本机桥接已停止"
        statusLabel.textColor = isRunning ? .systemGreen : .secondaryLabelColor
        endpointLabel.stringValue = lastStatus["endpoint"] as? String ?? ""
        sessionsLabel.stringValue = "会话由 Agent 提供 · 展示最近 10 条 · 无需选择项目目录"
        if let code = lastStatus["pairCode"] as? String { pairingLabel.stringValue = "手动配对码：\(code)（10 分钟有效）" } else { pairingLabel.stringValue = "" }
        toggleButton.title = isRunning ? "停止桥接" : "启动桥接"
        loginLabel.stringValue = loginDescription()
        buildMenu()
    }

    func loginDescription() -> String {
        if let error = loginError { return "登录启动设置未完成：" + error }
        switch SMAppService.mainApp.status {
        case .enabled: return "登录自启动：已启用"
        case .requiresApproval: return "登录自启动：请在系统设置 → 通用 → 登录项中允许"
        case .notRegistered: return settings.loginEnabled ? "登录自启动：尚未注册" : "登录自启动：已关闭"
        default: return "登录自启动：当前应用位置或签名不可用，请安装到“应用程序”"
        }
    }
    func updateLoginRegistration() {
        loginError = nil
        do {
            if settings.loginEnabled && [.notRegistered, .notFound].contains(SMAppService.mainApp.status) { try SMAppService.mainApp.register() }
            if !settings.loginEnabled && SMAppService.mainApp.status != .notRegistered { try SMAppService.mainApp.unregister() }
        } catch { loginError = error.localizedDescription }
    }
    @objc func toggleLogin() { settings.loginEnabled.toggle(); do { try saveSettings(); updateLoginRegistration(); render(); if SMAppService.mainApp.status == .requiresApproval { SMAppService.openSystemSettingsLoginItems() } } catch { alert("设置未保存", error.localizedDescription) } }
    @objc func showWindow(_ sender: Any?) { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); render() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(nil); return true }

    @objc func editOrigins() {
        if isRunning { alert("请先停止桥接", "更改网站白名单会使现有连接失效。请先停止桥接，再修改配置。"); return }
        let dialog = NSAlert(); dialog.messageText = "允许接入的网站"; dialog.informativeText = "每行一个完整来源，包含协议、域名和端口。正式网站使用 HTTPS。"; dialog.addButton(withTitle: "保存"); dialog.addButton(withTitle: "取消")
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 150)); scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds); text.isRichText = false; text.string = settings.origins.joined(separator: "\n"); scroll.documentView = text; dialog.accessoryView = scroll
        guard dialog.runModal() == .alertFirstButtonReturn else { return }
        let values = text.string.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !values.isEmpty && values.count <= 16 && Set(values).count == values.count && values.allSatisfy({ value in
            guard let u = URLComponents(string: value), let host = u.host, u.user == nil, u.password == nil, u.query == nil, u.fragment == nil, u.path.isEmpty else { return false }
            return u.scheme == "https" || (u.scheme == "http" && (["127.0.0.1", "localhost", "local.lt.com", "lt.com"].contains(host) || host.hasSuffix(".localhost")))
        }) else { alert("网站配置无效", "请使用完整且不重复的来源，例如 https://app.ltpass.com，末尾不要带路径或斜杠。"); return }
        settings.origins = values; do { try saveSettings(); render() } catch { alert("配置未保存", error.localizedDescription) }
    }

    func launchWorker() {
        guard !quitting else { return }
        isReady = false
        let process = Process(), stdinPipe = Pipe(), stdoutPipe = Pipe()
        guard let resources = Bundle.main.resourceURL else { return }
        process.executableURL = resources.appendingPathComponent("bin/node")
        process.arguments = [resources.appendingPathComponent("runtime/desktop/service.mjs").path]
        process.currentDirectoryURL = resources.appendingPathComponent("runtime")
        var environment = ProcessInfo.processInfo.environment
        environment["KM_AGENT_APP_DATA_DIR"] = dataDirectory.path
        environment["PATH"] = resources.appendingPathComponent("bin").path + ":" + FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path + ":/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = environment; process.standardInput = stdinPipe; process.standardOutput = stdoutPipe
        // Child diagnostic output stays local; credentials are never written to this log.
        let log = dataDirectory.appendingPathComponent("service.log")
        if (try? log.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0 > 1024 * 1024 { try? Data().write(to: log) }
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let errorHandle = try? FileHandle(forWritingTo: log); _ = try? errorHandle?.seekToEnd(); process.standardError = errorHandle ?? FileHandle.nullDevice
        input = stdinPipe.fileHandleForWriting; output = stdoutPipe.fileHandleForReading; outputBuffer = Data(); worker = process
        output?.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            if data.isEmpty { handle.readabilityHandler = nil; return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        process.terminationHandler = { [weak self] _ in DispatchQueue.main.async {
            guard let self = self else { return }
            self.isReady = false; self.lastStatus = [:]; self.render()
            for callback in self.callbacks.values { callback(nil, "本机服务已退出，请重新接入") }; self.callbacks.removeAll()
            guard !self.quitting else { return }
            if Date().timeIntervalSince(self.lastRestart) > 60 { self.restartCount = 0 }
            self.lastRestart = Date(); self.restartCount += 1
            if self.restartCount <= 3 { DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.launchWorker() } }
            else { self.alert("本机服务未能启动", "请检查本机日志，再重新打开连接器。") }
        } }
        do { try process.run() } catch { alert("无法启动后台服务", error.localizedDescription) }
    }

    func consume(_ data: Data) {
        outputBuffer.append(data)
        if outputBuffer.count > 1024 * 1024 { outputBuffer.removeAll(); return }
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = outputBuffer.prefix(upTo: newline); outputBuffer.removeSubrange(...newline)
            guard let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            if object["event"] as? String == "ready" {
                isReady = true
                if settings.serviceEnabled { startService() }
                let actions = readyActions; readyActions.removeAll(); actions.forEach { $0() }; processNextURL()
            } else if object["event"] as? String == "status", let value = object["data"] as? [String: Any] { lastStatus = value; render() }
            else if let id = object["id"] as? String, let callback = callbacks.removeValue(forKey: id) {
                callback(object["data"] as? [String: Any], object["ok"] as? Bool == true ? nil : object["error"] as? String ?? "本机操作未完成")
            }
        }
    }
    func command(_ action: String, fields: [String: Any] = [:], completion: @escaping ([String: Any]?, String?) -> Void) {
        guard isReady else { readyActions.append { self.command(action, fields: fields, completion: completion) }; return }
        let id = UUID().uuidString; var request = fields; request["id"] = id; request["action"] = action; callbacks[id] = completion
        do { var bytes = try JSONSerialization.data(withJSONObject: request); bytes.append(10); try input?.write(contentsOf: bytes) }
        catch { callbacks.removeValue(forKey: id); completion(nil, "本机服务通信失败") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { if let callback = self.callbacks.removeValue(forKey: id) { callback(nil, "本机操作超时，请核验状态后再试") } }
    }
    func startService(completion: (() -> Void)? = nil, onFailure: (() -> Void)? = nil) {
        settings.serviceEnabled = true; try? saveSettings()
        command("start", fields: ["config": ["origins": settings.origins]]) { status, error in
            if let error = error { self.alert("启动未完成", error); onFailure?(); return }
            if let status = status { self.lastStatus = status; self.render() }; completion?()
        }
    }
    @objc func toggleService() {
        if isRunning { settings.serviceEnabled = false; try? saveSettings(); command("stop") { _, error in if let error = error { self.alert("停止未完成", error) } } }
        else { startService() }
    }
    func application(_ application: NSApplication, open urls: [URL]) { urlQueue.append(contentsOf: urls.prefix(max(0, 8 - urlQueue.count))); processNextURL() }
    func processNextURL() {
        guard isReady && !consentShowing && !urlQueue.isEmpty else { return }
        consentShowing = true; let url = urlQueue.removeFirst()
        guard let origin = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "origin" })?.value, settings.origins.contains(origin) else {
            alert("网站尚未获准接入", "请在连接器的“允许的网站”中核对完整域名。此次请求未获授权。"); finishURL(); return
        }
        let inspect = {
            self.command("inspect-link", fields: ["url": url.absoluteString]) { request, error in
                guard let request = request, let id = request["id"] as? String, let origin = request["origin"] as? String, error == nil else { self.alert("接入未完成", error ?? "无效请求"); self.finishURL(); return }
                NSApp.activate(ignoringOtherApps: true)
                let dialog = NSAlert(); dialog.messageText = "允许这个网页连接本机 Agent？"
                dialog.informativeText = "网站：\(origin)\n\n连接后可选择本机 Agent 最近 10 条会话，无需配置项目目录。网页发送 prompt 仍需授权所选会话的控制。"
                dialog.addButton(withTitle: "允许此次接入"); dialog.addButton(withTitle: "取消")
                if dialog.runModal() != .alertFirstButtonReturn { self.command("deny", fields: ["requestId": id]) { _, _ in }; self.finishURL(); return }
                self.command("authorize", fields: ["requestId": id]) { result, error in
                    defer { self.finishURL() }
                    guard let result = result, error == nil else { self.alert("接入未完成", error ?? "本机授权失败"); return }
                    if result["transport"] as? String == "direct" { return }
                    guard let value = result["callbackURL"] as? String, let callback = URL(string: value) else { self.alert("接入未完成", "回调地址无效"); return }
                    self.openCallback(callback, browser: result["browser"] as? String ?? "default")
                }
            }
        }
        if isRunning { inspect() } else { startService(completion: inspect, onFailure: { self.finishURL() }) }
    }
    func finishURL() { consentShowing = false; processNextURL() }
    func openCallback(_ url: URL, browser: String) {
        let ids = ["chrome": "com.google.Chrome", "edge": "com.microsoft.edgemac", "firefox": "org.mozilla.firefox", "safari": "com.apple.Safari"]
        if let id = ids[browser], let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            NSWorkspace.shared.open([url], withApplicationAt: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
                if let error = error { DispatchQueue.main.async { self.alert("无法返回网页", error.localizedDescription) } }
            }
        } else { NSWorkspace.shared.open(url) }
    }
    func alert(_ title: String, _ detail: String) { NSApp.activate(ignoringOtherApps: true); let dialog = NSAlert(); dialog.messageText = title; dialog.informativeText = detail; dialog.runModal() }
    @objc func quitApp() { NSApp.terminate(nil) }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        if worker?.isRunning != true { return .terminateNow }
        command("stop") { _, _ in try? self.input?.close(); NSApp.reply(toApplicationShouldTerminate: true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) { if self.worker?.isRunning == true { self.worker?.terminate() }; NSApp.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

if CommandLine.arguments.contains("--version") { print("Kuaimai Agent Connector 0.2.2"); exit(0) }
if CommandLine.arguments.contains("--login-status") || CommandLine.arguments.contains("--unregister-login") {
    do {
        if CommandLine.arguments.contains("--unregister-login") && SMAppService.mainApp.status != .notRegistered { try SMAppService.mainApp.unregister() }
        let names: [SMAppService.Status: String] = [.notRegistered: "notRegistered", .enabled: "enabled", .requiresApproval: "requiresApproval", .notFound: "notFound"]
        print(names[SMAppService.mainApp.status] ?? "unknown"); exit(0)
    } catch { fputs(error.localizedDescription + "\n", stderr); exit(1) }
}
let application = NSApplication.shared
let delegate = ConnectorApp()
application.delegate = delegate
application.run()

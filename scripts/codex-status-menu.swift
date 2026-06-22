import AppKit
import Foundation
import Darwin

struct WindowState: Codable {
  let remainingPercent: Int
  let reset: String
}

struct StatusState: Codable {
  let state: String
  let count: Int?
  let label: String?
}

struct SessionItem: Codable {
  let state: String
  let label: String
  let title: String
  let meta: String
}

struct SessionCounts: Codable {
  let work: Int
  let check: Int
  let idle: Int
  let error: Int?
  let items: [SessionItem]?
}

struct TransportState: Codable {
  let mode: String?
  let state: String?
  let target: String?
  let detail: String?
}

struct EnhancementSummary: Codable {
  let summary: String?
}

struct MenuEnhancements: Codable {
  let plan: EnhancementSummary?
  let activity: EnhancementSummary?
  let token: EnhancementSummary?
  let health: EnhancementSummary?
  let goal: EnhancementSummary?
  let account: EnhancementSummary?
  let schedule: EnhancementSummary?
  let larkAuth: EnhancementSummary?
}

struct LarkAuthStartResponse: Codable {
  let device_code: String?
  let verification_url: String?
  let verification_uri: String?
}

struct MenuSnapshot: Codable {
  let v: Int
  let clientSessionId: String?
  let ts: Int
  let short: WindowState?
  let long: WindowState?
  let status: StatusState
  let sessions: SessionCounts?
  let homeHint: String?
  let enhancements: MenuEnhancements?
  let limited: Bool?
  let error: String?
  let transport: TransportState?
}

struct MenuConfig: Codable {
  let intervalMs: Int?
  let transport: String?
}

struct MenuOptions {
  var nodePath: String
  var bridgeScriptPath: String
  var serialPort: String
  var baudRate: Int
  var transport: String
  var bleDeviceId: String
  var bleName: String
  var bleServiceUuid: String
  var bleWriteCharUuid: String
  var intervalMs: Int
  var stateFilePath: String
  var configFilePath: String
  var sessionId: String
}

let minIntervalMs = 5_000
let maxIntervalMs = 60_000
let intervalStepMs = 5_000
let defaultTransport = "ble"
let defaultBleServiceUuid = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
let defaultBleWriteCharUuid = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
let launchAgentServiceName = "com.codex.weixue.bridge"
let larkCalendarScope = "calendar:calendar.event:read"

func isExecutableFile(_ path: String) -> Bool {
  var isDirectory: ObjCBool = false
  return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) &&
    !isDirectory.boolValue &&
    FileManager.default.isExecutableFile(atPath: path)
}

func bundleResourceURL() -> URL {
  if let resourceURL = Bundle.main.resourceURL, FileManager.default.fileExists(atPath: resourceURL.path) {
    return resourceURL
  }

  let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
  let appLikeResourceCandidate = scriptDir.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Resources")
  if FileManager.default.fileExists(atPath: appLikeResourceCandidate.path) {
    return appLikeResourceCandidate
  }
  return scriptDir
}

func resolveDefaultNodePath(resourcesDirectory: URL) -> String {
  let envNodePath = ProcessInfo.processInfo.environment["CODEX_NODE_BIN"]
  let candidateNodePaths = [
    envNodePath,
    resourcesDirectory.appendingPathComponent("node/bin/node").path,
    "/usr/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/bin/node",
  ].compactMap { $0 }

  for path in candidateNodePaths where isExecutableFile(path) {
    return path
  }

  return "/usr/bin/node"
}

func resolveDefaultBridgeScriptPath(resourcesDirectory: URL, scriptDirectory: URL) -> String {
  let bundledPath = resourcesDirectory.appendingPathComponent("codex-usage-bridge.js").path
  if FileManager.default.fileExists(atPath: bundledPath) {
    return bundledPath
  }

  let inlinePath = scriptDirectory.appendingPathComponent("codex-usage-bridge.js").path
  return inlinePath
}

final class MenuController: NSObject, NSApplicationDelegate {
  private var options: MenuOptions
  private var bridgeProcess: Process?
  private var statusTimer: Timer?
  private var isQuitting = false
  private var isRestarting = false
  private var bridgeRestartFailCount = 0
  private var bridgeRestartWorkItem: DispatchWorkItem?

  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private let menu = NSMenu()
  private let stateItem = NSMenuItem(title: "状态：加载中", action: nil, keyEquivalent: "")
  private let shortItem = NSMenuItem(title: "5小时窗口：--", action: nil, keyEquivalent: "")
  private let longItem = NSMenuItem(title: "本周窗口：--", action: nil, keyEquivalent: "")
  private let sessionItem = NSMenuItem(title: "会话：运行 0  待检 0  空闲 0", action: nil, keyEquivalent: "")
  private let activeSessionItem = NSMenuItem(title: "当前会话：--", action: nil, keyEquivalent: "")
  private let homeHintItem = NSMenuItem(title: "首页：--", action: nil, keyEquivalent: "")
  private let planItem = NSMenuItem(title: "计划：--", action: nil, keyEquivalent: "")
  private let activityItem = NSMenuItem(title: "正在做：--", action: nil, keyEquivalent: "")
  private let tokenItem = NSMenuItem(title: "Token：--", action: nil, keyEquivalent: "")
  private let healthItem = NSMenuItem(title: "健康：--", action: nil, keyEquivalent: "")
  private let goalItem = NSMenuItem(title: "目标：--", action: nil, keyEquivalent: "")
  private let accountItem = NSMenuItem(title: "账号：--", action: nil, keyEquivalent: "")
  private let scheduleItem = NSMenuItem(title: "日程：--", action: nil, keyEquivalent: "")
  private let larkAuthItem = NSMenuItem(title: "飞书授权：--", action: nil, keyEquivalent: "")
  private let transportStatusItem = NSMenuItem(title: "通信：初始化", action: nil, keyEquivalent: "")
  private let resetHintItem = NSMenuItem(title: "刷新频率：15秒", action: nil, keyEquivalent: "")
  private let intervalItem = NSMenuItem(title: "上报间隔", action: nil, keyEquivalent: "")
  private let intervalSubmenu = NSMenu()
  private let transportModeItem = NSMenuItem(title: "通信方式", action: nil, keyEquivalent: "")
  private let transportModeSubmenu = NSMenu()
  private let transportSerialItem = NSMenuItem(title: "串口", action: #selector(selectTransport(_:)), keyEquivalent: "")
  private let transportBleItem = NSMenuItem(title: "蓝牙", action: #selector(selectTransport(_:)), keyEquivalent: "")
  private let reauthorizeLarkItem = NSMenuItem(title: "重新授权飞书日历", action: #selector(reauthorizeLarkCalendar(_:)), keyEquivalent: "a")
  private let restartItem = NSMenuItem(title: "重启", action: #selector(restartApp(_:)), keyEquivalent: "r")

  init(options: MenuOptions) {
    self.options = options
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    statusItem.button?.title = "Codex"
    statusItem.button?.toolTip = "Codex 状态"

    menu.removeAllItems()
    menu.addItem(NSMenuItem(title: "Codex 状态监控", action: nil, keyEquivalent: ""))
    menu.addItem(NSMenuItem.separator())
    intervalItem.submenu = intervalSubmenu
    buildIntervalMenu()
    menu.addItem(intervalItem)

    transportModeItem.submenu = transportModeSubmenu
    buildTransportModeMenu()
    menu.addItem(transportModeItem)

    [stateItem, transportStatusItem, shortItem, longItem, sessionItem, activeSessionItem, homeHintItem, scheduleItem, larkAuthItem, planItem, activityItem, tokenItem, healthItem, goalItem, accountItem, resetHintItem].forEach { item in
      item.isEnabled = false
      menu.addItem(item)
    }

    menu.addItem(NSMenuItem.separator())
    menu.addItem(reauthorizeLarkItem)
    menu.addItem(restartItem)
    menu.addItem(NSMenuItem(title: "退出", action: #selector(quitApp(_:)), keyEquivalent: "q"))
    for item in menu.items where item.action != nil {
      item.target = self
    }
    statusItem.menu = menu

    startBridgeProcess()
    statusTimer = Timer.scheduledTimer(
      timeInterval: 1.2,
      target: self,
      selector: #selector(refreshFromStateFile),
      userInfo: nil,
      repeats: true,
    )
    statusTimer?.tolerance = 0.2
    refreshFromStateFile()
  }

  func applicationWillTerminate(_ notification: Notification) {
    isQuitting = true
    statusTimer?.invalidate()
    statusTimer = nil
    stopBridgeProcess()
  }

  @objc private func quitApp(_ sender: Any?) {
    isQuitting = true
    stopBridgeProcess()
    NSApp.terminate(sender)
  }

  @objc private func refreshFromStateFile() {
    guard FileManager.default.fileExists(atPath: options.stateFilePath) else {
      updateFrom(snapshot: nil)
      return
    }

    guard let content = try? String(contentsOfFile: options.stateFilePath, encoding: .utf8),
          let lastLine = content.split(whereSeparator: \.isNewline).last,
          let data = lastLine.data(using: .utf8),
          let snapshot = try? JSONDecoder().decode(MenuSnapshot.self, from: data) else {
      return
    }

    updateFrom(snapshot: snapshot)
  }

  private func log(_ message: String) {
    print("[menu] \(message)")
  }

  private func bridgeRestartDelay() -> TimeInterval {
    let exponent = max(0, min(5, bridgeRestartFailCount - 1))
    let delay = Double(2 * (1 << exponent))
    return min(30, delay)
  }

  @objc private func selectInterval(_ sender: NSMenuItem) {
    let intervalMs = sender.tag * 1000
    guard intervalMs >= minIntervalMs, intervalMs <= maxIntervalMs else {
      return
    }
    guard intervalMs != options.intervalMs else { return }

    options.intervalMs = intervalMs
    persistMenuConfig(options.configFilePath, intervalMs: normalizeIntervalMs(intervalMs), transport: options.transport)
    buildIntervalMenu()
    restartBridgeProcess()
  }

  @objc private func selectTransport(_ sender: NSMenuItem) {
    let transport = sender.tag == 1 ? "ble" : "serial"
    guard transport != options.transport else { return }

    options.transport = transport
    persistMenuConfig(options.configFilePath, intervalMs: options.intervalMs, transport: options.transport)
    buildTransportModeMenu()
    restartBridgeProcess()
  }

  @objc private func restartBridge(_ sender: Any?) {
    restartBridgeProcess()
  }

  private func restartBridgeProcess() {
    guard !isRestarting else { return }
    isRestarting = true
    options.sessionId = UUID().uuidString
    stopBridgeProcess()
    bridgeRestartFailCount = 0
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
      guard let self else { return }
      self.startBridgeProcess()
      self.isRestarting = false
    }
  }

  @objc private func restartApp(_ sender: Any?) {
    guard !isRestarting else { return }
    isRestarting = true
    isQuitting = true

    stopBridgeProcess()
    statusTimer?.invalidate()
    statusTimer = nil

    if isLaunchAgentManaged() {
      log("通过 LaunchAgent 重启菜单栏应用")
      fflush(stdout)
      kill(getpid(), SIGKILL)
      exit(1)
    }

    if restartManualApp() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
        exit(0)
      }
      return
    }

    isQuitting = false
    isRestarting = false
    startBridgeProcess()
  }

  private func isLaunchAgentManaged() -> Bool {
    let serviceName = ProcessInfo.processInfo.environment["XPC_SERVICE_NAME"] ?? ""
    return serviceName == launchAgentServiceName
  }

  private func appBundlePath() -> String? {
    let bundleURL = Bundle.main.bundleURL.standardized
    if bundleURL.pathExtension == "app", FileManager.default.fileExists(atPath: bundleURL.path) {
      return bundleURL.path
    }

    let executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[0]).standardized
    let contentsURL = executableURL.deletingLastPathComponent().deletingLastPathComponent()
    let appURL = contentsURL.deletingLastPathComponent()
    if contentsURL.lastPathComponent == "Contents",
       appURL.pathExtension == "app",
       FileManager.default.fileExists(atPath: appURL.path) {
      return appURL.path
    }

    return nil
  }

  private func restartManualApp() -> Bool {
    guard let bundlePath = appBundlePath() else {
      log("无法定位 App bundle，重启取消")
      return false
    }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-n", bundlePath, "--args"] + buildRestartArguments()
    process.environment = ProcessInfo.processInfo.environment

    do {
      try process.run()
      return true
    } catch {
      log("通过 open 重启失败: \(error)")
      return false
    }
  }

  private func buildRestartArguments() -> [String] {
    var args = Array(ProcessInfo.processInfo.arguments.dropFirst())
    let normalizedInterval = String(options.intervalMs)
    if let intervalIndex = args.firstIndex(of: "--interval") {
      if intervalIndex + 1 < args.count {
        args[intervalIndex + 1] = normalizedInterval
      } else {
        args.append(normalizedInterval)
      }
    } else {
      args.append("--interval")
      args.append(normalizedInterval)
    }

    if let stateIndex = args.firstIndex(of: "--state-file"), stateIndex + 1 < args.count {
      args[stateIndex + 1] = options.stateFilePath
    }
    if let transportIndex = args.firstIndex(of: "--transport"), transportIndex + 1 < args.count {
      args[transportIndex + 1] = options.transport
    } else {
      args.append("--transport")
      args.append(options.transport)
    }

    return args
  }

  private func buildIntervalMenu() {
    intervalSubmenu.removeAllItems()
    let currentIntervalSeconds = max(
      minIntervalMs,
      min(maxIntervalMs, options.intervalMs),
    ) / 1000

    var seconds = minIntervalMs / 1000
    while seconds <= maxIntervalMs / 1000 {
      let item = NSMenuItem(
        title: "\(seconds) 秒",
        action: #selector(selectInterval(_:)),
        keyEquivalent: "",
      )
      item.target = self
      item.tag = seconds
      item.state = seconds == currentIntervalSeconds ? .on : .off
      intervalSubmenu.addItem(item)
      seconds += intervalStepMs / 1000
    }
  }

  private func buildTransportModeMenu() {
    transportModeSubmenu.removeAllItems()

    transportSerialItem.target = self
    transportSerialItem.tag = 0
    transportSerialItem.state = options.transport == "serial" ? .on : .off

    transportBleItem.target = self
    transportBleItem.tag = 1
    transportBleItem.state = options.transport == "ble" ? .on : .off

    transportModeSubmenu.addItem(transportSerialItem)
    transportModeSubmenu.addItem(transportBleItem)
  }

  private func statusTitle(_ status: StatusState, sessions: SessionCounts) -> String {
    if status.state == "working" {
      let runningCount = max(status.count ?? 0, sessions.work)
      return "运行中 \(runningCount)"
    }
    if status.state == "waiting" {
      let waitingCount = max(status.count ?? 0, sessions.check)
      let label = status.label ?? "待检"
      return waitingCount > 0 ? "\(label) \(waitingCount)" : label
    }
    if status.state == "error" {
      return "异常"
    }
    return "空闲"
  }

  private func statusBarTitle(_ status: String) -> String {
    if status == "运行中" || status.hasPrefix("运行中") { return status }
    if status == "异常" { return status }
    if status == "待检" || status.hasPrefix("需要") || status.hasPrefix("等待") { return status }
    return "空闲"
  }

  private func transportTitle(_ transport: TransportState?) -> String {
    let mode = transport?.mode == "ble" ? "蓝牙" : "串口";
    let rawState = transport?.state ?? "disconnected"
    let state: String
    switch rawState {
    case "connecting":
      state = "连接中"
    case "connected":
      state = "已连接"
    case "disconnected":
      state = "已断开"
    case "error":
      state = "异常"
    default:
      state = "未识别"
    }
    let target = transport?.target ?? ""
    if target.isEmpty {
      return "\(mode)\(state)"
    }
    return "\(mode)\(state)（\(target)）"
  }

  private func truncateText(_ value: String, _ maxLength: Int) -> String {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.count <= maxLength { return trimmed }
    let endIndex = trimmed.index(trimmed.startIndex, offsetBy: maxLength - 1)
    return "\(trimmed[..<endIndex])…"
  }

  private func activeSessionSummary(_ sessions: SessionCounts) -> String {
    if let active = sessions.items?.first(where: {
      let state = $0.state.lowercased()
      return state == "work" || state == "running"
    }) {
      let label = active.label.isEmpty ? "运行中" : active.label
      let title = truncateText(active.title, 22)
      let meta = truncateText(active.meta, 12)
      if meta.isEmpty {
        return "当前会话：\(label) \(title)"
      }
      return "当前会话：\(label) \(title) · \(meta)"
    }

    if sessions.work > 0 {
      return "当前会话：请查看详情"
    }
    return "当前会话：无"
  }

  private func formatBarUsage(_ snapshot: MenuSnapshot?) -> String {
    guard let shortPercent = snapshot?.short?.remainingPercent,
          let longPercent = snapshot?.long?.remainingPercent else {
      return "5h --% / 周 --%"
    }
    return "5h \(shortPercent)%  周 \(longPercent)%"
  }

  private func updateFrom(snapshot: MenuSnapshot?) {
    guard let snapshot else {
      setOfflineStatus()
      return
    }
    if let transportMode = snapshot.transport?.mode, transportMode != options.transport {
      return
    }

    let sessions = snapshot.sessions ?? SessionCounts(work: 0, check: 0, idle: 0, error: 0, items: nil)
    transportStatusItem.title = "通信：\(transportTitle(snapshot.transport))"
    let statusText = statusTitle(snapshot.status, sessions: sessions)
    statusItem.button?.title = "Codex \(formatBarUsage(snapshot))  \(statusBarTitle(statusText))"

    if let message = snapshot.error {
      stateItem.title = "状态：\(message)"
    } else {
      stateItem.title = "状态：\(statusText)"
    }

    if let shortReset = snapshot.short?.reset {
      shortItem.title = "5小时窗口：\(snapshot.short?.remainingPercent ?? 0)%（重置：\(shortReset)）"
    } else {
      shortItem.title = "5小时窗口：--"
    }

    if let longReset = snapshot.long?.reset {
      longItem.title = "本周窗口：\(snapshot.long?.remainingPercent ?? 0)%（重置：\(longReset)）"
    } else {
      longItem.title = "本周窗口：--"
    }

    let errorCount = sessions.error ?? 0
    sessionItem.title = "会话：运行 \(sessions.work)  待检 \(sessions.check)  空闲 \(sessions.idle)  异常 \(errorCount)"
    activeSessionItem.title = activeSessionSummary(sessions)
    homeHintItem.title = "首页：\(snapshot.homeHint ?? "--")"
    planItem.title = "计划：\(snapshot.enhancements?.plan?.summary ?? "--")"
    activityItem.title = "正在做：\(snapshot.enhancements?.activity?.summary ?? "--")"
    tokenItem.title = "Token：\(snapshot.enhancements?.token?.summary ?? "--")"
    healthItem.title = "健康：\(snapshot.enhancements?.health?.summary ?? "--")"
    goalItem.title = "目标：\(snapshot.enhancements?.goal?.summary ?? "--")"
    accountItem.title = "账号：\(snapshot.enhancements?.account?.summary ?? "--")"
    scheduleItem.title = "日程：\(snapshot.enhancements?.schedule?.summary ?? "--")"
    larkAuthItem.title = "飞书授权：\(snapshot.enhancements?.larkAuth?.summary ?? "--")"
    let intervalSeconds = max(minIntervalMs, options.intervalMs) / 1000
    resetHintItem.title = "刷新频率：\(intervalSeconds) 秒"
  }

  private func setOfflineStatus() {
    let transport = TransportState(mode: nil, state: "error", target: nil, detail: nil)
    transportStatusItem.title = "通信：\(transportTitle(transport))"
    stateItem.title = "状态：服务离线"
    shortItem.title = "5小时窗口：--"
    longItem.title = "本周窗口：--"
    sessionItem.title = "会话：运行 0  待检 0  空闲 0  异常 0"
    homeHintItem.title = "首页：--"
    planItem.title = "计划：--"
    activityItem.title = "正在做：--"
    tokenItem.title = "Token：--"
    healthItem.title = "健康：--"
    goalItem.title = "目标：--"
    accountItem.title = "账号：--"
    scheduleItem.title = "日程：--"
    larkAuthItem.title = "飞书授权：--"
    let intervalSeconds = max(minIntervalMs, options.intervalMs) / 1000
    resetHintItem.title = "刷新频率：\(intervalSeconds) 秒"
    activeSessionItem.title = "当前会话：--"
    statusItem.button?.title = "Codex"
  }

  private func bridgeWorkDirectory() -> URL {
    return URL(fileURLWithPath: options.stateFilePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
  }

  private func resolveLarkCliPath() -> String? {
    if let envPath = ProcessInfo.processInfo.environment["LARK_CLI_BIN"],
       isExecutableFile(envPath) {
      return envPath
    }

    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let candidates = [
      "/opt/homebrew/bin/lark-cli",
      "/usr/local/bin/lark-cli",
      "\(home)/.nvm/versions/node/v20.20.2/bin/lark-cli",
    ]
    return candidates.first(where: { isExecutableFile($0) })
  }

  private func runText(_ executable: String, _ arguments: [String], currentDirectoryURL: URL? = nil) throws -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    if let currentDirectoryURL {
      process.currentDirectoryURL = currentDirectoryURL
    }

    let outputPipe = Pipe()
    let errorPipe = Pipe()
    process.standardOutput = outputPipe
    process.standardError = errorPipe
    try process.run()
    process.waitUntilExit()

    let output = String(data: outputPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let error = String(data: errorPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let combined = output.isEmpty ? error : output
    if process.terminationStatus != 0 {
      throw NSError(
        domain: "LarkAuth",
        code: Int(process.terminationStatus),
        userInfo: [NSLocalizedDescriptionKey: combined.isEmpty ? "命令执行失败" : combined],
      )
    }
    return combined
  }

  private func decodeLarkAuthStart(_ output: String) throws -> LarkAuthStartResponse {
    let data = Data(output.utf8)
    return try JSONDecoder().decode(LarkAuthStartResponse.self, from: data)
  }

  @objc private func reauthorizeLarkCalendar(_ sender: Any?) {
    guard let larkCli = resolveLarkCliPath() else {
      larkAuthItem.title = "飞书授权：未找到 lark-cli"
      return
    }

    larkAuthItem.title = "飞书授权：生成授权链接..."
    reauthorizeLarkItem.isEnabled = false
    reauthorizeLarkItem.title = "飞书授权中..."

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self else { return }
      do {
        let startOutput = try self.runText(larkCli, [
          "auth",
          "login",
          "--scope",
          larkCalendarScope,
          "--no-wait",
          "--json",
        ])
        let startResponse = try self.decodeLarkAuthStart(startOutput)
        guard let deviceCode = startResponse.device_code else {
          throw NSError(
            domain: "LarkAuth",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "飞书授权未返回 device_code"],
          )
        }
        let verificationURLText = startResponse.verification_url
          ?? startResponse.verification_uri
          ?? ""
        guard !verificationURLText.isEmpty else {
          throw NSError(
            domain: "LarkAuth",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "飞书授权未返回 verification_url"],
          )
        }

        let stateDirectory = self.bridgeWorkDirectory().appendingPathComponent("state")
        try FileManager.default.createDirectory(at: stateDirectory, withIntermediateDirectories: true, attributes: nil)
        let qrFileName = "lark-calendar-auth.png"
        let qrURL = stateDirectory.appendingPathComponent(qrFileName)
        _ = try? self.runText(larkCli, [
          "auth",
          "qrcode",
          verificationURLText,
          "--output",
          qrFileName,
        ], currentDirectoryURL: stateDirectory)

        DispatchQueue.main.async {
          if let authURL = URL(string: verificationURLText) {
            NSWorkspace.shared.open(authURL)
          }
          if FileManager.default.fileExists(atPath: qrURL.path) {
            NSWorkspace.shared.open(qrURL)
          }
          self.larkAuthItem.title = "飞书授权：等待确认"
        }

        _ = try self.runText(larkCli, [
          "auth",
          "login",
          "--device-code",
          deviceCode,
        ])

        DispatchQueue.main.async {
          self.larkAuthItem.title = "飞书授权：已授权"
          self.reauthorizeLarkItem.isEnabled = true
          self.reauthorizeLarkItem.title = "重新授权飞书日历"
          self.restartBridgeProcess()
        }
      } catch {
        DispatchQueue.main.async {
          self.larkAuthItem.title = "飞书授权：授权失败"
          self.reauthorizeLarkItem.isEnabled = true
          self.reauthorizeLarkItem.title = "重新授权飞书日历"
          self.log("飞书授权失败: \(error.localizedDescription)")
        }
      }
    }
  }

  private func startBridgeProcess() {
    log("准备启动 bridge 子进程: node=\(options.nodePath), script=\(options.bridgeScriptPath), interval=\(options.intervalMs)")
    stopBridgeProcess()
    let resourceURL = bundleResourceURL()
    let bridgeWorkDirectory = URL(fileURLWithPath: options.stateFilePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
    let runtimeBridgeScriptURL = bridgeWorkDirectory.appendingPathComponent("runtime/codex-usage-bridge.js")
    let bridgeScriptPath = FileManager.default.fileExists(atPath: runtimeBridgeScriptURL.path)
      ? runtimeBridgeScriptURL.path
      : options.bridgeScriptPath
    let process = Process()

    guard FileManager.default.isExecutableFile(atPath: options.nodePath) else {
      log("Node 可执行文件不可用: \(options.nodePath)")
      setOfflineStatus()
      return
    }
    guard FileManager.default.fileExists(atPath: bridgeScriptPath) else {
      log("bridge 脚本不存在: \(bridgeScriptPath)")
      setOfflineStatus()
      return
    }

    process.executableURL = URL(fileURLWithPath: options.nodePath)
    var arguments = [
      bridgeScriptPath,
      "--transport",
      options.transport,
      "--interval",
      String(options.intervalMs),
      "--state-file",
      options.stateFilePath,
      "--session-id",
      options.sessionId,
    ]

    if options.transport == "serial" {
      arguments.append(contentsOf: ["--port", options.serialPort, "--baud", String(options.baudRate)])
    } else {
      arguments.append(contentsOf: ["--ble-name", options.bleName])
      if !options.bleDeviceId.isEmpty { arguments.append(contentsOf: ["--ble-device-id", options.bleDeviceId]) }
      arguments.append(contentsOf: ["--ble-service-uuid", options.bleServiceUuid])
      arguments.append(contentsOf: ["--ble-write-char-uuid", options.bleWriteCharUuid])
    }

    process.arguments = arguments
    try? FileManager.default.createDirectory(at: bridgeWorkDirectory, withIntermediateDirectories: true, attributes: nil)
    process.currentDirectoryURL = bridgeWorkDirectory

    var processEnv = ProcessInfo.processInfo.environment
    let runtimeNodeModules = bridgeWorkDirectory.appendingPathComponent("runtime/node_modules").path
    var nodeModulePaths: [String] = []
    if FileManager.default.fileExists(atPath: runtimeNodeModules) {
      nodeModulePaths.append(runtimeNodeModules)
    } else {
      let bundledNodeModules = resourceURL.appendingPathComponent("node_modules").path
      if FileManager.default.fileExists(atPath: bundledNodeModules) {
        nodeModulePaths.append(bundledNodeModules)
      }
    }
    if !nodeModulePaths.isEmpty {
      let previousNodePath = processEnv["NODE_PATH"] ?? ""
      var allNodeModulePaths = nodeModulePaths
      if !previousNodePath.isEmpty {
        allNodeModulePaths.append(previousNodePath)
      }
      processEnv["NODE_PATH"] = allNodeModulePaths.joined(separator: ":")
    }
    process.environment = processEnv
    process.standardOutput = FileHandle.standardOutput
    process.standardError = FileHandle.standardError
    process.terminationHandler = { [weak self] terminatedProcess in
      guard let self else { return }
      DispatchQueue.main.async {
        guard !self.isQuitting && !self.isRestarting else { return }
        self.bridgeProcess = nil
        self.bridgeRestartFailCount += 1
        let reason = terminatedProcess.terminationReason == .uncaughtSignal ? "signal" : "exit"
        self.log("bridge 子进程退出: code=\(terminatedProcess.terminationStatus), reason=\(reason)")
        self.setOfflineStatus()
        let delay = Int(self.bridgeRestartDelay())
        self.log("bridge 子进程退出，\(delay) 秒后重试")
        self.bridgeRestartWorkItem?.cancel()
        let workItem = DispatchWorkItem { [weak self] in
          guard let self else { return }
          guard !self.isQuitting && !self.isRestarting else { return }
          self.startBridgeProcess()
        }
        self.bridgeRestartWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + self.bridgeRestartDelay(), execute: workItem)
      }
    }

    do {
      try process.run()
      log("bridge 子进程已启动: pid=\(process.processIdentifier)")
      bridgeRestartFailCount = 0
      bridgeProcess = process
    } catch {
      log("bridge 启动失败: \(error)")
      setOfflineStatus()
    }
  }

  private func stopBridgeProcess() {
    bridgeRestartWorkItem?.cancel()
    bridgeRestartWorkItem = nil
    guard let process = bridgeProcess else { return }
    if process.isRunning {
      process.terminate()
      let deadline = Date().addingTimeInterval(1.0)
      while process.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.05)
      }
      if process.isRunning {
        kill(process.processIdentifier, SIGKILL)
      }
    }
    bridgeProcess = nil
  }
}

func normalizeIntervalMs(_ intervalMs: Int) -> Int {
  if intervalMs < minIntervalMs { return minIntervalMs }
  if intervalMs > maxIntervalMs { return maxIntervalMs }
  let rounded = Int((Double(intervalMs) / Double(intervalStepMs)).rounded() * Double(intervalStepMs))
  return max(minIntervalMs, min(maxIntervalMs, rounded))
}

func printHelp() {
  print("""
Usage: codex-status-menu [options]

Options:
  --node <path>             Node executable path
  --bridge-script <path>    Bridge script path
  --transport <serial|ble>  Communication transport (default: ble)
  --ble-device-id <id>      BLE peripheral id/address (ble mode)
  --ble-name <name>         BLE advertised name (ble mode)
  --ble-service-uuid <uuid> BLE service UUID (ble mode)
  --ble-write-char-uuid <id>BLE write char UUID (ble mode)
  --port <path>             Serial port for the ESP32
  --baud <number>           Serial baud rate (default: 115200)
  --interval <ms>           Refresh interval for the bridge (5000~60000, step 5000, default: 15000)
  --config-file <path>       Menu config file path
  --state-file <path>       State file path used by the menu bar app
""")
}

func loadMenuConfig(from path: String) -> MenuConfig? {
  guard FileManager.default.fileExists(atPath: path) else { return nil }
  guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
    return nil
  }
  return try? JSONDecoder().decode(MenuConfig.self, from: data)
}

func loadMenuConfigInterval(from path: String) -> Int? {
  guard let config = loadMenuConfig(from: path) else { return nil }
  guard let intervalMs = config.intervalMs else { return nil }
  return normalizeIntervalMs(intervalMs)
}

func loadMenuConfigTransport(from path: String) -> String? {
  guard let config = loadMenuConfig(from: path) else { return nil }
  if config.transport == "ble" { return "ble" }
  if config.transport == "serial" { return "serial" }
  return nil
}

func persistMenuConfig(_ path: String, intervalMs: Int, transport: String) {
  let normalizedInterval = normalizeIntervalMs(intervalMs)
  let normalizedTransport = transport == "ble" ? "ble" : "serial"
  let directory = (path as NSString).deletingLastPathComponent
  try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true, attributes: nil)
  let config = MenuConfig(intervalMs: normalizedInterval, transport: normalizedTransport)
  guard let data = try? JSONEncoder().encode(config) else { return }
  try? data.write(to: URL(fileURLWithPath: path))
}

func parseMenuArguments() -> MenuOptions {
  let home = FileManager.default.homeDirectoryForCurrentUser.path
  let scriptDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
  let resourcesDirectory = bundleResourceURL()
  let defaultConfigPath = "\(home)/Library/Application Support/weixue-codex-bridge/config/codex-status-menu-config.json"
  let defaultNodePath = resolveDefaultNodePath(resourcesDirectory: resourcesDirectory)
  var configPath = defaultConfigPath
  let persistedInterval = loadMenuConfigInterval(from: configPath)
  let persistedTransport = loadMenuConfigTransport(from: configPath)
  let sessionId = UUID().uuidString

  var options = MenuOptions(
    nodePath: defaultNodePath,
    bridgeScriptPath: resolveDefaultBridgeScriptPath(
      resourcesDirectory: resourcesDirectory,
      scriptDirectory: scriptDir,
    ),
    serialPort: "/dev/cu.usbmodem1401",
    baudRate: 115200,
    transport: persistedTransport
      ?? ProcessInfo.processInfo.environment["CODEX_TRANSPORT"]
      ?? defaultTransport,
    bleDeviceId: ProcessInfo.processInfo.environment["CODEX_BLE_DEVICE_ID"] ?? "",
    bleName: ProcessInfo.processInfo.environment["CODEX_BLE_NAME"] ?? "CodexStatusDisplay",
    bleServiceUuid: ProcessInfo.processInfo.environment["CODEX_BLE_SERVICE_UUID"] ?? defaultBleServiceUuid,
    bleWriteCharUuid: ProcessInfo.processInfo.environment["CODEX_BLE_WRITE_CHAR_UUID"] ?? defaultBleWriteCharUuid,
    intervalMs: persistedInterval ?? 15000,
    stateFilePath: "\(home)/Library/Application Support/weixue-codex-bridge/state/codex-status-menu-state.json",
    configFilePath: configPath,
    sessionId: sessionId,
  )

  var i = 1
  while i < CommandLine.arguments.count {
    let arg = CommandLine.arguments[i]
    if arg == "--help" || arg == "-h" {
      printHelp()
      exit(0)
    }

    func nextArg() -> String {
      let value = (i + 1 < CommandLine.arguments.count) ? CommandLine.arguments[i + 1] : ""
      i += 1
      return value
    }

    switch arg {
    case "--node":
      options.nodePath = nextArg()
      i += 1
    case "--bridge-script":
      options.bridgeScriptPath = nextArg()
      i += 1
    case "--transport":
      let transport = nextArg()
      options.transport = transport == "ble" ? "ble" : "serial"
      i += 1
    case "--ble-device-id":
      options.bleDeviceId = nextArg()
      i += 1
    case "--ble-name":
      options.bleName = nextArg()
      i += 1
    case "--ble-service-uuid":
      options.bleServiceUuid = nextArg()
      i += 1
    case "--ble-write-char-uuid":
      options.bleWriteCharUuid = nextArg()
      i += 1
    case "--port":
      options.serialPort = nextArg()
      i += 1
    case "--baud":
      options.baudRate = Int(nextArg()) ?? 115200
      i += 1
    case "--interval":
      options.intervalMs = normalizeIntervalMs(Int(nextArg()) ?? 15000)
      i += 1
    case "--config-file":
      configPath = nextArg()
      if !configPath.isEmpty {
        options.configFilePath = configPath
      }
      if let loaded = loadMenuConfigInterval(from: options.configFilePath) {
        options.intervalMs = loaded
      }
      if let loadedTransport = loadMenuConfigTransport(from: options.configFilePath) {
        options.transport = loadedTransport
      }
      i += 1
    case "--state-file":
      options.stateFilePath = nextArg()
      i += 1
    default:
      print("Unknown argument: \(arg)")
      printHelp()
      exit(1)
    }
  }

  options.transport = options.transport == "ble" ? "ble" : "serial"
  return options
}

let options = parseMenuArguments()
let stateDir = (options.stateFilePath as NSString).deletingLastPathComponent
try? FileManager.default.createDirectory(atPath: stateDir, withIntermediateDirectories: true, attributes: nil)

let app = NSApplication.shared
let controller = MenuController(options: options)
app.delegate = controller
app.run()

# Codex Status Display for ESP32-S3 Touch LCD

一个给 Waveshare ESP32-S3-Touch-LCD-1.85 做的 Codex 状态小屏。它由三部分组成：

- ESP32-S3 圆形触摸屏固件，负责 UI、触摸交互、串口/BLE 接收。
- macOS 菜单栏 App，负责常驻、配置、重启、飞书授权和可视化状态。
- Node bridge，负责读取 Codex 本地 app-server、飞书日历，并把精简后的状态推到开发板。

当前主要服务个人工作流：抬眼看 Codex 用量、会话状态、飞书日程，以及设备/桥接健康状态。

## 功能

- Codex 5 小时窗口剩余百分比、本周剩余百分比。
- 圆形边缘进度条：显示 5 小时窗口用量；进度点显示 5 小时窗口剩余时间比例。
- 低余量告警：5 小时剩余小于 50% 显示黄色，小于 20% 显示红色。
- Codex 当前状态：空闲、运行中、待确认、异常、离线。
- 会话页：展示运行中、待检、空闲会话，以及标题和项目名。
- 飞书日程页：展示当前日程、15 分钟内即将开始的日程、后续日程和次日数量。
- 健康页：展示账号、app-server、串口/BLE、飞书授权等诊断状态。
- 触摸交互：
  - 首页点按：进入飞书日程页。
  - 详情页点按：飞书日程 -> 会话 -> 健康 -> 首页。
  - 左滑：直接进入飞书日程页。
  - 右滑：从详情页返回首页。
  - 飞书日程页上下滑：滚动日程列表。
- 300 秒无更新自动息屏；收到新数据或触摸后唤醒。
- macOS 菜单栏常驻、退出、重启、上报间隔配置和日志自清理。
- 通信优先串口，支持 BLE 作为备用通道。

## 硬件

- Waveshare ESP32-S3-Touch-LCD-1.85
- USB-C 数据线
- macOS 主机

板卡资料见 Waveshare 文档：

```text
https://docs.waveshare.net/ESP32-S3-Touch-LCD-1.85
```

## 目录

```text
Firmware/CodexStatusDisplay/   ESP32-S3 固件和 LVGL UI
scripts/codex-usage-bridge.js  Codex/飞书 -> 设备的桥接服务
scripts/codex-status-menu.swift macOS 菜单栏 App 源码
scripts/run-codex-status-menu.sh 菜单栏启动脚本和日志清理
scripts/package-menubar-app.sh  打包 CodexStatusMenu.app
scripts/generate-codex-cjk-font.js 生成中文子集字体
src/usage-format.js            状态摘要、页面线和设备载荷格式化
tests/usage-format.test.js     Node 测试和固件源码断言
launchd/                       macOS LaunchAgent 示例
```

## 依赖

### macOS

- Node.js 20+
- npm
- Swift compiler / Xcode Command Line Tools
- Arduino CLI
- Codex 桌面 App 或可用的 `codex app-server --stdio`
- 可选：`lark-cli`，用于读取飞书日历

安装 Node 依赖：

```sh
npm install
```

安装 ESP32 Arduino core：

```sh
arduino-cli core update-index
arduino-cli core install esp32:esp32
```

准备 LVGL 8.3.10：

```sh
mkdir -p third_party
git clone --depth 1 --branch v8.3.10 https://github.com/lvgl/lvgl.git third_party/lvgl
```

`third_party/lvgl` 默认不进 Git，避免把 100MB 以上的第三方库推到仓库里。

## 快速开始

1. 安装依赖：

```sh
npm install
```

2. 生成中文字体：

```sh
npm run font
```

3. 编译固件：

```sh
FQBN='esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,MSCOnBoot=default,DFUOnBoot=default,UploadMode=default,CPUFreq=240,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,DebugLevel=none,PSRAM=opi,LoopCore=1,EventsCore=1,EraseFlash=none,JTAGAdapter=default,ZigbeeMode=default'

arduino-cli compile \
  --fqbn "$FQBN" \
  --libraries "$PWD/third_party" \
  --build-path "$PWD/build/CodexStatusDisplay" \
  "$PWD/Firmware/CodexStatusDisplay"
```

4. 烧录固件：

```sh
arduino-cli upload \
  -p /dev/cu.usbmodem1401 \
  --fqbn "$FQBN" \
  --input-dir "$PWD/build/CodexStatusDisplay"
```

如果端口不同，先查看：

```sh
ls /dev/cu.usbmodem*
```

5. 打包并启动菜单栏 App：

```sh
npm run package:menu-app
open dist/CodexStatusMenu.app
```

## Host Bridge

bridge 会读取本地 Codex app-server 的：

- `account/rateLimits/read`
- `thread/status/changed`
- `thread/loaded/list`
- `thread/read`
- `turn/plan/updated`
- `item/started`
- `item/completed`
- `command/exec/outputDelta`
- `process/exited`
- `account/read`
- `account/usage/read`
- `model/list`

然后生成三类设备数据：

- JSON 首页用量数据
- `SESS|...` 会话摘要
- `PAGE|...` 详情页数据

单次发送：

```sh
npm run bridge -- --port /dev/cu.usbmodem1401 --once
```

持续发送：

```sh
npm run bridge -- --port /dev/cu.usbmodem1401 --interval 15000
```

BLE 模式：

```sh
npm run bridge -- --transport ble --ble-name CodexStatusDisplay --interval 15000
```

## 菜单栏 App

推荐通过打包后的 App 使用：

```sh
npm run package:menu-app
open dist/CodexStatusMenu.app
```

菜单栏支持：

- 查看 bridge/设备连接状态。
- 查看 5 小时和本周余量。
- 查看会话数量和当前日程摘要。
- 调整上报间隔：5 秒到 60 秒，每 5 秒一档。
- 重启 App 和 bridge。
- 退出。
- 重新授权飞书日历。

配置文件：

```text
~/Library/Application Support/weixue-codex-bridge/config/codex-status-menu-config.json
```

状态文件：

```text
~/Library/Application Support/weixue-codex-bridge/state/codex-status-menu-state.json
```

日志：

```text
~/Library/Application Support/weixue-codex-bridge/logs/bridge.out.log
~/Library/Application Support/weixue-codex-bridge/logs/bridge.log
```

日志会自动截断，默认单文件 5MB：

```sh
CODEX_MAX_LOG_BYTES=5242880
CODEX_LOG_CLEANUP_INTERVAL_SECONDS=300
```

## 开机自启动

仓库里提供了一个 LaunchAgent 示例：

```text
launchd/com.codex.weixue.bridge.plist
```

这个文件目前包含本机路径，推到 GitHub 后建议使用前先替换：

- App 路径
- Node 路径
- bridge 脚本路径
- 串口路径

安装：

```sh
cp launchd/com.codex.weixue.bridge.plist "$HOME/Library/LaunchAgents/com.codex.weixue.bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codex.weixue.bridge.plist"
```

查看：

```sh
launchctl print "gui/$(id -u)/com.codex.weixue.bridge"
```

停止：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.codex.weixue.bridge.plist"
```

## 飞书日历

日程功能依赖 `lark-cli` 和 `calendar:calendar.event:read` 权限。

菜单栏 App 里可以点“重新授权飞书日历”。授权后 bridge 会读取当天和次日事件，并生成飞书日程页。

展示策略：

- 有当前会议：顶部大卡片展示当前会议。
- 没有当前会议，但下一场会议在 15 分钟内开始：顶部大卡片展示“即将开始”。
- 下方列表展示后续日程，并带具体时间。
- 今日列表到底部展示次日日程数量。
- 今日无剩余日程时，弱展示明日日程。

日程缓存时间为 60 秒。

## 中文字体

设备端使用 LVGL 中文子集字体：

```text
Firmware/CodexStatusDisplay/lv_font_codex_cjk_16.c
Firmware/CodexStatusDisplay/lv_font_codex_cjk_24.c
```

重新生成：

```sh
npm run font
```

生成脚本会扫描：

- 固件源码
- `src/`
- `scripts/`

默认不会读取本机 Codex 数据库或菜单栏实时状态，避免把个人数据相关字形集合写进要提交的字体文件。若是只给自己烧录，并且希望补齐当前会话标题或飞书日程里的新字，可以显式开启本地状态扫描：

```sh
CODEX_FONT_INCLUDE_LOCAL_STATE=1 npm run font
```

然后重新编译和烧录固件。开源提交前建议重新执行普通的 `npm run font`，让字体文件回到不含本机状态的版本。

## 验证

Node 测试：

```sh
npm test
```

bridge 语法检查：

```sh
node --check scripts/codex-usage-bridge.js
```

单次上报验证：

```sh
npm run bridge -- --port /dev/cu.usbmodem1401 --once
```

成功时开发板串口日志通常包含：

```text
[codex-display] payload applied
[codex-display] sessions applied
[codex-display] page applied
```

## 常见问题

### 设备显示离线

先确认串口：

```sh
ls /dev/cu.usbmodem*
```

再确认 bridge：

```sh
pgrep -fl 'CodexStatusMenu|codex-usage-bridge'
```

如果串口被占用，先退出菜单栏 App，再重新烧录或启动。

### USB 断开重连后不恢复

新版 bridge 会在串口异常时重试。若仍未恢复，可以从菜单栏点“重启”，或手动：

```sh
pkill -f CodexStatusMenu
open dist/CodexStatusMenu.app
```

### 飞书日程为空

检查：

- `lark-cli` 是否在 PATH 中。
- 是否已授权 `calendar:calendar.event:read`。
- 菜单栏中“飞书授权”是否为“已授权”。

### 中文缺字

执行：

```sh
npm run font
```

再重新编译烧录固件。

## 推送到 GitHub 前

建议提交这些文件：

- `Firmware/CodexStatusDisplay/`
- `src/`
- `scripts/`
- `tests/`
- `launchd/`
- `package.json`
- `package-lock.json`
- `.gitignore`
- `README.md`

不要提交：

- `node_modules/`
- `build/`
- `.arduino/`
- `dist/`
- `logs/`
- `tmp/`
- `.venv/`
- `third_party/lvgl/`

最后检查：

```sh
git status --short
npm test
```

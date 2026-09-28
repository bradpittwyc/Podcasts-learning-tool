# Podcasts Learning Tool — 工作总结（截至 2026-09-28）

> 仓库：`bradpittwyc/Podcasts-learning-tool`
> 一句话定位：一个**英语学习跟读播放器**——加载本地视频 + 字幕，支持字幕叠加、点句跳读、点词查词、跟读录音对比；桌面端用 Electron，移动端用 Flutter 重写。

---

## 一、项目是什么（核心功能集）

| 模块 | 说明 |
| --- | --- |
| 本地播放 | 加载本地视频文件 + 字幕（SRT/VTT），视频上叠加当前句字幕 |
| 点句跳读 | 点字幕任意一句 → 进度跳到该句开始 |
| 点词查词 | 点字幕里任意单词 → 底部弹出释义（本地词典 + LLM 分级查词） |
| 跟读（Shadowing） | 听原句 → 录音跟读 → 回放对比 |
| 下载到本地 | YouTube 链接通过 yt-dlp + ffmpeg 下载视频 + 字幕（Mac 上已补全 ffmpeg） |

桌面端（Electron 33）已完成 Windows / Mac 双平台；移动端（Flutter 3.47.5）安卓已可用，iOS 仅占位壳。

---

## 二、Mac 版（Phase C）收尾与验证

- **自测**：158 → **175 项**，全部通过 0 失败。
- **文档**：README 补 macOS 下载表（arm64/x64）、首次权限（Screen Recording / Accessibility / Mic）、屏幕取词 OCR、Key 存储改 Keychain；RELEASE_NOTES 重写为 v1.3.0（含 Windows/macOS 差异对照）。
- **真实构建与安装**：
  - `npm run dist:mac:dir` 产出 `release/mac/Podcasts Learning Tool.app`（x64，247MB），icns 与全部 extraResources 正确打包。
  - Swift 辅助程序 `helper/plt-macos.swift` 本机 `xcrun swiftc` 编译通过。
  - 复制到 `/Applications/Podcasts Learning Tool.app`，清隔离属性，`open` 启动验证主进程 + 渲染进程 6 秒存活 → **Mac 上可装可跑**。
- **签名真相**：`build.mac.identity:null` 跳过正式签名，但 `npm run dist:mac` 后自动 `sign:mac`（`codesign --force --deep --sign -`）做 **ad-hoc 自签名**。已验证本机可启动，但**未公证**——下载件仍会被 Gatekeeper 拦，需 Developer ID + 公证才能双击即用。
- **下载含视频**：本机缺 ffmpeg/yt-dlp → 已装 ffmpeg 6.1.1 + yt-dlp + `/usr/local/bin/python3` 软链（GUI App 走 `/etc/paths`，三者必须在 `/usr/local/bin` 才能被找到）。
- **已知 Bug（未修）**：`src/main/youtube.js` 的 `DLP_RELEASE_URL` 写死 `yt-dlp.exe`、`findYtDlp` 只搜 `yt-dlp.exe`，macOS 自动下载会拿到不能跑的 Windows 二进制。已用本机预装 yt-dlp 绕过，代码修法（按平台取 URL + 搜 `yt-dlp`）待做。

---

## 三、移动端 Flutter 重写（安卓优先）

路线：托尼拍板 **Flutter 重写**（非 Capacitor），首期功能 = 本地播放集。

- **工程**：`mobile/` Flutter 3.47.5，Dart 全写完——字幕 SRT/VTT 解析 + 数据模型、词形还原 lemma、本地词典 + LLM 查词、video_player 封装 + 字幕叠加 + 点句跳转、Transcript 点词查词、跟读录音（`AudioRecorder`）+ 回放对比、首页响应式（手机单栏 / 平板双栏）。
- **安卓壳**：包名 `com.bradpittwyc.podcastlearning`，minSdk 21，权限 INTERNET / RECORD_AUDIO / READ_MEDIA_VIDEO(+AUDIO) / READ_EXTERNAL_STORAGE；compileSdk/targetSdk = 36。
- **依赖坑（逐个修）**：
  - `record` 5.1.1 → 7.1.1（旧 `record_linux` 与 `record_platform_interface` 不兼容）
  - `audioplayers` 5.2.0 → 6.8.1（android compileSdk 要求 ≥34）
  - `file_picker` 8.0.0 → 13.1.0（其 android 要求 compileSdk 36，且 13.x API 大改：`FilePicker` 变抽象类、`pickFiles` 变静态、返回 `List<PlatformFile>`、去 `allowMultiple`；已重写 `media_service.dart`）
  - `lemma.dart` 重复 key `sought`、`pubspec` 引用缺失的 `assets/` 目录（已建 `.gitkeep`）
- **本机构建环境**：本机无 JDK → 装 JDK 17（Corretto，因 Adoptium 跳 GitHub 被沙箱 TLS 拦）+ Android SDK（platforms 33/34/35/36 + build-tools + platform-tools）；Gradle 内存压到 `-Xmx2G -Dorg.gradle.daemon=false`（本机 8GB 防 OOM）。
- **构建结果**：`flutter build apk --debug` 成功 → `mobile/build/app/outputs/flutter-apk/app-debug.apk`。
- **iOS**：仅最小占位壳，无业务逻辑，按计划下一步做。

---

## 四、竖屏版布局（最新）

- 原 `HomeScreen` 只按**宽度**判断：平板一竖过来（宽仍 ≥600）会错走双栏横排，很难看。
- 改用 `OrientationBuilder` 区分横竖屏：
  - **竖屏（手机 / 平板竖持）**：顶部视频（常驻）→ 当前句高亮条（实时显示正在播放句、点按回到该句）→ 字幕 / 跟读 Tab 主体。
  - **横屏宽屏（平板横持）**：左视频 + 右字幕/跟读双栏（保持不变）。
  - **横屏窄屏（手机横持）**：单栏上下。
- 新增 `_buildPortrait()` 与 `_currentCueBar()` 两个方法（`mobile/lib/screens/home_screen.dart`）；修 `withOpacity`→`withValues` 弃用警告。
- 验证：`flutter analyze` → 0 issue；重新打包 debug APK → **181 MB**。

---

## 五、当前状态与下一步

**状态**
- 全部改动（Mac 版 + 移动端 + 竖屏版）**均未 commit / 未 push / 未打 tag**。
- APK 路径：`mobile/build/app/outputs/flutter-apk/app-debug.apk`（debug 签名，可侧载，不能上架 Play）。

**待办（按优先级）**
1. 把 debug APK 装到托尼安卓设备（`adb install` 或传文件 + 允许未知来源），实测竖屏布局。
2. 修 `src/main/youtube.js` 的 macOS yt-dlp 自动下载 bug（按平台取 URL + 搜 `yt-dlp`）。
3. 实做 iOS 版（目前仅占位壳）。
4. 发版：commit / push / 打 `v1.3.0` tag 触发 CI 双平台出包；如需 Mac 双击即用，补 Developer ID + 公证。

**可调项（竖屏体验）**：视频占屏比例、当前句条是否常驻、跟读要不要做成底部常驻录音条而非塞进 Tab。

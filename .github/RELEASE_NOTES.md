## 英语学习神器 · Podcasts Learning Tool v1.3.0

播放 MP4 / MP3 与播客、视频字幕跟读，**点击文字跳转时间戳**，**大模型按难度分级查词典**（雅思 / 托福 / GRE / 受过良好教育的母语级）。Windows 与 macOS **双平台**，界面贴合各自系统原生风格，功能完全一致。

> 本次为 **macOS 首发版本**。Windows 侧的既有功能与 v1.2.0 一致；详见文末「v1.2.0 回顾」。

### 🆕 本次重点：macOS 版并行发布

与 Windows 版同源、功能对齐，差异只在系统原生层：

| 维度 | Windows | macOS |
| --- | --- | --- |
| 窗口与标题栏 | 自绘 Fluent 标题栏 + 三键 | 原生交通灯（`hiddenInset`），无自绘三键 |
| 屏幕取词 OCR | Windows 内置 `Windows.Media.Ocr` | 系统原生 **Vision**（随包附 Swift 辅助程序 `plt-macos`，首次使用本机编译，需 Xcode CLT） |
| 抓取前台选中文字 | PowerShell 读剪贴板 | `osascript` 读选中内容（需辅助功能权限） |
| 原生背景材质 | Mica / 亚克力 | 无等价物（macOS 上禁用） |
| 数据目录 | 便携目录 / `%APPDATA%` | `~/Library/Application Support/Podcasts Learning Tool` |
| 打包 | NSIS 安装版 + 绿色便携版 | dmg + zip，arm64（Apple Silicon）/ x64（Intel）双架构 |
| 自动升级 | 静默原地安装 / 退出后换 exe | 退出后换 `.app`（无写入权限时引导 Finder 手动替换） |
| 签名 | 未签名（SmartScreen 提示） | **ad-hoc 自签名**（未公证，`identity: null` + 打包后 `sign:mac` 用 `codesign -s -`，Gatekeeper 仍可能拦下载件） |

- 平台差异收敛进唯一入口 `src/main/platform.js`，其它模块只问「要什么」，不再散落 `process.platform === 'darwin'` 判断。
- 所有改动通过双平台自检（Windows / macOS 两个 CI runner 都跑 `npm test`）。

### 🔗 YouTube 链接自动播放（v1.2.0 引入，本版继续支持）

工具栏 **🔗 链接**（或直接 `Ctrl+V` / macOS `Cmd+V` 粘贴链接），粘进 YouTube 链接后选路线：

| 方式 | 怎么用 | 能力边界 |
| --- | --- | --- |
| **在线速听** | YouTube 官方嵌入播放器，秒开、不下载 | 播放 / 倍速 / A-B 复读 / 全屏；**没有字幕文本**，点句跳转、全文扫描、分级取词、跟读用不了 |
| **下载到本地（全功能）** | 调 `yt-dlp` 抓音视频 + 字幕，之后当普通本地文件播 | **全部功能照常** |

- `yt-dlp` / ffmpeg 不塞进安装包，第一次用时提示下载到数据目录 `tools\`（macOS 为 `~/Library/.../tools/`）。

### 🔑 内嵌出厂 API Key 已彻底移除

应用不再内置、不再代管任何 Key，源码与构建产物中均无明文 Key。Key 只有两个来源：使用者在「⚙ 设置 → 大模型」里自己填，或由上层平台（网站 / 后端账号体系）统一下发到所有产品 —— 播放器只是其中一个调用方。（未配置 Key 时，除「点词看释义」外的功能全部照常可用。）

### 📦 下载

| 文件 | 适用场景 |
| --- | --- |
| **`Podcasts-Learning-Tool-Portable-1.3.0.exe`** | Windows 绿色便携版（推荐） |
| `Podcasts-Learning-Tool-Setup-1.3.0.exe` | Windows 安装版 |
| **`Podcasts Learning Tool-1.3.0-arm64.dmg` / `.zip`** | macOS Apple Silicon（M1/M2/M3…） |
| **`Podcasts Learning Tool-1.3.0-x64.dmg` / `.zip`** | macOS Intel |

> macOS 已做 **ad-hoc 自签名**（未公证）：本机 `open` 已验证可正常启动，双击一般无碍；但从互联网下载的 `.app` 首次打开仍可能被 Gatekeeper 拦 —— 右键「打开」或 `系统设置 → 隐私与安全性 → 仍要打开`，也可 `sudo xattr -rd com.apple.quarantine "/Applications/Podcasts Learning Tool.app"` 一次性解除隔离（详见 README 常见问题）。要对外发布给陌生用户「双击即用」，需 Apple Developer ID 证书 + 公证。

### ⬆️ 自动升级

- Windows 安装版 / 便携版、macOS `.app` 均支持：启动后自动检查本仓库 Release → 状态栏提示 → 一键下载 → 静默替换并重启。
- 检查更新**不消耗 GitHub API 额度**（读 Release 的 `latest.yml`）。
- **只提示，不自动下载**，不会突然占满带宽。

### 🧪 自检

- 无界面自检 **158 → 175 项**（新增平台抽象模块、macOS 打包配置校验）。
- Windows / macOS 双 runner 在 CI 跑 `npm test` 与 `npm run test:update`。

---

### 📌 v1.2.0 回顾（上个大版本）

- 新增 **🔗 链接**：粘贴 YouTube 链接即可「在线速听 / 下载到本地」，播放层用后端门面统一本地与在线接口。
- 内嵌出厂 Key 移除；UI 打磨（更新面板、Fluent 图标、发音按钮）。
- 自检 129 → 158。

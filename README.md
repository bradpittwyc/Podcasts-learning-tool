# Podcasts Learning Tool · 英语学习神器

> 播放 MP4 / MP3 与播客、视频字幕跟读，点击文字跳转时间戳，**大模型分级取词查词典**（雅思 / 托福 / GRE / 受过良好教育的母语级）。
> 提供 **Windows** 与 **macOS** 双平台版本，界面贴合各自系统原生风格，功能完全一致。

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11%20%7C%20macOS-0078D4?logo=windows)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ✨ 功能总览

| 模块 | 能力 |
| --- | --- |
| **播放器** | MP4 / MP3 / M4A / WAV / MKV / MOV / FLAC…（Chromium 支持的格式） |
| **视频链接** | 粘贴 YouTube 链接 → 选「在线速听」或「下载到本地（全功能）」 |
| **变速** | 慢速 **0.75× / 0.5× / 0.25×**，加速最高 **2.5×**，变速不变调（preservesPitch） |
| **字幕** | 导入 + 自动配对 SRT / VTT / ASS / SSA / LRC / JSON / TXT（无时间轴也能自动断句） |
| **字幕选择** | 「字幕」按钮下拉：从**同目录 / 导入的文件夹**里挑字幕（含子目录、标出同名字幕）、关闭或恢复字幕显示、打开其他文件、清除字幕 |
| **校对** | 软件内直接改文本与时间戳、拆分 / 合并 / 插入 / 删除、整篇平移、一键保存 SRT/VTT/JSON |
| **跳转** | 点击任意字幕行或单词 → 视频/音频立即跳到对应时间戳 |
| **文字界面** | 英文 **Times New Roman**，中文 **微软雅黑**，界面 **Segoe UI Variable**（可自定义） |
| **取词查词典** | 点单词 → 中文释义 + 音标 + 词性 + 语境；**内置 9 万词离线词典，常见词 0 费用** |
| **难度分级** | **雅思 / 托福 / GRE / Educated Native**（受过良好教育的母语级）等 8 档，**只标出目标级别及以上的词** |
| **级别锁定** | 顶栏 🔒 一键锁定：低于所选级别的单词**不可取词**（不显示释义、不调用 AI） |
| **屏幕取词** | ① 截图框选 + **Windows 内置 OCR**（离线、免费）② 抓取前台程序选中文字 ③ 全局快捷键 `Alt+Shift+W` |
| **跟读** | 麦克风录音、A/B 对比播放、原句后留跟读间隔、单句循环、**A-B 复读**、录音保存 |
| **生词本** | 一键收藏、搜索排序、闪卡复习、导出 CSV / JSON（可直接导入 Anki / 欧路） |
| **学习笔记** | 一键导出 Markdown（生词表 + 双语对照全文） |
| **便携版** | 单文件 exe，数据写在程序同目录，U 盘即插即用，卸载零残留 |

---

## 🚀 快速开始

### 方式一：下载即用（推荐给普通用户）

到 [Releases](https://github.com/bradpittwyc/Podcasts-learning-tool/releases/latest) 下载：

**Windows**（自 v1.1.6 起）

| 文件 | 说明 |
| --- | --- |
| **Podcasts-Learning-Tool-Portable-`<版本>`.exe** | **便携版**：双击即运行，数据存于 exe 同目录 `PodcastsLearningData\`，U 盘即插即用 |
| **Podcasts-Learning-Tool-Setup-`<版本>`.exe** | 安装版：开始菜单 + 桌面快捷方式，数据存于 `%APPDATA%` |

**macOS**（自 **v1.3.0** 起，提供 Apple Silicon 与 Intel 双架构）

| 文件 | 说明 |
| --- | --- |
| **Podcasts Learning Tool-`<版本>`-arm64.dmg** / `.zip` | Apple Silicon（M1/M2/M3…） |
| **Podcasts Learning Tool-`<版本>`-x64.dmg** / `.zip` | Intel Mac |
| 把 `.app` 拖进「应用程序」即可；或解压 `.zip` 后直接打开 |

> 想看其它版本或更新日志：[全部 Releases](https://github.com/bradpittwyc/Podcasts-learning-tool/releases)。
> 源码里的版本号可能比这里新（例如刚合入功能、还没打 tag 发布），那种情况下以 Releases 里实际能下到的为准。
> 未签名程序首次运行可能被 SmartScreen（Windows）/ Gatekeeper（macOS）拦截，见下方「常见问题 → macOS 打开提示已损坏」。

### macOS 首次使用须知（权限与离线 OCR）

- **屏幕取词 / 划词**走 macOS 原生 **Vision OCR**（通过随包附带的 Swift 辅助程序 `plt-macos` 调用）：
  - 首次使用会在本机**就地编译**这个 Swift 辅助程序（需要 **Xcode 命令行工具**：`xcode-select --install`），编译一次后缓存复用；没装 CLT 时这部分功能会提示不可用，不影响其它功能。
  - 需在 **系统设置 → 隐私与安全性** 里授予：**屏幕录制**（截图 OCR 取画面）、**辅助功能**（抓取前台选中文字）。
- **跟读录音**需授予**麦克风**权限。
- 自动更新、屏幕取词辅助依赖 **Apple 事件**权限，首次触发时按系统提示允许即可。
- 打包配置 `build.mac.identity` 为 `null`，electron-builder **不会**做开发者签名（它在钥匙串里查不到可用证书就直接跳过）；但 `npm run dist:mac` 会在打包后自动跑 `npm run sign:mac`，用系统自带 `codesign -s -` 给 `.app` 做 **ad-hoc 自签名**（已在本机验证：签名有效、`open` 可正常启动）。
- ad-hoc 签名足以让**本机 / 右键「打开」/ 解除隔离属性**后正常运行；但它**不是公证（notarization）**，从互联网下载的 `.app` 仍会被 Gatekeeper 拦，直到右键「打开」或 `xattr -dr com.apple.quarantine`。要对外发布给陌生用户「双击即用」，需改为有效的 **Apple Developer ID 证书 + 公证**（把 `build.mac.identity` 设为你的证书名）。详见下方「常见问题 → macOS 打开提示已损坏」。

### 方式二：源码运行

```powershell
git clone https://github.com/bradpittwyc/Podcasts-learning-tool.git
cd Podcasts-learning-tool
npm install
npm start          # 启动
npm test           # 跑自检（175 项：字幕解析/编码/分级逻辑/链接解析/平台抽象/语法/结构）
npm run dist       # 同时产出「安装版 + 便携版」到 release\
npm run dist:portable   # 只出便携版
```

需要 Node.js ≥ 18（开发时使用 Node 24 / Electron 33）。

---

## 🔑 配置大模型（可选 — 不内置任何 Key）

**本应用不内置、不代管任何 API Key**，源码与构建产物里都没有明文 Key。
Key 由使用者本人填写，或由你的上层平台（网站 / 后端账号体系）统一下发到所有产品 —— 播放器只是其中一个调用方。

打开应用 → 右上角 **⚙ 设置 → 大模型**：

1. 选服务商预设（默认 **DeepSeek**，中文好、价格低，约 ¥1 / 百万输入 tokens）
2. 填 **API Key**（[DeepSeek 申请入口](https://platform.deepseek.com/)，新用户有赠送额度）
3. 点 **测试连接** —— 显示 `✓ 连接成功` 即可
4. 也支持任何 **OpenAI 兼容**接口：OpenAI / Moonshot / 通义千问 / 智谱 / SiliconFlow，以及**本地 Ollama**（`http://localhost:11434/v1`，完全免费离线）

> **Key 只有一个来源**：设置里填的那一个。点「清除」即彻底不用（不会再回退到任何出厂 Key）。
> **不配置 Key 也能用**：播放、字幕、校对、跟读、生词本、本地词典分级取词、全文难词扫描全部可用，
> 只有点选查词的「释义」需要 Key。
> API Key 使用系统原生加密（Windows DPAPI / macOS Keychain，即 Electron `safeStorage`）保存在本地，绝不上传到本项目以外的任何地方。

---

## 📁 导入与字幕选择

1. **拖进窗口**：MP4/MP3 + 字幕文件一起拖进来；同名字幕会自动加载
2. **打开媒体**：单选/多选音视频文件
3. **文件夹导入**：扫描整个文件夹（**含子目录，默认 3 层**，自动跳过无关文件），
   列出所有媒体并标注「音频/视频 + 大小 + 是否有字幕 + 相对路径」，点条目即打开
4. **字幕按钮**（打开媒体后随时可用）：
   - 关闭字幕显示 / ✓ 恢复字幕显示（等同 `Ctrl+H`）
   - 列出**同目录**及**已导入文件夹**内的全部字幕（同名字幕带「同名」标记，当前使用的打 ●）
   - 字幕很多时选「从列表中选择…」打开完整列表
   - 打开其他字幕文件… / 清除当前字幕
   - 按钮标签会显示当前字幕名（无字幕时提示跟随）

> 关闭的是**视频上的字幕浮层**；右侧正文区仍然保留，方便「先盲听 → 再看文本 → 点句跳转核对」。

---

---

## 🔗 打开视频链接（YouTube）

工具栏点 **🔗 链接**（或直接 `Ctrl+V` 粘贴链接），粘进 YouTube 链接后，软件会问你走哪条路：

| 方式 | 怎么用 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| **在线速听** | YouTube 官方嵌入播放器，秒开，不下载 | 播放 / 倍速（0.25×–2×）/ A-B 复读 / 全屏 | **拿不到字幕文本** → 点句跳转、全文扫描、分级取词、跟读都不可用 |
| **下载到本地（全功能）** | 调 `yt-dlp` 把音视频 + 字幕抓到本机，之后当普通本地文件播放 | **全部功能照常**（点句跳转、变速不变调、字幕校对、跟读 A-B、分级取词） | 要等下载；需要 `yt-dlp` |

### 支持哪些链接

`youtube.com/watch?v=…` · `youtu.be/…` · `/shorts/…` · `/live/…` · `/embed/…` · 带 `list=` / `t=` 参数的链接 · 直接粘 11 位视频 ID

### 关于 yt-dlp

`yt-dlp` 体积大、更新频繁，**本应用不把它打进安装包** —— 第一次用「下载到本地」时会提示从
[yt-dlp 官方发布页](https://github.com/yt-dlp/yt-dlp/releases/latest) 下载到本机数据目录 `PodcastsLearningData\tools\`。
也可以自己装好后到 **⚙ 设置 → 高级** 里指定路径。

- 装了 **ffmpeg** → 下载「视频 + 音频」合成 MP4
- 没装 ffmpeg → 自动降级为**只下载音频**（字幕照样能下），对英语跟读来说通常够用
- 字幕走 `--write-subs --write-auto-subs --sub-langs en.*`，下完自动挂上（英文自动字幕也能拿到）
- 文件落在 `PodcastsLearningData\YouTube\<视频ID>\`

> **合规提示**：下载功能由你自行决定是否使用，请遵守当地法律与 YouTube 服务条款，
> 仅用于你有权使用的个人学习内容。本项目不提供任何绕过版权保护的能力。

---

## 💰 分工设计：本地词典负责「筛」，大模型负责「解」

这是本项目的核心设计：**筛选要快要免费，解释要准要结合语境**。

```
扫描全篇（本地词典，毫秒级、0 费用、可离线）
        ↓  按所选级别筛出「哪些词值得看」
   标记可取词 / 锁定低级别词
        ↓  用户点选某个词
释义卡片（大模型，结合该句语境给准确义项）
```

### 为什么这么分工

| 环节 | 用什么 | 原因 |
|---|---|---|
| 全文扫描 / 分级筛选 | **内置离线词典**（90,754 词条，120ms 加载） | 每集要筛几百个词，必须快且免费；且要能离线工作 |
| 点选后的释义卡片 | **大模型**（DeepSeek 等） | 本地词典常有义项错误（`could`→"装罐头"、`are`→"面积单位"），大模型能结合语境给出正确义项 |

### 成本（实测，`scripts/prompt-cost-check.js` 可复跑）

点选一次 = 一次 API 请求，系统提示 288 token + 输入 35 + 输出 84：

| 模型 | 每次点选 | 1 万次点选 |
|---|---|---|
| **deepseek-flash 非高峰** | ¥0.00040 | **¥4.01** |
| deepseek-flash 高峰 | ¥0.00080 | ¥7.96 |
| deepseek-v4-pro 非高峰 | ¥0.00139 | ¥13.90 |
| deepseek-v4-pro 高峰 | ¥0.00273 | ¥27.35 |

> 提示词已按「点选成本」优化：从 555 token 压到 288，省约 12%。
> DeepSeek 的磁盘缓存默认开启，系统提示作为公共前缀会自动命中，上表按缓存热计算。
> **务必关闭思考模式**（`{"thinking":{"type":"disabled"}}`）—— V4 默认开启且按输出计费，
> 不关的话成本会膨胀数倍。
> 建议用 `deepseek-flash`：定级+写 10 字释义不需要前沿推理能力，价格只有 v4-pro 的 1/3.5。

### 级别门槛与锁定

- 顶栏「取词级别」决定**哪些词能被选中**：低于该级别的词一律锁死
- 🔒 锁形按钮：锁定时低级别词**完全不可点击** —— 不弹面板、不高亮、不跳转、无任何提示，
  外观与普通词完全一致（只有光标变成 `not-allowed`）
- 未锁定时：点任意词都能查，一律由大模型出释义

### 级别一览

| 选项 | 说明 |
| --- | --- |
| 不筛选 | 全部单词都可选 |
| A2 / B1 / B2 | 按 CEFR 级别过滤 |
| **雅思 IELTS / 托福 TOEFL** | C1 及以上 |
| **GRE** | C2 |
| **Educated Native** | 生僻词、文学/专业级难词 |

### 🔒 级别锁定

顶栏「取词级别」右侧的锁形按钮（或设置 → 取词级别）：

- **未锁定（默认）**：点任意单词都能查 —— 低于级别的词只用本地词典，**不产生 AI 费用**
- **已锁定**：低于所选级别的单词**直接拦截**，不显示释义、不调用 AI，面板明确提示

适合「只想看托福以上难词」的沉浸式学习：锁定后点错词也不会泄漏答案、不会花钱。

---

## ⌨️ 快捷键

| 键 | 功能 |
| --- | --- |
| `空格` | 播放 / 暂停 |
| `← / →` | 后退 / 前进 5 秒（`Shift` 为 10 秒） |
| `↑ / ↓` | 上一句 / 下一句 |
| `Enter` | 从选中句开始播放 |
| `Ctrl+R` / `R` | 重播当前句 |
| `Ctrl+[` / `Ctrl+]` | 减速 / 加速 |
| `Ctrl+←/→` | 上一句 / 下一句 |
| `Ctrl+H` | 显示 / 隐藏字幕浮层 |
| `Ctrl+D` | 查询选中文本 |
| `Ctrl+Shift+S` | 屏幕取词（截图 OCR） |
| `Ctrl+Shift+D` | 扫描全文难词 |
| `F` / `L` / `A` / `E` / `S` / `N` | 全屏 / 单句循环 / A-B 复读 / 校对模式 / 跟读面板 / 生词本 |
| `Ctrl+O` / `Ctrl+Shift+O` / `Ctrl+S` | 打开媒体 / 打开字幕 / 保存校对字幕 |
| 点「字幕」按钮 | 选择同目录或文件夹里的字幕 / 关闭字幕显示 / 打开其他字幕文件 |
| `Ctrl+,` | 设置 |
| **`Alt+Shift+W`**（全局） | 任意程序内屏幕取词 |
| **`Alt+Shift+Space`**（全局） | 任意程序内播放 / 暂停 |

---

## 🖥 屏幕取词（任何软件里都能查词）

三种方式，互为补充：

1. **截图 OCR（默认，离线免费）**：按 `Ctrl+Shift+S`（macOS 上同 `Cmd+Shift+S`）或点工具栏「屏幕取词」→ 鼠标框选屏幕上的任意英文（YouTube 视频、Kindle、PDF、图片）→ 识别 → 大模型按当前级别挑出难词并给释义。
   - **Windows**：走 **Windows 内置 OCR**（`Windows.Media.Ocr`）。首次会弹「屏幕录制权限」请求（画面不离开本机）；若提示 OCR 不可用，去 设置 → 时间和语言 → 语言和区域 → 添加「English (United States)」语言包并勾选**光学字符识别**组件，设置 → 高级 → 「OCR 可用性检测」可一键验证。
   - **macOS**：走 **系统原生 Vision OCR**（通过随包附带的 Swift 辅助程序 `plt-macos` 调用，首次使用在本机编译一次）。需先在 **系统设置 → 隐私与安全性** 授予**屏幕录制**权限；没装 Xcode 命令行工具时这部分会提示不可用，不影响其它功能。
2. **抓取前台选中文字**：在浏览器/PDF 里选中英文 → 按全局快捷键 `Alt+Shift+W`（macOS 上用 `Cmd+Shift+W`）→ 弹出置顶浮窗显示难词释义（自动复制并还原你原来的剪贴板内容）。macOS 走 `osascript` 复制选中内容，需授予**辅助功能**权限。
3. **应用内选中**：在右侧文字区选中任意文本 → `Ctrl+D`（macOS `Cmd+D`）。

> 技术说明：截图 OCR 在 Windows 上走系统自带的 `Windows.Media.Ocr` 引擎（通过 `scripts/ocr.ps1` 调用）；
> 在 macOS 上走 **Vision** 框架（通过 `helper/plt-macos.swift` 编译出的辅助程序调用）。两者都**完全离线、零 API 费用**，
> 也避免了把屏幕内容发给云端视觉模型。Windows 侧 PowerShell 5.1 无法直接 await WinRT 异步操作，脚本内用一段反射桥接（`AsTask<T>` + PowerShell 构造的封闭泛型接口）解决。

---

## 🎧 跟读（Shadowing）工作流建议

1. 打开一集播客（拖入 MP4/MP3，同名字幕会自动加载）
2. 顶栏「取词级别」选 **托福**，点「扫描难词」→ 全文难词被高亮并显示中文
3. 把速度调到 **0.75×** 或 **0.5×**，点任意一句开始精听；`L` 打开单句循环
4. 点工具栏 🎙 打开跟读面板 → 「开始录音」→ 回放对比，或「A/B 对比」听原声与自己的差距
5. `A` 设置 **A-B 复读**，反复啃最难的 5 秒
6. 生词加入生词本 → 「闪卡复习」→ 导出 CSV 到手机 App

---

## ⬆️ 自动升级

程序连的是本仓库的 [GitHub Release](https://github.com/bradpittwyc/Podcasts-learning-tool/releases)，
发现新版本会在**状态栏右下角**提示，点一下就能升级：

| 你用的是 | 升级方式 |
| --- | --- |
| **安装版**（Setup，Windows） | 启动后自动检查 → 一键下载 → **静默原地安装**并自动重启（设置、生词本全部保留） |
| **便携版**（Portable，Windows） | 自动检查 + 下载 → 程序退出后由后台脚本**替换 exe 并重新拉起**（便携版 exe 运行期间被系统占用，只能退出后再换） |
| **macOS（.app / .dmg / .zip）** | 自动检查 + 下载 → 退出后由后台脚本把新 `.app` 换进「应用程序」（或解压目录）；若「应用程序」不可写，会引导你在 Finder 里手动替换 |

- 手动入口：**帮助 → 检查更新…**，或 **设置 → 高级 → 软件更新**
- **只提示，不自动下载** —— 不会在你上课/听写时突然占满带宽
- 不想让它检查：设置 → 高级 → 软件更新 → 取消勾选「启动后自动检查更新」
- 换包日志：便携版在 `PodcastsLearningData\update\update.log`（万一替换失败，可看日志并按提示手动改名）

> 开发模式（`npm start`）不检查更新；`--smoke-update` 可以在开发模式下真连 GitHub 验证通路。

---

## 🔒 便携版说明

便携版（Portable）的行为：

- 数据目录 = exe 同目录的 `PodcastsLearningData\`（设置、生词本、历史、词典缓存、录音全在里面）
- 也可以手动触发便携模式：在 exe 同目录新建空文件 `portable.flag` 或空文件夹 `portable-data`
- 删除程序目录 = 完全卸载，注册表零残留（安装版卸载也不会删除你的生词本）

---

## 🏗 项目结构

```
src/
  main/                  Electron 主进程
    main.js              窗口 / 无边框标题栏 / 自定义 plt-media:// 协议 / IPC / 菜单 / 全局快捷键 / 冒烟测试
    store.js             设置持久化（safeStorage 加密 API Key、便携模式路径）
    llm.js               大模型取词引擎：级别体系、批量合并、持久缓存、提示词
    updater.js           自动更新：安装版走 electron-updater，便携版走自研换包脚本
    ocr.js               Windows.Media.Ocr 桥接（离线屏幕取词）
    screen-text.js       抓取前台程序选中文字（SendKeys + 剪贴板还原）
    youtube.js           在线视频：yt-dlp 探测/安装、下载任务（进度 + 可取消）
  preload/preload.js     contextBridge 白名单 API
  renderer/
    index.html           主界面（标题栏 / 命令栏 / 播放区 / 文字区 / 状态栏）
    quick.html           屏幕取词浮窗
    css/                 tokens(设计标记) app player transcript panels
    js/
      subtitles.js       字幕引擎（主/渲染共用：SRT/VTT/ASS/LRC/JSON/TXT、编码嗅探、分词、词形还原）
      player.js          播放器（0.25×~2.5×、A-B 复读、单句循环、画中画）+ Playback 后端门面
      ytplayer.js        YouTube 在线播放后端（IFrame API，接口与本地播放器一致）
      youtube.js         链接流程：粘贴 → 取标题 → 选在线/下载 → 播放
      transcript.js      文字区（Times New Roman + 微软雅黑、点词查词、校对编辑）
      dict.js            查词面板、批量扫描、成本统计、截图 OCR 框选
      shadow.js          跟读录音与 A/B 对比
      settings.js        设置面板（大模型 / 取词级别 / 外观 / 播放 / 高级）
      updater-ui.js      更新界面（状态栏角标 / 更新面板 / 进度条）
      app.js             主控：文件导入、同步、导航、快捷键
scripts/
  ocr.ps1                Windows OCR 实现（含 WinRT 异步桥接，UTF-8 with BOM）
  ocr-selftest.js        OCR 链路自检（生成测试图 → 识别 → 断言）
  update-selftest.js     更新自检（版本比较 + 真跑便携版换包脚本）
  publish-release.js     发布到 GitHub Release（保证资产名与 latest.yml 一致）
  build-dict.js          用 ECDICT 生成内置离线词典（npm run dict / dict:fetch）
  ui-probe.js            UI 交互回归探测（播放图标/拖动/跳转/字幕菜单/查词/加载态）
  analyze-trace.js       解析冒烟 trace 并打印断言明细
  make-icon.js           纯 JS 生成多尺寸 ICO 图标
  make-sample.js         用 ffmpeg 生成示例媒体与中英字幕
  fix-ps1-bom.js         为 .ps1 补 UTF-8 BOM（PowerShell 5.1 必需）
  selftest.js            无界面自检（字幕解析 / 编码 / 分级逻辑 / 链接解析 / 语法 / 结构）
src/shared/lemma.js      词形还原规则（构建词典与运行时共用）
src/shared/youtube-url.js YouTube 链接解析（纯函数，主进程与自检共用同一份实现）
resources/               内置离线词典（npm run dict 生成，不入库）
```

---

## 🧪 自检与验证

```powershell
npm test           # 175 项无界面自检
npm run test:update # 18 项更新通路自检（版本比较 + 真跑一遍便携版换包脚本）
npm run test:ocr   # 验证 Windows OCR 链路（生成图片→识别→校验文本）
npm run dict:fetch # 下载 ECDICT 原始数据（63MB，仅首次）
npm run dict       # 生成内置离线词典 resources/local-dict.json(.gz)
npm run sample     # 用 ffmpeg 生成 60 秒示例视频/音频/中英字幕到 samples\
npm run smoke      # 真实启动应用，加载示例、截图、检查播放与字幕同步（需先 npm run sample）
npm run test:all   # 三套自检一次跑完
```

`npm test` 覆盖：时间戳解析与格式化、双语拆分、SRT/VTT/ASS/LRC/JSON/纯文本解析、序列化往返、
UTF-8/UTF-16/GBK 编码嗅探、正文分词与词形还原、级别分级判定、YouTube 链接解析（含 `t=` 时间参数与非法输入拦截）、
工程文件完整性、脚本语法与 HTML 结构。

`npm run smoke` 会真实启动 Electron 窗口，验证：自定义 `plt-media://` 协议能否播放 MP4（时长/解码/跳转）、
同名字幕自动配对、24 行字幕渲染、快捷键与进度条联动，并在 `samples\` 下输出三张截图（整窗 / 文字区 1:1 / 词典面板）。

加上 `--smoke-ui` 会额外用**真实鼠标事件**驱动界面做交互断言（`scripts/ui-probe.js`）：

| 断言 | 说明 |
| --- | --- |
| 暂停态显示三角 / 播放中显示两道竖 | 三个播放按钮（命令栏 / 传输栏 / 悬浮条）同步切换 |
| 进度条 pointerdown→move→up 拖到 50% | 断言 `currentTime ≈ 30s` |
| 点第 24 / 12 行字幕 | 断言跳到 57.65s / 27.65s，且单击不自动播放 |
| 字幕菜单内容 / 切换 / 关闭 / 恢复 | 点击后立刻生效 |
| 全部单词均可点选 | 断言零锁定：无 `.locked`、无 `not-allowed` 光标、无 title 提示 |
| 点词出释义 | 断言面板内容与来源徽标（AI 语境）；低级词照查不误 |
| 加载态文案 | 断言请求返回前显示「思考中........」+ 一个转圈，返回后被释义替换 |
| 图标几何居中 | 断言三角/两道竖的圆心与按钮圆心误差 ≤ 0.6px |

额外开关：`--smoke-update` 真连 GitHub Release 验证更新通路，`--smoke-update-download` 连下载一起验证。

> 打包前的完整验证流程：`npm test` → `npm run test:ocr` → `npm run dict` → `npm run sample` → `npm run smoke -- --smoke-ui` → `npm run dist`

---

## ❓ 常见问题

**Q：为什么有些常用词不显示中文？**
A：这是省钱设计的预期行为 —— 它们低于你选择的取词级别。想查就**直接点那个词**（手动点击默认忽略级别过滤），或在设置里把级别调低。

**Q：视频打不开 / 只有声音没画面？**
A：Chromium 不支持部分编码（如 H.265/HEVC、部分 MKV 内封字幕）。建议转成 **H.264 + AAC 的 MP4**。内封字幕需另存为外挂 SRT 后导入。

**Q：字幕和声音不同步？**
A：点「时间轴」按钮整篇平移（例如 `-0.35` 秒），或进入「校对」模式用 `−0.1s / +0.1s` 逐条微调。

**Q：查词报 401 / 402 / 429？**
A：401 = Key 无效；402 = 余额不足；429 = 频率过高。设置面板的「测试连接」会给出明确提示。

**Q：在线播放为什么没有字幕、不能点句跳转？**
A：YouTube 不把字幕文本暴露给第三方嵌入播放器，所以在线模式只能播。**要完整功能就选「下载到本地」** —— 下完当本地文件播放，点句跳转、跟读、分级取词全部照常。

**Q：点「下载到本地」提示要下载 yt-dlp，安全吗？**
A：yt-dlp 是开源命令行工具，从它的 GitHub 官方发布页下载到本机 `PodcastsLearningData\tools\`，不放进安装包是因为它体积大且每周更新。你也可以自己装好后在设置里指定路径。

**Q：下载很慢 / 只有声音没有画面？**
A：没装 ffmpeg 时会自动降级为只下载音频（对跟读够用）。装上 ffmpeg 就能合成带画面的 MP4。

**Q：想完全离线、不花钱？**
A：装 [Ollama](https://ollama.com/) 后设置服务商选「本地 Ollama」即可；屏幕取词本来就用的离线 OCR。

**Q：便携版和安装版能同时用吗？**
A：可以，各自独立的数据目录，互不影响。

**Q：macOS 打开时提示「已损坏 / 无法验证开发者」？**
A：打包脚本 `npm run dist:mac` 已经用系统自带 `codesign -s -` 给 `.app` 做了 **ad-hoc 自签名**（本机 `open` 已验证可正常启动），但 ad-hoc 不是付费的「开发者签名 + 公证」，所以**从互联网下载**的 `.app` 仍可能被 Gatekeeper 拦。仍要打开：在「应用程序」里右键应用 → 打开（或 `系统设置 → 隐私与安全性` 里点「仍要打开」）；也可在终端执行 `sudo xattr -rd com.apple.quarantine "/Applications/Podcasts Learning Tool.app"` 一次性解除隔离。从本仓库下载的 dmg/zip 第一次打开若报「已损坏」，多半是隔离属性未清，清掉即可。后续若要发布给陌生用户「双击即用」，用有效 **Developer ID 签名并公证**即可（把 `build.mac.identity` 设为你的证书名，其余交给 electron-builder）。

**Q：macOS 屏幕取词用不了 / 提示 OCR 不可用？**
A：先确认已装 **Xcode 命令行工具**（`xcode-select --install`，Swift 辅助程序首次需就地编译）；再到 **系统设置 → 隐私与安全性** 授予**屏幕录制**与**辅助功能**权限，并完全退出重开应用让权限生效。这些都就绪后「设置 → 高级 → OCR 可用性检测」应显示可用。

---

## 📄 许可

[MIT](LICENSE) © 2025 bradpittwyc

第三方接口说明：单词发音使用有道词典公开语音接口（`dict.youdao.com/dictvoice`），仅在点击朗读时请求；不联网也能使用系统语音合成。

第三方资源与致谢：

| 资源 | 用途 | 许可 |
| --- | --- | --- |
| [Microsoft Fluent System Icons](https://github.com/microsoft/fluentui-system-icons) | 设置齿轮等界面图标 | MIT © Microsoft Corporation |
| [ECDICT](https://github.com/skywind3000/ECDICT) | 内置离线词典（仅用于分级筛选，不参与释义） | MIT |
| [有道词典语音接口](https://dict.youdao.com/dictvoice) | 单词真人发音 | 公开接口，点击时才请求 |

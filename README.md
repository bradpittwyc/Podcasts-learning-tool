# Podcasts Learning Tool · 英语学习神器

> 播放 MP4 / MP3 与播客、视频字幕跟读，点击文字跳转时间戳，**大模型分级取词查词典**（雅思 / 托福 / GRE / 受过良好教育的母语级）。
> Windows 11 风格界面（Fluent / Mica / 亚克力），提供**安装版**与**绿色便携版**。

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078D4?logo=windows)](https://www.microsoft.com/windows)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## ✨ 功能总览

| 模块 | 能力 |
| --- | --- |
| **播放器** | MP4 / MP3 / M4A / WAV / MKV / MOV / FLAC…（Chromium 支持的格式） |
| **变速** | 慢速 **0.75× / 0.5× / 0.25×**，加速最高 **2.5×**，变速不变调（preservesPitch） |
| **字幕** | 导入 + 自动配对 SRT / VTT / ASS / SSA / LRC / JSON / TXT（无时间轴也能自动断句） |
| **校对** | 软件内直接改文本与时间戳、拆分 / 合并 / 插入 / 删除、整篇平移、一键保存 SRT/VTT/JSON |
| **跳转** | 点击任意字幕行或单词 → 视频/音频立即跳到对应时间戳 |
| **文字界面** | 英文 **Times New Roman**，中文 **微软雅黑**，界面 **Segoe UI Variable**（可自定义） |
| **取词查词典** | 点单词 / 悬停 / 屏幕取词 → 中文释义 + 英文释义 + 音标 + 例句 + 语境 |
| **难度分级** | **雅思 / 托福 / GRE / Educated Native**（受过良好教育的母语级）等 8 档，**只翻译目标级别及以上的词**（省钱） |
| **屏幕取词** | ① 截图框选 + **Windows 内置 OCR**（离线、免费）② 抓取前台程序选中文字 ③ 全局快捷键 `Alt+Shift+W` |
| **跟读** | 麦克风录音、A/B 对比播放、原句后留跟读间隔、单句循环、**A-B 复读**、录音保存 |
| **生词本** | 一键收藏、搜索排序、闪卡复习、导出 CSV / JSON（可直接导入 Anki / 欧路） |
| **学习笔记** | 一键导出 Markdown（生词表 + 双语对照全文） |
| **便携版** | 单文件 exe，数据写在程序同目录，U 盘即插即用，卸载零残留 |

---

## 🚀 快速开始

### 方式一：下载即用（推荐给普通用户）

到 [Releases](https://github.com/bradpittwyc/Podcasts-learning-tool/releases) 下载：

| 文件 | 说明 |
| --- | --- |
| `Podcasts Learning Tool-Setup-1.0.0.exe` | 安装版：开始菜单 + 桌面快捷方式，数据存于 `%APPDATA%` |
| `Podcasts Learning Tool-Portable-1.0.0.exe` | **便携版**：双击即运行，数据存于 exe 同目录 `PodcastsLearningData\` |

> 未签名程序首次运行可能被 SmartScreen 拦截，点「更多信息 → 仍要运行」即可。

### 方式二：源码运行

```powershell
git clone https://github.com/bradpittwyc/Podcasts-learning-tool.git
cd Podcasts-learning-tool
npm install
npm start          # 启动
npm test           # 跑自检（123+ 项：字幕解析/编码/分级逻辑/语法/结构）
npm run dist       # 同时产出「安装版 + 便携版」到 release\
npm run dist:portable   # 只出便携版
```

需要 Node.js ≥ 18（开发时使用 Node 24 / Electron 33）。

---

## 🔑 配置大模型（查词功能）

打开应用 → 右上角 **⚙ 设置 → 大模型**：

1. 选服务商预设（默认 **DeepSeek**，中文好、价格低，约 ¥1 / 百万输入 tokens）
2. 填 **API Key**（[DeepSeek 申请入口](https://platform.deepseek.com/)，新用户有赠送额度）
3. 点 **测试连接** —— 显示 `✓ 连接成功` 即可
4. 也支持任何 **OpenAI 兼容**接口：OpenAI / Moonshot / 通义千问 / 智谱 / SiliconFlow，以及**本地 Ollama**（`http://localhost:11434/v1`，完全免费离线）

> API Key 使用 Windows DPAPI（Electron `safeStorage`）加密后保存在本地，绝不上传到本项目以外的任何地方。
> 不配置 Key 时，播放、字幕、校对、跟读、生词本功能**全部可用**，只是不能自动翻译。

---

## 💰 分级取词是怎么省钱的

这是本项目的核心设计。传统「点读」工具会给**每一个词**都生成释义，token 消耗巨大。本工具把「哪些词值得花钱」交给大模型一次性批量判断：

```
TARGET_LEVEL=TOEFL (C1)
material: "The committee's decision was met with widespread opprobrium."
                                                      ↑ 只在目标级别以上的词上花钱
→ the / committee / decision / met / with / was   → shouldExplain = false（跳过，0 释义 token）
→ opprobrium (C2, GRE, rare)                       → shouldExplain = true（生成释义）
```

省钱的四层机制：

1. **难度闸门**：低于目标级别的常用词直接跳过，不生成释义（`shouldExplain:false`）
2. **批量合并**：一屏内的候选词合成 **一次** 请求（默认 24 词/次，可调 4~60）
3. **本地永久缓存**：同一个词 + 语境只付费一次（`cache/dictionary-cache.json`，LRU 20000 条）
4. **免费 OCR**：屏幕取词用 Windows 内置 OCR，不走视觉大模型

实测参考：一集 30 分钟播客（约 1200 行字幕），按「托福及以上」取词，首次全文扫描约 **¥0.05 ~ 0.2**；同一个视频第二次打开，命中缓存**花费为 0**。
状态栏右下角实时显示本会话请求次数、token 数与估算费用。

### 级别一览

| 选项 | 对应难度 | 说明 |
| --- | --- | --- |
| 不筛选 | — | 全部单词都翻译（最贵） |
| A2 / B1 / B2 | CEFR 基础档 | 按 CEFR 排序过滤 |
| **雅思 IELTS** | C1 | 雅思 6.5+ 核心词及以上 |
| **托福 TOEFL** | C1 | 托福核心学术词及以上 |
| **GRE** | C2 | GRE 高阶词库 |
| **Educated Native** | C2+ | 受过良好教育的母语者书面语、文化典故级难词 |

过滤模式可选「级别及以上」（默认）／「仅该级别」／「交给大模型判断」（结合上下文更准，稍贵）。

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
| `Ctrl+,` | 设置 |
| **`Alt+Shift+W`**（全局） | 任意程序内屏幕取词 |
| **`Alt+Shift+Space`**（全局） | 任意程序内播放 / 暂停 |

---

## 🖥 屏幕取词（任何软件里都能查词）

三种方式，互为补充：

1. **截图 OCR（默认，离线免费）**：按 `Ctrl+Shift+S` 或点工具栏「屏幕取词」→ 鼠标框选屏幕上的任意英文（YouTube 视频、Kindle、PDF、图片）→ **Windows 内置 OCR** 识别 → 大模型按当前级别挑出难词并给释义。
   - 首次使用会弹出 Windows 的「屏幕录制权限」请求（用于截取屏幕画面，画面不会离开本机）。
   - 若提示 OCR 引擎不可用：Windows 设置 → 时间和语言 → 语言和区域 → 添加「English (United States)」语言包（勾选**光学字符识别**组件）。设置 → 高级 → 「OCR 可用性检测」可一键验证。
2. **抓取前台选中文字**：在浏览器/PDF 里选中英文 → 按全局快捷键 `Alt+Shift+W` → 弹出置顶浮窗显示难词释义（自动复制并还原你原来的剪贴板内容）。
3. **应用内选中**：在右侧文字区选中任意文本 → `Ctrl+D`。

> 技术说明：截图 OCR 走的是 Windows 自带的 `Windows.Media.Ocr` 引擎（通过 `scripts/ocr.ps1` 调用），
> 完全离线、零 API 费用，也避免了把屏幕内容发给云端视觉模型。PowerShell 5.1 无法直接 await WinRT
> 异步操作，脚本内用一段反射桥接（`AsTask<T>` + PowerShell 构造的封闭泛型接口）解决。

---

## 🎧 跟读（Shadowing）工作流建议

1. 打开一集播客（拖入 MP4/MP3，同名字幕会自动加载）
2. 顶栏「取词级别」选 **托福**，点「扫描难词」→ 全文难词被高亮并显示中文
3. 把速度调到 **0.75×** 或 **0.5×**，点任意一句开始精听；`L` 打开单句循环
4. 点工具栏 🎙 打开跟读面板 → 「开始录音」→ 回放对比，或「A/B 对比」听原声与自己的差距
5. `A` 设置 **A-B 复读**，反复啃最难的 5 秒
6. 生词加入生词本 → 「闪卡复习」→ 导出 CSV 到手机 App

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
    ocr.js               Windows.Media.Ocr 桥接（离线屏幕取词）
    screen-text.js       抓取前台程序选中文字（SendKeys + 剪贴板还原）
  preload/preload.js     contextBridge 白名单 API
  renderer/
    index.html           主界面（标题栏 / 命令栏 / 播放区 / 文字区 / 状态栏）
    quick.html           屏幕取词浮窗
    css/                 tokens(设计标记) app player transcript panels
    js/
      subtitles.js       字幕引擎（主/渲染共用：SRT/VTT/ASS/LRC/JSON/TXT、编码嗅探、分词、词形还原）
      player.js          播放器（0.25×~2.5×、A-B 复读、单句循环、画中画）
      transcript.js      文字区（Times New Roman + 微软雅黑、点词查词、校对编辑）
      dict.js            查词面板、批量扫描、成本统计、截图 OCR 框选
      shadow.js          跟读录音与 A/B 对比
      settings.js        设置面板（大模型 / 取词级别 / 外观 / 播放 / 高级）
      app.js             主控：文件导入、同步、导航、快捷键
scripts/
  ocr.ps1                Windows OCR 实现（含 WinRT 异步桥接，UTF-8 with BOM）
  ocr-selftest.js        OCR 链路自检（生成测试图 → 识别 → 断言）
  make-icon.js           纯 JS 生成多尺寸 ICO 图标
  make-sample.js         用 ffmpeg 生成示例媒体与中英字幕
  fix-ps1-bom.js         为 .ps1 补 UTF-8 BOM（PowerShell 5.1 必需）
  selftest.js            无界面自检（字幕解析 / 编码 / 分级逻辑 / 语法 / 结构）
```

---

## 🧪 自检与验证

```powershell
npm test          # 128 项无界面自检
npm run test:ocr  # 验证 Windows OCR 链路（生成图片→识别→校验文本）
npm run sample    # 用 ffmpeg 生成 60 秒示例视频/音频/中英字幕到 samples\
npm run smoke     # 真实启动应用，加载示例、截图、检查播放与字幕同步（需先 npm run sample）
```

`npm test` 覆盖：时间戳解析与格式化、双语拆分、SRT/VTT/ASS/LRC/JSON/纯文本解析、序列化往返、
UTF-8/UTF-16/GBK 编码嗅探、正文分词与词形还原、级别分级判定、工程文件完整性、脚本语法与 HTML 结构。

`npm run smoke` 会真实启动 Electron 窗口，验证：自定义 `plt-media://` 协议能否播放 MP4（时长/解码/跳转）、
同名字幕自动配对、24 行字幕渲染、快捷键与进度条联动，并在 `samples\` 下输出三张截图（整窗 / 文字区 1:1 / 词典面板）。

> 打包前的完整验证流程：`npm test` → `npm run test:ocr` → `npm run sample` → `npm run smoke` → `npm run dist`

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

**Q：想完全离线、不花钱？**
A：装 [Ollama](https://ollama.com/) 后设置服务商选「本地 Ollama」即可；屏幕取词本来就用的离线 OCR。

**Q：便携版和安装版能同时用吗？**
A：可以，各自独立的数据目录，互不影响。

---

## 📄 许可

[MIT](LICENSE) © 2025 bradpittwyc

第三方接口说明：单词发音使用有道词典公开语音接口（`dict.youdao.com/dictvoice`），仅在点击朗读时请求；不联网也能使用系统语音合成。

'use strict';
/**
 * main.js — Electron 主进程
 *  · 无边框 Win11 风格窗口（Fluent / Mica / 自绘标题栏 + 系统 WCO 按钮）
 *  · 自定义 plt-media:// 协议，安全地流式播放本地 MP4/MP3（支持 Range 拖动）
 *  · 文件对话框、字幕解析/校对/导出、历史记录、生词本
 *  · IPC：大模型分级取词、OCR 屏幕取词、全局快捷键
 */

const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, clipboard, globalShortcut, Menu, nativeTheme, screen } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const store = require('./store');
const subs = require('../renderer/js/subtitles'); // 主/渲染共用的字幕引擎（单一实现）
const llm = require('./llm');
const localDict = require('./local-dict');
const ocr = require('./ocr');
const screenText = require('./screen-text');

const isDev = process.argv.includes('--dev') || !!process.env.PLT_DEV;
const isSmoke = process.argv.includes('--smoke-test');
const isSmokeUi = process.argv.includes('--smoke-ui');
const smokeOut = (() => {
  const i = process.argv.indexOf('--smoke-out');
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
})();

// ─────────────────────────────────────────────────────────────
// 应用名（决定 userData 目录：%APPDATA%\Podcasts Learning Tool）
// 必须在任何 app.getPath('userData') 之前设置，否则会退回 "Electron" 目录。
// ─────────────────────────────────────────────────────────────
app.setName('Podcasts Learning Tool');

// ─────────────────────────────────────────────────────────────
// 单实例
// ─────────────────────────────────────────────────────────────
let mainWindow = null;
let quickWindow = null;
const pendingOpenFiles = [];

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = collectArgvFiles(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('app:open-files', files);
    }
  });
}

function isSupportedFile(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  if (!subs.MEDIA_EXT.includes(ext) && !subs.SUBTITLE_EXT.includes(ext)) return false;
  // 目录不能当文件打开（例如 --smoke-folder 后面的路径）
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * 从命令行参数里挑出「要打开的文件」。
 * 必须跳开带值的开关（--smoke-out / --smoke-folder …）后面的参数，否则会把目录当成媒体文件。
 */
function collectArgvFiles(argv) {
  const VALUE_FLAGS = new Set(['--smoke-out', '--smoke-folder', '--user-data-dir', '--lang', '--remote-debugging-port']);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (VALUE_FLAGS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    if (i <= 1) continue;              // argv[0]=exe, argv[1]=app 目录（或第一个文件关联参数）
    if (isSupportedFile(a)) out.push(a);
  }
  // 文件关联启动时目标文件位于 argv[1]，单独兜底判断
  if (argv[1] && isSupportedFile(argv[1])) out.unshift(argv[1]);
  return [...new Set(out)];
}

// ─────────────────────────────────────────────────────────────
// 便携模式：必须在 app ready 之前改 userData
// ─────────────────────────────────────────────────────────────
(function applyPortablePaths() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  let base = null;
  if (portableDir) base = portableDir;
  else {
    try {
      const exeDir = path.dirname(app.getPath('exe'));
      if (fs.existsSync(path.join(exeDir, 'portable.flag')) || fs.existsSync(path.join(exeDir, 'portable-data'))) base = exeDir;
    } catch (_) { /* ignore */ }
  }
  if (base) {
    // 便携模式把 userData 也放进数据目录，缓存/设置全部随身携带
    const dataDir = path.join(base, 'PodcastsLearningData');
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      app.setPath('userData', dataDir);
      app.setPath('sessionData', path.join(dataDir, 'session'));
      process.env.PLT_PORTABLE = '1';
    } catch (err) {
      console.error('[portable] 无法设置数据目录：', err.message);
    }
  }
})();

// 只允许单实例（放在 userData 设置后，锁文件才会落在便携目录）
if (gotLock) app.setAppUserModelId('com.bradpittwyc.podcastlearning');

// ─────────────────────────────────────────────────────────────
// 自定义媒体协议：plt-media://local/<urlencoded-abs-path>
//
// 关键：必须自己实现 HTTP Range（206 Partial Content）与 Accept-Ranges 头，
// 否则 Chromium 认为媒体不可 seek —— 表现为拖动进度条、点击字幕跳转都无效
// （currentTime 赋值被静默忽略，播放位置永远回到 0）。
// ─────────────────────────────────────────────────────────────
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'plt-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true, corsEnabled: true }
  }
]);

const MIME_BY_EXT = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.flac': 'audio/flac', '.wma': 'audio/x-ms-wma'
};

function mediaUrlFor(absPath) {
  return 'plt-media://local/' + encodeURIComponent(absPath).replace(/%2F/gi, '/');
}

function pathFromMediaUrl(requestUrl) {
  const url = new URL(requestUrl);
  let rel = decodeURIComponent(url.pathname || '');
  if (rel.startsWith('/')) rel = rel.slice(1);
  return path.normalize(rel); // Windows 盘符：plt-media://local/E:/x/y.mp4
}

/** 解析 Range 头：bytes=START-END / bytes=START- / bytes=-SUFFIX */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return null;
  let start;
  let end;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Math.min(Number(m[2]), size - 1) : size - 1;
  } else {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return { invalid: true };
  return { start, end };
}

function registerMediaProtocol() {
  protocol.handle('plt-media', async (request) => {
    let stream = null;
    try {
      const abs = pathFromMediaUrl(request.url);
      if (!path.isAbsolute(abs)) return new Response('bad path', { status: 400 });
      let stat;
      try { stat = await fsp.stat(abs); } catch (_) { return new Response('not found', { status: 404 }); }
      if (!stat.isFile()) return new Response('not a file', { status: 404 });

      const size = stat.size;
      const type = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
      const rangeHeader = request.headers.get('Range') || request.headers.get('range');
      const isHead = request.method === 'HEAD';

      // 无 Range：返回完整文件，但声明支持 Range（这是 seek 的前提）
      if (!rangeHeader) {
        const body = isHead ? null : fs.createReadStream(abs);
        if (body) body.on('error', (err) => console.error('[plt-media] 读取失败：', err.message));
        return new Response(body, {
          status: 200,
          headers: {
            'Content-Type': type,
            'Content-Length': String(size),
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
          }
        });
      }

      const range = parseRange(rangeHeader, size);
      if (!range || range.invalid) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' }
        });
      }
      const { start, end } = range;
      const chunkSize = end - start + 1;
      if (!isHead) {
        stream = fs.createReadStream(abs, { start, end });
        stream.on('error', (err) => console.error('[plt-media] 分片读取失败：', err.message));
      }
      return new Response(stream, {
        status: 206,
        headers: {
          'Content-Type': type,
          'Content-Length': String(chunkSize),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store'
        }
      });
    } catch (err) {
      // 播放器频繁 seek 会取消旧请求，销毁流是正常现象，不要让它冒泡成未处理异常
      try { if (stream) stream.destroy(); } catch (_) { /* ignore */ }
      console.error('[plt-media] 请求失败：', err.message);
      return new Response('error: ' + err.message, { status: 500 });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 窗口
// ─────────────────────────────────────────────────────────────
function createMainWindow() {
  const s = store.settings();
  const win = s.get('window', {});
  const wide = { width: win.width || 1480, height: win.height || 920 };
  const bounds = {
    ...wide,
    x: Number.isFinite(win.x) ? win.x : undefined,
    y: Number.isFinite(win.y) ? win.y : undefined
  };

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 1020,
    minHeight: 640,
    show: false,
    title: 'Podcasts Learning Tool',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f6f7fb',
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: undefined,
    roundedCorners: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      webSecurity: true
    }
  });

  applyBackdrop(mainWindow);
  if (win.maximized) mainWindow.maximize();
  mainWindow.setAlwaysOnTop(!!win.alwaysOnTop);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  const persist = debounce(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const max = mainWindow.isMaximized();
    const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
    store.settings().patch({
      window: { width: b.width, height: b.height, x: b.x, y: b.y, maximized: max, alwaysOnTop: mainWindow.isAlwaysOnTop() }
    });
  }, 400);

  mainWindow.on('resize', persist);
  mainWindow.on('move', persist);
  mainWindow.on('maximize', () => { sendWindowState(); persist(); });
  mainWindow.on('unmaximize', () => { sendWindowState(); persist(); });
  mainWindow.on('enter-full-screen', sendWindowState);
  mainWindow.on('leave-full-screen', sendWindowState);
  mainWindow.on('closed', () => { mainWindow = null; });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); }
  });

  return mainWindow;
}

function applyBackdrop(win) {
  const s = store.settings();
  if (process.platform !== 'win32' || !win.setBackgroundMaterial) return;
  const want = s.get('ui.mica', true) ? s.get('ui.backdrop', 'acrylic') : 'none';
  try {
    win.setBackgroundMaterial(want === 'none' ? 'none' : want);
  } catch (_) {
    try { win.setBackgroundMaterial('mica'); } catch (__) { /* ignore */ }
  }
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:state', {
    maximized: mainWindow.isMaximized(),
    fullscreen: mainWindow.isFullScreen(),
    alwaysOnTop: mainWindow.isAlwaysOnTop(),
    focused: mainWindow.isFocused()
  });
}

/**
 * 渲染进程完成初始化后主动通知主进程，此时才投递「要打开的文件」。
 * （页面脚本注册 IPC 监听发生在 did-finish-load 之后，直接发送会丢事件）
 */
function flushPendingOpenFiles(target) {
  const win = target || mainWindow;
  if (!win || win.isDestroyed()) return;
  if (!pendingOpenFiles.length) return;
  win.webContents.send('app:open-files', pendingOpenFiles.splice(0));
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
}

// ─────────────────────────────────────────────────────────────
// 快捷查词浮窗（屏幕取词结果）
// ─────────────────────────────────────────────────────────────
function createQuickWindow(payload) {
  if (quickWindow && !quickWindow.isDestroyed()) {
    quickWindow.webContents.send('quick:payload', payload);
    quickWindow.showInactive();
    return quickWindow;
  }
  quickWindow = new BrowserWindow({
    width: 420,
    height: 480,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    transparent: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  applyBackdrop(quickWindow);
  quickWindow.loadFile(path.join(__dirname, '..', 'renderer', 'quick.html'));
  quickWindow.once('ready-to-show', () => {
    quickWindow.webContents.send('quick:payload', payload);
    quickWindow.showInactive();
  });
  quickWindow.on('blur', () => { if (quickWindow && !quickWindow.isDestroyed()) quickWindow.hide(); });
  quickWindow.on('closed', () => { quickWindow = null; });
  return quickWindow;
}

// ─────────────────────────────────────────────────────────────
// 应用菜单（中文）
// ─────────────────────────────────────────────────────────────
function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    {
      label: '文件(&F)',
      submenu: [
        { label: '打开媒体文件…', accelerator: 'CmdOrCtrl+O', click: () => mainWindow?.webContents.send('menu:action', 'open-media') },
        { label: '打开字幕文件…', accelerator: 'CmdOrCtrl+Shift+O', click: () => mainWindow?.webContents.send('menu:action', 'open-subtitle') },
        { label: '批量导入文件夹…', click: () => mainWindow?.webContents.send('menu:action', 'open-folder') },
        { type: 'separator' },
        { label: '保存校对后的字幕…', accelerator: 'CmdOrCtrl+S', click: () => mainWindow?.webContents.send('menu:action', 'save-subtitle') },
        { label: '导出学习笔记(Markdown)…', click: () => mainWindow?.webContents.send('menu:action', 'export-notes') },
        { type: 'separator' },
        { label: '退出', role: isMac ? 'close' : 'quit' }
      ]
    },
    {
      label: '播放(&P)',
      submenu: [
        { label: '播放/暂停', accelerator: 'Space', click: () => mainWindow?.webContents.send('menu:action', 'toggle-play') },
        { label: '上一句', accelerator: 'CmdOrCtrl+Left', click: () => mainWindow?.webContents.send('menu:action', 'prev-line') },
        { label: '下一句', accelerator: 'CmdOrCtrl+Right', click: () => mainWindow?.webContents.send('menu:action', 'next-line') },
        { label: '重播当前句', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.send('menu:action', 'replay-line') },
        { type: 'separator' },
        { label: '减速', accelerator: 'CmdOrCtrl+[', click: () => mainWindow?.webContents.send('menu:action', 'speed-down') },
        { label: '加速', accelerator: 'CmdOrCtrl+]', click: () => mainWindow?.webContents.send('menu:action', 'speed-up') },
        { type: 'separator' },
        { label: '显示/隐藏字幕', accelerator: 'CmdOrCtrl+H', click: () => mainWindow?.webContents.send('menu:action', 'toggle-subtitle') }
      ]
    },
    {
      label: '学习(&L)',
      submenu: [
        { label: '查词（选中文本）', accelerator: 'CmdOrCtrl+D', click: () => mainWindow?.webContents.send('menu:action', 'lookup-selection') },
        { label: '屏幕取词（截图 OCR）', accelerator: 'CmdOrCtrl+Shift+S', click: () => mainWindow?.webContents.send('menu:action', 'screen-ocr') },
        { label: '扫描全文难词（按当前级别）', accelerator: 'CmdOrCtrl+Shift+D', click: () => mainWindow?.webContents.send('menu:action', 'scan-all') },
        { type: 'separator' },
        { label: '生词本', click: () => mainWindow?.webContents.send('menu:action', 'show-vocab') }
      ]
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '放大界面', accelerator: 'CmdOrCtrl+=', click: () => mainWindow?.webContents.send('menu:action', 'zoom-in') },
        { label: '缩小界面', accelerator: 'CmdOrCtrl+-', click: () => mainWindow?.webContents.send('menu:action', 'zoom-out') },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => mainWindow?.webContents.send('menu:action', 'zoom-reset') },
        { type: 'separator' },
        { label: '浅色/深色跟随系统', click: () => mainWindow?.webContents.send('menu:action', 'theme-system') },
        { label: '强制浅色', click: () => mainWindow?.webContents.send('menu:action', 'theme-light') },
        { label: '强制深色', click: () => mainWindow?.webContents.send('menu:action', 'theme-dark') },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: '使用说明 / README', click: () => shell.openExternal('https://github.com/bradpittwyc/Podcasts-learning-tool#readme') },
        { label: '项目主页', click: () => shell.openExternal('https://github.com/bradpittwyc/Podcasts-learning-tool') },
        { type: 'separator' },
        { label: '数据目录', click: () => shell.openPath(store.getDataDir()) },
        { label: '关于', click: () => mainWindow?.webContents.send('menu:action', 'about') }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────
// 全局快捷键
// ─────────────────────────────────────────────────────────────
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const hk = store.settings().get('hotkeys', {});
  const bind = (accel, handler) => {
    if (!accel) return;
    try { globalShortcut.register(accel, handler); } catch (err) { console.error('[hotkey]', accel, err.message); }
  };
  bind(hk.quickLookup, async () => {
    // 屏取词：优先抓前台程序选中文字；失败则让主窗口进入框选 OCR
    const res = await screenText.captureSelection({});
    if (res.ok && res.text) {
      createQuickWindow({ mode: 'text', text: res.text, source: 'selection' });
    } else if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('menu:action', 'screen-ocr');
    }
  });
  bind(hk.playPause, () => mainWindow?.webContents.send('menu:action', 'toggle-play'));
  bind(hk.repeatLine, () => mainWindow?.webContents.send('menu:action', 'replay-line'));
}

// ─────────────────────────────────────────────────────────────
// IPC — 窗口控制
// ─────────────────────────────────────────────────────────────
function registerIpc() {
  ipcMain.handle('window:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.handle('window:toggleMaximize', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    if (w.isMaximized()) w.unmaximize(); else w.maximize();
    return w.isMaximized();
  });
  ipcMain.handle('window:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.handle('window:state', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return {};
    return { maximized: w.isMaximized(), fullscreen: w.isFullScreen(), alwaysOnTop: w.isAlwaysOnTop(), focused: w.isFocused() };
  });
  ipcMain.handle('window:setAlwaysOnTop', (e, flag) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w?.setAlwaysOnTop(!!flag);
    store.settings().set('window.alwaysOnTop', !!flag);
    return !!flag;
  });
  ipcMain.handle('window:setFullScreen', (e, flag) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    w?.setFullScreen(!!flag);
    return !!flag;
  });
  ipcMain.handle('window:hideQuick', () => { quickWindow?.hide(); });
  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:/i.test(String(url))) shell.openExternal(String(url)); });
  ipcMain.handle('app:openPath', (_e, p) => shell.openPath(String(p)));
  ipcMain.handle('app:showItemInFolder', (_e, p) => { shell.showItemInFolder(String(p)); });
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    portable: store.isPortable(),
    dataDir: store.getDataDir(),
    packaged: app.isPackaged
  }));
  // 渲染进程就绪握手：此时才投递待打开文件
  ipcMain.handle('app:ready', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    flushPendingOpenFiles(win);
    return true;
  });

  // ── 主题 ──
  ipcMain.handle('theme:set', (_e, theme) => {
    store.settings().set('ui.theme', theme);
    nativeTheme.themeSource = theme === 'system' ? 'system' : theme;
    applyBackdrop(mainWindow);
    return nativeTheme.shouldUseDarkColors;
  });
  ipcMain.handle('theme:resolve', () => ({
    dark: nativeTheme.shouldUseDarkColors,
    source: nativeTheme.themeSource
  }));
  ipcMain.handle('ui:setBackdrop', (_e, backdrop) => {
    store.settings().set('ui.backdrop', backdrop);
    applyBackdrop(mainWindow);
    return true;
  });

  // ── 设置 ──
  ipcMain.handle('settings:get', () => store.publicSettings());
  ipcMain.handle('settings:patch', (_e, patch) => {
    const before = store.settings().get('hotkeys', {});
    store.settings().patch(patch || {});
    const after = store.settings().get('hotkeys', {});
    if (JSON.stringify(before) !== JSON.stringify(after)) registerHotkeys();
    const applied = store.publicSettings();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', applied);
    return applied;
  });
  ipcMain.handle('settings:reset', () => {
    store.settings().reset();
    registerHotkeys();
    const applied = store.publicSettings();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', applied);
    return applied;
  });
  ipcMain.handle('settings:setApiKey', (_e, key) => store.setApiKey(String(key || '').trim()));
  ipcMain.handle('settings:testLLM', () => llm.testConnection());

  // ── 文件 ──
  ipcMain.handle('dialog:openMedia', async () => {
    const s = store.settings();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '打开视频 / 音频文件',
      defaultPath: s.get('ui.lastDir') || app.getPath('videos'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '媒体文件 (MP4/MP3/M4A/WAV/MKV)', extensions: subs.MEDIA_EXT.map((e) => e.slice(1)) },
        { name: '视频', extensions: ['mp4', 'mkv', 'webm', 'mov', 'm4v'] },
        { name: '音频', extensions: ['mp3', 'm4a', 'aac', 'wav', 'ogg', 'flac', 'opus', 'wma'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    store.settings().set('ui.lastDir', path.dirname(res.filePaths[0]));
    return res.filePaths.map(describeMedia);
  });

  ipcMain.handle('dialog:openSubtitle', async () => {
    const s = store.settings();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '打开字幕文件',
      defaultPath: s.get('ui.lastDir') || app.getPath('videos'),
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '字幕文件 (srt/vtt/ass/lrc/json/txt)', extensions: subs.SUBTITLE_EXT.map((e) => e.slice(1)) },
        { name: '全部文件', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return null;
    store.settings().set('ui.lastDir', path.dirname(res.filePaths[0]));
    return res.filePaths.map((p) => {
      try { return subs.loadSubtitleFile(p); } catch (err) { return { path: p, name: path.basename(p), error: err.message, cues: [] }; }
    });
  });

  ipcMain.handle('dialog:openFolder', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: '导入文件夹（自动配对同名媒体与字幕）',
      properties: ['openDirectory']
    });
    if (res.canceled || !res.filePaths.length) return null;
    return scanFolder(res.filePaths[0]);
  });

  ipcMain.handle('dialog:saveSubtitle', async (_e, payload) => {
    const { cues, defaultName, format } = payload || {};
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存校对后的字幕',
      defaultPath: defaultName || 'subtitle.srt',
      filters: [
        { name: 'SubRip 字幕 (*.srt)', extensions: ['srt'] },
        { name: 'WebVTT 字幕 (*.vtt)', extensions: ['vtt'] },
        { name: 'JSON 字幕稿 (*.json)', extensions: ['json'] }
      ]
    });
    if (res.canceled || !res.filePath) return null;
    return subs.saveSubtitleFile(res.filePath, cues, { format: format || undefined, bilingual: true });
  });

  ipcMain.handle('dialog:saveText', async (_e, payload) => {
    const { content, defaultName, filters } = payload || {};
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出',
      defaultPath: defaultName || 'export.txt',
      filters: filters || [{ name: 'Markdown', extensions: ['md'] }, { name: '文本', extensions: ['txt'] }]
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, content ?? '', 'utf8');
    return { path: res.filePath };
  });

  ipcMain.handle('file:loadSubtitle', (_e, filePath) => {
    try { return subs.loadSubtitleFile(filePath); }
    catch (err) { return { path: filePath, error: err.message, cues: [] }; }
  });

  ipcMain.handle('file:readText', async (_e, filePath) => {
    try { return { ok: true, text: await fsp.readFile(filePath, 'utf8') }; }
    catch (err) { return { ok: false, error: err.message }; }
  });

  ipcMain.handle('file:describe', (_e, filePath) => {
    try { return describeMedia(filePath); } catch (err) { return { path: filePath, error: err.message }; }
  });

  ipcMain.handle('file:findSiblingSubtitle', (_e, mediaPath) => {
    const found = subs.findSiblingSubtitle(mediaPath);
    return found ? { path: found } : null;
  });

  // 扫描文件夹并配对同名字幕（供「文件夹导入」列表与自动化测试复用）
  ipcMain.handle('file:scanFolder', (_e, dir) => {
    try { return scanFolder(dir); } catch (err) { const r = [{ error: err.message }]; r.subtitles = []; return r; }
  });

  /**
   * 列出可用于当前媒体的字幕文件：
   *   1) 同一目录下所有字幕（默认，便于手动挑一份）
   *   2) 全盘扫描过的目录（dir 参数，来自「文件夹导入」）
   *   3) 已在本应用加载过的字幕（renderer 侧合并）
   */
  ipcMain.handle('file:listSubtitles', async (_e, payload) => {
    const { dir, mediaPath } = payload || {};
    const list = [];
    const seen = new Set();
    const push = (full, extra) => {
      const key = String(full).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      let size = 0;
      let mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (_) { /* ignore */ }
      list.push({
        path: full,
        name: path.basename(full),
        dir: path.dirname(full),
        size,
        mtime,
        matched: !!(extra && extra.matched)
      });
    };

    // 1) 媒体同目录
    if (mediaPath) {
      const mediaDir = path.dirname(mediaPath);
      const base = path.basename(mediaPath, path.extname(mediaPath)).toLowerCase();
      let entries = [];
      try { entries = fs.readdirSync(mediaDir, { withFileTypes: true }); } catch (_) { entries = []; }
      for (const e of entries) {
        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!subs.SUBTITLE_EXT.includes(ext)) continue;
        // 纯 .txt 没有时间轴，导入需要额外输入时长，不放进快速选择列表
        if (ext === '.txt') continue;
        const nb = path.basename(e.name, path.extname(e.name)).toLowerCase();
        push(path.join(mediaDir, e.name), { matched: nb === base || nb.startsWith(base) });
      }
      list.sort((a, b) => (Number(b.matched) - Number(a.matched)) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    }

    // 2) 指定目录（递归）—— 去重，避免与同目录结果重复
    if (dir && dir.toLowerCase() !== (mediaPath ? path.dirname(mediaPath).toLowerCase() : '')) {
      try {
        const rows = scanFolder(dir);
        for (const s of (rows.subtitles || [])) push(s.path, {});
      } catch (_) { /* ignore */ }
    }
    return list;
  });

  ipcMain.handle('file:autoSaveSubtitle', async (_e, payload) => {
    // 自动保存到媒体同目录（校对后一键落盘）
    const { cues, targetPath } = payload || {};
    if (!targetPath) return null;
    return subs.saveSubtitleFile(targetPath, cues, { bilingual: true });
  });

  // ── 离线本地词典（0 费用）──
  ipcMain.handle('dict:stats', () => localDict.stats());
  ipcMain.handle('dict:lookup', (_e, payload) => {
    const { requests, options } = payload || {};
    try {
      return { ok: true, ...localDict.lookupBatch(requests || [], options || {}) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ── 大模型取词 ──
  ipcMain.handle('llm:lookup', async (_e, payload) => {
    try {
      const { requests, options } = payload || {};
      const s = store.settings();
      const useLocal = options && options.localDict !== undefined ? !!options.localDict : !!s.get('lookup.localDict', true);
      // 默认走「本地优先 + 只对难词调用 AI」的分级路由
      if (useLocal && !(options && options.noLocal)) {
        return await llm.lookupTiered(requests || [], options || {});
      }
      const res = await llm.lookupBatch(requests || [], options || {});
      return { ok: true, ...res };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message, partial: err.partial || null };
    }
  });
  ipcMain.handle('llm:lookupWord', async (_e, payload) => {
    try {
      const { word, context, options } = payload || {};
      const s = store.settings();
      const levelId = (options && options.level) || s.get('lookup.level', 'toefl');
      const lockLevel = s.get('lookup.lockLevel', false);
      const useLocal = s.get('lookup.localDict', true);
      const force = !!(options && options.force);

      // ① 本地词典优先
      const hit = useLocal ? localDict.get(word) : null;
      if (hit) {
        const atLevel = localDict.meetsTier(hit, levelId);
        const expanded = localDict.lookupBatch([{ word, context }], { level: levelId, lockLevel: false }).entries[String(word).toLowerCase()];
        if (!atLevel && lockLevel && !force) {
          return { ok: true, entry: null, blocked: true, reason: 'below-level-locked', cefr: expanded ? expanded.cefr : '', toApi: 0, fromCache: 0 };
        }
        // 难词且需要语境 → 追加 AI 分析；否则直接用本地释义（0 费用）
        const wantAi = force || (atLevel && s.get('lookup.llmForContext', true) && localDict.needsContext(hit));
        if (!wantAi) {
          return { ok: true, entry: expanded, toApi: 0, fromCache: 0, source: 'local' };
        }
        const tier = await llm.lookupTiered([{ word, context }], { level: levelId, lockLevel, force: true });
        const key = String(word).toLowerCase();
        const entry = tier.entries[key] || expanded;
        return { ok: true, entry, toApi: tier.stats.aiCalls, fromCache: tier.stats.aiSkippedByCache, usage: tier.usage, source: entry ? entry.source : 'local' };
      }

      // ② 本地没有 → 大模型（仍遵守级别锁定）
      const tier = await llm.lookupTiered([{ word, context }], { level: levelId, lockLevel, localDict: false });
      const key = String(word).toLowerCase();
      if (tier.blocked && tier.blocked[key]) {
        return { ok: true, entry: null, blocked: true, reason: 'below-level-locked', toApi: 0, fromCache: 0 };
      }
      return { ok: true, entry: tier.entries[key] || null, toApi: tier.stats.aiCalls, fromCache: tier.stats.aiSkippedByCache, usage: tier.usage, source: 'ai' };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message, partial: err.partial || null };
    }
  });
  ipcMain.handle('llm:scanLine', async (_e, payload) => {
    try {
      const { text, context, options } = payload || {};
      return { ok: true, ...(await llm.scanLine(text, context, options || {})) };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message };
    }
  });
  ipcMain.handle('llm:scanTranscript', async (_e, payload) => {
    try {
      const { cues, options } = payload || {};
      const opts = options || {};
      const s = store.settings();
      const useLocal = s.get('lookup.localDict', true);
      if (!useLocal) return { ok: true, ...(await llm.scanTranscript(cues || [], opts)) };

      // 本地词典扫描：0 费用、毫秒级；只有「本地没有 / 需要语境」的词才交给 AI
      const levelId = opts.level || s.get('lookup.level', 'toefl');
      const lockLevel = !!s.get('lookup.lockLevel', false);
      const limit = Math.max(1, Math.min(Number(opts.limit || s.get('lookup.autoScanLimit', 400)), 4000));
      const slice = (cues || []).slice(0, limit);
      const seen = new Map();
      for (const cue of slice) {
        const text = cue.en || cue.text || '';
        for (const w of subs.extractCandidates(text)) {
          if (!seen.has(w.lower)) seen.set(w.lower, { word: w.word, context: text });
        }
      }
      const list = [...seen.values()];
      const t0 = Date.now();
      const res = await llm.lookupTiered(list, {
        level: levelId,
        lockLevel,
        onlyLocal: opts.onlyLocal === true || opts.noAi === true,
        topic: opts.topic
      });
      return {
        ok: true,
        entries: res.entries,
        skipped: res.skipped,
        below: res.below,
        blocked: res.blocked,
        partial: !!res.partial,
        aiError: res.aiError || null,
        scannedLines: slice.length,
        uniqueWords: list.length,
        level: levelId,
        localHits: res.stats.localHits,
        llmWords: res.stats.llmWords,
        blockedCount: res.stats.blocked,
        toApi: res.stats.aiCalls,
        fromCache: res.stats.aiSkippedByCache,
        usage: res.usage,
        ms: Date.now() - t0,
        engine: 'local+ai'
      };
    } catch (err) {
      return { ok: false, code: err.code || 'ERROR', error: err.message };
    }
  });
  ipcMain.handle('llm:levels', () => llm.LEVELS);
  ipcMain.handle('llm:cacheStats', () => llm.cacheStats());
  ipcMain.handle('llm:clearCache', () => llm.clearCache());

  // ── 屏幕取词 ──
  ipcMain.handle('screen:captureSelection', () => screenText.captureSelection({}));
  ipcMain.handle('screen:captureSources', async () => {
    try {
      const { desktopCapturer } = require('electron');
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      return sources.map((s) => ({ id: s.id, name: s.display_id ? `显示器 ${s.display_id}` : s.name, displayId: s.display_id }));
    } catch (err) {
      return [{ error: err.message }];
    }
  });
  ipcMain.handle('screen:ocr', async (_e, payload) => {
    const { dataUrl, langs } = payload || {};
    const res = await ocr.recognizeDataUrl(dataUrl, { langs });
    return res;
  });
  ipcMain.handle('screen:ocrProbe', () => ocr.probe());
  ipcMain.handle('screen:displayBounds', () => {
    const displays = screen.getAllDisplays();
    return displays.map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id }));
  });
  ipcMain.handle('screen:showQuick', (_e, payload) => { createQuickWindow(payload || {}); return true; });

  // ── 剪贴板 ──
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('clipboard:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });

  // ── 生词本 ──
  ipcMain.handle('vocab:list', () => store.vocab().get('items', []));
  ipcMain.handle('vocab:add', (_e, item) => {
    const v = store.vocab();
    const items = v.get('items', []);
    const key = String(item?.lemma || item?.word || '').toLowerCase();
    const exist = items.find((x) => String(x.lemma || x.word).toLowerCase() === key);
    if (exist) {
      Object.assign(exist, item, { updatedAt: Date.now(), count: (exist.count || 1) + 1 });
      v.set('items', items);
      return { ok: true, updated: true, item: exist };
    }
    const rec = { ...item, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, addedAt: Date.now(), count: 1 };
    items.unshift(rec);
    v.set('items', items.slice(0, 20000));
    return { ok: true, item: rec };
  });
  ipcMain.handle('vocab:remove', (_e, idOrWord) => {
    const v = store.vocab();
    const key = String(idOrWord || '').toLowerCase();
    const items = v.get('items', []).filter((x) => x.id !== idOrWord && String(x.lemma || x.word).toLowerCase() !== key);
    v.set('items', items);
    return { ok: true, items };
  });
  ipcMain.handle('vocab:update', (_e, payload) => {
    const { id, patch } = payload || {};
    const v = store.vocab();
    const items = v.get('items', []);
    const it = items.find((x) => x.id === id);
    if (it) { Object.assign(it, patch || {}); v.set('items', items); return { ok: true, item: it }; }
    return { ok: false };
  });
  ipcMain.handle('vocab:clear', () => { store.vocab().set('items', []); return { ok: true }; });
  ipcMain.handle('vocab:export', async () => {
    const items = store.vocab().get('items', []);
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '导出生词本',
      defaultPath: 'vocabulary.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }, { name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return null;
    if (path.extname(res.filePath).toLowerCase() === '.json') {
      await fsp.writeFile(res.filePath, JSON.stringify(items, null, 2), 'utf8');
    } else {
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const rows = [['word', 'lemma', 'phonetic', 'pos', 'cefr', 'examLevels', 'translation', 'enDef', 'example', 'source', 'addedAt'].join(',')];
      for (const it of items) {
        rows.push([it.word, it.lemma, it.phonetic, it.pos, it.cefr, (it.examLevels || []).join('/'), it.translation, it.enDef, it.example, it.source, new Date(it.addedAt || Date.now()).toISOString()].map(esc).join(','));
      }
      await fsp.writeFile(res.filePath, '\uFEFF' + rows.join('\r\n'), 'utf8');
    }
    return { path: res.filePath, count: items.length };
  });

  // ── 历史记录 ──
  ipcMain.handle('history:list', () => store.history().get('items', []));
  ipcMain.handle('history:add', (_e, item) => {
    const h = store.history();
    const items = h.get('items', []).filter((x) => x.path !== item.path);
    items.unshift({ ...item, openedAt: Date.now() });
    h.set('items', items.slice(0, 200));
    return items.slice(0, 200);
  });
  ipcMain.handle('history:clear', () => { store.history().set('items', []); return []; });

  // ── 录音（跟读）保存 ──
  ipcMain.handle('record:save', async (_e, payload) => {
    const { dataUrl, defaultName } = payload || {};
    const m = /^data:audio\/(\w+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return { ok: false, error: '无效的音频数据' };
    const res = await dialog.showSaveDialog(mainWindow, {
      title: '保存跟读录音',
      defaultPath: defaultName || `shadowing-${Date.now()}.webm`,
      filters: [{ name: '音频', extensions: [m[1] === 'webm' ? 'webm' : m[1]] }]
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, Buffer.from(m[2], 'base64'));
    return { ok: true, path: res.filePath };
  });
  ipcMain.handle('record:saveToDir', async (_e, payload) => {
    const { dataUrl, dir, name } = payload || {};
    const m = /^data:audio\/(\w+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m || !dir) return { ok: false, error: '无效参数' };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, name || `shadowing-${Date.now()}.webm`);
      await fsp.writeFile(target, Buffer.from(m[2], 'base64'));
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// ─────────────────────────────────────────────────────────────
// 文件夹扫描：媒体 ↔ 字幕 自动配对（支持递归子目录，默认最多 3 层）
// ─────────────────────────────────────────────────────────────
function scanFolder(dir, opts = {}) {
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 3;
  const byDir = new Map(); // 目录 -> { media: [name], subs: [name] }
  let scannedDirs = 0;

  const walk = (current, depth, relative) => {
    let entries = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (err) {
      if (depth === 0) throw err; // 顶层目录打不开才算致命
      return;
    }
    scannedDirs++;
    const bucket = { media: [], subs: [] };
    const subdirs = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (depth < maxDepth && !e.name.startsWith('.')) subdirs.push(e.name);
        continue;
      }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (subs.MEDIA_EXT.includes(ext)) bucket.media.push(e.name);
      // .txt 无时间轴（导入需额外输入时长），不参与自动配对和快速选择
      else if (subs.SUBTITLE_EXT.includes(ext) && ext !== '.txt') bucket.subs.push(e.name);
    }
    if (bucket.media.length || bucket.subs.length) byDir.set(current, { ...bucket, relative });
    for (const name of subdirs) {
      walk(path.join(current, name), depth + 1, relative ? path.join(relative, name) : name);
    }
  };

  try { walk(dir, 0, ''); } catch (err) { return [{ error: err.message }]; }

  const out = [];
  const allSubs = [];   // 目录内全部字幕文件（供「选择字幕」菜单使用）
  for (const [folder, bucket] of byDir) {
    for (const name of bucket.subs) {
      const full = path.join(folder, name);
      allSubs.push({
        path: full,
        name,
        relative: bucket.relative ? path.join(bucket.relative, name) : name,
        dir: folder
      });
    }
    for (const name of bucket.media) {
      const full = path.join(folder, name);
      const base = path.basename(name, path.extname(name)).toLowerCase();
      // 只在同目录内配对字幕，避免跨目录错配
      let matched = null;
      let bestScore = -1;
      for (const s of bucket.subs) {
        const sb = path.basename(s, path.extname(s)).toLowerCase();
        let score = -1;
        if (sb === base) score = 100;
        else if (sb.startsWith(base) || base.startsWith(sb)) score = 60 - Math.abs(sb.length - base.length);
        if (score > bestScore) { bestScore = score; matched = s; }
      }
      let info = null;
      try { info = describeMedia(full); } catch (_) { info = { path: full, name }; }
      out.push({
        ...info,
        relative: bucket.relative ? path.join(bucket.relative, name) : name,
        subtitlePath: bestScore >= 0 ? path.join(folder, matched) : null
      });
    }
  }
  // 按目录名 + 文件名自然排序，保证列表顺序稳定
  out.sort((a, b) => String(a.relative || a.name).localeCompare(String(b.relative || b.name), 'zh-CN', { numeric: true }));
  allSubs.sort((a, b) => String(a.relative).localeCompare(String(b.relative), 'zh-CN', { numeric: true }));
  out.scannedDirs = scannedDirs;
  out.subtitles = allSubs;
  return out;
}

function describeMedia(filePath) {
  const st = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const isAudio = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.opus', '.wma'].includes(ext);
  return {
    path: filePath,
    name: path.basename(filePath),
    ext,
    size: st.size,
    mtime: st.mtimeMs,
    kind: isAudio ? 'audio' : 'video',
    url: mediaUrlFor(filePath),
    dir: path.dirname(filePath),
    siblingSubtitle: subs.findSiblingSubtitle(filePath)
  };
}

// ─────────────────────────────────────────────────────────────
// 生命周期
// ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  registerMediaProtocol();
  nativeTheme.themeSource = store.settings().get('ui.theme', 'system');
  nativeTheme.on('updated', () => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
  });
  registerIpc();
  buildMenu();

  // 命令行传入的文件（文件关联 / 拖到 exe 上打开）——必须在建窗前收集
  const argvFiles = collectArgvFiles(process.argv);
  if (argvFiles.length) pendingOpenFiles.push(...argvFiles);
  if (isSmoke) console.log('[smoke] argv=' + JSON.stringify(process.argv) + ' pending=' + JSON.stringify(pendingOpenFiles));

  createMainWindow();
  registerHotkeys();

  if (isSmoke) runSmokeTest();

  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createMainWindow(); });
});

// ─────────────────────────────────────────────────────────────
// 冒烟测试（--smoke-test）：启动 → 加载示例 → 截图 → 退出
// 用于在无人值守环境下验证真实运行状态（媒体协议 / 渲染 / 字幕解析）
// ─────────────────────────────────────────────────────────────
function runSmokeTest() {
  const lines = [];
  const traceFile = smokeOut
    ? smokeOut.replace(/\.png$/i, '-trace.txt')
    : path.join(store.getDataDir(), 'smoke-trace.txt');
  const writeTrace = () => {
    try { fs.writeFileSync(traceFile, lines.join('\n'), 'utf8'); } catch (err) { console.log('[smoke] trace 写入失败：' + err.message); }
  };
  const log = (...a) => {
    const text = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    lines.push(`[${new Date().toISOString().slice(11, 23)}] ${text}`);
    writeTrace(); // 每行都立即落盘：即使进程异常退出也能看到进度
    console.log('[smoke]', ...a);
  };
  const argAfter = (flag) => {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
  };
  // 未直接给媒体文件时，退化为「文件夹里第一个可播放文件」
  const smokeFile = () => {
    const direct = collectArgvFiles(process.argv)[0];
    if (direct) return direct;
    const folder = argAfter('--smoke-folder');
    if (!folder) return '';
    try {
      const rows = scanFolder(folder).filter((x) => x && x.path && !x.error);
      return rows.length ? rows[0].path : '';
    } catch (_) { return ''; }
  };
  const smokeFolder = argAfter('--smoke-folder');
  const smokeFolderIndex = Number(argAfter('--smoke-folder-index') || 0) || 0;
  log('开始冒烟测试 · trace=' + traceFile);
  const timer = setTimeout(() => { log('超时退出（90s）'); writeTrace(); app.exit(3); }, 90000);
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2 || /plt-ipc/.test(message)) console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  log('等待 did-finish-load…');
  mainWindow.webContents.once('did-finish-load', async () => {
    const js = (code) => mainWindow.webContents.executeJavaScript(code);
    log('did-finish-load 已触发，等待渲染进程就绪…');
    try {
      // 等待渲染进程 boot() 完成（__pltSmoke 在 boot 末尾暴露）
      let ready = false;
      for (let i = 0; i < 120; i++) {
        ready = await js('!!window.__pltSmoke');
        if (ready) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      log('渲染进程就绪：' + ready);
      log('启动文件是否经由握手投递：' + await js('window.__pltOpenedFromHandshake === true').catch(() => 'ERR'));
      if (!ready) {
        const errs = await js('(window.__pltErrors || []).join(" | ")').catch(() => '');
        log('页面错误：' + errs);
        clearTimeout(timer);
        return app.exit(5);
      }
      await new Promise((r) => setTimeout(r, 1200));
      log('页面错误：' + (await js('(window.__pltErrors || []).join(" | ")').catch(() => '')));
      log('待处理文件队列：' + JSON.stringify(await js('window.__pltPendingFiles || []').catch(() => 'ERR')));

      // 手动触发加载（验证 loadMedia 路径本身是否可用）
      log('手动加载结果：' + await js(`window.__pltOpenFile(${JSON.stringify(smokeFile())}).then(() => 'ok', (e) => 'ERR: ' + e.message)`));

      // IPC 桥与文件加载自检
      const diag = await js(`(async () => {
        const out = {};
        out.hasPLT = !!window.PLT;
        out.hasSmoke = !!window.__pltSmoke;
        out.info = await window.PLT.app.info().catch((e) => 'ERR:' + e.message);
        out.describe = await window.PLT.file.describe(${JSON.stringify(smokeFile())}).catch((e) => 'ERR:' + e.message);
        out.settings = await window.PLT.settings.get().then((s) => ({ level: s.lookup.level, hasKey: s.llm.hasApiKey })).catch((e) => 'ERR:' + e.message);
        return out;
      })()`).catch((e) => ({ execError: e.message }));
      log('IPC 自检：' + JSON.stringify(diag).slice(0, 600));

      // 等待媒体加载完成（命令行传入的文件是异步加载的）
      const waitMedia = async (ms) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          const st = await js(`(() => {
            const v = document.getElementById('video');
            return { hasMedia: !!window.__pltSmoke.state().media, readyState: v.readyState, duration: v.duration, error: v.error ? v.error.code : null };
          })()`);
          if (st.hasMedia && st.duration > 0) return st;
          await new Promise((r) => setTimeout(r, 250));
        }
        return await js(`(() => {
          const v = document.getElementById('video');
          return { hasMedia: !!window.__pltSmoke.state().media, readyState: v.readyState, duration: v.duration, error: v.error ? v.error.code : null, src: String(v.currentSrc || v.src).slice(0, 80), networkState: v.networkState };
        })()`);
      };
      let mediaReady = await waitMedia(20000);
      if (!mediaReady || !(mediaReady.duration > 0)) {
        // 卡在 readyState 0 时（两次 load 互相打断的典型症状）重载一次
        log('媒体首次加载未就绪，重试一次：' + JSON.stringify(mediaReady));
        await js(`window.__pltOpenFile(${JSON.stringify(smokeFile())})`).catch(() => { });
        mediaReady = await waitMedia(15000);
        log('重试后：' + JSON.stringify(mediaReady));
      }

      log('video 元素：' + JSON.stringify(await js(`(() => {
        const v = document.getElementById('video');
        const r = v.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), readyState: v.readyState, paused: v.paused, srcKind: (v.currentSrc || v.src || '').split(':')[0] };
      })()`)));

      log('界面状态：' + JSON.stringify(await js('window.__pltSmoke.state()')));
      log('当前行：' + JSON.stringify(await js('window.__pltSmoke.currentCue')));

      const media = await js(`(() => {
        const v = document.getElementById('video');
        return { readyState: v.readyState, duration: v.duration, error: v.error ? v.error.code : null, networkState: v.networkState, videoWidth: v.videoWidth, videoHeight: v.videoHeight };
      })()`);
      log('媒体状态：' + JSON.stringify(media));

      const probe = await js(`(async () => {
        const v = document.getElementById('video');
        try { v.currentTime = 6; await new Promise((res) => { v.addEventListener('seeked', res, { once: true }); setTimeout(res, 3000); }); } catch (e) { return { error: e.message }; }
        try { await v.play(); } catch (e) { /* 自动播放可能被拦截 */ }
        await new Promise((r) => setTimeout(r, 1200));
        return { currentTime: Math.round(v.currentTime * 100) / 100, readyState: v.readyState, paused: v.paused, duration: v.duration, error: v.error ? v.error.code : null };
      })()`);
      log('跳转+播放探针：' + JSON.stringify(probe));
      log('同步后当前行：' + JSON.stringify(await js('window.__pltSmoke.currentCue')));
      log('UI 渲染检查：' + JSON.stringify(await js(`(() => {
        const cueEls = document.querySelectorAll('#transcript .cue').length;
        const wEls = document.querySelectorAll('#transcript .w').length;
        const overlay = document.getElementById('overlayEn').textContent.slice(0, 40);
        const rateChips = document.querySelectorAll('#ratePresets .rate-chip').length;
        const seekStyle = document.getElementById('seekProgress').style.width;
        return { cueEls, wEls, overlay, rateChips, seekStyle, subStatus: document.getElementById('sbSubs').textContent };
      })()`)));

      // ── 真实 UI 交互探测（--smoke-ui）：放在截图之前，保证探测到的界面状态就是截图状态 ──
      let uiOk = true;
      if (isSmokeUi) {
        try {
          const probePath = [
            path.join(process.resourcesPath || '', 'ui-probe.js'),        // 打包后
            path.join(__dirname, '..', '..', 'scripts', 'ui-probe.js')    // 源码运行
          ].find((p) => { try { return p && fs.existsSync(p); } catch (_) { return false; } });
          if (!probePath) throw new Error('找不到 ui-probe.js');
          const probeMod = require(probePath);
          const p = probeMod.install({ js, log, wait: (ms) => new Promise((r) => setTimeout(r, ms)) });
          const res = await p.probe();
          log('UI 探测结果：' + JSON.stringify(res, null, 1));
          uiOk = !!(res['1b 真实坐标点击播放按钮'] && res['1b 真实坐标点击播放按钮'].pauseVisible
            && res['1b 真实坐标点击播放按钮'].paused === false
            && res['1c 再点一次（应回到三角 + paused）'] && res['1c 再点一次（应回到三角 + paused）'].playVisible
            && res['1c 再点一次（应回到三角 + paused）'].paused === true
            && res['2b 拖动到 50%'] && res['2b 拖动到 50%'].tUp > 20
            && res['3a 点最后一行（应跳到 ~57s，保持暂停/不回到开头）'] && res['3a 点最后一行（应跳到 ~57s，保持暂停/不回到开头）'].after > 30
            && res['4a 字幕按钮与菜单'] && res['4a 字幕按钮与菜单'].menuVisible);
        } catch (err) {
          log('UI 探测异常：' + (err && (err.stack || err.message)));
          uiOk = false;
        }
      }

      // 收尾：关掉面板/菜单，还原一个干净界面再截图
      if (isSmokeUi) {
        await js(`(() => {
          document.getElementById('dictPanel').classList.add('hidden');
          document.getElementById('paneBody').classList.remove('dict-open');
          document.getElementById('contextMenu').classList.add('hidden');
          const host = document.getElementById('modalHost');
          host.classList.add('hidden'); host.innerHTML = '';
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 400));
      }

      const shot = await mainWindow.webContents.capturePage();
      const out = smokeOut || path.join(store.getDataDir(), 'smoke.png');
      fs.writeFileSync(out, shot.toPNG());
      log('截图已保存：' + out + ` (${shot.getSize().width}x${shot.getSize().height})`);

      // 第二张：文字区 1:1 裁剪（检查 Times New Roman / 微软雅黑 渲染；先于弹窗拍摄）
      const clip = await js(`(() => {
        const r = document.getElementById('transcript').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: 280 };
      })()`);
      const shot3 = await mainWindow.webContents.capturePage(clip);
      const out3 = out.replace(/\.png$/i, '-text.png');
      fs.writeFileSync(out3, shot3.toPNG());
      log('截图 2（文字区裁剪 ' + clip.width + 'x' + clip.height + '）：' + out3);

      // 第三张：打开词典面板（同时验证无 API Key 时的错误提示路径）
      // 注意：这一步可能触发「未配置 Key」提示，必须放在 UI 交互探测与截图之后
      const dictInfo = await js(`(async () => {
        const spans = document.querySelectorAll('#transcript .w');
        if (!spans.length) return { error: 'no word spans' };
        const target = [...spans].find((s) => s.dataset.lower === 'meticulous') || spans[6];
        target.click();
        await new Promise((r) => setTimeout(r, 2600));
        return {
          clicked: target.dataset.lower,
          panelVisible: !document.getElementById('dictPanel').classList.contains('hidden'),
          word: document.getElementById('dictWord').textContent,
          bodyText: document.getElementById('dictBody').textContent.slice(0, 160),
          tags: [...document.querySelectorAll('#dictTags .tag')].map((t) => t.textContent)
        };
      })()`).catch((e) => ({ execError: e.message }));
      log('词典面板：' + JSON.stringify(dictInfo));
      const shot2 = await mainWindow.webContents.capturePage();
      const out2 = out.replace(/\.png$/i, '-dict.png');
      fs.writeFileSync(out2, shot2.toPNG());
      log('截图 3 已保存：' + out2);

      // 第四张：词典标题区 1:1 裁剪（诊断“单词显示块”排版）
      const headClip = await js(`(() => {
        const r = document.getElementById('dictPanel').getBoundingClientRect();
        return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: 70 };
      })()`);
      const shot4 = await mainWindow.webContents.capturePage(headClip);
      fs.writeFileSync(out.replace(/\.png$/i, '-word.png'), shot4.toPNG());
      log('截图 4（词典标题 ' + headClip.width + 'x' + headClip.height + '）：' + out.replace(/\.png$/i, '-word.png'));

      // ── 大模型分级取词端到端测试（已配置 API Key 时自动启用）──
      let llmInfo = null;
      const keyDiag = store.debugKey();
      log('【Key 诊断】' + JSON.stringify(keyDiag));
      const settingsInfo = await js(`window.PLT.settings.get().then((s) => ({ hasApiKey: !!s.llm.hasApiKey, hint: s.llm.apiKeyHint, dataDir: s.meta.dataDir, model: s.llm.model }))`).catch((e) => ({ error: e.message }));
      log('【设置】' + JSON.stringify(settingsInfo));
      let hasKey = !!(settingsInfo && settingsInfo.hasApiKey);

      // --smoke-set-key <key>：通过应用自身身份写入 API Key（DPAPI 绑定应用身份）
      const keyToSet = argAfter('--smoke-set-key');
      if (keyToSet) {
        const setRes = await js(`window.__pltSmoke.setApiKey(${JSON.stringify(keyToSet)})`).catch((e) => ({ error: e.message }));
        log('【写入 API Key】' + JSON.stringify(setRes));
        const test = await js(`window.__pltSmoke.testLLM()`).catch((e) => ({ error: e.message }));
        log('【连接测试】' + JSON.stringify(test));
        const after = store.debugKey();
        log('【Key 诊断·写入后】' + JSON.stringify(after));
        hasKey = !!(setRes && setRes.hasApiKey);
      }
      if (hasKey) {
        const t0 = Date.now();
        llmInfo = await js(`(async () => {
          const res = await window.PLT.llm.lookup([
            { word: 'the', context: 'The expedition relied on meticulous planning.' },
            { word: 'meticulous', context: 'The expedition relied on meticulous planning.' },
            { word: 'squander', context: 'We should not squander this fragile heritage.' }
          ], { level: 'toefl', applyLevelFilter: true });
          return {
            ok: res.ok,
            ms: res.ms,
            apiCalls: res.toApi,
            cacheHits: res.fromCache,
            usage: res.usage,
            explained: Object.keys(res.entries || {}),
            skipped: Object.entries(res.skipped || {}).map(([w, v]) => ({ word: w, cefr: v.cefr, reason: v.reason })),
            sample: res.entries && res.entries.squander ? {
              lemma: res.entries.squander.lemma,
              cefr: res.entries.squander.cefr,
              exam: res.entries.squander.examLevels,
              pos: res.entries.squander.pos,
              zh: res.entries.squander.translation,
              en: res.entries.squander.enDef,
              example: res.entries.squander.example
            } : null
          };
        })()`).catch((e) => ({ error: e.message }));
        log('【大模型取词】' + JSON.stringify(llmInfo));
        log('【大模型取词】耗时 ' + (Date.now() - t0) + 'ms');
      } else {
        log('【大模型取词】跳过（未配置 API Key）');
      }

      const ok = media.duration > 0 && media.error === null;

      // ── 文件夹导入回归测试（覆盖「选择文件夹后打不开视频」这一路径）──
      let folderOk = true;
      if (smokeFolder) {
        const scan = await js(`window.PLT.file.scanFolder(${JSON.stringify(smokeFolder)})`).catch((e) => ({ error: e.message }));
        log('文件夹扫描：' + JSON.stringify(Array.isArray(scan) ? scan.map((x) => ({ name: x.name, kind: x.kind, sub: !!x.subtitlePath, error: x.error })) : scan));
        const sim = await js(`window.__pltSmoke.simulateFolderOpen(${JSON.stringify(smokeFolder)}, ${smokeFolderIndex})`).catch((e) => ({ error: e.message }));
        log('文件夹打开（模拟点击第 ' + (smokeFolderIndex + 1) + ' 条）：' + JSON.stringify(sim));
        await new Promise((r) => setTimeout(r, 2600));
        const after = await js(`(() => {
          const v = document.getElementById('video');
          return {
            state: window.__pltSmoke.state(),
            duration: v.duration,
            error: v.error ? v.error.code : null,
            readyState: v.readyState,
            overlay: document.getElementById('overlayEn').textContent.slice(0, 40),
            subStatus: document.getElementById('sbSubs').textContent
          };
        })()`);
        log('文件夹打开后状态：' + JSON.stringify(after));
        folderOk = !!(after.state && after.state.media) && after.duration > 0 && after.error === null;
        log('文件夹导入回归：' + (folderOk ? 'PASS' : 'FAIL'));
      } else {
        log('文件夹导入回归：跳过（未传 --smoke-folder）');
      }

      log('结果：' + (ok && folderOk && uiOk ? 'PASS' : 'FAIL')
        + `（媒体=${ok ? 'ok' : 'fail'}，文件夹导入=${folderOk ? 'ok' : 'fail'}，UI 交互=${uiOk ? 'ok' : 'fail'}）`);
      clearTimeout(timer);
      writeTrace();
      setTimeout(() => app.exit(ok && folderOk && uiOk ? 0 : 2), 400);
    } catch (err) {
      log('异常：' + (err && (err.stack || err.message)));
      clearTimeout(timer);
      writeTrace();
      app.exit(4);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); });

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[main] unhandledRejection:', err);
});

module.exports = { mediaUrlFor, describeMedia, scanFolder };

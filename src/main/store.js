'use strict';
/**
 * store.js — 轻量级 JSON 持久化存储（支持 Portable 便携模式）
 *
 * 便携模式(Portable)判定顺序：
 *   1. electron-builder portable 打包运行时注入的 PORTABLE_EXECUTABLE_DIR
 *   2. 可执行文件所在目录存在 `portable-data` 文件夹 或 `portable.flag` 文件
 * 命中后，所有数据写入同级 `PodcastsLearningData` 目录，真正做到绿色免安装。
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  schema: 1,
  // ── 大模型 / 词典 ─────────────────────────────────────────────
  llm: {
    provider: 'deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    apiKeyEnc: '',          // safeStorage 加密后的 base64
    apiKeyPlain: '',        // 无法加密时的降级存储（有提示）
    useBundled: true,       // 没有自己的 Key 时，是否使用本地构建内嵌的出厂 Key
    temperature: 0.2,
    maxTokens: 8192,
    timeoutMs: 45000,
    thinking: false,         // 关闭思考模式：V4 默认开启且思维链按输出计费，词典任务不需要
    batchSize: 24           // 一次请求最多多少个词（省钱：批量合并）
  },
  // ── 取词难度分级（核心省钱开关） ───────────────────────────────
  lookup: {
    level: 'toefl',              // none | ielts | toefl | gre | educated_native
    filterMode: 'at-or-above',   // at-or-above | exact | ai-judge
    explainInChinese: true,
    cacheEnabled: true,
    autoScan: true,              // 加载字幕后自动批量分级
    autoScanLimit: 400,          // 自动扫描的最大行数（控制 token 消耗）
    maxWordsPerRequest: 40,
    pronounce: 'us',             // us | uk | none
    contextChars: 160,
    // 本地词典只用于「分级筛选」（决定哪些词可被选中），点选后的释义一律走大模型
    localDict: true,
    contextAware: true           // 结合上下文给词义（点选查词一律开启）
  },
  // ── 播放器 ───────────────────────────────────────────────────
  player: {
    rate: 1,
    volume: 1,
    muted: false,
    loopMode: 'none',            // none | one | all | ab
    autoPauseAtLineEnd: false,
    skipSilenceHint: true,
    subtitleOverlay: true,
    subtitleFontScale: 1,
    subtitleBilingual: true
  },
  // ── 界面 ─────────────────────────────────────────────────────
  ui: {
    theme: 'system',             // system | light | dark
    mica: true,
    backdrop: 'acrylic',         // acrylic | mica | tabbed | none
    transcriptFontScale: 1,
    showChinese: true,
    autoScroll: true,
    englishFont: '"Times New Roman", Times, Georgia, serif',
    chineseFont: '"Microsoft YaHei UI", "Microsoft YaHei", "微软雅黑", sans-serif',
    uiFont: '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif',
    highlightTargetWords: true,
    lastDir: ''
  },
  // ── 跟读 / 录音 ──────────────────────────────────────────────
  shadowing: {
    enabled: false,
    gapFactor: 0.5,              // 跟读间隔 = 原句时长 * gapFactor
    autoNextAfterRecord: true,
    micDeviceId: ''
  },
  hotkeys: {
    quickLookup: 'Alt+Shift+W',
    playPause: 'Alt+Shift+Space',
    repeatLine: 'Alt+Shift+R'
  },
  window: {
    width: 1480,
    height: 920,
    x: null,
    y: null,
    maximized: false,
    alwaysOnTop: false
  },
  // ── 自动更新（GitHub Release） ──────────────────────────────
  update: {
    autoCheck: true,          // 启动后自动检查（只提示，不自动下载）
    autoCheckDelayMs: 12000,  // 启动后延迟多久检查，避开首屏加载
    lastCheck: 0
  }
};

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    const bv = base[key];
    const pv = patch[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && pv && typeof pv === 'object' && !Array.isArray(pv)) {
      out[key] = deepMerge(bv, pv);
    } else if (pv !== undefined) {
      out[key] = pv;
    }
  }
  return out;
}

class Store {
  constructor(fileName, defaults) {
    this.fileName = fileName;
    this.defaults = defaults;
    this.data = JSON.parse(JSON.stringify(defaults));
    this.path = path.join(getDataDir(), fileName);
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf8');
        const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
        this.data = deepMerge(JSON.parse(JSON.stringify(this.defaults)), parsed);
      } else if (isPortable() && this.fileName === 'settings.json') {
        // 便携版首次运行：把安装版（漫游目录）里能真正解密的设置继承过来，
        // 免得用户为了「绿色版」再配一遍。
        // 注意：safeStorage 的密文可能绑定可执行文件身份，换 exe 也许解不开 ——
        // 所以先试解密，解不开就整段丢弃，绝不把一段废密文写进便携目录。
        const roaming = path.join(app.getPath('appData'), 'Podcasts Learning Tool', 'settings.json');
        if (fs.existsSync(roaming)) {
          const parsed = JSON.parse(fs.readFileSync(roaming, 'utf8').replace(/^\uFEFF/, ''));
          const enc = parsed && parsed.llm && parsed.llm.apiKeyEnc;
          let usable = true;
          if (enc) {
            try { usable = !!safeStorage.decryptString(Buffer.from(enc, 'base64')); }
            catch (_) { usable = false; }
            if (!usable) {
              parsed.llm.apiKeyEnc = '';
              parsed.llm.apiKeyPlain = '';
            }
          }
          this.data = deepMerge(JSON.parse(JSON.stringify(this.defaults)), parsed);
          this.save();
          console.log('[store] 便携版首次运行：已继承安装版设置（Key ' + (enc ? (usable ? '可用' : '不可用，已忽略') : '未设置') + '）');
        }
      }
    } catch (err) {
      console.error('[store] 读取失败，使用默认值：', this.path, err.message);
      try {
        fs.copyFileSync(this.path, this.path + '.corrupt-' + Date.now());
      } catch (_) { /* ignore */ }
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = this.path + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.path);
    } catch (err) {
      console.error('[store] 写入失败：', this.path, err.message);
    }
  }

  get(key, fallback) {
    if (key === undefined) return this.data;
    const parts = String(key).split('.');
    let cur = this.data;
    for (const p of parts) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  }

  set(key, value) {
    const parts = String(key).split('.');
    let cur = this.data;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    this.save();
    return value;
  }

  patch(patch) {
    this.data = deepMerge(this.data, patch);
    this.save();
    return this.data;
  }

  reset() {
    this.data = JSON.parse(JSON.stringify(this.defaults));
    this.save();
    return this.data;
  }
}

// ─────────────────────────────────────────────────────────────
// 便携模式 / 数据目录
// ─────────────────────────────────────────────────────────────
let cachedDataDir = null;

function isPortable() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  try {
    const exeDir = path.dirname(app.getPath('exe'));
    if (fs.existsSync(path.join(exeDir, 'portable.flag'))) return true;
    if (fs.existsSync(path.join(exeDir, 'portable-data'))) return true;
  } catch (_) { /* ignore */ }
  return false;
}

function getDataDir() {
  if (cachedDataDir) return cachedDataDir;
  if (isPortable()) {
    const base = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe'));
    cachedDataDir = path.join(base, 'PodcastsLearningData');
  } else {
    cachedDataDir = app.getPath('userData');
  }
  try { fs.mkdirSync(cachedDataDir, { recursive: true }); } catch (_) { /* ignore */ }
  return cachedDataDir;
}

function getCacheDir() {
  const dir = path.join(getDataDir(), 'cache');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
}

// ─────────────────────────────────────────────────────────────
// 单例
// ─────────────────────────────────────────────────────────────
let settingsStore = null;
let vocabStore = null;
let historyStore = null;

function settings() {
  if (!settingsStore) settingsStore = new Store('settings.json', DEFAULT_SETTINGS);
  return settingsStore;
}

function vocab() {
  if (!vocabStore) vocabStore = new Store('vocabulary.json', { schema: 1, items: [] });
  return vocabStore;
}

function history() {
  if (!historyStore) historyStore = new Store('history.json', { schema: 1, items: [] });
  return historyStore;
}

// ── API Key 安全存储 ─────────────────────────────────────────
/**
 * 出厂预置 Key：本地构建时随 src/ 一起打进 asar（该文件被 .gitignore 排除，
 * 公开仓库 / CI 构建里不存在，此时返回空串，走「用户自己填」的正常流程）。
 */
function bundledKey() {
  try {
    const m = require('./default-key');
    return String((m && m.key) || '').trim();
  } catch (_) {
    return '';
  }
}

function setApiKey(plain) {
  const s = settings();
  if (!plain) {
    s.set('llm.apiKeyEnc', '');
    s.set('llm.apiKeyPlain', '');
    s.set('llm.useBundled', false);   // 用户明确清空 → 连内置 Key 也不用
    return { ok: true, encrypted: false };
  }
  if (safeStorage.isEncryptionAvailable()) {
    s.set('llm.apiKeyEnc', safeStorage.encryptString(plain).toString('base64'));
    s.set('llm.apiKeyPlain', '');
    s.set('llm.useBundled', true);
    return { ok: true, encrypted: true };
  }
  s.set('llm.apiKeyPlain', plain);
  s.set('llm.apiKeyEnc', '');
  s.set('llm.useBundled', true);
  return { ok: true, encrypted: false };
}

/**
 * 取 Key 的顺序：
 *   1. 用户自己填的（safeStorage 密文）—— 但换过 exe / 换过机器可能解不开；
 *   2. 明文降级位（系统不支持加密时才会用到）；
 *   3. 构建内嵌的出厂 Key（useBundled 时）。
 * 第 1 步解不开时**不再直接返回空**（那会让界面显示「未配置 Key」却查不了词），
 * 而是继续往下兜底 —— 密文失效也能自愈。
 */
function getApiKey() {
  const s = settings();
  const enc = s.get('llm.apiKeyEnc', '');
  if (enc) {
    try {
      const k = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      if (k) return k;
    } catch (err) {
      console.warn('[store] API Key 解密失败，改用兜底 Key：', err.message);
    }
  }
  const plain = s.get('llm.apiKeyPlain', '');
  if (plain) return plain;
  if (s.get('llm.useBundled', true) !== false) return bundledKey();
  return '';
}

/** 当前 Key 的来源，用于界面提示与冒烟诊断 */
function apiKeySource() {
  const s = settings();
  const enc = s.get('llm.apiKeyEnc', '');
  if (enc) {
    try {
      if (safeStorage.decryptString(Buffer.from(enc, 'base64'))) return 'stored';
    } catch (_) { /* 落到下面兜底 */ }
  }
  if (s.get('llm.apiKeyPlain', '')) return 'plain';
  if (s.get('llm.useBundled', true) !== false && bundledKey()) return 'bundled';
  return 'none';
}

function hasApiKey() {
  return !!getApiKey();
}

/** 诊断用：定位 Key 读取链路的问题（不输出明文） */
function debugKey() {
  const s = settings();
  const enc = s.get('llm.apiKeyEnc', '');
  const plain = s.get('llm.apiKeyPlain', '');
  const out = {
    settingsPath: s.path,
    fileExists: false,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    apiKeyEncLen: enc ? enc.length : 0,
    apiKeyPlain: !!plain,
    bundledAvailable: !!bundledKey(),
    source: apiKeySource(),
    decryptOk: false,
    decryptError: null,
    keyLen: 0
  };
  try { out.fileExists = fs.existsSync(s.path); } catch (_) { /* ignore */ }
  if (enc) {
    try {
      const dec = safeStorage.decryptString(Buffer.from(enc, 'base64'));
      out.decryptOk = true;
      out.keyLen = dec.length;
    } catch (err) {
      out.decryptError = err.message;
    }
  }
  return out;
}

/** 给渲染进程用的脱敏设置（不含明文 key） */
function publicSettings() {
  const s = settings();
  const data = JSON.parse(JSON.stringify(s.data));
  const key = getApiKey();
  data.llm.hasApiKey = !!key;
  data.llm.apiKeyHint = key ? key.slice(0, 4) + '••••••••' + key.slice(-4) : '';
  data.llm.apiKeySource = apiKeySource();   // stored | plain | bundled | none
  delete data.llm.apiKeyEnc;
  delete data.llm.apiKeyPlain;
  data.meta = {
    portable: isPortable(),
    dataDir: getDataDir(),
    version: app.getVersion(),
    encrypted: safeStorage.isEncryptionAvailable()
  };
  return data;
}

module.exports = {
  DEFAULT_SETTINGS,
  Store,
  settings,
  vocab,
  history,
  setApiKey,
  getApiKey,
  hasApiKey,
  apiKeySource,
  debugKey,
  publicSettings,
  isPortable,
  getDataDir,
  getCacheDir,
  deepMerge
};

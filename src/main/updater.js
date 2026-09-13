'use strict';
/**
 * updater.js — 自动更新
 *
 * 两条完全不同的通路（electron-updater 官方不支持 portable 目标）：
 *
 *   安装版（NSIS）  → electron-updater
 *                     · 读 resources/app-update.yml（打包时由 electron-builder 生成）
 *                     · 走 GitHub Release 的 latest.yml，下载 exe 后静默安装
 *
 *   便携版（Portable）→ 自研换包
 *                     · 查 GitHub API 的 releases/latest，比较版本号
 *                     · 下载 Portable exe 到 PodcastsLearningData\update\
 *                     · 生成一个 PowerShell 换包脚本：等本进程退出 → 覆盖 exe → 重新拉起
 *                       （便携版的 exe 是自解压外壳，运行期间文件被占用，
 *                         所以只能"退出后再换"，脚本用重试循环兜住外壳退出的时间差）
 *
 * 约定：所有状态都通过 emit() 推给渲染进程，UI 只认 state.phase。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app, shell, dialog } = require('electron');
const store = require('./store');

const REPO = { owner: 'bradpittwyc', repo: 'Podcasts-learning-tool' };
const REPO_URL = `https://github.com/${REPO.owner}/${REPO.repo}`;
const RELEASE_PAGE = `${REPO_URL}/releases/latest`;
const PORTABLE_ASSET_RE = /Portable.*\.exe$/i;

let send = () => {};
let autoUpdater = null;
let checking = false;
let downloadReq = null;
let checkTimer = null;

const state = {
  phase: 'idle',      // idle|checking|uptodate|available|downloading|downloaded|installing|error|unsupported
  mode: 'none',       // installer | portable | none
  current: '',
  latest: '',
  notes: '',
  releaseUrl: RELEASE_PAGE,
  assetName: '',
  percent: 0,
  transferred: 0,
  total: 0,
  error: '',
  lastCheck: 0,
  savedTo: ''
};

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────
function emit(patch) {
  if (patch) Object.assign(state, patch);
  const snapshot = Object.assign({}, state);
  try { send(snapshot); } catch (_) { /* 窗口可能已关闭 */ }
  return snapshot;
}

function getState() { return Object.assign({}, state); }

/** 便携版：exe 在用户手上，不在 asar 里 */
function updaterMode() {
  if (!app.isPackaged) return 'none';
  if (store.isPortable() || process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  return 'installer';
}

/** 测试用：把「已是最新」也当成「有新版本」，用来在本地完整演练换包流程 */
function forceUpdate() {
  return process.argv.includes('--smoke-update-force');
}

/**
 * 便携版更新目录的清理：上一次更新可能留下没来得及换的 exe 或半截 .part。
 * 只有「用户主动点了下载」才会往里写文件，所以启动时清掉的一定是陈货。
 */
function cleanupUpdateDir() {
  const dir = updateDir();
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name === 'update.log') continue;
      if (!/\.(exe|part|tmp)$/i.test(name)) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; } catch (_) { /* 正在被占用就留着 */ }
    }
  } catch (_) { /* ignore */ }
  return removed;
}

/** 语义化版本比较：a>b 返回 1，a<b 返回 -1，相等 0（忽略 v 前缀与预发布号） */
function compareVersion(a, b) {
  const norm = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const x = norm(a); const y = norm(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 抓一小段文本（用于 latest.yml，几百字节） */
function fetchText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Podcasts-Learning-Tool-Updater', Accept: 'text/plain,*/*' },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchText(res.headers.location, redirects + 1));
      }
      if (res.statusCode === 404) { res.resume(); return reject(new Error('还没有发布更新清单')); }
      if (res.statusCode === 403) { res.resume(); return reject(new Error('GitHub 接口限流（403）')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('GitHub 返回 ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body));
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

function fetchJSON(url, redirects = 0) {  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Podcasts-Learning-Tool-Updater',
        Accept: 'application/vnd.github+json'
      },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchJSON(res.headers.location, redirects + 1));
      }
      if (res.statusCode === 404) { res.resume(); return reject(new Error('尚未发布任何 Release')); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('GitHub 返回 ' + res.statusCode)); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Release 数据解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
  });
}

function downloadFile(url, dest, onProgress, redirects = 0) {  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const req = https.get(url, {
      headers: { 'User-Agent': 'Podcasts-Learning-Tool-Updater', Accept: 'application/octet-stream' },
      timeout: 30000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(downloadFile(res.headers.location, dest, onProgress, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('下载失败：HTTP ' + res.statusCode)); }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.on('data', (chunk) => {
        got += chunk.length;
        onProgress(got, total);
      });
      res.pipe(out);
      out.on('finish', () => {
        out.close(() => {
          try { fs.renameSync(tmp, dest); } catch (e) { return reject(e); }
          resolve({ size: got, total });
        });
      });
      out.on('error', (e) => { try { fs.unlinkSync(tmp); } catch (_) {} reject(e); });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
    downloadReq = req;
  });
}

// ─────────────────────────────────────────────────────────────
// 安装版：electron-updater
// ─────────────────────────────────────────────────────────────
function initAutoUpdater() {
  if (autoUpdater) return autoUpdater;
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;          // 由 UI 决定何时下载
  autoUpdater.autoInstallOnAppQuit = true;   // 下载完退出时自动装
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => emit({ phase: 'checking', error: '' }));
  autoUpdater.on('update-available', (info) => emit({
    phase: 'available',
    latest: info && info.version ? info.version : '',
    notes: typeof (info && info.releaseNotes) === 'string' ? info.releaseNotes : '',
    releaseUrl: RELEASE_PAGE,
    percent: 0
  }));
  autoUpdater.on('update-not-available', () => emit({ phase: 'uptodate', latest: state.current }));
  autoUpdater.on('download-progress', (p) => emit({
    phase: 'downloading',
    percent: Math.round(p.percent || 0),
    transferred: p.transferred || 0,
    total: p.total || 0
  }));
  autoUpdater.on('update-downloaded', (info) => emit({
    phase: 'downloaded',
    percent: 100,
    latest: info && info.version ? info.version : state.latest
  }));
  autoUpdater.on('error', (err) => emit({ phase: 'error', error: friendlyError(err && err.message) }));
  return autoUpdater;
}

function friendlyError(msg) {
  const m = String(msg || '');
  if (/403/.test(m)) return 'GitHub 接口限流了（同一网络共用额度），稍后再试，或用「打开发布页」手动下载';
  if (/net::|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|连接 GitHub 超时/i.test(m)) return '网络不通，未能连接 GitHub（可稍后重试）';
  if (/404|latest\.yml|Cannot find|还没有发布更新清单/i.test(m)) return '这个 Release 还没有更新清单（latest.yml）';
  if (/sha512|checksum/i.test(m)) return '安装包校验不通过，已中止（可能是上传不完整）';
  return m || '未知错误';
}

// ─────────────────────────────────────────────────────────────
// 便携版：查 Release → 下载 → 换包
// ─────────────────────────────────────────────────────────────
/**
 * 便携版的「查最新版本」优先走 Release 资产，而不是 GitHub API：
 *   · https://github.com/<owner>/<repo>/releases/latest/download/latest.yml
 *     —— 这是 GitHub 的固定跳转地址，永远指向最新正式版，**不消耗 API 额度**；
 *   · 拿到 version 后按命名约定拼出便携版资产名。
 * 为什么要这样：未登录的 GitHub API 每小时只有 60 次（同一出口 IP 共用），
 * 公司/学校网络下很容易 403；而走资产下载地址则没有这个限制。
 * API 只作为兜底（万一资产命名不符约定）。
 */
function releaseAssetUrl(name) {
  return `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest/download/${encodeURIComponent(name)}`;
}

function headRequest(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('重定向过多'));
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'Podcasts-Learning-Tool-Updater' }, timeout: 15000 }, (res) => {
      res.resume();
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(headRequest(res.headers.location, redirects + 1));
      }
      resolve({ status: res.statusCode, size: parseInt(res.headers['content-length'] || '0', 10) });
    });
    req.on('timeout', () => req.destroy(new Error('连接 GitHub 超时')));
    req.on('error', reject);
    req.end();
  });
}

async function portableLatest() {
  const errors = [];
  // ── 首选：latest.yml（无 API 额度消耗） ──
  try {
    const yml = await fetchText(releaseAssetUrl('latest.yml'));
    const version = (yml.match(/^version:\s*(.+)$/m) || [])[1];
    if (version) {
      const v = version.trim().replace(/^v/i, '');
      const candidates = [
        `Podcasts-Learning-Tool-Portable-${v}.exe`,
        `Podcasts-Learning-Tool-Portable.exe`
      ];
      for (const name of candidates) {
        try {
          const head = await headRequest(releaseAssetUrl(name));
          if (head.status === 200 || head.status === 302) {
            return {
              version: v,
              tag: `v${v}`,
              notes: '',
              url: `${REPO_URL}/releases/tag/v${v}`,
              assetName: name,
              assetUrl: releaseAssetUrl(name),
              assetSize: head.size,
              via: 'latest.yml'
            };
          }
        } catch (e) { errors.push(name + ': ' + e.message); }
      }
    }
  } catch (e) { errors.push('latest.yml: ' + e.message); }

  // ── 兜底：GitHub API（可能被限流） ──
  const rel = await fetchJSON(`https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`);
  const tag = String(rel.tag_name || rel.name || '').trim();
  const version = tag.replace(/^v/i, '');
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const asset = assets.find((a) => PORTABLE_ASSET_RE.test(a.name || ''))
    || assets.find((a) => /\.exe$/i.test(a.name || ''));
  return {
    version,
    tag,
    notes: rel.body || '',
    url: rel.html_url || RELEASE_PAGE,
    assetName: asset ? asset.name : '',
    assetUrl: asset ? asset.browser_download_url : '',
    assetSize: asset ? asset.size : 0,
    publishedAt: rel.published_at || '',
    via: 'api'
  };
}

function currentExePath() {
  return process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
}

function updateDir() {
  const dir = path.join(store.getDataDir(), 'update');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  return dir;
}

/** 生成换包脚本（PowerShell：等本进程退出 → 覆盖 exe → 重新拉起 → 自删） */
function writeSwapScript(newExe, targetExe, pid, dir) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const workDir = dir || updateDir();
  const script = `# 由 Podcasts Learning Tool 自动生成：退出后替换便携版 exe 并重启
$ErrorActionPreference = 'SilentlyContinue'
$pidToWait = ${pid}
$target = ${q(targetExe)}
$new = ${q(newExe)}
$log = ${q(path.join(workDir, 'update.log'))}
function Log($m) { Add-Content -LiteralPath $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) -Encoding UTF8 }
Log "等待主进程退出 (PID $pidToWait)"
while (Get-Process -Id $pidToWait -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 400 }
Log "主进程已退出，开始替换"
$ok = $false
for ($i = 0; $i -lt 150; $i++) {
  try {
    Copy-Item -LiteralPath $new -Destination $target -Force -ErrorAction Stop
    $ok = $true
    break
  } catch {
    Start-Sleep -Milliseconds 400
  }
}
if ($ok) {
  Log "替换成功，重新启动"
  Start-Process -FilePath $target
  Remove-Item -LiteralPath $new -Force
} else {
  Log "替换失败：目标文件一直被占用（可手动把 $new 改成正式文件名）"
}
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force
`;
  const file = path.join(workDir, 'apply-update.ps1');
  // PowerShell 5.1 读 UTF-8 必须带 BOM，否则中文注释乱码
  fs.writeFileSync(file, '\uFEFF' + script, 'utf8');
  return file;
}

// ─────────────────────────────────────────────────────────────
// 对外 API
// ─────────────────────────────────────────────────────────────
async function check({ silent, force } = {}) {
  if (checking) return getState();
  if (!app.isPackaged && !force) {
    return emit({ phase: 'unsupported', mode: 'none', current: app.getVersion(), error: '开发模式不检查更新' });
  }
  checking = true;
  const mode = (!app.isPackaged && force) ? 'portable' : updaterMode();
  emit({ phase: 'checking', mode, error: '', current: app.getVersion(), lastCheck: Date.now() });
  try {
    if (mode === 'portable') {
      const info = await portableLatest();
      const cmp = compareVersion(info.version, app.getVersion());
      // forceUpdate() 是本地演练开关：即使已经是最新（甚至比线上还新）也当成可升级，
      // 用来在不上线新版本的情况下，完整跑一遍「下载 → 换包 → 重启」
      if (cmp > 0 || (forceUpdate() && info.assetUrl)) {
        emit({
          phase: 'available',
          latest: info.version,
          notes: info.notes,
          releaseUrl: info.url,
          assetName: info.assetName,
          assetUrl: info.assetUrl,
          total: info.assetSize,
          percent: 0
        });
      } else {
        emit({ phase: 'uptodate', latest: info.version, releaseUrl: info.url });
      }
    } else {
      const up = initAutoUpdater();
      await up.checkForUpdates();
    }
    store.settings().set('update.lastCheck', Date.now());
  } catch (err) {
    if (!silent) emit({ phase: 'error', error: friendlyError(err && err.message) });
    else emit({ phase: 'idle' });
  } finally {
    checking = false;
  }
  return getState();
}

async function download() {
  // 开发模式（--smoke-update）下没有 electron-updater 的 app-update.yml，统一走便携版通路
  const mode = app.isPackaged ? updaterMode() : 'portable';
  if (state.phase === 'downloading') return getState();
  if (mode === 'installer') {
    try {
      emit({ phase: 'downloading', percent: 0 });
      await initAutoUpdater().downloadUpdate();
    } catch (err) {
      emit({ phase: 'error', error: friendlyError(err && err.message) });
    }
    return getState();
  }
  if (mode !== 'portable') return emit({ phase: 'unsupported', error: '当前方式不支持自动更新' });
  if (!state.assetUrl) return emit({ phase: 'error', error: '没有可下载的便携版安装包' });

  const dest = path.join(updateDir(), state.assetName || 'Podcasts-Learning-Tool-Portable.exe');
  try {
    emit({ phase: 'downloading', percent: 0, savedTo: dest, error: '' });
    let lastTick = 0;
    const res = await downloadFile(state.assetUrl, dest, (got, total) => {
      const now = Date.now();
      if (now - lastTick < 300) return;     // 限流，别把渲染进程刷爆
      lastTick = now;
      emit({ percent: total ? Math.round((got / total) * 100) : 0, transferred: got, total });
    });
    emit({ phase: 'downloaded', percent: 100, transferred: res.size, total: res.total || res.size, savedTo: dest });
  } catch (err) {
    emit({ phase: 'error', error: friendlyError(err && err.message) });
  }
  return getState();
}

/**
 * 便携版换包脚本的「启动确认」。
 *
 * 踩过的坑：直接 detached spawn 出来的子进程，可能在父进程退出的瞬间被一起带走，
 * 脚本连第一行都没执行（update.log 都不存在）。所以这里必须：
 *   1. 用 cmd /c start 派生（真正脱离进程树）；
 *   2. 等脚本把第一行日志写出来再退出 —— 脚本第一件事就是写 update.log，
 *      日志出现即证明它活着，之后即使我们退出它也会继续把包换完。
 */
function waitForScriptReady(logFile, timeoutMs = 9000) {
  const started = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (fs.existsSync(logFile)) return resolve(true);
      if (Date.now() - started > timeoutMs) return resolve(false);
      setTimeout(tick, 250);
    };
    tick();
  });
}

/** 派生一个脱离进程树的子进程；resolve 时确认它真的起来了 */
function spawnDetached(cmd, args) {
  const { spawn } = require('child_process');
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) { return done({ ok: false, error: err.message }); }
    child.on('error', (err) => done({ ok: false, error: err.message }));
    child.on('spawn', () => done({ ok: true, pid: child.pid }));
    setTimeout(() => done({ ok: true, pid: child.pid }), 1500);
    if (child.unref) child.unref();
  });
}

/** 便携版：生成换包脚本并退出，由脚本完成替换 + 重启 */
async function installPortable() {
  const target = currentExePath();
  const newExe = state.savedTo;
  if (!newExe || !fs.existsSync(newExe)) return { ok: false, error: '更新包还没下载完' };
  const dir = path.dirname(newExe);
  const logFile = path.join(dir, 'update.log');
  try { fs.unlinkSync(logFile); } catch (_) { /* 旧日志留着也无妨 */ }
  const ps1 = writeSwapScript(newExe, target, process.pid, dir);

  emit({ phase: 'installing', percent: 100, error: '' });

  // 三种派生方式依次试，谁先把日志写出来就用谁。
  // 注意：传给 spawn 的参数不要再自己加引号 —— Node 会自动为含空格的参数加引号，
  // 手工再加一层会被转义成 \" ，cmd /c start 就会拿到一个坏路径。
  const attempts = [
    ['cmd /c start + powershell',
      () => spawnDetached('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1])],
    ['cmd /c start（工作目录取数据目录）',
      () => spawnDetached('cmd.exe', ['/c', 'start', '', '/D', dir, 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1])],
    ['直接 detached powershell',
      () => spawnDetached('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1])]
  ];
  const tried = [];
  for (const [label, run] of attempts) {
    const res = run();
    if (!res.ok) { tried.push(label + ': ' + res.error); continue; }
    if (await waitForScriptReady(logFile, 4000)) {
      setTimeout(() => app.quit(), 500);
      return { ok: true, target, ps1, logFile, strategy: label };
    }
    tried.push(label + ': 脚本未启动');
  }
  emit({ phase: 'downloaded', error: '替换脚本没能启动，可手动用下面这个文件覆盖当前 exe：' + newExe });
  return { ok: false, error: '替换脚本没能启动（' + tried.join('；') + '）', newExe };
}

async function install() {
  const mode = updaterMode();
  if (mode === 'portable') return await installPortable();
  if (mode === 'installer') {
    emit({ phase: 'installing' });
    // 静默安装：assisted（oneClick:false）安装包的 NSIS 脚本会从注册表读回
    // 上次的 InstallLocation，所以即使用户改过安装目录也还是原地升级；
    // 第二参数 true = --force-run，装完自动把新版拉起来。
    initAutoUpdater().quitAndInstall(true, true);
    return { ok: true };
  }
  return { ok: false, error: '当前方式不支持自动安装' };
}

function openRelease() {
  shell.openExternal(state.releaseUrl || RELEASE_PAGE);
}

/** 启动后延迟自检；设置里可关 */
function scheduleAutoCheck(win) {
  const s = store.settings();
  if (s.get('update.autoCheck', true) === false) return;
  const delay = Math.max(3000, Number(s.get('update.autoCheckDelayMs', 12000)) || 12000);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) check({ silent: true });
  }, delay);
}

function init(opts = {}) {
  if (typeof opts.send === 'function') send = opts.send;
  state.current = app.getVersion();
  state.mode = updaterMode();
  state.releaseUrl = RELEASE_PAGE;
  if (state.mode === 'portable') cleanupUpdateDir();
  return getState();
}

module.exports = {
  init,
  getState,
  check,
  download,
  install,
  openRelease,
  scheduleAutoCheck,
  updaterMode,
  compareVersion,
  writeSwapScript,
  cleanupUpdateDir,
  REPO,
  RELEASE_PAGE
};

'use strict';
/**
 * mac-helper.js — macOS 原生能力桥接（Vision OCR / Accessibility 选区文本）
 *
 * Windows 版用 PowerShell 调 Windows.Media.Ocr + SendKeys；macOS 没有等价命令，
 * 所以这里用一个小 Swift CLI（helper/plt-macos.swift）做同样的事：
 *
 *   子命令 ocr        → Vision 识别图片里的文字（离线）
 *   子命令 selection  → Accessibility 读前台 App 选中文字（不碰剪贴板、不模拟按键）
 *
 * helper 二进制不放进产物（体积 + 必须跟机器架构一致），改为**首次使用时就地编译**并缓存到
 * 数据目录 tools/ —— 与 yt-dlp 的处理方式保持一致：外部工具按需准备，缺了就给出明确引导。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('./store');

const HELPER_NAME = 'plt-macos';
const SOURCE_NAME = HELPER_NAME + '.swift';

/** 已编译好的 helper 候选位置：优先用户目录（可写、可更新），其次随包资源、仓库内预编译 */
function helperCandidates() {
  const list = [];
  try { list.push(path.join(getDataDir(), 'tools', HELPER_NAME)); } catch (_) { /* ignore */ }
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, HELPER_NAME));
  list.push(path.join(__dirname, '..', '..', 'helper', HELPER_NAME));
  return list;
}

/** helper 源码候选位置（注意：不能指望 asar 里的路径，打包后进 resources） */
function sourceCandidates() {
  const list = [];
  if (process.resourcesPath) list.push(path.join(process.resourcesPath, SOURCE_NAME));
  list.push(path.join(__dirname, '..', '..', 'helper', SOURCE_NAME));
  return list;
}

function firstExisting(list) {
  for (const p of list) {
    try { if (p && fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

function buildTarget() {
  return path.join(getDataDir(), 'tools', HELPER_NAME);
}

/** Xcode 命令行工具是否可用决定能否就地编译 */
function swiftcAvailable() {
  try {
    const r = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8', timeout: 15000 });
    if (r.status === 0 && String(r.stdout || '').trim()) return true;
  } catch (_) { /* ignore */ }
  return false;
}

/**
 * 就地编译 helper（仅 macOS）。返回 { ok, path, code, error }
 * 已存在同名二进制时直接复用，不重复编译。
 */
function ensureBuilt(opts = {}) {
  const existing = firstExisting(helperCandidates());
  if (existing && opts.force !== true) return { ok: true, path: existing, reused: true };

  const src = sourceCandidates()
    .find((p) => { try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!src) return { ok: false, code: 'NO_SOURCE', error: `找不到 helper 源码 ${SOURCE_NAME}` };
  if (!swiftcAvailable()) {
    return { ok: false, code: 'NO_SWIFTC', error: '本机没有 Xcode 命令行工具，无法编译 Helper。终端执行 xcode-select --install 安装后重试。', hint: 'xcode-select --install' };
  }

  const out = buildTarget();
  const dir = path.dirname(out);
  try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
    return { ok: false, code: 'MKDIR_FAILED', error: err.message };
  }
  const tmp = out + '.build-' + process.pid;
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }

  try {
    const r = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', '-suppress-warnings', '-o', tmp, src], {
      encoding: 'utf8',
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024
    });
    if (r.status !== 0) {
      const tail = String(r.stderr || r.stdout || '').split('\n').slice(-12).join('\n').trim();
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      return { ok: false, code: 'BUILD_FAILED', error: tail || `swiftc 退出码 ${r.status}` };
    }
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, out);
    return { ok: true, path: out, built: true };
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return { ok: false, code: 'BUILD_FAILED', error: err.message };
  }
}

/** 起一次 helper，返回解析后的 JSON（helper 永远输出单行 JSON） */
function run(args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const built = ensureBuilt();
    if (!built.ok) {
      resolve({ ok: false, code: built.code, error: built.error, hint: built.hint });
      return;
    }

    const child = spawn(built.path, args, { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      resolve({ ok: false, code: 'TIMEOUT', error: `helper 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: 'SPAWN_FAILED', error: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.replace(/^\uFEFF/, '').trim();
      if (!text) {
        resolve({ ok: false, code: 'EMPTY', error: err.slice(0, 400) || `helper 退出码 ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        resolve({ ok: false, code: 'BAD_OUTPUT', error: `helper 输出解析失败：${text.slice(0, 300)}` });
      }
    });
  });
}

/** UI / 诊断用：helper 当前处于什么状态 */
function status() {
  const builtPath = firstExisting(helperCandidates());
  return {
    helper: !!builtPath,
    path: builtPath || buildTarget(),
    source: firstExisting(sourceCandidates()),
    swiftc: swiftcAvailable()
  };
}

module.exports = { ensureBuilt, ensureBuiltSync: ensureBuilt, run, status, helperCandidates, sourceCandidates, swiftcAvailable, buildTarget, HELPER_NAME };

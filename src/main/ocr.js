'use strict';
/**
 * ocr.js — 屏幕取词 OCR（Windows.Media.Ocr 桥接）
 *
 * 屏幕取词三种方式，全部离线/低成本：
 *   1) 划词：按住热键 → 此时前台程序若为浏览器/PDF 阅读器，模拟 Ctrl+C 抓取选区文字
 *   2) 截图 OCR：框选屏幕区域 → Windows 内置 OCR → 文本（默认，无需网络）
 *   3) 视觉模型（可选）：把截图交给支持视觉的大模型
 * 本文件实现 1 与 2 的底层，并把结果交给 llm.js 做分级释义。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

const OCR_LANGS = process.env.PLT_OCR_LANGS || 'en-US,zh-Hans-CN';

function scriptPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'ocr.ps1'),
    path.join(__dirname, '..', '..', 'scripts', 'ocr.ps1')
  ];
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
  }
  return candidates[candidates.length - 1];
}

function powershellExe() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const ps5 = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(ps5)) return ps5; } catch (_) { /* ignore */ }
  return 'powershell.exe';
}

/** 运行 OCR，返回 { ok, text, lines, lang } */
function recognizeFile(imagePath, opts = {}) {
  return new Promise((resolve) => {
    const args = [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath(),
      '-Path', imagePath,
      '-Langs', opts.langs || OCR_LANGS
    ];
    let child;
    try {
      child = spawn(powershellExe(), args, { windowsHide: true });
    } catch (err) {
      resolve({ ok: false, code: 'SPAWN_FAILED', error: err.message });
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) { /* ignore */ }
      resolve({ ok: false, code: 'TIMEOUT', error: 'OCR 超时（30s）' });
    }, 30000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 'SPAWN_FAILED', error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.replace(/^\uFEFF/, '').trim();
      if (!text) {
        resolve({ ok: false, code: 'EMPTY', error: err.slice(0, 400) || `PowerShell 退出码 ${code}` });
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (e) {
        resolve({ ok: false, code: 'BAD_OUTPUT', error: `OCR 输出解析失败：${text.slice(0, 300)}` });
      }
    });
  });
}

/** 接收 dataURL(png) → 临时文件 → OCR → 清理 */
async function recognizeDataUrl(dataUrl, opts = {}) {
  const m = /^data:image\/(png|jpeg|jpg|bmp);base64,(.+)$/i.exec(String(dataUrl || '').trim());
  if (!m) return { ok: false, code: 'BAD_IMAGE', error: '不支持的图像数据' };
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const dir = path.join(os.tmpdir(), 'plt-ocr');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const file = path.join(dir, `shot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
  } catch (err) {
    return { ok: false, code: 'WRITE_FAILED', error: err.message };
  }
  try {
    const res = await recognizeFile(file, opts);
    return { ...res, imagePath: file };
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
}

/**
 * 引擎可用性检测：真实调用一次 Windows.Media.Ocr（不涉及屏幕捕获权限），
 * 返回语言包是否就绪。截图链路本身由渲染进程的 getDisplayMedia 在首次使用时授权。
 */
async function probe() {
  const dir = path.join(os.tmpdir(), 'plt-ocr');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
  const file = path.join(dir, `probe-${Date.now()}.png`);
  // 1x1 白色 PNG（避免依赖任何图像库）
  const png1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
    'base64'
  );
  try { fs.writeFileSync(file, png1x1); } catch (err) {
    return { ok: false, code: 'WRITE_FAILED', error: err.message };
  }
  try {
    const res = await recognizeFile(file);
    if (res.ok) return { ok: true, lang: res.lang, engine: 'Windows.Media.Ocr', script: scriptPath() };
    return { ok: false, code: res.code, error: res.error, script: scriptPath() };
  } finally {
    try { fs.unlinkSync(file); } catch (_) { /* ignore */ }
  }
}

module.exports = { recognizeFile, recognizeDataUrl, probe, scriptPath, OCR_LANGS };

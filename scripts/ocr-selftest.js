'use strict';
/**
 * ocr-selftest.js — 验证 Windows 内置 OCR 链路（scripts/ocr.ps1）
 *   node scripts/ocr-selftest.js
 * 生成一张带文字的位图 → 调用 ocr.ps1 → 断言识别结果包含关键词。
 * 若系统未安装 OCR 语言包，会给出明确的安装指引并以退出码 2 结束（不算致命错误）。
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const script = path.join(ROOT, 'scripts', 'ocr.ps1');
const WORD = 'Hello Ocean';

function powershell() {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(p) ? p : 'powershell.exe';
}

// 用 .NET System.Drawing 生成一张 640x120 的白底黑字 PNG（Windows 自带，无需第三方库）
function makeImage(file) {
  const ps = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 640,120
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::White)
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$font = New-Object System.Drawing.Font('Segoe UI', 36, [System.Drawing.FontStyle]::Regular)
$brush = [System.Drawing.Brushes]::Black
$g.DrawString('${WORD}', $font, $brush, 20, 30)
$g.Dispose()
$bmp.Save('${file.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output 'saved'
`;
  const r = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  return r.status === 0 && fs.existsSync(file);
}

function main() {
  const dir = path.join(os.tmpdir(), 'plt-ocr-test');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const img = path.join(dir, 'sample.png');

  if (!fs.existsSync(script)) {
    console.error('✗ 找不到 scripts/ocr.ps1');
    process.exit(1);
  }
  if (!makeImage(img)) {
    console.error('✗ 无法生成测试图片（System.Drawing 不可用）');
    process.exit(1);
  }
  console.log('✓ 测试图片：' + img);

  const r = spawnSync(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Path', img, '-Langs', 'en-US'], { encoding: 'utf8' });
  const out = (r.stdout || '').replace(/^\uFEFF/, '').trim();
  if (!out) {
    console.error('✗ ocr.ps1 无输出；stderr：' + (r.stderr || '').slice(0, 400));
    process.exit(1);
  }
  let json;
  try { json = JSON.parse(out); }
  catch (err) {
    console.error('✗ ocr.ps1 输出无法解析：' + out.slice(0, 300));
    process.exit(1);
  }

  if (!json.ok) {
    if (json.code === 'NO_OCR_ENGINE') {
      console.warn('! Windows OCR 引擎不可用：' + json.error);
      console.warn('  安装方法：设置 → 时间和语言 → 语言和区域 → 添加语言 → English (United States)（勾选“光学字符识别”）');
      process.exit(2);
    }
    console.error('✗ OCR 失败：' + (json.error || json.code));
    process.exit(1);
  }

  const text = String(json.text || '');
  const hit = text.toLowerCase().replace(/\s+/g, ' ').includes(WORD.toLowerCase());
  console.log(`✓ OCR 引擎可用（语言 ${json.lang}），识别到 ${json.lines ? json.lines.length : 0} 行：`);
  console.log('  「' + text.replace(/\s+/g, ' ').trim() + '」');
  if (!hit) {
    console.error(`✗ 识别结果未包含「${WORD}」`);
    process.exit(1);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ OCR 链路自检通过');
}

main();

'use strict';
/**
 * screen-text.js — 从「当前前台窗口」抓取用户选中的文字
 *
 * Windows：PowerShell + System.Windows.Forms.SendKeys 发送 ^c，读剪贴板差异再还原。
 * macOS  ：Accessibility API 直读 AXSelectedText —— 不模拟按键、不碰剪贴板，
 *          代价是需要在「系统设置 → 隐私与安全性 → 辅助功能」里勾选本应用。
 *
 * 被拒绝 / 无选区时返回 ok:false，UI 会提示改用「截图 OCR」。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');
const platform = require('./platform');

function powershellExe() {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const ps5 = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(ps5)) return ps5; } catch (_) { /* ignore */ }
  return 'powershell.exe';
}

function runPowerShell(script, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err, code }); });
  });
}

/**
 * 复制前台应用选中文字
 * @returns {Promise<{ok:boolean, text:string, restored:boolean, code?:string, error?:string}>}
 */
async function captureSelection(opts = {}) {
  if (platform.IS_MAC) return captureSelectionMac(opts);
  return captureSelectionWin(opts);
}

/**
 * macOS：Accessibility 直读选中文本。
 * 返回结构对齐 Windows 版 { ok, text, restored }，额外带 code 便于 UI 给精确引导。
 */
async function captureSelectionMac(opts = {}) {
  const res = await require('./mac-helper').run(['selection'], 8000);
  if (res.ok && res.text) return { ok: true, text: String(res.text).trim(), restored: true };
  const code = res.code || 'NO_SELECTION';
  const error = res.error || (code === 'NO_SELECTION' ? '' : '未能读取选中文字');
  return { ok: false, text: '', code, error, restored: true, touchesClipboard: false };
}

async function captureSelectionWin(opts = {}) {
  const prevText = clipboard.readText();
  const prevHtml = clipboard.readHTML();
  // 清空剪贴板以便判断是否真的有新内容（否则可能读到旧内容）
  clipboard.clear();
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Start-Sleep -Milliseconds 60',
    '[System.Windows.Forms.SendKeys]::SendWait("^c")',
    'Start-Sleep -Milliseconds 260',
    'exit 0'
  ].join('; ');
  const res = await runPowerShell(script, opts.timeoutMs || 6000);
  const text = (clipboard.readText() || '').replace(/\u0000/g, '').trim();
  if (opts.restore !== false) {
    try {
      if (prevText || prevHtml) clipboard.write({ text: prevText, html: prevHtml });
      else clipboard.clear();
    } catch (_) { /* ignore */ }
  }
  if (!res.ok && !text) return { ok: false, text: '', error: res.error || `exit ${res.code}`, restored: true };
  return { ok: !!text, text, restored: true };
}

module.exports = { captureSelection, runPowerShell, powershellExe };

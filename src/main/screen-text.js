'use strict';
/**
 * screen-text.js — 从「当前前台窗口」抓取用户选中的文字
 *
 * 原理：调用 PowerShell + System.Windows.Forms.SendKeys 发送 ^c，
 * 读取剪贴板差异，再恢复原剪贴板内容。无需任何原生模块。
 * 对被拒绝/无选区的情况返回空串，UI 会提示改用「截图 OCR」。
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { clipboard } = require('electron');

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
 * @returns {Promise<{ok:boolean, text:string, restored:boolean}>}
 */
async function captureSelection(opts = {}) {
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

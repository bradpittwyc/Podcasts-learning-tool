'use strict';
// 临时诊断 2：换几种方式派生子进程，看哪种能在主进程退出后活下来
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'samples', 'spawn-survival2.txt');
const line = (s) => fs.appendFileSync(out, s + '\n', 'utf8');
try { fs.unlinkSync(out); } catch (_) {}

const ps1 = path.join(__dirname, '..', 'samples', 'spawn2.ps1');
fs.writeFileSync(ps1, '\uFEFF' + `Start-Sleep -Seconds 3\n"[OK] powershell 存活 $(Get-Date -Format HH:mm:ss)" | Out-File -Append -Encoding UTF8 '${path.join(__dirname, '..', 'samples', 'spawn2-marker.txt').replace(/'/g, "''")}'\n`, 'utf8');

app.whenReady().then(() => {
  // A) 直接 detached spawn powershell
  const a = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { detached: true, stdio: 'ignore', windowsHide: true });
  a.unref();
  line('A spawned pid=' + a.pid);
  // B) 经 cmd start 再派生（双重脱离进程树）
  const b = spawn('cmd.exe', ['/c', 'start', '', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { detached: true, stdio: 'ignore', windowsHide: true });
  b.unref();
  line('B spawned pid=' + b.pid);
  // C) 普通 GUI 进程（对照组）
  const c = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' });
  c.unref();
  line('C spawned pid=' + c.pid);
  setTimeout(() => { line('主进程退出'); app.exit(0); }, 900);
});

'use strict';
// 临时诊断：Electron 退出后，detached 的 PowerShell 子进程还能不能活下来
const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const marker = path.join(__dirname, '..', 'samples', 'spawn-survival.txt');
try { fs.unlinkSync(marker); } catch (_) {}
const ps = path.join(__dirname, '..', 'samples', 'spawn-survival.ps1');
fs.writeFileSync(ps, '\uFEFF' +
  `Start-Sleep -Seconds 3\n"[OK] 子进程存活，时间 $(Get-Date -Format HH:mm:ss)" | Out-File -Encoding UTF8 '${marker.replace(/'/g, "''")}'\n`,
  'utf8');

app.whenReady().then(() => {
  const child = spawn('powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps],
    { detached: true, stdio: 'ignore', windowsHide: true });
  console.log('spawned pid=' + child.pid);
  child.unref();
  setTimeout(() => { console.log('退出主进程'); app.exit(0); }, 600);
});

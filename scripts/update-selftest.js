'use strict';
/**
 * update-selftest.js — 自动更新的离线自测
 *
 * 验证两件在真机升级前必须成立的事：
 *   1. 版本号比较（决定「要不要提示升级」）—— 纯逻辑
 *   2. 便携版换包脚本（决定「升不升得上去」）—— 真的跑一遍 PowerShell，
 *      确认「等进程退出 → 覆盖 exe → 重启 → 自删」这条链路在真机上成立
 *
 * 用法：node scripts/update-selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const updater = require('../src/main/updater');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + JSON.stringify(extra) : '')); }
};

console.log('\n=== 1. 版本号比较 ===');
const cmp = updater.compareVersion;
ok('v 前缀忽略：v1.0.1 = 1.0.1', cmp('v1.0.1', '1.0.1') === 0);
ok('补丁位：1.0.1 > 1.0.0', cmp('1.0.1', '1.0.0') === 1);
ok('补丁位：1.0.0 < 1.0.1', cmp('1.0.0', '1.0.1') === -1);
ok('次版本：1.1.0 > 1.0.9', cmp('1.1.0', '1.0.9') === 1);
ok('主版本：2.0.0 > 1.99.99', cmp('2.0.0', '1.99.99') === 1);
ok('位数不齐：1.0 = 1.0.0', cmp('1.0', '1.0.0') === 0);
ok('位数不齐：1.0.1 > 1.0', cmp('1.0.1', '1.0') === 1);
ok('预发布号忽略：1.0.1-beta < 1.0.1', cmp('1.0.1-beta', '1.0.1') === 0);
ok('两位数比较：1.10.0 > 1.9.0', cmp('1.10.0', '1.9.0') === 1);
ok('空值当 0：0.0.0 < 1.0.0', cmp('', '1.0.0') === -1);

console.log('\n=== 2. 便携版换包脚本（真跑一遍）===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plt-update-'));
// 借系统自带的 where.exe 当假 exe：被替换后会「重启」一下，然后自己退出，无副作用
const sysExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe');
const oldExe = path.join(tmp, 'Podcasts Learning Tool-Portable-9.9.9.exe');
const newExe = path.join(tmp, 'Podcasts Learning Tool-Portable-9.9.10.exe');

fs.copyFileSync(sysExe, oldExe);
fs.copyFileSync(sysExe, newExe);
fs.appendFileSync(newExe, Buffer.from('PLT-NEW-VERSION-MARKER'));   // 让新旧内容可区分

const oldSize = fs.statSync(oldExe).size;
const newSize = fs.statSync(newExe).size;

// PID 用一个肯定不存在的值：脚本应立即跳过等待，直接进入替换
const ps1 = updater.writeSwapScript(newExe, oldExe, 999999, tmp);
ok('脚本已生成', fs.existsSync(ps1));
const scriptText = fs.readFileSync(ps1, 'utf8');
ok('脚本带 UTF-8 BOM（PS 5.1 中文不乱码）', scriptText.charCodeAt(0) === 0xFEFF);
ok('脚本里写入了正确的新旧路径', scriptText.includes(oldExe.replace(/'/g, "''")) && scriptText.includes(newExe.replace(/'/g, "''")));

const run = spawnSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
  { encoding: 'utf8', timeout: 120000, windowsHide: true });
ok('PowerShell 执行无报错', run.status === 0, { status: run.status, stderr: (run.stderr || '').slice(0, 300) });

// 脚本内部是异步等待 + 重启，给它几秒收尾
const deadline = Date.now() + 20000;
let replaced = false;
while (Date.now() < deadline) {
  try { replaced = fs.statSync(oldExe).size === newSize; } catch (_) { replaced = false; }
  if (replaced) break;
  spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 300'], { windowsHide: true });
}
ok('旧 exe 已被替换成新版本', replaced, { oldSize, newSize, nowSize: (() => { try { return fs.statSync(oldExe).size; } catch (_) { return -1; } })() });
ok('新 exe 副本已清理', !fs.existsSync(newExe));
ok('换包脚本已自删', !fs.existsSync(ps1));

const logFile = path.join(tmp, 'update.log');
const logText = (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').replace(/^\uFEFF/, '');
ok('换包日志可读且记录了替换成功', /替换成功/.test(logText), logText.slice(0, 200));
fs.appendFileSync(oldExe, Buffer.from('x'));   // 确认替换后文件可写（没有被锁住）

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}

console.log('\n====================================================');
console.log(`更新自检结果：${pass} 通过 / ${fail} 失败`);
console.log('====================================================');
process.exit(fail ? 1 : 0);

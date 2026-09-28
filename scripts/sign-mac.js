'use strict';
/**
 * sign-mac.js — 本地 ad-hoc 签名 macOS 打包产物
 *
 * 为什么需要它：本项目没有付费的 Apple Developer ID 证书，electron-builder 25.x
 * 在钥匙串里找不到可用证书时会**直接跳过签名**（把 identity 当证书名去查，查不到就 skip），
 * 于是产出的 .app 是「完全未签名」状态 —— macOS Gatekeeper 会拦死，双击打不开。
 *
 * 本脚本用系统自带的 `codesign -s -`（ad-hoc，即「用本机匿名身份签名」）把 .app 签上，
 * 这样 app 在**本机 / 通过右键「打开」/ 解除隔离属性后**可以正常运行。
 *
 * ⚠️ ad-hoc 不是公证（notarization）：从互联网下载的 .app 仍会被 Gatekeeper 拦，
 * 直到用户右键「打开」或执行 `xattr -dr com.apple.quarantine "<app>"`。
 * 要对外发布给陌生人「双击即用」，需：Apple Developer ID 证书 + 公证（见 README）。
 *
 * 用法：node scripts/sign-mac.js   （通常在 npm run dist:mac 之后）
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CANDIDATE_DIRS = ['release/mac', 'release-test/mac', 'release-test2/mac'].map((d) => path.join(ROOT, d));

function findApp(dir) {
  if (!fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir);
    const app = entries.find((e) => e.endsWith('.app') && fs.statSync(path.join(dir, e)).isDirectory());
    return app ? path.join(dir, app) : null;
  } catch (_) { return null; }
}

const targets = [];
for (const d of CANDIDATE_DIRS) {
  const a = findApp(d);
  if (a) targets.push(a);
}

if (!targets.length) {
  console.error('[sign-mac] 未找到打包好的 .app（请先运行 npm run dist:mac 或 dist:mac:dir）。');
  process.exit(1);
}

for (const app of targets) {
  console.log('[sign-mac] ad-hoc 签名：' + app);
  try {
    execSync(`codesign --force --deep --sign - ${JSON.stringify(app)}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('[sign-mac] 签名失败：', err.message);
    process.exit(1);
  }
  // 顺手清掉隔离属性，避免本机双击被拦
  try { execSync(`xattr -dr com.apple.quarantine ${JSON.stringify(app)}`, { stdio: 'ignore' }); } catch (_) { /* ignore */ }
}

console.log('[sign-mac] 完成。本机可直接打开；若从别处下载，右键「打开」或 `xattr -dr com.apple.quarantine` 即可。');

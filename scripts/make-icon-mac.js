#!/usr/bin/env node
/**
 * make-icon-mac.js — 从 build/icon.png 生成 macOS 需要的 build/icon.icns
 *
 * macOS 不认 .ico，只认 .icns（内部是一组不同尺寸的 PNG）。
 * 本脚本用 macOS 自带的 sips + iconutil 完成，无需任何 npm 依赖：
 *   1. build/icon.png → /tmp 缩放出 iconset 需要的全部尺寸
 *   2. iconutil -c icns 打包成 build/icon.icns
 *
 * 用法：npm run icons:mac   （仅 macOS 可用；CI 的 macos runner 自带这两个工具）
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'build', 'icon.png');
const OUT = path.join(ROOT, 'build', 'icon.icns');

if (process.platform !== 'darwin') {
  console.error('make-icon-mac.js 只能在 macOS 上运行（依赖 sips / iconutil）');
  process.exit(1);
}
if (!fs.existsSync(SRC)) {
  console.error(`找不到源图标 ${SRC}`);
  process.exit(1);
}

// iconset 规范要求的全部尺寸；@2x 版本像素翻倍
const SIZES = [16, 32, 128, 256, 512];
// 注意：iconutil 要求目录名必须以 .iconset 结尾，否则报 Invalid Iconset
const iconset = path.join(os.tmpdir(), `plt-iconset-${process.pid}.iconset`);

fs.rmSync(iconset, { recursive: true, force: true });
fs.mkdirSync(iconset, { recursive: true });

for (const s of SIZES) {
  for (const [name, px] of [[`icon_${s}x${s}.png`, s], [`icon_${s}x${s}@2x.png`, s * 2]]) {
    execFileSync('/usr/bin/sips', ['-z', String(px), String(px), SRC, '--out', path.join(iconset, name)], { stdio: 'pipe' });
  }
}

fs.rmSync(OUT, { force: true });
execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', OUT], { stdio: 'pipe' });
fs.rmSync(iconset, { recursive: true, force: true });

console.log(`✓ 已生成 ${OUT}`);

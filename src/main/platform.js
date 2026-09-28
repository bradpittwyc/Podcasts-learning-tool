'use strict';
/**
 * platform.js — 平台差异的唯一出处
 *
 * macOS 与 Windows 在这几处必然不同，集中在这里统一治理，其它模块只问「要什么」，
 * 不再到处写 process.platform === 'darwin'：
 *
 *   1. 窗口外形：Windows 自绘标题栏 + 自绘三键；macOS 用原生交通灯
 *   2. 菜单：macOS 要有 Application menu，且助记符 (&F) 会字面显示
 *   3. 快捷键：部分 CmdOrCtrl+X 在 macOS 上撞系统快捷键
 *   4. 原生能力：Windows 走 PowerShell，macOS 走 Swift helper（Vision / Accessibility）
 *   5. 数据目录：Windows 有便携模式；macOS 走 ~/Library/Application Support
 */

const fs = require('fs');
const pathMod = require('path');

const PLATFORM = process.platform;

const IS_WIN = PLATFORM === 'win32';
const IS_MAC = PLATFORM === 'darwin';
const IS_LINUX = !IS_WIN && !IS_MAC;

/**
 * macOS 上会撞「系统级」快捷键的映射。
 *   CmdOrCtrl+H → Cmd+H 是 macOS 的「隐藏窗口」，菜单项抢不过，改 Ctrl+H
 */
const MAC_ACCEL_MAP = {
  'CmdOrCtrl+H': 'Ctrl+H'
};

/** 菜单快捷键：按平台给出最终生效的组合 */
function menuAccel(accel) {
  if (!accel) return accel;
  if (IS_MAC && Object.prototype.hasOwnProperty.call(MAC_ACCEL_MAP, accel)) return MAC_ACCEL_MAP[accel];
  return accel;
}

/**
 * Windows 菜单用 (&F) 标助记符，macOS 会把它当成字面量显示出来 —— strip 掉。
 */
function menuLabel(label) {
  if (!IS_MAC) return label;
  return String(label || '').replace(/\(&[A-Za-z0-9]\)/g, '');
}

/** 当前 .app bundle 路径（Windows / 源码运行时为 null） */
function appBundlePath(app) {
  if (!IS_MAC || !app || typeof app.getAppPath !== 'function') return null;
  try {
    // getAppPath() → …/Podcasts Learning Tool.app/Contents/Resources/app.asar
    return pathResolveUp(app.getAppPath(), 2);
  } catch (_) {
    return null;
  }
}

function pathResolveUp(p, levels) {
  let out = String(p || '');
  for (let i = 0; i < levels; i++) out = pathMod.dirname(out);
  return out;
}

/**
 * 便携模式的根在哪一侧。
 *
 * Windows 便携版是 exe 旁边放 portable.flag / portable-data；macOS 的「exe」藏在
 * Contents/MacOS 里，用户碰不到 —— 所以 macOS 上把判定放在 **.app 所在目录**
 * （也就是 U 盘根目录）：旁边有 portable.flag 就整体随身携带。
 *
 * @returns {string|null}
 */
function portableRoot(app) {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  const marker = (dir) => {
    try {
      if (fs.existsSync(pathMod.join(dir, 'portable.flag'))) return true;
      if (fs.existsSync(pathMod.join(dir, 'portable-data'))) return true;
    } catch (_) { /* ignore */ }
    return false;
  };
  try {
    const exeDir = pathMod.dirname(app.getPath('exe'));
    if (marker(exeDir)) return exeDir;
  } catch (_) { /* ignore */ }
  if (IS_MAC) {
    const bundle = appBundlePath(app);
    if (bundle) {
      const parent = pathMod.dirname(bundle);
      if (marker(parent)) return parent;
    }
  }
  return null;
}

/** CPU 架构，用于挑选更新资产 */
function assetArch() {
  const a = process.arch;
  if (a === 'arm64') return 'arm64';
  if (a === 'x64') return 'x64';
  return a;
}

function ocrEngineName() {
  return IS_MAC ? 'macOS Vision' : (IS_WIN ? 'Windows.Media.Ocr' : 'none');
}

/** Windows 的 Mica / Acrylic 背景材质；macOS 上 Electron 没有等价物 */
function supportsBackdropMaterial() {
  return IS_WIN;
}

module.exports = {
  PLATFORM,
  IS_WIN,
  IS_MAC,
  IS_LINUX,
  menuAccel,
  menuLabel,
  appBundlePath,
  portableRoot,
  assetArch,
  ocrEngineName,
  supportsBackdropMaterial
};

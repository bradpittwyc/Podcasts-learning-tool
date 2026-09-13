'use strict';
/**
 * patch-icon.js — 用官方 Fluent System Icons 替换界面里手绘的图标
 * 用法：node scripts/patch-icon.js            （替换设置齿轮）
 *
 * 为什么单独写脚本：图标 path 很长，手工复制粘贴容易漏字符，
 * 这里直接从微软官方仓库拉取原文件、抽取 path、写回 index.html。
 * 图标来源：microsoft/fluentui-system-icons（MIT），与 Windows 11 原生图标同源。
 */
const fs = require('fs');
const path = require('path');

const ICON_URL = {
  settings24: 'https://raw.githubusercontent.com/microsoft/fluentui-system-icons/main/assets/Settings/SVG/ic_fluent_settings_24_regular.svg'
};

async function fetchPath(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'PLT-Icon-Patch' } });
  if (!res.ok) throw new Error('下载失败 ' + res.status);
  const svg = await res.text();
  const m = svg.match(/<path[^>]*\sd="([^"]+)"/);
  if (!m) throw new Error('没找到 path');
  return m[1];
}

function replaceSvg(html, id, viewBox, d) {
  const re = new RegExp('(<button class="cb-icon" id="' + id + '"[^>]*>)([\\s\\S]*?)(</button>)');
  const m = html.match(re);
  if (!m) throw new Error('没找到按钮 ' + id);
  const icon = '\n          <svg viewBox="' + viewBox + '" aria-hidden="true"><path d="' + d + '" fill="currentColor"/></svg>\n        ';
  return html.replace(re, m[1] + icon + m[3]);
}

(async () => {
  const file = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const d = await fetchPath(ICON_URL.settings24);
  console.log('取到 Fluent settings_24_regular，path 长度 =', d.length);
  html = replaceSvg(html, 'btnSettings', '0 0 24 24', d);
  fs.writeFileSync(file, html, 'utf8');
  console.log('已写入 ' + file);
})().catch((e) => { console.error('× ' + e.message); process.exit(1); });

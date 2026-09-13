'use strict';
/**
 * fix-ps1-bom.js — 为需要中文输出的 PowerShell 脚本补上 UTF-8 BOM
 *   node scripts/fix-ps1-bom.js
 * Windows PowerShell 5.1 读取 .ps1 时按 ANSI(GBK) 解码，没有 BOM 的中文会被误读并报语法错误。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BOM = Buffer.from([0xEF, 0xBB, 0xBF]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'release') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.toLowerCase().endsWith('.ps1')) out.push(full);
  }
  return out;
}

let fixed = 0;
for (const file of walk(ROOT)) {
  const buf = fs.readFileSync(file);
  if (buf.slice(0, 3).equals(BOM)) {
    console.log('· 已有 BOM：' + path.relative(ROOT, file));
    continue;
  }
  fs.writeFileSync(file, Buffer.concat([BOM, buf]));
  console.log('✓ 已补 BOM：' + path.relative(ROOT, file));
  fixed++;
}
console.log(`完成，修复 ${fixed} 个文件。`);

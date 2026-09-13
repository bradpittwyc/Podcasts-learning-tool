'use strict';
/** 测算新旧 prompt 的 token 与「点选」成本对比 */
const { encode } = require('gpt-tokenizer');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'llm.js'), 'utf8');
const m = src.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!m) { console.error('提取 SYSTEM_PROMPT 失败'); process.exit(1); }
const SYS = m[1];
const t = (s) => encode(String(s)).length;

const USER = 'L=TOEFL/C1\n' + JSON.stringify({
  r: [{ i: 0, w: 'meticulous', c: 'The expedition relied on meticulous planning before the dive.' }]
});
const OUT = JSON.stringify({
  r: [{
    i: 0, lemma: 'meticulous', ph: '/məˈtɪkjələs/', pos: 'adj.', cefr: 'B2',
    ex: ['TOEFL'], ac: false, idi: false, rare: false, ok: true,
    zh: '一丝不苟的；极仔细的', en: 'showing great attention to detail'
  }]
});

const sysT = t(SYS), userT = t(USER), outT = t(OUT);
console.log('=== 新 prompt（精简版，点选弹框用）===');
console.log(`  系统提示   ${sysT} token   （旧版 555）`);
console.log(`  用户消息   ${userT} token`);
console.log(`  典型输出   ${outT} token   （旧版 91，且旧版含例句要求）`);
console.log(`  单次合计   ${sysT + userT + outT} token\n`);

const PRICES = [
  ['flash 非峰', 0.15, 0.60],
  ['flash 高峰', 0.30, 1.20],
  ['v4-pro 非峰', 0.66, 1.98],
  ['v4-pro 高峰', 1.32, 3.96]
];
const FX = 7.1;
console.log('=== 点选成本（缓存热：系统提示命中磁盘缓存）===');
for (const [name, pin, pout] of PRICES) {
  const inHit = name.startsWith('flash') ? 0.003 : 0.022;
  const per = (inHit / 1e6) * sysT + (pin / 1e6) * userT + (pout / 1e6) * outT;
  const perCold = (pin / 1e6) * sysT + (pin / 1e6) * userT + (pout / 1e6) * outT;
  console.log(`  ${name.padEnd(12)} 每次 ¥${(per * FX).toFixed(5)}   1万次 ¥${(per * FX * 10000).toFixed(2)}   （缓存冷 ¥${(perCold * FX * 10000).toFixed(2)}）`);
}

console.log('\n=== 对比旧 prompt（555 token 系统提示）===');
const OLD_SYS = 555, OLD_OUT = 91;
for (const [name, pin, pout] of PRICES) {
  const inHit = name.startsWith('flash') ? 0.003 : 0.022;
  const oldPer = (inHit / 1e6) * OLD_SYS + (pin / 1e6) * 46 + (pout / 1e6) * OLD_OUT;
  const newPer = (inHit / 1e6) * sysT + (pin / 1e6) * userT + (pout / 1e6) * outT;
  console.log(`  ${name.padEnd(12)} 旧 ¥${(oldPer * FX * 10000).toFixed(2)} → 新 ¥${(newPer * FX * 10000).toFixed(2)}   省 ${((1 - newPer / oldPer) * 100).toFixed(0)}%`);
}

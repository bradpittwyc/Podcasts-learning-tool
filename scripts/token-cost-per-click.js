'use strict';
/**
 * token-cost-perclick.js — 按「点一次 = 查一个词」建模的真实成本
 *
 *   与 token-cost.js 的区别：
 *   token-cost.js 算的是「一次把整篇单词批量发给模型」（扫描模式）；
 *   本脚本算的是「用户点一下查一个词」——每次请求都要重新携带整个系统提示，
 *   所以系统提示会成为固定的单次成本，缓存命中与否影响巨大。
 *
 * 用法: node scripts/token-cost-per-click.js
 */
const { encode } = require('gpt-tokenizer');
const fs = require('fs');
const path = require('path');

const toks = (s) => encode(String(s)).length;

// ── 抠出 llm.js 里真实使用的 SYSTEM_PROMPT（现行线上版本）──
const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'llm.js'), 'utf8');
const CURRENT_SYSTEM_PROMPT = llmSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

/** 现行提示里要求的返回字段（不含例句） */
const CURRENT_OUTPUT = (word, ctx) => JSON.stringify({
  i: 0,
  lemma: word,
  phonetic: '/ˈeksəmpəl/',
  pos: 'n.',
  cefr: 'B2',
  examLevels: ['TOEFL'],
  isAcademic: false,
  isIdiom: false,
  rare: false,
  shouldExplain: true,
  translation: '例子；实例；范例（约 10 字）',
  enDef: 'a thing characteristic of its kind or illustrating a general rule'
});

/** 极简版：保留「级别 + 中文释义 + 一句英文释义」，去掉音标/词性/各类标记 */
const LEAN_SYSTEM_PROMPT = `You are a bilingual (English->Simplified Chinese) lexicographer for learners.
Input: JSON {"w":"word","c":"context sentence"}.
Output STRICT JSON only: {"lemma":"","cefr":"A1|A2|B1|B2|C1|C2","zh":"","en":""}
Rules: zh <= 14 Chinese characters and must fit the given context. en <= 12 words. No extra text.`;

const LEAN_OUTPUT = JSON.stringify({
  lemma: 'example', cefr: 'B2',
  zh: '例子；实例；范例', en: 'a thing that illustrates a general rule'
});

/** 中间档：保留音标与词性（学习者确实需要），但去掉学术/习语/生僻三类标记和 shouldExplain */
const MID_SYSTEM_PROMPT = `You are a bilingual (English->Simplified Chinese) lexicographer.
Input: JSON {"w":"word","c":"context"}.
Output STRICT JSON only: {"lemma":"","phonetic":"","pos":"","cefr":"","examLevels":[],"zh":"","en":""}
Rules: cefr in A1..C2; examLevels subset of ["IELTS","TOEFL","GRE"]; zh <= 14 Chinese characters, fitted to context; en <= 12 words.`;
const MID_OUTPUT = JSON.stringify({
  lemma: 'example', phonetic: '/ɪɡˈzæmpəl/', pos: 'n.', cefr: 'B2',
  examLevels: ['TOEFL'], zh: '例子；实例；范例', en: 'a thing illustrating a general rule'
});

// ── 单次点击请求的完整输入 ──
const SAMPLE_CTX = 'The expedition relied on meticulous planning before the dive.';
const SAMPLE_WORD = 'meticulous';
const USER_MSG_CURRENT = `TARGET_LEVEL=TOEFL (C1)\nEXPLAIN_IN=Simplified Chinese\n\n` +
  JSON.stringify({ items: [{ i: 0, w: SAMPLE_WORD, c: SAMPLE_CTX }] });
const USER_MSG_LEAN = JSON.stringify({ w: SAMPLE_WORD, c: SAMPLE_CTX });

const scenarios = [
  {
    key: 'current',
    name: '① 现行 prompt（音标+词性+中英释义+3 个标记，无例句）',
    sys: CURRENT_SYSTEM_PROMPT,
    user: USER_MSG_CURRENT,
    out: CURRENT_OUTPUT(SAMPLE_WORD, SAMPLE_CTX)
  },
  {
    key: 'mid',
    name: '② 精简字段（保留音标/词性/考试标签，去掉 isAcademic/isIdiom/rare）',
    sys: MID_SYSTEM_PROMPT,
    user: USER_MSG_LEAN,
    out: MID_OUTPUT
  },
  {
    key: 'lean',
    name: '③ 极简（级别 + 中文释义 + 短英文释义）',
    sys: LEAN_SYSTEM_PROMPT,
    user: USER_MSG_LEAN,
    out: LEAN_OUTPUT
  }
];

const PRICE = {
  'flash 非高峰': { inMiss: 0.15, inHit: 0.003, out: 0.60 },
  'flash 高峰': { inMiss: 0.30, inHit: 0.006, out: 1.20 },
  'v4-pro 非高峰': { inMiss: 0.66, inHit: 0.022, out: 1.98 },
  'v4-pro 高峰': { inMiss: 1.32, inHit: 0.044, out: 3.96 }
};
const FX = 7.1;
const CLICKS = 10000;

console.log('='.repeat(104));
console.log('【点击查词】成本模型：点一次 = 查一个词，共 10,000 次点击');
console.log('='.repeat(104));

const rows = [];
for (const sc of scenarios) {
  const sysT = toks(sc.sys);
  const userT = toks(sc.user);
  const outT = toks(sc.out);
  const row = {
    name: sc.name, sysT, userT, outT, perCallPrompt: sysT + userT,
    costs: {}
  };
  for (const [k, p] of Object.entries(PRICE)) {
    // 缓存冷：每次都是 cache miss
    const cold = ((sysT + userT) / 1e6) * p.inMiss + (outT / 1e6) * p.out;
    // 缓存热：系统提示命中缓存（DeepSeek 默认开启磁盘缓存，重复前缀会自动命中）
    const warm = ((sysT / 1e6) * p.inHit + (userT / 1e6) * p.inMiss) + (outT / 1e6) * p.out;
    row.costs[k] = { cold: cold * CLICKS, warm: warm * CLICKS, perClickCold: cold, perClickWarm: warm };
  }
  rows.push(row);
}

console.log('\n单次请求的 token 结构：');
console.log('场景'.padEnd(58), '系统提示'.padStart(9), '用户输入'.padStart(9), '输出'.padStart(7));
console.log('-'.repeat(104));
for (const r of rows) {
  console.log(`${r.name}`.padEnd(58), String(r.sysT).padStart(9), String(r.userT).padStart(9), String(r.outT).padStart(7));
}

console.log('\n' + '='.repeat(104));
console.log('10,000 次点击总成本（¥，1 USD ≈ 7.1）');
console.log('='.repeat(104));
console.log('场景'.padEnd(58), 'flash 非峰'.padStart(12), 'v4-pro 非峰'.padStart(13), 'v4-pro 高峰'.padStart(13));
console.log('-'.repeat(104));
for (const r of rows) {
  const f = (k, mode) => '¥' + (r.costs[k][mode] * FX).toFixed(2);
  console.log(`${r.name}`.padEnd(58),
    f('flash 非高峰', 'warm').padStart(12),
    f('v4-pro 非高峰', 'warm').padStart(13),
    f('v4-pro 高峰', 'warm').padStart(13));
}
console.log('-'.repeat(104));
console.log('（以上为「缓存热」：系统提示命中磁盘缓存。首次/缓存失效按下面冷启动算）\n');

console.log('缓存冷热对比（v4-pro 非高峰）：');
for (const r of rows) {
  const c = r.costs['v4-pro 非高峰'];
  console.log(`  ${r.name}`);
  console.log(`      每次点击: 冷 ¥${(c.perClickCold * FX).toFixed(5)}   热 ¥${(c.perClickWarm * FX).toFixed(5)}`);
  console.log(`      一万次  : 冷 ¥${(c.cold * FX).toFixed(2)}   热 ¥${(c.warm * FX).toFixed(2)}`);
}

console.log('\n' + '='.repeat(104));
console.log('对比：同样 10,000 个词，如果用「批量扫描」模式（token-cost.js 的场景 D/E ~ 24词一批）');
console.log('='.repeat(104));
const batchIn = rows[0].perCallPrompt * Math.ceil(CLICKS / 24);
const batchOut = rows[0].outT * Math.ceil(CLICKS / 24);
for (const [k, p] of Object.entries(PRICE)) {
  const c = ((batchIn / 1e6) * p.inMiss + (batchOut / 1e6) * p.out) * FX;
  console.log(`  ${k.padEnd(14)} 批量 ¥${c.toFixed(2)}`);
}
console.log('  → 单次点击比批量贵约 ' +
  (rows[0].costs['v4-pro 非高峰'].warm * FX / (((batchIn / 1e6) * PRICE['v4-pro 非高峰'].inMiss + (batchOut / 1e6) * PRICE['v4-pro 非高峰'].out) * FX)).toFixed(1) + ' 倍（v4-pro 非高峰）');

console.log('\n' + '='.repeat(104));
console.log('真实使用粒度参考（按 v4-pro 非高峰、缓存热）');
console.log('='.repeat(104));
for (const r of rows) {
  const per = r.costs['v4-pro 非高峰'].perClickWarm * FX;
  console.log(`  ${r.name}`);
  console.log(`      1 次点击 ¥${per.toFixed(5)}   100 次 ¥${(per * 100).toFixed(3)}   1,000 次 ¥${(per * 1000).toFixed(2)}   10,000 次 ¥${(per * 10000).toFixed(2)}`);
}

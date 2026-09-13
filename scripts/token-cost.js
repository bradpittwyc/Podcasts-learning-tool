'use strict';
/**
 * token-cost.js — 用真实 tokenizer 测算「全大模型查词」的成本
 *   用法: node scripts/token-cost.js
 * 说明: DeepSeek 未公开官方 tokenizer，这里用 cl100k_base 作近似
 *       （中英混排下与 DeepSeek tokenizer 的偏差通常在 ±10% 内）。
 * prompt 直接取自 src/main/llm.js，保证测的是我们真实发出去的内容。
 */
const { encode } = require('gpt-tokenizer');
const fs = require('fs');
const path = require('path');

// ── 从 llm.js 里抠出真实的 SYSTEM_PROMPT ──
const llmSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'llm.js'), 'utf8');
const sysMatch = llmSrc.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
if (!sysMatch) { console.error('无法从 llm.js 提取 SYSTEM_PROMPT'); process.exit(1); }
const SYSTEM_PROMPT = sysMatch[1];

/** 精简版：自动扫描只需要「定级」，不需要释义 */
const RATING_SYSTEM_PROMPT = `You are a CEFR vocabulary rater for English learners.
Input: a JSON array of {i, w} (index, word).
Output STRICT JSON: {"items":[{"i":0,"lemma":"base form","cefr":"A1|A2|B1|B2|C1|C2","examLevels":[],"rare":false}]}
Rules: cefr = difficulty for an adult Chinese learner. examLevels uses only "IELTS","TOEFL","GRE".
lemma = base form. Return exactly one item per input, same i, same order.`;

const DEF_SYSTEM_PROMPT = `You are a bilingual (English->Simplified Chinese) lexicographer.
Input: JSON array of {i, w, c}.
Output STRICT JSON: {"items":[{"i":0,"lemma":"","pos":"","translation":"","enDef":"","example":""}]}
Rules: translation <= 14 Chinese characters, disambiguated by context c. Return one item per input, same i.`;

/** 极简：只给「级别 + 一句中文小注」，不要音标/词性/英文释义/例句 */
const LEAN_SYSTEM_PROMPT = `Rate and gloss English words for a Chinese learner.
Input: {"l":"LEVEL","w":[[i,"word","short context"],...]}
Output STRICT JSON only: {"r":[[i,"cefr","中文小注"],...]}
cefr in A1..C2. 中文小注 <= 12 字, disambiguated by context. Same i, same order, no extra text.`;

function leanCompletion(batchSize) {
  // 每条回答形如 [0,"B2","一丝不苟的"]
  const items = Array.from({ length: batchSize }, (_, i) => `[${i},"B2","一丝不苟的"]`);
  return toks(`{"r":[${items.join(',')}]}`);
}

function toks(s) { return encode(String(s)).length; }

// ── 构造真实语料：用仓库自带字幕 ──
const srt = fs.readFileSync(path.join(__dirname, '..', 'samples', 'english-podcast.srt'), 'utf8');
const lines = srt.split('\n').filter((l) => l && !/^\d+$/.test(l) && !/-->/.test(l) && !/[\u4e00-\u9fff]/.test(l));
const words = [];
const seen = new Set();
for (const line of lines) {
  for (const m of line.matchAll(/[A-Za-z][A-Za-z'-]*/g)) {
    const w = m[0].toLowerCase();
    if (seen.has(w) || w.length < 2) continue;
    seen.add(w);
    words.push({ w: m[0], c: line.trim() });
  }
}
console.log(`语料：${lines.length} 行英文 → ${words.length} 个不同单词\n`);

/** 按批量分组，模拟 lookupBatch 的请求构造 */
function buildBatch(items, opts = {}) {
  const ctxChars = opts.ctxChars === undefined ? 160 : opts.ctxChars;
  const withCtx = opts.withContext !== false;
  const level = opts.level || 'TOEFL';
  // 极简格式：更短的键名 + 数组而非对象，省掉大量重复的字段名 token
  if (opts.leanPayload) {
    const arr = items.map((it, idx) => [idx, it.w, it.c.slice(0, ctxChars)]);
    return `{"l":"${level}","w":${JSON.stringify(arr)}}`;
  }
  const payload = {
    items: items.map((it, idx) => (withCtx
      ? { i: idx, w: it.w, c: it.c.slice(0, ctxChars) }
      : { i: idx, w: it.w }))
  };
  const head = opts.rating
    ? `TARGET_LEVEL=${level}\n\n`
    : `TARGET_LEVEL=${level}\nEXPLAIN_IN=Simplified Chinese\n\n`;
  return head + JSON.stringify(payload);
}

/** 估算返回内容 token（按每条回答的典型长度） */
function estimateCompletion(batchSize, kind) {
  if (kind === 'lean') return leanCompletion(batchSize);
  // kind: 'full' 完整释义(含中文/英文释义/例句) | 'rating' 仅定级
  const samples = kind === 'full'
    ? Array.from({ length: batchSize }, (_, i) => JSON.stringify({
        i, lemma: 'example', phonetic: '/ɪɡˈzæmpəl/', pos: 'n.', cefr: 'B2',
        examLevels: ['TOEFL'], isAcademic: false, isIdiom: false, rare: false,
        shouldExplain: true, translation: '例子；实例（约 12 字）',
        enDef: 'a thing characteristic of its kind or illustrating a general rule',
        example: 'This is a good example of the problem.', exampleZh: '这是该问题的一个很好的例子。'
      }))
    : Array.from({ length: batchSize }, (_, i) => JSON.stringify({
        i, lemma: 'example', cefr: 'B2', examLevels: ['TOEFL'], rare: false
      }));
  return toks(`{"items":[${samples.join(',')}]}`);
}

// ── 场景测算 ──
const TOTAL = 10000;
const scenarios = [
  { name: 'A. 现状：完整系统提示 + 24 词/批 + 带语境', sys: SYSTEM_PROMPT, batch: 24, withContext: true, kind: 'full' },
  { name: 'B. 精简提示：只定级（不含释义字段）', sys: RATING_SYSTEM_PROMPT, batch: 50, withContext: false, kind: 'rating' },
  { name: 'C. 精简提示 + 定级 + 64 词/批', sys: RATING_SYSTEM_PROMPT, batch: 64, withContext: false, kind: 'rating' },
  { name: 'D. 全大模型给释义（精简提示 + 24 词/批）', sys: DEF_SYSTEM_PROMPT, batch: 24, withContext: true, kind: 'full' },
  { name: 'E. 全大模型给释义（64 词/批 + 短语境）', sys: DEF_SYSTEM_PROMPT, batch: 64, withContext: true, kind: 'full', ctxChars: 60 },
  { name: 'F. ★极简输出：级别+中文小注（50 词/批）', sys: LEAN_SYSTEM_PROMPT, batch: 50, withContext: true, kind: 'lean', ctxChars: 50, leanPayload: true },
  { name: 'G. ★极简输出 + 64 词/批', sys: LEAN_SYSTEM_PROMPT, batch: 64, withContext: true, kind: 'lean', ctxChars: 50, leanPayload: true }
];

const sysTokens = {
  [SYSTEM_PROMPT]: toks(SYSTEM_PROMPT),
  [RATING_SYSTEM_PROMPT]: toks(RATING_SYSTEM_PROMPT),
  [DEF_SYSTEM_PROMPT]: toks(DEF_SYSTEM_PROMPT)
};
console.log('系统提示 token：');
console.log(`  现有 SYSTEM_PROMPT        ${sysTokens[SYSTEM_PROMPT]}`);
console.log(`  精简定级 RATING_PROMPT    ${sysTokens[RATING_SYSTEM_PROMPT]}`);
console.log(`  精简释义 DEF_PROMPT       ${sysTokens[DEF_SYSTEM_PROMPT]}\n`);

const prices = {
  'flash 非高峰': { in: 0.15, out: 0.6, cache: 0.003 },
  'flash 高峰': { in: 0.3, out: 1.2, cache: 0.006 },
  'v4-pro 非高峰': { in: 0.66, out: 1.98, cache: 0.022 },
  'v4-pro 高峰': { in: 1.32, out: 3.96, cache: 0.044 }
};

const results = [];
for (const sc of scenarios) {
  // 每批的输入 token = 系统提示 + 用户消息
  const sampleItems = words.slice(0, Math.min(sc.batch, words.length));
  const userMsg = buildBatch(sampleItems, {
    withContext: sc.withContext,
    ctxChars: sc.ctxChars,
    rating: sc.sys === RATING_SYSTEM_PROMPT,
    leanPayload: !!sc.leanPayload
  });
  const userTokens = toks(userMsg);
  const sysTok = sysTokens[sc.sys] || 0;
  const perBatchIn = sysTok + userTokens;
  const perBatchOut = estimateCompletion(sc.batch, sc.kind);
  const batches = Math.ceil(TOTAL / sc.batch);

  const inPer10k = perBatchIn * batches;
  const outPer10k = perBatchOut * batches;

  const row = { name: sc.name, batch: sc.batch, batches, perBatchIn, perBatchOut, inPer10k, outPer10k, costs: {} };
  for (const [k, p] of Object.entries(prices)) {
    row.costs[k] = (inPer10k / 1e6) * p.in + (outPer10k / 1e6) * p.out;
  }
  results.push(row);
}

console.log('='.repeat(96));
console.log('查 10,000 个词的总成本（USD，未计缓存命中）');
console.log('='.repeat(96));
const hdr = ['场景'.padEnd(42), '批数'.padStart(5), '输入tok'.padStart(10), '输出tok'.padStart(9)];
for (const k of Object.keys(prices)) hdr.push(k.padStart(14));
console.log(hdr.join(' '));
console.log('-'.repeat(96));
for (const r of results) {
  const line = [`${r.name}`.padEnd(42), String(r.batches).padStart(5), String(r.inPer10k).padStart(10), String(r.outPer10k).padStart(9)];
  for (const k of Object.keys(prices)) line.push(('$' + r.costs[k].toFixed(3)).padStart(14));
  console.log(line.join(' '));
}
console.log('-'.repeat(96));

// 人民币换算（按 1 USD ≈ 7.1 CNY）
const FX = 7.1;
console.log('\n换成人民币（¥，1 USD ≈ 7.1）：');
for (const r of results) {
  const vals = Object.entries(r.costs).map(([k, v]) => `${k}=¥${(v * FX).toFixed(2)}`);
  console.log(`  ${r.name}`);
  console.log(`      ${vals.join('   ')}`);
}

// 单集参考：一集播客约 1200 行 / 约 3000 个不同单词
console.log('\n参考：一集播客（约 1200 行字幕 / 约 3000 个不同单词）');
for (const r of results) {
  const scale = 3000 / TOTAL;
  console.log(`  ${r.name}`);
  console.log(`      flash 非高峰 ¥${(r.costs['flash 非高峰'] * FX * scale).toFixed(4)}  |  v4-pro 非高峰 ¥${(r.costs['v4-pro 非高峰'] * FX * scale).toFixed(4)}`);
}

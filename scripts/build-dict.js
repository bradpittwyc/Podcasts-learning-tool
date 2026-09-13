'use strict';
/**
 * build-dict.js — 把 ECDICT (ecdict.csv) 精简为应用内置的离线词典
 *
 *   node scripts/build-dict.js [--in .tmp-dict/ecdict.csv] [--out resources/local-dict.json]
 *
 * 产物结构（紧凑数组，尽量小）：
 *   {
 *     meta: { source, version, builtAt, count, fields: [...] },
 *     k: ["word", ...],
 *     d: { word: [headword, lemma, phonetic, cefr, pos, exams, zh, rank, rare, academic] }
 *   }
 * 字段索引：0 headword 1 lemma 2 phonetic 3 cefr 4 pos 5 exams 6 zh 7 rank 8 rare 9 academic
 *
 * 收录策略：只保留「学习者会遇到」的词 —— 有词频排名 / 有考试标签 / 有 Collins·Oxford 星级 / 学术词，
 * 丢弃 ECDICT 里大量无词频、无标签的冷僻条目（它们只会让词典变大而几乎不会被查到）。
 * 分级依据（CEFR）：ECDICT 的 bnc/frq 词频排名 + 考试标签 + 学术/生僻标记。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const lemmaUtil = require('../src/shared/lemma');
const { candidateForms, isFunctionWord } = lemmaUtil;

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const IN = path.resolve(ROOT, argOf('--in', '.tmp-dict/ecdict.csv'));
const OUT = path.resolve(ROOT, argOf('--out', 'resources/local-dict.json'));
const MAX_RANK = Number(argOf('--max-rank', '60000'));      // 词频排名阈值：更靠后的词不值得内置

// ── CEFR 分级阈值（按词频排名，越低越常见）──
// 参考 ECDICT 词频分布与 Oxford 3000/5000、CEFR-J 的常用对应关系，
// 让各级别占比落在合理区间（A1/A2 覆盖最高频日常词，C1/C2 才是考试与母语级难词）。
const TIERS = [
  [1000, 'A1'], [2500, 'A2'], [6000, 'B1'], [13000, 'B2'], [30000, 'C1']
];
function levelFromRank(rank) {
  if (!rank || rank <= 0) return '';
  for (const [max, lv] of TIERS) if (rank <= max) return lv;
  return 'C2';
}

// ── CSV 逐行解析（支持引号包裹与 \n 转义）──
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function cleanZh(s) {
  return String(s || '')
    .replace(/\\n/g, '；')
    .replace(/\s+/g, ' ')
    .replace(/；{2,}/g, '；')
    .replace(/^[；\s]+|[；\s]+$/g, '')
    .trim();
}

/** 从 exchange 字段解析词形变化：p:过去式 d:过去分词 i:现在分词 3:第三人称 s:复数 r:比较级 t:最高级 0:原形 1:原形变换 */
function lemmasFromExchange(exchange, headword) {
  const map = {};
  for (const part of String(exchange || '').split('/')) {
    const idx = part.indexOf(':');
    if (idx <= 0) continue;
    const type = part.slice(0, idx);
    const word = part.slice(idx + 1).trim().toLowerCase();
    if (!word || !/^[a-z][a-z'-]*$/.test(word)) continue;
    map[word] = headword;
  }
  return map;
}

function normalizeExams(tag) {
  const set = new Set();
  const t = String(tag || '');
  if (/\bielts\b/.test(t)) set.add('IELTS');
  if (/\btoefl\b/.test(t)) set.add('TOEFL');
  if (/\bgre\b/.test(t)) set.add('GRE');
  return [...set].join(',');
}

/**
 * 高频功能词/不规则词形修正表（与 src/shared/lemma.js 同源）。
 * 这些词在 ECDICT 里可能以「专有名词 / 其他词性」条目出现，词频排名失真
 * （例如 are 被记成面积单位 are，排名 44037 → 误判成 C2）。
 */
const FORCE_A1 = lemmaUtil.FUNCTION_WORDS;

async function main() {
  // --fetch：自动下载 ECDICT 原始数据（63MB）到 .tmp-dict/
  if (args.includes('--fetch') && !fs.existsSync(IN)) {
    console.log('正在下载 ECDICT（约 63 MB）…');
    fs.mkdirSync(path.dirname(IN), { recursive: true });
    const url = 'https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv';
    const res = await fetch(url);
    if (!res.ok) { console.error('下载失败：HTTP ' + res.status); process.exit(1); }
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(IN, buf);
    console.log('已保存 ' + (buf.length / 1048576).toFixed(1) + ' MB → ' + IN);
  }
  if (!fs.existsSync(IN)) {
    console.error('找不到输入文件：' + IN);
    console.error('运行 `npm run dict:fetch` 自动下载，或手动下载 ECDICT：');
    console.error('  https://raw.githubusercontent.com/skywind3000/ECDICT/master/ecdict.csv');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: fs.createReadStream(IN, { encoding: 'utf8' }), crlfDelay: Infinity });
  const data = {};
  const lemmas = new Map();   // 词形 -> 原形
  let lineNo = 0;
  let kept = 0;

  for await (const rawLine of rl) {
    lineNo++;
    if (lineNo === 1 && /^word,/.test(rawLine)) continue;      // 表头
    if (!rawLine || rawLine[0] === undefined) continue;
    const f = parseCsvLine(rawLine);
    if (f.length < 11) continue;

    const word = String(f[0] || '').trim();
    if (!word) continue;
    // 只保留纯字母词条（含连字符/撇号），丢掉短语、缩写、带括号的变体
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(word)) continue;
    if (word.length > 24) continue;

    const lower = word.toLowerCase();
    const phonetic = String(f[1] || '').trim();
    const translation = cleanZh(f[3]);
    const pos = String(f[4] || '').trim();
    const collins = Number(f[5]) || 0;
    const oxford = Number(f[6]) || 0;
    const tag = String(f[7] || '');
    const bnc = Number(f[8]) || 0;
    const frq = Number(f[9]) || 0;
    const exchange = String(f[10] || '');

    // 必须有中文释义，否则对中文母语学习者没意义
    if (!translation) continue;

    // bnc 与 frq 都是「词频排名」（越小越常见），取更常见的那个；
    // 注意不能取 max —— walls(bnc 18881 / frq 0) 这类只有单侧数据的词会被误判为难词。
    const ranks = [bnc, frq].filter((n) => n > 0);
    const rank = ranks.length ? Math.min(...ranks) : 0;
    let cefr = levelFromRank(rank);
    const exams = normalizeExams(tag);
    // 注意：ECDICT 的 oxford 字段表示「收录进 Oxford 3000/5000 核心词表」，
    // 那是「常用」而不是「学术」，早期版本误当成学术词，导致 a / and / along 全被标成学术难词。
    // 生僻 / 母语级：词频很低、或完全没有词频且没有核心词表收录
    const rare = (!rank || rank > 30000) && !oxford;
    const academic = /\bacademic\b/.test(tag);

    // 收录门槛：有词频且不算太冷僻，或有考试/学术标签，或属核心词表
    const worthKeeping = (rank > 0 && rank <= MAX_RANK) || !!exams || academic || oxford > 0;
    if (!worthKeeping) continue;

    // 分级：以词频为主。考试标签只作标记，不再抬高难度
    // （fragile 这类词同时挂在 IELTS/TOEFL/GRE 名单上，若用标签覆盖难度会把大量常见词误判成 C2）
    if (!cefr) cefr = (exams || academic) ? 'C1' : 'C2';
    if (rare && cefr !== 'C2') cefr = 'C2';
    if (FORCE_A1.has(lower)) { cefr = 'A1'; }

    const rec = [word, lower, phonetic, cefr, pos, exams, translation, rank, rare ? 1 : 0, academic ? 1 : 0];

    // 同词多条目（ECDICT 里一个词可能既是动词又是名词，分两行）：
    // 保留「有词频且排名更好」的那条；并列时优先带考试标签/核心词表的，避免
    // could 被 can（装罐）这类次要义项覆盖。
    const prev = data[lower];
    if (prev) {
      const better = (a, b) => {
        const ra = a[7] || Infinity;
        const rb = b[7] || Infinity;
        if (ra !== rb) return ra < rb;
        const score = (r) => (r[5] ? 2 : 0) + (r[9] ? 2 : 0) + (r[2] ? 1 : 0);
        return score(a) >= score(b);
      };
      if (!better(rec, prev)) continue;
    }
    data[lower] = rec;
    kept++;

    for (const [form, lemma] of Object.entries(lemmasFromExchange(exchange, lower))) {
      if (form === lemma) continue;
      if (!lemmas.has(form)) lemmas.set(form, lemma);
    }
  }

  // ── 词形指回原形 ──
  // 两轮：① ECDICT exchange 字段给出的权威词形  ② 规则化后缀还原（catalogued→catalogue 这类缺失项）
  // 目的：变形词继承原形的词频与级别，否则会因为自身词频低被误判成 C1/C2、当成难词标出来。
  let lemmaCount = 0;
  const applyLemma = (form, lemma) => {
    if (!form || !lemma || form === lemma) return false;
    const target = data[lemma];
    if (!target) return false;
    const self = data[form];
    // 自身词频明显更常见（如 saw 也是独立高频词）→ 保留自身
    if (self && self[7] && self[7] <= (target[7] || Infinity)) return false;
    data[form] = [form, lemma, self && self[2] ? self[2] : target[2], target[3], target[4], target[5], target[6], target[7], target[8], target[9]];
    lemmaCount++;
    return true;
  };

  for (const [form, lemma] of lemmas) applyLemma(form, lemma);

  // 规则化补漏：只处理「本地已有 + 自身没有词频」的词形
  const snapshot = Object.keys(data);
  for (const form of snapshot) {
    const self = data[form];
    if (!self || self[7]) continue;                 // 本身有词频就不动
    for (const cand of candidateForms(form)) {
      if (cand === form) continue;
      if (applyLemma(form, cand)) break;
    }
  }

  // 功能词钉死为 A1（放在最后，避免被词形指回覆盖）
  for (const w of FORCE_A1) {
    if (data[w]) { data[w][3] = 'A1'; data[w][8] = 0; }
  }
  // 兜底：任何「本身无词频但被其它词指为原形」的条目，若原形是功能词也降为 A1
  for (const form of Object.keys(data)) {
    const e = data[form];
    if (e && isFunctionWord(e[1])) { e[3] = 'A1'; e[8] = 0; }
  }

  const keys = Object.keys(data).sort();
  const out = {
    meta: {
      source: 'ECDICT (MIT) https://github.com/skywind3000/ECDICT',
      version: '1.0.0',
      builtAt: new Date().toISOString(),
      count: keys.length,
      lemmaEntries: lemmaCount,
      totalLines: lineNo - 1,
      fields: ['headword', 'lemma', 'phonetic', 'cefr', 'pos', 'exams', 'zh', 'rank', 'rare', 'academic']
    },
    k: keys,
    d: {}
  };
  for (const k of keys) out.d[k] = data[k];

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const json = JSON.stringify(out);
  fs.writeFileSync(OUT, json, 'utf8');

  // 同时产出 gzip 版（打包/运行时只读这个，11 MB → 2.7 MB）
  const zlib = require('zlib');
  const gzPath = OUT.replace(/\.json$/, '.json.gz');
  fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }));

  // ── 统计 ──
  const byLevel = {};
  for (const k of keys) { const lv = data[k][3]; byLevel[lv] = (byLevel[lv] || 0) + 1; }
  const sizeMB = fs.statSync(OUT).size / 1024 / 1024;
  const gzMB = fs.statSync(gzPath).size / 1024 / 1024;
  console.log(`输入：${IN}（${lineNo - 1} 行）`);
  console.log(`输出：${OUT}（${sizeMB.toFixed(1)} MB） 与 ${path.basename(gzPath)}（${gzMB.toFixed(1)} MB）`);
  console.log(`词条：${keys.length}（含词形指回 ${lemmaCount}）`);
  console.log('分级分布：' + Object.entries(byLevel).sort().map(([k, v]) => `${k}=${v}`).join('  '));
  console.log('覆盖检查：' + ['the', 'expedition', 'meticulous', 'squander', 'unprecedented', 'ubiquity', 'abyssal', 'heritage']
    .map((w) => `${w}${data[w] ? '✓' + data[w][3] : '✗'}`).join(' '));
}

main().catch((err) => { console.error(err); process.exit(1); });

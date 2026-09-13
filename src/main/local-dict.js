'use strict';
/**
 * local-dict.js — 离线本地词典（ECDICT 精简版）
 *
 * 设计目标：把「绝大多数常见词」的释义在本地解决，只有真正难的词才调用大模型。
 * 数据来自 scripts/build-dict.js 生成的 resources/local-dict.json（CEFR / 考试标签 / 中文释义 / 词形变化）。
 * 内存按需加载一次，之后全部是 O(1) 查表，0 网络、0 费用。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { app } = require('electron');

const CEFR_RANK = { A1: 0, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
const LEVEL_RANK = { none: 0, a2: 2, b1: 3, b2: 4, ielts: 5, toefl: 5, gre: 6, educated_native: 7 };

let dict = null;        // { meta, map: Map<string, entry> }
let loadError = null;

function candidatePaths() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(process.resourcesPath);
  dirs.push(path.join(__dirname, '..', '..', 'resources'));
  dirs.push(path.join(__dirname, '..', '..', 'build'));
  const files = [];
  for (const d of dirs) {
    files.push(path.join(d, 'local-dict.json.gz'));
    files.push(path.join(d, 'local-dict.json'));
  }
  return files;
}

function ensureLoaded() {
  if (dict || loadError) return dict;
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const t0 = Date.now();
      const raw = p.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(p)).toString('utf8')
        : fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      const map = new Map();
      for (const w of parsed.k || []) {
        const e = parsed.d[w];
        if (e) map.set(w, e);
      }
      dict = { meta: parsed.meta || {}, map, file: p, loadMs: Date.now() - t0 };
      console.log(`[local-dict] 已加载 ${map.size} 词条（${path.basename(p)}，${dict.loadMs}ms）`);
      return dict;
    } catch (err) {
      loadError = err;
      console.error('[local-dict] 加载失败：', p, err.message);
    }
  }
  if (!loadError) loadError = new Error('未找到 local-dict.json(.gz)');
  return null;
}

/** 词形变化候选（查表用） */
function candidateForms(word) {
  const w = String(word || '').toLowerCase().trim();
  if (!w) return [];
  const out = new Set([w]);
  const add = (x) => { if (x && x.length > 1) out.add(x); };
  const undouble = (s) => (/([bdfglmnprtz])\1$/.test(s) ? s.slice(0, -1) : s);
  if (w.includes(' ')) add(w.split(/\s+/)[0]);                 // 短语先试首词
  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/(ches|shes|sses|xes|zes)$/.test(w)) add(w.slice(0, -2));
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
  if (/ing$/.test(w)) {
    const stem = w.slice(0, -3);
    add(stem); add(undouble(stem)); add(stem + 'e');
    if (/y$/.test(stem)) add(stem.slice(0, -1) + 'ie');
  }
  if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
  if (/ed$/.test(w)) {
    const stem = w.slice(0, -2);
    add(stem); add(undouble(stem)); add(w.slice(0, -1));
    if (/i$/.test(stem)) add(stem.slice(0, -1) + 'y');
  }
  if (/er$/.test(w)) { add(w.slice(0, -2)); add(undouble(w.slice(0, -2))); add(w.slice(0, -1)); }
  if (/est$/.test(w)) { add(w.slice(0, -3)); add(undouble(w.slice(0, -3))); add(w.slice(0, -2)); }
  if (/ly$/.test(w)) add(w.slice(0, -2));
  return [...out];
}

/** 查词（含词形还原），返回条目 + 命中的形式 */
function get(rawWord) {
  const d = ensureLoaded();
  if (!d) return null;
  const forms = candidateForms(rawWord);
  for (const f of forms) {
    const e = d.map.get(f);
    if (e) return { ...e, matchedForm: f, queriedWord: String(rawWord || '').toLowerCase() };
  }
  return null;
}

/**
 * 该条目是否达到目标级别。
 * 只用 CEFR（词频推导）与生僻标记判定 —— 考试标签（IELTS/TOEFL/GRE）只作为徽标展示，
 * 不参与难度判定：像 could 这类基础词也出现在 TOEFL 词表里，用标签判级会把它误标成难词。
 */
function meetsTier(entry, levelId) {
  const target = LEVEL_RANK[String(levelId || 'none')] ?? 0;
  if (target === 0) return true;
  if (!entry) return false;
  const cefr = String(entry[3] || '').toUpperCase();
  let rank = CEFR_RANK[cefr];
  if (rank === undefined) rank = 3;
  if (entry[8]) rank = Math.max(rank, 7);   // rare → 母语级
  return rank >= target;
}

/** 是否需要大模型参与（本地没收录，或本地有但需要语境/背景知识） */
function needsContext(entry) {
  if (!entry) return true;                       // 本地没有 → 必须问 AI
  if (entry[8]) return true;                     // 生僻词 → 语境意义大
  if (entry[9]) return true;                     // 学术词 → 学科含义可能有偏差
  if (!entry[6]) return true;                    // 没有中文释义 → 只能问 AI
  if (entry[0].length >= 13) return true;        // 超长词多为多义/专业
  return false;
}

/** 把紧凑数组展开成渲染进程用的对象 */
function expand(entry, levelId) {
  if (!entry) return null;
  return {
    source: 'local',
    word: entry[0],
    queriedWord: entry.queriedWord || entry[0],
    matchedForm: entry[1] || entry[0],
    lemma: entry[1] || entry[0],
    phonetic: entry[2] || '',
    pos: entry[4] || '',
    cefr: entry[3] || '',
    examLevels: entry[5] ? String(entry[5]).split(',').filter(Boolean) : [],
    isAcademic: !!entry[9],
    rare: !!entry[8],
    translation: entry[6] || '',
    enDef: '',
    example: '',
    exampleZh: '',
    rank: entry[7] || 0,
    meetsTier: meetsTier(entry, levelId),
    needContext: needsContext(entry)
  };
}

/**
 * 分级批量查询：本地词典 + 级别判定 + 锁定过滤
 * @returns {{ entries, skipped, below, needLlm, stats }}
 */
function lookupBatch(requests, options = {}) {
  const levelId = options.level || 'toefl';
  const lock = !!options.lockLevel;
  const entries = {};
  const skipped = {};
  const below = {};
  const needLlm = [];
  let localHits = 0;
  let blocked = 0;

  for (const req of requests || []) {
    const word = String(req.word || '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    const hit = options.enabled === false ? null : get(word);
    if (!hit) {
      needLlm.push({ word, context: req.context || '', reason: 'not-in-local-dict' });
      continue;
    }
    const atLevel = meetsTier(hit, levelId);
    const expanded = expand(hit, levelId);
    if (!atLevel) {
      if (lock) {
        blocked++;
        below[key] = {
          status: 'below', reason: 'locked', level: levelId,
          cefr: expanded.cefr, examLevels: expanded.examLevels, translation: ''
        };
        continue;
      }
      // 未锁定：低级别词也给本地释义（0 费用），但不作为“难词”高亮
      localHits++;
      entries[key] = { ...expanded, belowLevel: true };
      continue;
    }
    localHits++;
    const wantsLlm = options.llmForContext !== false && expanded.needContext;
    if (wantsLlm) {
      needLlm.push({ word, context: req.context || '', reason: expanded.translation ? 'context' : 'no-translation', local: expanded });
      if (expanded.translation) entries[key] = expanded;   // 先用本地结果顶上，AI 回来可覆盖
    } else {
      entries[key] = expanded;
    }
  }

  return { entries, skipped, below, needLlm, stats: { localHits, blocked, needLlm: needLlm.length, total: (requests || []).length } };
}

function stats() {
  const d = ensureLoaded();
  if (!d) return { loaded: false, error: loadError ? loadError.message : '未知', size: 0 };
  return {
    loaded: true,
    file: d.file,
    size: d.map.size,
    loadMs: d.loadMs,
    version: (d.meta && d.meta.version) || '',
    builtAt: (d.meta && d.meta.builtAt) || '',
    source: (d.meta && d.meta.source) || ''
  };
}

module.exports = { get, lookupBatch, meetsTier, needsContext, stats, candidateForms, ensureLoaded };

'use strict';
/**
 * llm.js — 大模型取词引擎（省钱核心）
 *
 * 设计要点：
 *  1) 分级过滤：只翻译「目标级别及以上」的词，低于目标级别的常用词直接跳过，
 *     LLM 用 shouldExplain:false 返回，本地不渲染、不缓存翻译 → 大幅省 token。
 *  2) 批量合并：一屏/一段内的候选词一次性请求（batchSize），并做请求去重与内存缓存。
 *  3) 本地持久缓存：同一个词在同一个级别下只花钱查一次（cache.json）。
 *  4) 结构化输出：要求返回严格 JSON，失败时自动降级解析。
 *
 * 级别定义（rank 越大越难）：
 *   A1/A2/B1/B2 = CEFR 基础；IELTS/TOEFL → C1；GRE → C2；EDUCATED_NATIVE → 母语级书面语。
 */

const { settings, getApiKey, getCacheDir } = require('./store');
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────────────────────
// 级别体系
// ─────────────────────────────────────────────────────────────
const LEVELS = [
  { id: 'none', label: '不筛选（全部单词）', short: '全部', rank: 0, desc: '每个生词都翻译，最费 token' },
  { id: 'a2', label: 'A2 基础', short: 'A2', rank: 2, cefr: 'A2' },
  { id: 'b1', label: 'B1 中级', short: 'B1', rank: 3, cefr: 'B1' },
  { id: 'b2', label: 'B2 中高级', short: 'B2', rank: 4, cefr: 'B2' },
  { id: 'ielts', label: '雅思 IELTS', short: '雅思', rank: 5, cefr: 'C1', exam: 'IELTS', desc: '雅思 6.5+ 核心词及以上' },
  { id: 'toefl', label: '托福 TOEFL', short: '托福', rank: 5, cefr: 'C1', exam: 'TOEFL', desc: '托福核心学术词及以上' },
  { id: 'gre', label: 'GRE', short: 'GRE', rank: 6, cefr: 'C2', exam: 'GRE', desc: 'GRE 高阶词库' },
  { id: 'educated_native', label: 'Educated Native（受过良好教育的母语级）', short: '母语级', rank: 7, cefr: 'C2+', desc: '母语者书面/文化典故级难词' }
];

const LEVEL_BY_ID = Object.fromEntries(LEVELS.map((l) => [l.id, l]));
const CEFR_RANK = { A1: 0, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, 'C2+': 7 };

function levelRank(levelId) {
  const l = LEVEL_BY_ID[levelId];
  return l ? l.rank : 0;
}

/**
 * 判断一个词条是否达到目标级别（>= 目标）
 * entry: { cefr, examLevels: [], isAcademic, isIdiom, rare }
 */
function meetsLevel(entry, targetLevelId) {
  const target = LEVEL_BY_ID[targetLevelId] || LEVEL_BY_ID.none;
  if (target.id === 'none') return true;
  const ranks = [];
  if (entry.cefr && CEFR_RANK[String(entry.cefr).toUpperCase()] !== undefined) {
    ranks.push(CEFR_RANK[String(entry.cefr).toUpperCase()]);
  }
  if (entry.rare) ranks.push(7);
  if (entry.isIdiom) ranks.push(5);
  if (entry.isAcademic) ranks.push(5);
  if (Array.isArray(entry.examLevels)) {
    for (const ex of entry.examLevels) {
      const up = String(ex).toUpperCase();
      if (up === 'GRE') ranks.push(6);
      else if (up === 'TOEFL' || up === 'IELTS') ranks.push(5);
    }
  }
  if (!ranks.length) ranks.push(CEFR_RANK[(entry.cefr && String(entry.cefr).toUpperCase()) || 'B1'] ?? 3);
  const best = Math.max(...ranks);
  return best >= target.rank;
}

// ─────────────────────────────────────────────────────────────
// 持久缓存
// ─────────────────────────────────────────────────────────────
const CACHE_FILE = 'dictionary-cache.json';
const CACHE_MAX = 20000;
let cacheData = null;

function cachePath() { return path.join(getCacheDir(), CACHE_FILE); }

function loadCache() {
  if (cacheData) return cacheData;
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const parsed = JSON.parse(raw);
    cacheData = { schema: 1, entries: parsed.entries || {} };
  } catch (_) {
    cacheData = { schema: 1, entries: {} };
  }
  return cacheData;
}

let cacheDirty = false;
let cacheTimer = null;
function scheduleCacheSave() {
  cacheDirty = true;
  if (cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = null;
    if (!cacheDirty || !cacheData) return;
    cacheDirty = false;
    try {
      const keys = Object.keys(cacheData.entries);
      if (keys.length > CACHE_MAX) {
        // 简单 LRU：按 lastUsed 丢最旧
        const sorted = keys.map((k) => [k, cacheData.entries[k].lastUsed || 0]).sort((a, b) => b[1] - a[1]);
        const keep = Object.fromEntries(sorted.slice(0, CACHE_MAX));
        cacheData.entries = keep;
      }
      fs.writeFileSync(cachePath(), JSON.stringify(cacheData), 'utf8');
    } catch (err) {
      console.error('[llm] 缓存写入失败：', err.message);
    }
  }, 1500);
  if (cacheTimer.unref) cacheTimer.unref();
}

function cacheKey(word, ctx) {
  const model = settings().get('llm.model', 'deepseek-chat');
  const mode = settings().get('lookup.explainInChinese', true) ? 'zh' : 'en';
  // 上下文只取前 60 字符参与 key，避免同词不同句重复付费，同时保留词义消歧
  const cx = (ctx || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${model}|${mode}|${word.toLowerCase()}|${cx ? hash32(cx) : ''}`;
}

function hash32(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function cacheGet(word, ctx) {
  if (!settings().get('lookup.cacheEnabled', true)) return null;
  const c = loadCache();
  const hit = c.entries[cacheKey(word, ctx)];
  if (!hit) return null;
  if (!hit.entry) return null; // 负缓存（级别不足）也复用，避免重复调用
  hit.lastUsed = Date.now();
  hit.hits = (hit.hits || 0) + 1;
  scheduleCacheSave();
  return hit.entry;
}

function cacheGetSkip(word, ctx) {
  if (!settings().get('lookup.cacheEnabled', true)) return null;
  const c = loadCache();
  const hit = c.entries[cacheKey(word, ctx)];
  if (!hit || hit.entry) return null;
  return { skipped: true, reason: hit.skipReason || 'below-level', cefr: hit.cefr || '' };
}

function cacheSet(word, ctx, entry, meta = {}) {
  if (!settings().get('lookup.cacheEnabled', true)) return;
  const c = loadCache();
  c.entries[cacheKey(word, ctx)] = {
    word: word.toLowerCase(),
    entry: entry || null,
    skipReason: meta.skipReason || null,
    cefr: (entry && entry.cefr) || meta.cefr || '',
    addedAt: Date.now(),
    lastUsed: Date.now(),
    hits: 1
  };
  scheduleCacheSave();
}

function cacheStats() {
  const c = loadCache();
  const keys = Object.keys(c.entries);
  let explained = 0;
  for (const k of keys) if (c.entries[k].entry) explained++;
  return { total: keys.length, explained, skipped: keys.length - explained, path: cachePath() };
}

function clearCache() {
  cacheData = { schema: 1, entries: {} };
  try { fs.rmSync(cachePath(), { force: true }); } catch (_) { /* ignore */ }
  return cacheStats();
}

// ─────────────────────────────────────────────────────────────
// 提示词
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 提示词（精简版：只要求「点选后弹框」真正需要的字段，不含例句）
// 每一 token 都直接影响点选成本 —— 系统提示在每次单词查询里都要重发一遍。
// ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Bilingual EN->Simplified-Chinese lexicographer for Chinese learners of English.
Input: JSON {"i":int,"w":word,"c":the sentence it appears in}.
Output STRICT JSON, no prose:
{"r":[{"i":0,"lemma":"base form","ph":"/.../","pos":"n.","cefr":"B2","ex":["TOEFL"],"ac":false,"idi":false,"rare":false,"ok":true,"zh":"简明中文释义","en":"short English definition"}]}
Rules:
1 cefr one of A1,A2,B1,B2,C1,C2 - difficulty for an adult Chinese learner.
2 ex: any of IELTS,TOEFL,GRE this word belongs to; else [].
3 ac=academic word; idi=idiom/phrasal verb; rare=literary or highly specialized.
4 ok is the only cost-control flag: false when the word is clearly BELOW target level L given in the user message, otherwise true. Functional words, proper nouns and numbers are always false. When ok=false set zh and en to "".
5 zh <= 14 Chinese characters, disambiguated by context c. en <= 12 words.
6 lemma = base form (running->run, better->good); keep multi-word units as-is.
7 One output item per input item, same i and order, no omissions.`;

function buildUserPrompt(items, ctx = {}) {
  const level = LEVEL_BY_ID[ctx.level] || LEVEL_BY_ID.none;
  const list = items.map((it, idx) => ({
    i: idx,
    w: it.word,
    c: (it.context || '').slice(0, ctx.contextChars || 160)
  }));
  return `L=${level.id.toUpperCase()}${level.cefr ? '/' + level.cefr : ''}`
    + (level.exam ? ` exam=${level.exam}` : '')
    + (ctx.explainInChinese === false ? ' out=EN' : '')
    + (ctx.topic ? ` topic=${String(ctx.topic).slice(0, 60)}` : '')
    + `\n${JSON.stringify({ r: list })}`;
}

// ─────────────────────────────────────────────────────────────
// HTTP 调用（OpenAI 兼容协议；兼容 DeepSeek / OpenAI / Kimi / 通义 / Ollama / LM Studio 等）
// ─────────────────────────────────────────────────────────────
function normalizeBaseURL(url) {
  let u = String(url || '').trim();
  if (!u) u = 'https://api.deepseek.com/v1';
  u = u.replace(/\/+$/, '');
  if (/\/(chat\/completions)$/i.test(u)) return u;
  if (!/\/v\d+$/i.test(u)) u = u + '/v1';
  return u + '/chat/completions';
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/g, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return null;
  const slice = t.slice(first, last + 1);
  try { return JSON.parse(slice); } catch (_) { /* repair below */ }
  try {
    // 修复常见 LLM JSON 毛病：尾随逗号 / 中文引号
    const repaired = slice
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u201c\u201d]/g, '"');
    return JSON.parse(repaired);
  } catch (_) {
    return null;
  }
}

async function chatJSON(messages, opts = {}) {
  const s = settings();
  const apiKey = getApiKey() || opts.apiKey || '';
  const baseURL = normalizeBaseURL(s.get('llm.baseURL'));
  const model = s.get('llm.model', 'deepseek-chat');
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(baseURL);
  if (!apiKey && !isLocal) {
    const err = new Error('NO_API_KEY');
    err.code = 'NO_API_KEY';
    throw err;
  }
  const body = {
    model,
    messages,
    temperature: Number(s.get('llm.temperature', 0.2)),
    max_tokens: Number(s.get('llm.maxTokens', 2048)),
    stream: false,
    response_format: { type: 'json_object' }
  };
  const controller = new AbortController();
  const timeout = Number(s.get('llm.timeoutMs', 45000));
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(baseURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      const e = new Error(`请求超时（${timeout}ms）`); e.code = 'TIMEOUT'; throw e;
    }
    const e = new Error(`网络请求失败：${err.message}`); e.code = 'NETWORK'; throw e;
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 400); } catch (_) { /* ignore */ }
    // 部分服务不支持 response_format，去掉重试一次
    if (res.status === 400 && /response_format|json/i.test(detail)) {
      delete body.response_format;
      const retry = await fetch(baseURL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(body)
      });
      if (retry.ok) {
        const data = await retry.json();
        const content = data?.choices?.[0]?.message?.content || '';
        return { json: extractJson(content), raw: content, usage: data?.usage || {}, ms: Date.now() - t0, model };
      }
      detail = (await retry.text().catch(() => '')).slice(0, 400) || detail;
    }
    const e = new Error(`API ${res.status}：${detail || res.statusText}`);
    e.code = 'HTTP_' + res.status;
    throw e;
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content || '';
  const json = extractJson(content);
  if (!json) {
    const e = new Error('模型返回内容无法解析为 JSON');
    e.code = 'BAD_JSON';
    e.raw = content.slice(0, 500);
    throw e;
  }
  return { json, raw: content, usage: data?.usage || {}, ms: Date.now() - t0, model };
}

// ─────────────────────────────────────────────────────────────
// 取词主流程
// ─────────────────────────────────────────────────────────────
/** 解析模型返回项；兼容精简键名(zh/en/ph/ex/ac/idi/ok)与旧的长键名 */
function normalizeEntry(raw, originalWord, levelId) {
  if (!raw) return null;
  const pick = (...keys) => {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];
    }
    return undefined;
  };
  const rawCefr = String(pick('cefr') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rawExams = pick('exams', 'ex', 'examLevels');
  const entry = {
    word: originalWord,
    lemma: String(pick('lemma') || originalWord || '').trim(),
    phonetic: String(pick('phonetic', 'ph') || '').trim(),
    pos: String(pick('pos') || '').trim(),
    cefr: /^(A1|A2|B1|B2|C1|C2)$/.test(rawCefr) ? rawCefr : (rawCefr || 'B1'),
    examLevels: Array.isArray(rawExams) ? rawExams.map((x) => String(x).toUpperCase()).filter(Boolean) : [],
    isAcademic: !!(pick('isAcademic', 'ac') || false),
    isIdiom: !!(pick('isIdiom', 'idi') || false),
    rare: !!raw.rare,
    shouldExplain: pick('shouldExplain', 'ok') !== false,
    translation: String(pick('translation', 'zh') || '').trim(),
    enDef: String(pick('enDef', 'en') || '').trim(),
    example: String(pick('example') || '').trim(),
    exampleZh: String(pick('exampleZh') || '').trim(),
    lookedUpAt: Date.now()
  };
  if (!entry.translation && !entry.enDef && entry.shouldExplain) entry.shouldExplain = false;
  return entry;
}

/** 从句子中提取候选词（英文实词优先，去掉纯功能词/数字/单字母） */
const BASIC_STOP = new Set(('a an the and or but if then than that this these those there here of to in on at by for with from as is are was were be been being am do does did done have has had having will would shall should can could may might must not no nor so such it its it\'s i you he she they we me him her them us my your his their our mine yours theirs who whom whose which what when where why how all any both each few more most other some only own same too very just also again further once during before after above below up down out off over under into about against between because while both each'.split(/\s+/)).filter(Boolean));

function tokenizeCandidates(text, opts = {}) {
  const words = [];
  const re = /[A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z][A-Za-z'’\-]*){0,2}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let token = m[0].trim();
    // 去掉尾随连字符/撇号
    token = token.replace(/^[-'’]+|[-'’]+$/g, '');
    if (!token) continue;
    const lower = token.toLowerCase();
    if (token.length < 2) continue;
    if (/^\d+$/.test(token)) continue;
    const parts = lower.split(/\s+/);
    const isPhrase = parts.length > 1;
    if (!isPhrase && BASIC_STOP.has(lower)) continue;
    if (!isPhrase && opts.skipProperNouns && /^[A-Z][a-z]+$/.test(token) && !/^[A-Z]/.test(text)) continue;
    words.push({ word: token, lower, isPhrase });
  }
  // 去掉被更长短语包含的单词（短语优先）
  const phraseSet = new Set(words.filter((w) => w.isPhrase).map((w) => w.lower));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (!w.isPhrase) {
      let covered = false;
      for (const p of phraseSet) if (p.includes(w.lower)) { covered = true; break; }
      if (covered) continue;
    }
    if (seen.has(w.lower)) continue;
    seen.add(w.lower);
    out.push(w);
  }
  return out;
}

/**
 * 批量查询/解释单词
 * @param {Array<{word:string, context?:string}>} requests
 * @param {object} options { level, force, topic, noCache }
 * @returns {Promise<{entries:object, skipped:object, stats:object}>}
 */
async function lookupBatch(requests, options = {}) {
  const s = settings();
  const levelId = options.level || s.get('lookup.level', 'toefl');
  const force = !!options.force;
  const results = { entries: {}, skipped: {}, requested: requests.length, fromCache: 0, toApi: 0, usage: null, ms: 0 };

  // 1) 先查缓存
  const pending = [];
  const pendingSeen = new Set();
  for (const req of requests) {
    const word = String(req.word || '').trim();
    if (!word) continue;
    const key = word.toLowerCase();
    if (!force || options.noCache) {
      const hit = cacheGet(word, req.context);
      if (hit) {
        results.entries[key] = hit;
        results.fromCache++;
        continue;
      }
      const miss = cacheGetSkip(word, req.context);
      if (miss && !options.force) {
        results.skipped[key] = miss;
        results.fromCache++;
        continue;
      }
    }
    if (pendingSeen.has(key)) continue; // 请求内去重
    pendingSeen.add(key);
    pending.push({ word, context: req.context || '' });
  }

  if (!pending.length) return results;

  // 2) 分组请求（batchSize）
  const batchSize = Math.max(4, Math.min(Number(options.batchSize || s.get('lookup.batchSize', 24)), 60));
  const groups = [];
  for (let i = 0; i < pending.length; i += batchSize) groups.push(pending.slice(i, i + batchSize));

  for (const group of groups) {
    const t0 = Date.now();
    let resp;
    try {
      resp = await chatJSON([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(group, { level: levelId, explainInChinese: s.get('lookup.explainInChinese', true), topic: options.topic }) }
      ], options);
    } catch (err) {
      err.partial = results;
      throw err;
    }
    results.ms += Date.now() - t0;
    results.toApi++;
    if (resp.usage) {
      results.usage = results.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      results.usage.prompt_tokens += resp.usage.prompt_tokens || 0;
      results.usage.completion_tokens += resp.usage.completion_tokens || 0;
      results.usage.total_tokens += resp.usage.total_tokens || 0;
    }
    const parsed = resp.json || {};
    const items = Array.isArray(parsed.r) ? parsed.r
      : (Array.isArray(parsed.items) ? parsed.items : []);   // r = 精简键，items = 兼容旧格式
    const byIndex = new Map();
    for (const it of items) {
      const idx = Number(it.i);
      if (Number.isFinite(idx)) byIndex.set(idx, it);
    }
    group.forEach((req, idx) => {
      const key = req.word.toLowerCase();
      const raw = byIndex.get(idx) || items[idx] || null;
      const entry = normalizeEntry(raw, req.word, levelId);
      if (!entry) {
        results.skipped[key] = { skipped: true, reason: 'no-data' };
        cacheSet(req.word, req.context, null, { skipReason: 'no-data' });
        return;
      }
      const pass = force || levelId === 'none' || !options.applyLevelFilter
        ? true
        : meetsLevel(entry, levelId);
      if (!entry.shouldExplain || !pass) {
        results.skipped[key] = { skipped: true, reason: entry.shouldExplain ? 'below-level' : 'not-needed', cefr: entry.cefr, examLevels: entry.examLevels };
        cacheSet(req.word, req.context, null, { skipReason: results.skipped[key].reason, cefr: entry.cefr });
        // 仍然返回分级信息，用于正文高亮标记
        results.skipped[key].entry = { ...entry, translation: '', enDef: '', example: '', exampleZh: '' };
      } else {
        results.entries[key] = entry;
        cacheSet(req.word, req.context, entry);
      }
    });
  }
  return results;
}

/** 单词语境释义（查词典面板用，总是强制查询，忽略级别过滤） */
async function lookupWord(word, context, options = {}) {
  const res = await lookupBatch([{ word, context }], { ...options, force: true, applyLevelFilter: false });
  const key = String(word).toLowerCase();
  return res.entries[key] || null;
}

/** 段落级扫描：为一行字幕里的难词批量打标（返回 word→entry/skip 映射） */
async function scanLine(text, context, options = {}) {
  const s = settings();
  const levelId = options.level || s.get('lookup.level', 'toefl');
  const candidates = tokenizeCandidates(text, {});
  if (!candidates.length) return { entries: {}, skipped: {} };
  const max = Math.max(1, Math.min(Number(options.maxWords || s.get('lookup.maxWordsPerRequest', 40)), 60));
  const list = candidates.slice(0, max).map((c) => ({ word: c.word, context: context || text }));
  const res = await lookupBatch(list, { ...options, level: levelId, applyLevelFilter: true });
  return res;
}

/** 整篇自动分级（控制 token：按行合并上下文） */
async function scanTranscript(cues, options = {}) {
  const s = settings();
  const levelId = options.level || s.get('lookup.level', 'toefl');
  const limit = Math.max(1, Math.min(Number(options.limit || s.get('lookup.autoScanLimit', 400)), 4000));
  const slice = cues.slice(0, limit);
  const wordMap = new Map(); // lower -> {word, context, lineIndex}
  slice.forEach((cue, lineIndex) => {
    const text = cue.en || cue.text || '';
    for (const c of tokenizeCandidates(text)) {
      if (!wordMap.has(c.lower)) wordMap.set(c.lower, { word: c.word, context: text, lineIndex });
    }
  });
  const list = [...wordMap.values()];
  const res = await lookupBatch(list, { ...options, level: levelId, applyLevelFilter: true });
  return {
    ...res,
    scannedLines: slice.length,
    uniqueWords: list.length,
    level: levelId
  };
}

// ─────────────────────────────────────────────────────────────
// 分级取词总入口：本地词典优先，只有「难词 / 需要背景知识」才调用大模型
// ─────────────────────────────────────────────────────────────
const localDict = require('./local-dict');

/**
 * @param {Array<{word:string, context?:string}>} requests
 * @param {object} options { level, lockLevel, force, localDict, llmForContext, topic, onlyLocal }
 */
async function lookupTiered(requests, options = {}) {
  const s = settings();
  const levelId = options.level || s.get('lookup.level', 'toefl');
  const lockLevel = options.lockLevel !== undefined ? !!options.lockLevel : !!s.get('lookup.lockLevel', false);
  const useLocal = options.localDict !== undefined ? !!options.localDict : !!s.get('lookup.localDict', true);
  const llmForContext = options.llmForContext !== undefined ? !!options.llmForContext : !!s.get('lookup.llmForContext', true);
  const list = (requests || []).map((r) => ({ word: String(r.word || '').trim(), context: r.context || '' })).filter((r) => r.word);
  // skipLocal：单词查询（点选弹释义）走这条路 —— 本地词典只负责分级筛选，不在这里出释义
  const skipLocal = !!options.skipLocal;

  const result = {
    ok: true,
    level: levelId,
    locked: lockLevel,
    entries: {},          // 有释义（本地或 AI）
    below: {},            // 低于级别：锁定则不可取词；未锁定则带本地释义
    blocked: {},          // 锁定拦截
    skipped: {},
    stats: {
      requested: list.length, localHits: 0, llmWords: 0, blocked: 0,
      aiCalls: 0, aiSkippedByCache: 0, localOnly: 0
    },
    usage: null,
    ms: 0
  };
  if (!list.length) return result;

  // ① 本地词典分级（skipLocal 时全部交给 AI）
  const local = (useLocal && !skipLocal)
    ? localDict.lookupBatch(list, { level: levelId, lockLevel, llmForContext })
    : {
        entries: {},
        skipped: {},
        below: {},
        needLlm: list.map((r) => ({ ...r, reason: skipLocal ? 'skip-local' : 'local-disabled' })),
        stats: { localHits: 0, blocked: 0, needLlm: list.length, total: list.length }
      };

  Object.assign(result.entries, local.entries);
  Object.assign(result.below, local.below);
  result.stats.localHits = local.stats.localHits;
  result.stats.blocked = local.stats.blocked;

  // ② 只对「需要 AI」的词调用大模型；锁定时低级别词已在本地被拦下
  const needLlm = (local.needLlm || []).filter((r) => {
    if (options.onlyLocal) return false;
    if (lockLevel && local.below[r.word.toLowerCase()]) return false;
    return true;
  });
  if (needLlm.length) {
    const t0 = Date.now();
    try {
      const aiRes = await lookupBatch(needLlm, {
        level: levelId,
        applyLevelFilter: false,     // 分级过滤已由本地词典完成
        force: true,
        batchSize: options.batchSize,
        topic: options.topic
      });
      result.ms += Date.now() - t0;
      result.stats.aiCalls += aiRes.toApi || 0;
      result.stats.aiSkippedByCache += aiRes.fromCache || 0;
      result.stats.llmWords = needLlm.length;
      if (aiRes.usage) {
        result.usage = result.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        result.usage.prompt_tokens += aiRes.usage.prompt_tokens || 0;
        result.usage.completion_tokens += aiRes.usage.completion_tokens || 0;
        result.usage.total_tokens += aiRes.usage.total_tokens || 0;
      }
      // AI 结果覆盖本地（AI 有语境，质量更高）
      for (const [k, v] of Object.entries(aiRes.entries || {})) {
        result.entries[k] = { ...(result.entries[k] || {}), ...v, source: 'ai', needContext: false };
      }
      for (const [k, v] of Object.entries(aiRes.skipped || {})) {
        const localEntry = result.entries[k];
        if (localEntry) {
          // 本地已有释义：保留，只标记 AI 认为不需要额外解释
          localEntry.needContext = false;
          continue;
        }
        result.skipped[k] = v;
      }
    } catch (err) {
      // 关键：AI 失败（无 Key / 401 / 余额不足 / 网络问题）不能丢掉已经算好的本地结果。
      // 本地词典覆盖了绝大多数词，AI 只是锦上添花。
      result.stats.llmWords = needLlm.length;
      result.stats.aiFailed = needLlm.length;
      result.aiError = { code: err.code || 'ERROR', message: err.message };
      result.ok = true;
      result.partial = true;
    }
  }

  // 统计：本地单独解决的词数（0 费用）
  result.stats.localOnly = Object.values(result.entries).filter((e) => e && e.source === 'local').length;
  const localBelow = Object.values(result.below).filter((b) => b && b.translation).length;
  result.stats.localOnly += localBelow;
  return result;
}

/** 连通性 / API Key 自检 */
async function testConnection() {  const s = settings();
  const t0 = Date.now();
  try {
    const resp = await chatJSON([
      { role: 'system', content: 'You return strict JSON only.' },
      { role: 'user', content: 'Return {"ok":true,"msg":"pong"}' }
    ], {});
    return {
      ok: true,
      ms: Date.now() - t0,
      model: s.get('llm.model'),
      baseURL: s.get('llm.baseURL'),
      sample: resp.json,
      usage: resp.usage
    };
  } catch (err) {
    return { ok: false, code: err.code || 'ERROR', error: err.message, ms: Date.now() - t0 };
  }
}

module.exports = {
  LEVELS,
  LEVEL_BY_ID,
  CEFR_RANK,
  levelRank,
  meetsLevel,
  tokenizeCandidates,
  lookupBatch,
  lookupWord,
  lookupTiered,
  scanLine,
  scanTranscript,
  testConnection,
  cacheStats,
  clearCache,
  normalizeBaseURL,
  extractJson,
  chatJSON
};

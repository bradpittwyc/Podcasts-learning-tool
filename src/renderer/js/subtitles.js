'use strict';
/**
 * subtitles.js — 字幕解析/序列化（主进程与渲染进程共用，无依赖）
 * 支持：SRT、WebVTT、ASS/SSA、LRC、JSON、纯文本自动断句
 * 渲染进程通过 window.PLTSubs 访问；主进程通过 module.exports 访问。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PLTSubs = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  const SUBTITLE_EXT = ['.srt', '.vtt', '.ass', '.ssa', '.lrc', '.json', '.txt', '.sbv', '.tsv'];
  const MEDIA_EXT = ['.mp4', '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac', '.webm', '.mkv', '.mov', '.m4v', '.opus', '.wma'];

  // ── 时间戳 ──
  function parseTimestamp(str) {
    if (str === null || str === undefined) return null;
    const s = String(str).trim().replace(',', '.');
    if (!s) return null;
    const m = s.match(/^(?:(\d+):)?(?:(\d{1,2}):)?(\d{1,2}(?:\.\d+)?)$/);
    if (!m) { const n = Number(s); return Number.isFinite(n) ? n : null; }
    const a = m[1] !== undefined ? Number(m[1]) : 0;
    const b = m[2] !== undefined ? Number(m[2]) : 0;
    const c = Number(m[3]);
    return (m[1] !== undefined && m[2] !== undefined) ? a * 3600 + b * 60 + c : a * 60 + b + c;
  }

  function pad(n, w) { return String(n).padStart(w || 2, '0'); }

  function formatTimestamp(sec, style) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const si = Math.floor(s % 60);
    const ms = Math.round((s - Math.floor(s)) * 1000);
    if (style === 'ass') return `${h}:${pad(m)}:${pad(si)}.${pad(Math.floor(ms / 10))}`;
    if (style === 'vtt') return `${pad(h)}:${pad(m)}:${pad(si)}.${pad(ms, 3)}`;
    if (style === 'lrc') return `${pad(m)}:${pad(si)}.${pad(Math.floor(ms / 10))}`;
    return `${pad(h)}:${pad(m)}:${pad(si)},${pad(ms, 3)}`;
  }

  function formatClock(sec) {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }

  // ── 清洗 ──
  function stripMarkup(text) {
    return String(text)
      .replace(/\{[^}]*\}/g, '')            // ASS 标签
      .replace(/\\N|\\n/g, '\n')
      .replace(/\\h/g, ' ')
      .replace(/<\/?[^>]+>/g, '')           // HTML/VTT 标签
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'");
  }

  function cleanCueText(text) {
    return stripMarkup(text).split('\n').map((l) => l.trim()).filter(Boolean).join('\n').trim();
  }

  const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
  const CJK_ALL_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

  /** 双语拆行：返回 {en, zh, raw} */
  function splitBilingual(text) {
    const lines = cleanCueText(text).split('\n').filter((l) => l.trim());
    const en = [];
    const zh = [];
    for (const line of lines) {
      const hasCjk = CJK_RE.test(line);
      const hasLatin = /[A-Za-z]/.test(line);
      if (hasCjk && hasLatin) {
        const idx = line.search(CJK_RE);
        const left = line.slice(0, idx).trim();
        const right = line.slice(idx).trim();
        if (left) en.push(left);
        if (right) zh.push(right);
      } else if (hasCjk) zh.push(line.trim());
      else if (hasLatin) en.push(line.trim());
      else if (line.trim()) en.push(line.trim());
    }
    return { en: en.join(' ').trim(), zh: zh.join(' ').trim(), raw: lines.join('\n') };
  }

  function makeCue(start, end, text) {
    const parts = splitBilingual(text);
    let e = (end === null || end === undefined || end <= start) ? null : end;
    if (e === null) e = start + Math.max(1.2, parts.en.split(/\s+/).filter(Boolean).length * 0.34);
    return {
      start: Math.round(start * 1000) / 1000,
      end: Math.round(e * 1000) / 1000,
      text: parts.raw,
      en: parts.en,
      zh: parts.zh
    };
  }

  // ── 解析器 ──
  function parseSrt(text) {
    const cues = [];
    for (const block of text.replace(/^\uFEFF/, '').split(/\n{2,}/)) {
      const lines = block.split('\n');
      if (!lines.length) continue;
      let idx = /^\s*\d+\s*$/.test(lines[0]) ? 1 : 0;
      const timeLine = (lines[idx] || '').trim();
      const m = timeLine.match(/(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3}|\d+(?:\.\d+)?)\s*-->\s*(\d{1,3}:\d{2}:\d{2}[,.]\d{1,3}|\d{1,2}:\d{2}[,.]\d{1,3}|\d+(?:\.\d+)?)/);
      if (!m) continue;
      const start = parseTimestamp(m[1]);
      const body = cleanCueText(lines.slice(idx + 1).join('\n'));
      if (start === null || !body) continue;
      cues.push(makeCue(start, parseTimestamp(m[2]), body));
    }
    return cues;
  }

  function parseVtt(text) {
    const cues = [];
    const body = text.replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n/, '').replace(/^NOTE[\s\S]*?\n\n/, '');
    for (const block of body.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((l) => l.trim() !== '');
      if (!lines.length) continue;
      let idx = /-->/.test(lines[0]) ? 0 : (/-->/.test(lines[1] || '') ? 1 : -1);
      if (idx < 0) continue;
      const m = lines[idx].match(/([\d:.]+)\s*-->\s*([\d:.]+)/);
      if (!m) continue;
      const start = parseTimestamp(m[1]);
      const clean = cleanCueText(lines.slice(idx + 1).join('\n'));
      if (start === null || !clean) continue;
      cues.push(makeCue(start, parseTimestamp(m[2]), clean));
    }
    return cues;
  }

  function parseAss(text) {
    const cues = [];
    let fields = null;
    for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
      const line = raw.trim();
      if (/^\[.*\]$/.test(line)) { fields = /^\[events\]$/i.test(line) ? fields : null; continue; }
      if (/^Format\s*:/i.test(line)) {
        fields = line.slice(line.indexOf(':') + 1).split(',').map((f) => f.trim().toLowerCase());
        continue;
      }
      if (!/^Dialogue\s*:/i.test(line)) continue;
      const f = fields || ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text'];
      const parts = line.slice(line.indexOf(':') + 1).split(',');
      const head = parts.slice(0, f.length - 1);
      head.push(parts.slice(f.length - 1).join(','));
      const rec = {};
      f.forEach((name, i) => { rec[name] = (head[i] || '').trim(); });
      const start = parseTimestamp(rec.start);
      const clean = cleanCueText(rec.text || '');
      if (start === null || !clean) continue;
      cues.push(makeCue(start, parseTimestamp(rec.end), clean));
    }
    return cues;
  }

  function parseLrc(text) {
    const collected = [];
    const offsetMatch = text.match(/\[offset:\s*(-?\d+)\s*\]/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) / 1000 : 0;
    for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
      const line = raw.trim();
      if (!line || /^\[(ti|ar|al|by|offset|re|ve|length):/i.test(line)) continue;
      const stamps = [...line.matchAll(/\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g)];
      if (!stamps.length) continue;
      const body = line.replace(/\[[^\]]*\]/g, '').trim();
      if (!body) continue;
      for (const st of stamps) {
        collected.push({ start: Number(st[1]) * 60 + parseTimestamp(st[2].replace(':', '.')) + offset, text: body });
      }
    }
    collected.sort((a, b) => a.start - b.start);
    return collected.map((item, i) => {
      const next = collected[i + 1];
      const end = next ? next.start : item.start + Math.max(2.5, item.text.length * 0.06);
      return makeCue(item.start, end, cleanCueText(item.text));
    });
  }

  function parseJsonSubs(text) {
    let data;
    try { data = JSON.parse(text); } catch (_) { return []; }
    const arr = Array.isArray(data) ? data : (data.cues || data.segments || data.items || data.body || []);
    if (!Array.isArray(arr)) return [];
    const cues = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const start = parseTimestamp(item.start ?? item.from ?? item.startTime ?? item.t0);
      const body = item.text ?? item.content ?? item.en ?? item.line ?? '';
      const zh = item.zh ?? item.translation ?? item.cn ?? '';
      const clean = cleanCueText(zh ? `${body}\n${zh}` : body);
      if (start === null || !clean) continue;
      const cue = makeCue(start, parseTimestamp(item.end ?? item.to ?? item.endTime ?? item.t1), clean);
      if (Array.isArray(item.words)) cue.words = item.words;
      cues.push(cue);
    }
    return cues;
  }

  /** 纯文本：按标点断句，按字符数分配时长 */
  function parsePlainText(text, opts) {
    const duration = Number((opts && opts.duration) || 0);
    const cleaned = String(text || '').replace(/\uFEFF/g, '').replace(/\r\n?/g, '\n').trim();
    if (!cleaned) return [];
    const sentences = cleaned.split(/(?<=[.!?。！？；;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
    if (!sentences.length) return [];
    const totalChars = sentences.reduce((a, s) => a + s.length, 0) || 1;
    const cues = [];
    let cursor = 0;
    for (const s of sentences) {
      const dur = duration ? (s.length / totalChars) * duration : Math.max(1.6, s.length * 0.055);
      const start = duration ? cursor : cues.length * 3;
      cues.push(makeCue(start, start + dur, cleanCueText(s)));
      cursor += dur;
    }
    return cues;
  }

  function detectFormat(filePath, text) {
    const ext = String(filePath || '').toLowerCase().match(/\.[a-z0-9]+$/);
    const e = ext ? ext[0] : '';
    const head = String(text || '').slice(0, 600);
    if (e === '.srt') return 'srt';
    if (e === '.vtt') return 'vtt';
    if (e === '.ass' || e === '.ssa') return 'ass';
    if (e === '.lrc') return 'lrc';
    if (e === '.json') return 'json';
    if (e === '.txt') return 'text';
    if (/^WEBVTT/m.test(head)) return 'vtt';
    if (/^\[Script Info\]/im.test(head) || /^Dialogue:/im.test(head)) return 'ass';
    if (/^\[\d{1,3}:\d{2}/m.test(head)) return 'lrc';
    if (/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
    if (/^\s*[[{]/m.test(head)) return 'json';
    return 'text';
  }

  function normalizeCues(cues) {
    const list = cues.filter((c) => c && Number.isFinite(c.start)).sort((a, b) => a.start - b.start);
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const n = list[i + 1];
      if (!(c.end > c.start)) c.end = c.start + 1.2;
      if (n && c.end - n.start > 2) c.end = n.start;
      if (c.end - c.start > 30) c.end = c.start + 30;
    }
    return list;
  }

  function cuesFromText(text, format, opts) {
    const fmt = format || 'srt';
    let cues = [];
    const runners = { srt: parseSrt, vtt: parseVtt, ass: parseAss, lrc: parseLrc, json: parseJsonSubs };
    if (runners[fmt]) cues = runners[fmt](text);
    else cues = parsePlainText(text, opts);
    if (!cues.length && fmt !== 'text') {
      for (const key of ['srt', 'vtt', 'ass', 'lrc', 'json']) {
        const attempt = runners[key](text);
        if (attempt.length) { cues = attempt; break; }
      }
    }
    return normalizeCues(cues);
  }

  function serialize(cues, format, opts) {
    const bilingual = !opts || opts.bilingual !== false;
    const body = (c) => {
      if (!bilingual) return c.en || c.text || '';
      return [c.en, c.zh].map((x) => (x || '').trim()).filter(Boolean).join('\n');
    };
    if (format === 'json') {
      return JSON.stringify({
        version: 1,
        generatedBy: 'Podcasts Learning Tool',
        cues: cues.map((c) => ({ start: c.start, end: c.end, en: c.en || '', zh: c.zh || '', text: c.text || '' }))
      }, null, 2);
    }
    if (format === 'vtt') {
      const out = ['WEBVTT', ''];
      cues.forEach((c, i) => {
        out.push(String(i + 1), `${formatTimestamp(c.start, 'vtt')} --> ${formatTimestamp(c.end, 'vtt')}`, body(c), '');
      });
      return out.join('\n');
    }
    const out = [];
    cues.forEach((c, i) => {
      out.push(String(i + 1), `${formatTimestamp(c.start, 'srt')} --> ${formatTimestamp(c.end, 'srt')}`, body(c), '');
    });
    return out.join('\n');
  }

  /** 二分查找当前时间对应的字幕行索引 */
  function indexAt(cues, time) {
    if (!cues || !cues.length) return -1;
    let lo = 0; let hi = cues.length - 1; let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= time + 0.02) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  // ── 分词（正文渲染 & 取词候选）──
  const STOP = new Set(('a an the and or but if then than that this these those there here of to in on at by for with from as is are was were be been being am do does did done have has had having will would shall should can could may might must not no nor so such it its i you he she they we me him her them us my your his their our mine yours theirs who whom whose which what when where why how all any both each few more most other some only own same too very just also again further once during before after above below up down out off over under into about against between while'.split(' ')));

  /** 把英文句子切成可点击片段：[{type:'word'|'text', text, lower}] */
  function tokenizeLine(text) {
    const out = [];
    const re = /[A-Za-z][A-Za-z'\u2019\-]*/g;
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
      out.push({ type: 'word', text: m[0], lower: m[0].toLowerCase().replace(/[\u2019]/g, "'").replace(/^[-']+|[-']+$/g, '') });
      last = m.index + m[0].length;
    }
    if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
    return out.filter((p) => p.text !== '' && !(p.type === 'word' && !p.lower));
  }

  /** 从文本提取查词候选：所有实词（跳过功能词）+ 2~3 词短语，供大模型分级 */
  function extractCandidates(text) {
    const singles = [];
    const phrases = [];
    const seen = new Set();
    const push = (list, word) => {
      const lower = word.toLowerCase();
      if (seen.has(lower)) return;
      seen.add(lower);
      list.push({ word, lower });
    };
    for (const m of String(text).matchAll(/[A-Za-z][A-Za-z'\u2019\-]*/g)) {
      const w = m[0].replace(/^[-'\u2019]+|[-'\u2019]+$/g, '');
      if (!w || w.length < 2) continue;
      if (STOP.has(w.toLowerCase())) continue;
      push(singles, w);
    }
    // 短语（动词短语 / 习语）：2~3 个词，中间允许空格
    for (const m of String(text).matchAll(/\b([A-Za-z][A-Za-z'\u2019\-]*(?:\s+[A-Za-z][A-Za-z'\u2019\-]*){1,2})\b/g)) {
      const phrase = m[1].trim();
      if (!/[a-z]{2,}\s+[a-z]{2,}/i.test(phrase)) continue;
      // 短语里至少一个实词
      if (!phrase.split(/\s+/).some((w) => !STOP.has(w.toLowerCase()) && w.length >= 3)) continue;
      push(phrases, phrase);
    }
    return [...singles, ...phrases];
  }

  /** 猜测词形还原（用于把 LLM 返回的 lemma 映射回正文词） */
  function guessLemmas(word) {
    const w = String(word || '').toLowerCase();
    const out = new Set([w]);
    const add = (x) => { if (x && x.length > 1) out.add(x); };
    const undouble = (s) => (/([bdfglmnprtz])\1$/.test(s) ? s.slice(0, -1) : s);
    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/(ches|shes|sses|xes|zes)$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1));
    if (/ing$/.test(w)) {
      const stem = w.slice(0, -3);
      add(stem);
      add(undouble(stem));
      add(stem + 'e');
      if (/y$/.test(stem)) add(stem.slice(0, -1) + 'ie');
    }
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) {
      const stem = w.slice(0, -2);
      add(stem);
      add(undouble(stem));
      add(w.slice(0, -1));
      if (/i$/.test(stem)) add(stem.slice(0, -1) + 'y');
    }
    if (/er$/.test(w)) { add(w.slice(0, -2)); add(undouble(w.slice(0, -2))); add(w.slice(0, -1)); }
    if (/est$/.test(w)) { add(w.slice(0, -3)); add(undouble(w.slice(0, -3))); add(w.slice(0, -2)); }
    if (/ly$/.test(w)) add(w.slice(0, -2));
    return [...out];
  }

  function isCjkChar(ch) { return CJK_ALL_RE.test(ch); }

  // ── 文件层（仅主进程可用，渲染进程会得到 null）──
  let nodeFs = null;
  let nodePath = null;
  try {
    if (typeof module === 'object' && module.exports && typeof require === 'function') {
      nodeFs = require('fs');
      nodePath = require('path');
    }
  } catch (_) { /* 浏览器环境 */ }

  function sniffEncoding(buf) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return 'utf-8'; } catch (_) { /* not utf8 */ }
    for (const enc of ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
      try {
        const d = new TextDecoder(enc, { fatal: true }).decode(buf);
        if (d && !/\uFFFD/.test(d)) return enc;
      } catch (_) { /* next */ }
    }
    return 'utf-8';
  }

  function decodeBuffer(buf) {
    const encoding = sniffEncoding(buf);
    let text;
    try { text = new TextDecoder(encoding, { fatal: false }).decode(buf); }
    catch (_) { text = buf.toString('utf8'); }
    return { text: text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'), encoding };
  }

  function loadSubtitleFile(filePath, opts) {
    if (!nodeFs) throw new Error('loadSubtitleFile 仅在主进程可用');
    const buf = nodeFs.readFileSync(filePath);
    const { text, encoding } = decodeBuffer(buf);
    const format = detectFormat(filePath, text);
    const cues = cuesFromText(text, format, opts);
    return {
      path: filePath,
      name: nodePath.basename(filePath),
      encoding,
      format,
      cues,
      count: cues.length,
      duration: cues.length ? cues[cues.length - 1].end : 0
    };
  }

  function saveSubtitleFile(filePath, cues, opts) {
    if (!nodeFs) throw new Error('saveSubtitleFile 仅在主进程可用');
    const ext = nodePath.extname(filePath).toLowerCase();
    const format = ext === '.vtt' ? 'vtt' : ext === '.json' ? 'json' : 'srt';
    const text = serialize(cues, format, opts);
    nodeFs.mkdirSync(nodePath.dirname(filePath), { recursive: true });
    nodeFs.writeFileSync(filePath, '\uFEFF' + text, 'utf8');
    return { path: filePath, format, count: cues.length };
  }

  function findSiblingSubtitle(mediaPath) {
    if (!nodeFs) return null;
    try {
      const dir = nodePath.dirname(mediaPath);
      const base = nodePath.basename(mediaPath, nodePath.extname(mediaPath)).toLowerCase();
      const candidates = [];
      for (const name of nodeFs.readdirSync(dir)) {
        const ext = nodePath.extname(name).toLowerCase();
        if (!SUBTITLE_EXT.includes(ext)) continue;
        const nb = nodePath.basename(name, ext).toLowerCase();
        if (nb === base) candidates.push({ name, score: 100 });
        else if (nb.startsWith(base)) candidates.push({ name, score: 60 - (nb.length - base.length) });
        else if (base.startsWith(nb)) candidates.push({ name, score: 40 });
      }
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length) return nodePath.join(dir, candidates[0].name);
    } catch (_) { /* ignore */ }
    return null;
  }

  return {
    SUBTITLE_EXT, MEDIA_EXT,
    parseTimestamp, formatTimestamp, formatClock,
    stripMarkup, cleanCueText, splitBilingual, makeCue,
    parseSrt, parseVtt, parseAss, parseLrc, parseJsonSubs, parsePlainText,
    detectFormat, normalizeCues, cuesFromText, serialize, indexAt,
    tokenizeLine, extractCandidates, guessLemmas, isCjkChar, CJK_RE,
    sniffEncoding, decodeBuffer, loadSubtitleFile, saveSubtitleFile, findSiblingSubtitle
  };
}));

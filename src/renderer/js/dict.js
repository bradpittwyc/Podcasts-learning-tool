'use strict';
/**
 * dict.js — 查词与大模型分级取词
 *  · 词典面板渲染（中文释义 / 英文释义 / 例句 / 语境）
 *  · 难度过滤：只解释「目标级别及以上」的词（省钱核心）
 *  · 批量扫描全文难词、成本统计、去重与并发控制
 *  · 屏幕取词：截图框选 + Windows OCR / 划词抓取
 */
(function () {
  const U = window.PLTUtil;
  const S = window.PLTSubs;
  const { el, clear, toast } = U;

  // ══════════════════════════════════════════════════════════
  // 查词管理器
  // ══════════════════════════════════════════════════════════
  class Lookup {
    constructor(opts) {
      this.opts = opts || {};
      this.inflight = new Map();
      this.session = { calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedHits: 0, skipped: 0, ms: 0 };
      this.scanning = false;
      this.levels = [];
    }

    async loadLevels() {
      try {
        this.levels = await window.PLT.llm.levels();
      } catch (_) {
        this.levels = [];
      }
      return this.levels;
    }

    track(res) {
      if (!res) return;
      if (res.toApi) this.session.calls += res.toApi;
      if (res.fromCache) this.session.cachedHits += res.fromCache;
      if (res.skipped) this.session.skipped += Object.keys(res.skipped).length;
      if (res.usage) {
        this.session.promptTokens += res.usage.prompt_tokens || 0;
        this.session.completionTokens += res.usage.completion_tokens || 0;
        this.session.totalTokens += res.usage.total_tokens || 0;
      }
      if (res.ms) this.session.ms += res.ms;
      this.opts.onCost && this.opts.onCost(this.session);
    }

    status(text, busy) { this.opts.onStatus && this.opts.onStatus(text, busy); }

    /** 本地离线词典信息（设置面板展示） */
    async localDictStats() {
      try { return await window.PLT.dict.stats(); } catch (_) { return { loaded: false, size: 0 }; }
    }

    /** 查询单个词：释义一律走大模型（结合语境给义项）。所有单词都可查。 */
    async lookupWord(word, cue, options) {
      const key = String(word || '').toLowerCase();
      if (!key) return null;
      if (this.inflight.has('w:' + key)) return this.inflight.get('w:' + key);
      const context = cue ? (cue.en || cue.text || '') : '';
      this.status(`正在查询「${word}」…`, true);
      const p = (async () => {
        try {
          const res = await window.PLT.llm.lookupWord(word, context, {
            level: (options && options.level) || undefined,
            force: !!(options && options.force)
          });
          this.track({ toApi: res.toApi, fromCache: res.fromCache, usage: res.usage, ms: res.ms });
          if (!res.ok) return { error: res.code, message: res.error };
          if (!res.entry) {
            return res.noContent
              ? { error: 'NO_CONTENT', message: '模型这次没返回释义（偶发），点「重新查询」一般就好了。' }
              : { error: 'NO_DATA', message: '没有查到该词的解释，可点「重新查询」再试。' };
          }
          return { entry: res.entry };
        } catch (err) {
          return { error: 'EXCEPTION', message: err.message };
        } finally {
          this.inflight.delete('w:' + key);
          this.status('', false);
        }
      })();
      this.inflight.set('w:' + key, p);
      return p;
    }

    /** 扫描整篇字幕，按级别标出难词（本地词典分级为主，只有难词才走 AI） */
    async scanAll(cues, options) {
      if (this.scanning) { toast('正在扫描中，请稍候…', 'warn'); return null; }
      if (!cues || !cues.length) { toast('没有字幕可扫描', 'warn'); return null; }
      this.scanning = true;
      const limit = (options && options.limit) || undefined;
      const onlyLocal = !!(options && options.onlyLocal);
      this.status('正在按级别扫描难词…', true);
      try {
        const payload = cues.map((c) => ({ start: c.start, end: c.end, en: c.en || '', zh: c.zh || '', text: c.text || '' }));
        const res = await window.PLT.llm.scanTranscript(payload, {
          level: options && options.level,
          limit,
          onlyLocal
        });
        if (!res.ok) {
          toast(`扫描失败：${res.error}`, 'err');
          return null;
        }
        this.track(res);
        const map = new Map();
        // 达标的难词：本地词典直接给释义（0 费用），AI 结果覆盖
        for (const [k, v] of Object.entries(res.entries || {})) {
          map.set(k, {
            ...v,
            status: 'hit',
            translation: v.translation || '',
            source: v.source || (v.enDef ? 'ai' : 'local')
          });
        }
                for (const [k, v] of Object.entries(res.skipped || {})) {
          map.set(k, { ...(v.entry || {}), status: v.reason === 'no-data' ? 'queried' : 'below', reason: v.reason });
        }
        this.status('', false);
        return { map, stats: res };
      } catch (err) {
        toast('扫描出错：' + err.message, 'err');
        return null;
      } finally {
        this.scanning = false;
        this.status('', false);
      }
    }

    /** 对屏幕上抓取的一段文本，逐个候选词做分级解释 */
    async lookupText(text, options) {
      const candidates = S.extractCandidates(text || '').slice(0, 24);
      if (!candidates.length) return { ok: true, entries: {}, skipped: {} };
      this.status('正在分析屏幕文字…', true);
      try {
        const requests = candidates.map((c) => ({ word: c.word, context: text.slice(0, 200) }));
        const res = await window.PLT.llm.lookup(requests, {
          level: (options && options.level) || undefined,
          applyLevelFilter: !(options && options.force)
        });
        this.track(res);
        return res;
      } finally {
        this.status('', false);
      }
    }

    costLabel() {
      const s = this.session;
      const priceIn = 0.14 / 1e6;   // 参考价：DeepSeek 缓存未命中 ≈ ¥1/百万 输入
      const priceOut = 0.28 / 1e6;
      const cny = s.promptTokens * priceIn + s.completionTokens * priceOut;
      return {
        text: `本会话 ${s.calls} 次请求 · ${s.totalTokens} tokens · 约 ¥${cny.toFixed(4)} · 省下 ${s.cachedHits + s.skipped} 次`,
        cny,
        ...s
      };
    }
  }

  // ══════════════════════════════════════════════════════════
  // 词典面板
  // ══════════════════════════════════════════════════════════
  class DictPanel {
    constructor(opts) {
      this.opts = opts || {};
      this.panel = U.$('#dictPanel');
      this.body = U.$('#dictBody');
      this.wordEl = U.$('#dictWord');
      this.phEl = U.$('#dictPhonetic');
      this.tagsEl = U.$('#dictTags');
      this.current = null;
      this.currentCue = null;
      this.history = [];
      U.$('#dictClose').addEventListener('click', () => this.hide());
      U.$('#dictSave').addEventListener('click', () => this.save());
      U.$('#dictRetry').addEventListener('click', () => this.reload(true));
      // 单词旁的发音按钮：美音 / 英音各一个
      for (const btn of U.$$('#dictPron .pron-btn')) {
        btn.addEventListener('click', (e) => { e.stopPropagation(); this.speak(btn.dataset.accent); });
      }
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.panel.classList.contains('hidden')) { this.hide(); e.stopPropagation(); }
      });
    }

    show() { this.panel.classList.remove('hidden'); document.getElementById('paneBody').classList.add('dict-open'); }
    hide() {
      this.panel.classList.add('hidden');
      document.getElementById('paneBody').classList.remove('dict-open');
      document.querySelectorAll('.w.active').forEach((n) => n.classList.remove('active'));
      this.opts.onHide && this.opts.onHide();
    }

    setLoading(word) {
      this.show();
      this.current = null;
      this.wordEl.textContent = word;
      this.phEl.textContent = '';
      this.paintPron(null);
      clear(this.tagsEl);
      clear(this.body);
      this.body.appendChild(el('div', { class: 'dict-loading' }, [el('div', { class: 'spinner' }), el('span', { text: '思考中........' })]));
      document.querySelectorAll('.w.loading').forEach((n) => n.classList.remove('loading'));
      const span = [...document.querySelectorAll('.w')].find((n) => n.dataset.lower === String(word).toLowerCase());
      if (span) span.classList.add('loading');
    }

    render(word, result, cue) {
      this.show();
      clear(this.body);
      clear(this.tagsEl);
      this.current = result && result.entry ? { ...result.entry, queriedWord: word } : null;
      this.currentCue = cue || null;
      this.wordEl.textContent = (this.current && this.current.lemma) || word;
      if (this.current && this.current.queriedWord && this.current.queriedWord.toLowerCase() !== (this.current.lemma || '').toLowerCase()) {
        this.wordEl.textContent = `${this.current.lemma}`;
        this.wordEl.appendChild(el('span', { class: 'muted small', text: `  (${this.current.queriedWord})` }));
      }
      this.phEl.textContent = (this.current && this.current.phonetic) || '';

            if (!result || result.error) {
        const messages = {
          NO_API_KEY: '还没有配置大模型 API Key。点选查词由大模型生成释义 —— 可在 ⚙ 设置 → 大模型 填入 Key。',
          NO_CONTENT: '模型这次没返回释义（偶发情况），点「重新查询」再试一次即可。',
          NO_DATA: '没有查到该词的解释，可点「重新查询」再试。',
          TIMEOUT: '请求超时。可在设置里调大超时时间，或检查网络/代理。',
          NETWORK: '网络请求失败，请检查网络或 API 地址。',
          BAD_JSON: '模型返回格式无法解析，可点击「重新查询」再试一次。',
          HTTP_401: 'API Key 无效或已过期（401）。',
          HTTP_402: '账户余额不足（402）。',
          HTTP_429: '请求过于频繁（429），稍后再试。'
        };
        const code = result && result.error;
        clear(this.body);
        this.body.appendChild(el('div', { class: 'dict-error' }, [
          el('p', { text: messages[code] || `查询失败：${(result && result.message) || code}` }),
          code ? el('p', { class: 'muted small', html: `错误码：<code>${U.escapeHtml(code)}</code>` }) : null
        ]));
        return;
      }

      const entry = this.current;
      for (const t of U.buildTags(entry)) this.tagsEl.appendChild(el('span', { class: `tag ${t.cls}`, text: t.text }));
      // 点选查词的释义统一由大模型结合语境生成
      this.tagsEl.appendChild(el('span', { class: 'tag ai', text: 'AI 语境释义' }));

      if (entry.translation) {
        this.body.appendChild(el('div', { class: 'dict-sec' }, [
          el('h4', { text: '中文释义' }),
          el('div', { class: 'dict-trans' }, [
            entry.pos ? el('span', { class: 'dict-pos', text: entry.pos }) : null,
            document.createTextNode(entry.translationFull && entry.translationFull.length > entry.translation.length ? entry.translationFull : entry.translation)
          ])
        ]));
      }
      if (entry.enDef) {
        this.body.appendChild(el('div', { class: 'dict-sec' }, [el('h4', { text: 'English Definition' }), el('div', { class: 'dict-en', text: entry.enDef })]));
      }
      if (entry.example) {
        this.body.appendChild(el('div', { class: 'dict-sec' }, [
          el('h4', { text: 'Example' }),
          el('div', { class: 'dict-ex', text: entry.example }),
          entry.exampleZh ? el('div', { class: 'dict-ex-zh', text: entry.exampleZh }) : null
        ]));
      }
      if (cue) {
        const ctx = cue.en || cue.text || '';
        const span = el('span', { class: 'dict-ctx' });
        const lower = String(word).toLowerCase();
        const parts = S.tokenizeLine(ctx);
        for (const p of parts) {
          if (p.type === 'word' && (p.lower === lower || entry.lemma && p.lower === entry.lemma.toLowerCase())) {
            span.appendChild(el('span', { class: 'hl', text: p.text }));
          } else {
            span.appendChild(document.createTextNode(p.text));
          }
        }
        this.body.appendChild(el('div', { class: 'dict-sec' }, [el('h4', { text: '原文语境' }), span]));
      }
      U.$('#dictSave').textContent = '＋ 生词本';
    }

    async reload(force) {
      if (!this.currentWord) return;
      const w = this.currentWord;
      this.setLoading(w);
      const res = await this.opts.onReload ? this.opts.onReload(w, this.currentCue, force) : null;
      if (res) this.render(w, res, this.currentCue);
    }

    async load(word, cue) {
      this.currentWord = word;
      this.setLoading(word);
      const res = await this.opts.onLookup(word, cue);
      this.render(word, res, cue);
      return res;
    }

    /** 发音按钮状态：null=全部复位，'us'/'uk'=哪个在播 */
    paintPron(playing, phase) {
      for (const btn of U.$$('#dictPron .pron-btn')) {
        btn.classList.toggle('playing', playing === btn.dataset.accent && phase === 'playing');
        btn.classList.toggle('busy', playing === btn.dataset.accent && phase === 'busy');
        btn.classList.toggle('err', playing === btn.dataset.accent && phase === 'err');
      }
    }

    /** 点选发音：accent 传 'us'/'uk' 覆盖设置，不传则用设置里的口音 */
    async speak(accent) {
      const w = this.current ? (this.current.lemma || this.current.word) : this.wordEl.textContent;
      if (!w || w === '—') { toast('还没有可朗读的单词', 'warn'); return; }
      const mode = accent || (this.opts.pronounce ? this.opts.pronounce() : 'us');
      this.paintPron(mode === 'uk' ? 'uk' : 'us', 'busy');
      const res = await speakWord(w, mode);
      if (!res || !res.ok) {
        this.paintPron(mode === 'uk' ? 'uk' : 'us', 'err');
        toast('发音播放失败：' + ((res && res.error) || '未知原因'), 'warn', 5000);
        setTimeout(() => this.paintPron(null), 1200);
      } else if (res.via === 'tts' && !speakWarned) {
        // 只在本次会话提醒一次，避免离线时每次点都弹
        speakWarned = true;
        toast('在线真人发音取不到，已改用系统语音（可在设置 → 取词级别 里切换口音策略）', 'warn', 6000);
      }
      return res;
    }

    async save() {
      if (!this.current) { toast('还没有可以收藏的词', 'warn'); return; }
      const res = await this.opts.onSave(this.current, this.currentCue);
      if (res && res.ok) {
        toast(res.updated ? `已更新「${this.current.lemma}」` : `已加入生词本：${this.current.lemma}`, 'ok');
        const btn = U.$('#dictSave');
        btn.textContent = '✓ 已收藏';
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 真人发音（有道公开接口，失败则回退系统 TTS）
  // ══════════════════════════════════════════════════════════
  let currentAudio = null;
  let currentBtn = null;
  let speakWarned = false;

  /**
   * 朗读一个单词。
   * @returns {Promise<{ok:boolean, via:'online'|'tts'|'none', url?:string, error?:string}>}
   */
  function speakWord(word, mode) {
    return new Promise((resolve) => {
      const w = String(word || '').trim();
      if (!w) return resolve({ ok: false, via: 'none', error: '没有单词' });
      if (currentAudio) { try { currentAudio.pause(); } catch (_) { } currentAudio = null; }
      if (currentBtn) { currentBtn.classList.remove('playing'); currentBtn = null; }

      const wantTTS = mode === 'none';
      const type = mode === 'uk' ? 1 : 2;
      const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w)}&type=${type}`;
      const done = (r) => {
        // 测试接缝：冒烟断言据此确认「点了按钮确实去取音频了」
        try { window.__pltLastSpeak = Object.assign({ word: w, mode }, r); } catch (_) { }
        resolve(r);
      };

      if (wantTTS) return done(ttsSpeak(w) ? { ok: true, via: 'tts' } : { ok: false, via: 'none', error: '系统语音不可用' });

      const audio = new Audio(url);
      currentAudio = audio;
      audio.volume = 1;
      audio.addEventListener('playing', () => {
        const btn = U.$(`#dictPron .pron-btn[data-accent="${mode === 'uk' ? 'uk' : 'us'}"]`);
        if (btn) { btn.classList.remove('busy', 'err'); currentBtn = btn; btn.classList.add('playing'); }
      });
      audio.addEventListener('ended', () => { if (currentBtn) currentBtn.classList.remove('playing'); currentBtn = null; });
      audio.addEventListener('error', () => {
        // 联网失败（离线 / 接口不通）→ 退回系统 TTS，别让按钮点了没反应
        const ok = ttsSpeak(w);
        done(ok
          ? { ok: true, via: 'tts', url, error: '在线发音不可用，已用系统语音' }
          : { ok: false, via: 'none', url, error: '在线发音与系统语音都不可用' });
      });
      audio.play().then(
        () => done({ ok: true, via: 'online', url }),
        (err) => {
          const ok = ttsSpeak(w);
          done(ok
            ? { ok: true, via: 'tts', url, error: '播放被拒绝，已用系统语音：' + (err && err.message) }
            : { ok: false, via: 'none', url, error: '播放失败：' + (err && err.message) });
        }
      );
    });
  }

  /** 旧的同步入口（生词本 / 闪卡那边还在用），内部转调 speakWord */
  function speak(word, mode) {
    speakWord(word, mode || 'us');
  }

  function ttsSpeak(text) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = 0.95;
      speechSynthesis.cancel();
      speechSynthesis.speak(u);
      return true;
    } catch (_) { return false; }
  }

  // ══════════════════════════════════════════════════════════
  // 屏幕取词：框选 + OCR
  // ══════════════════════════════════════════════════════════
  async function screenCaptureLookup(opts) {
    const overlay = U.$('#ocrOverlay');
    const sel = U.$('#ocrSel');
    const tip = U.$('#ocrTip');
    if (!overlay || !navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('当前环境不支持屏幕捕获', 'err');
      return null;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: false,
        preferCurrentTab: false,
        selfBrowserSurface: 'include',
        surfaceSwitching: 'exclude'
      });
    } catch (err) {
      toast('未获得屏幕录制权限，无法截图取词', 'err');
      return null;
    }

    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play().catch(() => { });
    await new Promise((r) => setTimeout(r, 260)); // 等待首帧稳定
    const settings = track.getSettings ? track.getSettings() : {};
    const vw = video.videoWidth || settings.width || window.screen.width;
    const vh = video.videoHeight || settings.height || window.screen.height;

    overlay.classList.remove('hidden');
    sel.classList.remove('on');
    sel.style.cssText = '';
    tip.textContent = '按住鼠标左键框选要取词的屏幕区域 · Esc 或右键取消';

    return new Promise((resolve) => {
      let start = null;
      let done = false;
      const cleanup = (result) => {
        if (done) return;
        done = true;
        overlay.classList.add('hidden');
        overlay.removeEventListener('pointerdown', onDown);
        overlay.removeEventListener('pointermove', onMove);
        overlay.removeEventListener('pointerup', onUp);
        overlay.removeEventListener('contextmenu', onCancel);
        document.removeEventListener('keydown', onKey);
        try { track.stop(); } catch (_) { }
        try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { }
        video.remove();
        resolve(result);
      };
      const onCancel = (e) => { if (e) e.preventDefault(); cleanup(null); };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); cleanup(null); } };

      const onDown = (e) => {
        if (e.button !== 0) { onCancel(e); return; }
        start = { x: e.clientX, y: e.clientY };
        sel.classList.add('on');
        sel.style.left = `${start.x}px`;
        sel.style.top = `${start.y}px`;
        sel.style.width = '0px';
        sel.style.height = '0px';
      };
      const onMove = (e) => {
        if (!start) return;
        const x = Math.min(start.x, e.clientX);
        const y = Math.min(start.y, e.clientY);
        const w = Math.abs(e.clientX - start.x);
        const h = Math.abs(e.clientY - start.y);
        sel.style.left = `${x}px`;
        sel.style.top = `${y}px`;
        sel.style.width = `${w}px`;
        sel.style.height = `${h}px`;
        let size = sel.querySelector('.ocr-size');
        if (!size) { size = el('div', { class: 'ocr-size' }); sel.appendChild(size); }
        size.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      };
      const onUp = async (e) => {
        if (!start) return;
        const x0 = Math.min(start.x, e.clientX);
        const y0 = Math.min(start.y, e.clientY);
        let w = Math.abs(e.clientX - start.x);
        let h = Math.abs(e.clientY - start.y);
        if (w < 8 || h < 8) { cleanup(null); return; }
        start = null;
        tip.textContent = '正在识别文字…';
        const sx = Math.round((x0 / window.innerWidth) * vw);
        const sy = Math.round((y0 / window.innerHeight) * vh);
        const sw = Math.round((w / window.innerWidth) * vw);
        const sh = Math.round((h / window.innerHeight) * vh);
        // 放大 2 倍提升小字识别率
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, sw * scale);
        canvas.height = Math.max(1, sh * scale);
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
        let dataUrl = '';
        try { dataUrl = canvas.toDataURL('image/png'); } catch (err) { /* ignore */ }
        cleanup({ dataUrl, rect: { x: x0, y: y0, w, h }, deviceRect: { x: sx, y: sy, w: sw, h: sh } });
      };

      overlay.addEventListener('pointerdown', onDown);
      overlay.addEventListener('pointermove', onMove);
      overlay.addEventListener('pointerup', onUp);
      overlay.addEventListener('contextmenu', onCancel);
      document.addEventListener('keydown', onKey, true);
    });
  }

  async function ocrText(dataUrl, opts) {
    const res = await window.PLT.screen.ocr(dataUrl, (opts && opts.langs) || 'en-US,zh-Hans-CN');
    return res;
  }

  window.PLTDict = { Lookup, DictPanel, speak, speakWord, ttsSpeak, screenCaptureLookup, ocrText };
}());

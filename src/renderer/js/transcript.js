'use strict';
/**
 * transcript.js — 文字界面
 *  · 英文 Times New Roman / 中文微软雅黑（CSS 变量可换）
 *  · 点文字跳转时间戳；点单词查词典
 *  · 校对模式：直接改文本与时间戳、拆分/合并/插入/删除、整篇平移
 *  · 自动滚动、当前行高亮、生词高亮（由难度分级决定）
 */
(function () {
  const U = window.PLTUtil;
  const S = window.PLTSubs;
  const { el, clear, clamp, toast } = U;

  // 级别 → 难度 rank 对照（模块级，供 setLock / isLockedOut 共用）
  const LEVEL_RANK = { none: 0, a2: 2, b1: 3, b2: 4, ielts: 5, toefl: 5, gre: 6, educated_native: 7 };
  const CEFR_RANK = { A1: 0, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };

  class Transcript {
    constructor(root, opts) {
      this.root = root;
      this.opts = opts || {};
      this.cues = [];
      this.nodes = [];
      this.currentIndex = -1;
      this.selectedIndex = -1;
      this.editing = false;
      this.autoScroll = true;
      this.showZh = true;
      this.dirty = false;
      this.words = new Map();   // lower(含词形) -> 词典信息
      this.path = null;
      this._userScrolledAt = 0;
      // 级别锁定：决定哪些词直接呈现为“不可点击”
      this.lock = { enabled: false, rank: 0 };
      this.bindEvents();
    }

    /** 设置级别锁定状态（enabled + 目标级别），并立即重算所有词的锁定样式 */
    setLock(enabled, levelId) {
      this.lock = { enabled: !!enabled, rank: LEVEL_RANK[String(levelId || 'none')] ?? 0 };
      this.refreshWordStyles();
    }

    /** 某词是否因级别锁定而不可取词 */
    isLockedOut(info) {
      if (!this.lock.enabled || this.lock.rank <= 0) return false;
      if (!info) return false;
      if (info.status === 'hit') return false;                 // 已判定为达标词
      let rank = CEFR_RANK[String(info.cefr || '').toUpperCase()];
      if (rank === undefined) rank = info.rare ? 7 : 3;
      if (info.rare) rank = Math.max(rank, 7);
      return rank < this.lock.rank;
    }

    // ─────────────── 事件 ───────────────
    bindEvents() {
      this.root.addEventListener('click', (e) => this.onClick(e), true);
      this.root.addEventListener('dblclick', (e) => this.onDblClick(e));
      this.root.addEventListener('contextmenu', (e) => this.onContextMenu(e));
      this.root.addEventListener('scroll', U.throttle(() => {
        if (this._programmatic) return;
        this._userScrolledAt = Date.now();
      }, 120));
    }

    onClick(e) {
      const wordEl = e.target.closest('.w');
      if (wordEl && !this.editing) {
        e.preventDefault();
        e.stopPropagation();
        const cueEl = wordEl.closest('.cue');
        const idx = Number(cueEl?.dataset.index);
        // Shift+点击：只查词不跳转
        if (!e.shiftKey && Number.isFinite(idx) && this.opts.onSeekCue) {
          this.opts.onSeekCue(idx, { play: false });
        }
        this.opts.onWord && this.opts.onWord(wordEl.dataset.lower, this.cues[idx] || null, wordEl);
        return;
      }
      if (this.editing) return;
      const cueEl = e.target.closest('.cue');
      if (!cueEl) return;
      const idx = Number(cueEl.dataset.index);
      if (!Number.isFinite(idx)) return;
      if (e.detail >= 2) return; // 双击交给 onDblClick（双击 = 重播该句）
      this.select(idx);
      this.opts.onSeekCue && this.opts.onSeekCue(idx, { play: false });
    }

    onDblClick(e) {
      const cueEl = e.target.closest('.cue');
      if (!cueEl) return;
      const idx = Number(cueEl.dataset.index);
      if (!Number.isFinite(idx)) return;
      if (this.editing) this.startEditCue(idx, e.target.closest('.cue-en') ? 'en' : (e.target.closest('.cue-zh') ? 'zh' : 'en'));
      else this.opts.onReplayCue && this.opts.onReplayCue(idx);
    }

    onContextMenu(e) {
      const cueEl = e.target.closest('.cue');
      if (!cueEl) return;
      e.preventDefault();
      const idx = Number(cueEl.dataset.index);
      const wordEl = e.target.closest('.w');
      this.select(idx);
      const items = [];
      if (wordEl && !this.editing) {
        const lower = wordEl.dataset.lower;
        items.push({ label: `查词：${wordEl.textContent.trim()}`, action: () => this.opts.onWord && this.opts.onWord(lower, this.cues[idx], wordEl) });
        items.push({ label: '加入生词本', action: () => this.opts.onAddVocab && this.opts.onAddVocab(lower, this.cues[idx]) });
        items.push({ sep: true });
      }
      items.push(
        { label: '从此处播放', kbd: 'Enter', action: () => this.opts.onSeekCue && this.opts.onSeekCue(idx, { play: true }) },
        { label: '重播这一句', kbd: 'Ctrl+R', action: () => this.opts.onReplayCue && this.opts.onReplayCue(idx) },
        { label: '单句循环', action: () => this.opts.onLoopCue && this.opts.onLoopCue(idx) },
        { sep: true },
        { label: `复制英文`, action: () => navigator.clipboard.writeText(this.cues[idx].en || '') },
        { label: `复制中英对照`, action: () => navigator.clipboard.writeText(`${this.cues[idx].en}\n${this.cues[idx].zh}`) }
      );
      if (!this.editing) {
        items.push({ sep: true }, { label: '编辑这一句', action: () => { this.setEditing(true); this.startEditCue(idx, 'en'); } });
      }
      U.contextMenu(e.clientX, e.clientY, items);
    }

    // ─────────────── 渲染 ───────────────
    setCues(cues, opts) {
      this.cues = (cues || []).map((c, i) => ({ ...c, index: i }));
      this.path = (opts && opts.path) || null;
      this.words = new Map(opts && opts.words ? opts.words : []);
      this.currentIndex = -1;
      this.selectedIndex = -1;
      this.dirty = false;
      this.render();
    }

    render() {
      clear(this.root);
      this.nodes = [];
      this.root.classList.toggle('hide-zh', !this.showZh);
      if (!this.cues.length) {
        this.root.appendChild(el('div', { class: 'transcript-empty' }, [
          el('h3', { text: '还没有字幕' }),
          el('p', { text: '导入 SRT / VTT / ASS / LRC / TXT 字幕，或把字幕文件拖到左侧播放区。' }),
          el('p', { class: 'muted', text: '纯文本（无时间轴）也可导入，软件会自动断句并按播放时长均分时间戳。' }),
          el('button', { class: 'cb-btn accent', text: '导入字幕文件', onclick: () => this.opts.onPickSubtitle && this.opts.onPickSubtitle() })
        ]));
        return;
      }
      const frag = document.createDocumentFragment();
      this.cues.forEach((cue, i) => {
        const node = this.buildCue(cue, i);
        this.nodes.push(node);
        frag.appendChild(node);
      });
      this.root.appendChild(frag);
    }

    buildCue(cue, i) {
      const node = el('div', {
        class: 'cue', dataset: { index: String(i) }, id: `cue-${i}`
      });
      node.appendChild(el('div', { class: 'cue-time', text: U.fmtClock(cue.start) }));
      const text = el('div', { class: 'cue-text' });
      const en = el('div', { class: 'cue-en' });
      this.renderEn(en, cue);
      const zh = el('div', { class: 'cue-zh', text: cue.zh || '' });
      text.appendChild(en);
      text.appendChild(zh);
      node.appendChild(text);
      return node;
    }

    renderEn(container, cue) {
      clear(container);
      const parts = S.tokenizeLine(cue.en || '');
      if (!parts.length) { container.textContent = cue.en || ''; return; }
      for (const part of parts) {
        if (part.type !== 'word') {
          container.appendChild(document.createTextNode(part.text));
          continue;
        }
        const info = this.lookupWord(part.lower);
        const blocked = info && info.status === 'blocked';
        const span = el('span', {
          class: `w${info ? (info.status === 'hit' ? ' hit' : info.status === 'queried' ? ' queried' : blocked ? ' locked' : '') : ''}`,
          dataset: { lower: part.lower, word: part.text }
        });
        span.appendChild(document.createTextNode(part.text));
        if (info && info.status === 'hit' && info.translation) {
          span.appendChild(el('span', { class: 'wz', text: info.translation }));
        }
        if (info && info.cefr && !this.opts.hideLevelBadge) span.dataset.cefr = info.cefr;
        if (blocked) span.title = `低于当前取词级别（${info.cefr || '—'}）· 级别锁定中，不可取词`;
        container.appendChild(span);
      }
    }

    /** 词形还原查表：先直接查，再猜词形 */
    lookupWord(lower) {
      if (!lower) return null;
      if (this.words.has(lower)) return this.words.get(lower);
      if (this.words.has(lower.toLowerCase())) return this.words.get(lower.toLowerCase());
      for (const cand of S.guessLemmas(lower)) {
        if (this.words.has(cand)) {
          const info = this.words.get(cand);
          this.words.set(lower, info);
          return info;
        }
      }
      return null;
    }

    /** 写入/更新一个词的查词结果 */
    setWord(lower, info) {
      const key = String(lower || '').toLowerCase();
      if (!key) return;
      this.words.set(key, info);
      // 只更新相关节点，避免整篇重排
      for (const node of this.nodes) {
        for (const span of node.querySelectorAll(`.w[data-lower="${cssEscape(key)}"]`)) {
          this.applyWordStyle(span, info);
        }
      }
    }

    /** 批量写入（扫描结果），并刷新相应单词样式 */
    setWords(map) {
      let count = 0;
      for (const [key, info] of map) {
        this.words.set(key, info);
        count++;
      }
      this.refreshWordStyles();
      return count;
    }

    refreshWordStyles() {
      for (const node of this.nodes) {
        for (const span of node.querySelectorAll('.w')) {
          this.applyWordStyle(span, this.lookupWord(span.dataset.lower));
        }
      }
    }

    applyWordStyle(span, info) {
      span.classList.remove('hit', 'queried', 'loading', 'locked');
      span.removeAttribute('title');
      const old = span.querySelector('.wz');
      if (old) old.remove();
      if (!info) { delete span.dataset.cefr; return; }
      if (info.cefr) span.dataset.cefr = info.cefr;
      else delete span.dataset.cefr;

      // 级别锁定优先：低于所选级别的词直接呈现为不可点击
      if (info.status !== 'hit' && this.isLockedOut(info)) {
        span.classList.add('locked');
        span.title = `低于当前取词级别（${info.cefr || '—'}）· 级别锁定中，不可取词`;
        return;
      }
      if (info.status === 'hit') {
        span.classList.add('hit');
        if (info.translation) span.appendChild(el('span', { class: 'wz', text: info.translation }));
      } else if (info.status === 'queried') {
        span.classList.add('queried');
      } else if (info.status === 'loading') {
        span.classList.add('loading');
      } else if (info.status === 'blocked') {
        span.classList.add('locked');
        span.title = `低于当前取词级别（${info.cefr || '—'}）· 级别锁定中，不可取词`;
      }
    }

    // ─────────────── 选中 / 同步 ───────────────
    select(index) {
      if (index === this.selectedIndex) return;
      if (this.nodes[this.selectedIndex]) this.nodes[this.selectedIndex].classList.remove('selected');
      this.selectedIndex = index;
      if (this.nodes[index]) this.nodes[index].classList.add('selected');
    }

    setCurrent(index, opts) {
      if (index === this.currentIndex) {
        if (opts && opts.forceScroll) this.scrollTo(index, false);
        return;
      }
      const prev = this.nodes[this.currentIndex];
      if (prev) prev.classList.remove('current');
      this.currentIndex = index;
      const node = this.nodes[index];
      if (node) {
        node.classList.add('current');
        if (this.autoScroll && this.opts.autoScroll !== false) this.scrollTo(index, !!(opts && opts.smooth));
      }
    }

    scrollTo(index, smooth) {
      const node = this.nodes[index];
      if (!node) return;
      const rootRect = this.root.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const top = nodeRect.top - rootRect.top + this.root.scrollTop;
      const want = top - rootRect.height * 0.34;
      this._programmatic = true;
      this.root.scrollTo({ top: Math.max(0, want), behavior: smooth && Date.now() - this._userScrolledAt > 2500 ? 'smooth' : 'auto' });
      setTimeout(() => { this._programmatic = false; }, 60);
    }

    /** 用户手动滚动后暂停自动滚动一小段时间 */
    get userIsBrowsing() { return Date.now() - this._userScrolledAt < 2500; }

    setAutoScroll(on) { this.autoScroll = !!on; }
    setShowZh(on) {
      this.showZh = !!on;
      this.root.classList.toggle('hide-zh', !this.showZh);
    }

    // ─────────────── 校对编辑 ───────────────
    setEditing(on) {
      this.editing = !!on;
      this.root.classList.toggle('editing', this.editing);
      if (!this.editing) this.closeEditors();
      this.opts.onEditingChange && this.opts.onEditingChange(this.editing);
    }

    closeEditors() {
      for (const node of this.nodes) {
        if (!node.classList.contains('editing')) continue;
        const cue = this.cues[Number(node.dataset.index)];
        const enInput = node.querySelector('.ce-input.en');
        const zhInput = node.querySelector('.ce-input.zh');
        const sInput = node.querySelector('.ce-time.start');
        const eInput = node.querySelector('.ce-time.end');
        if (enInput) cue.en = enInput.value.trim();
        if (zhInput) cue.zh = zhInput.value.trim();
        if (sInput) cue.start = Math.max(0, S.parseTimestamp(sInput.value) ?? cue.start);
        if (eInput) cue.end = Math.max(cue.start + 0.2, S.parseTimestamp(eInput.value) ?? cue.end);
        cue.text = [cue.en, cue.zh].filter(Boolean).join('\n');
        node.classList.remove('editing');
        this.rebuildCue(Number(node.dataset.index));
      }
    }

    rebuildCue(i) {
      const old = this.nodes[i];
      if (!old) return;
      const fresh = this.buildCue(this.cues[i], i);
      fresh.classList.toggle('current', i === this.currentIndex);
      fresh.classList.toggle('selected', i === this.selectedIndex);
      if (this.dirtySet && this.dirtySet.has(i)) fresh.classList.add('cue-dirty');
      this.nodes[i] = fresh;
      old.replaceWith(fresh);
    }

    startEditCue(index, field) {
      const node = this.nodes[index];
      if (!node || node.classList.contains('editing')) return;
      const cue = this.cues[index];
      node.classList.add('editing');
      clear(node);
      const timeBox = el('div', { class: 'cue-time' });
      const sIn = el('input', { class: 'ce-time start', value: S.formatTimestamp(cue.start, 'srt').replace(',', '.'), title: '开始时间 时:分:秒.毫秒' });
      const eIn = el('input', { class: 'ce-time end', value: S.formatTimestamp(cue.end, 'srt').replace(',', '.'), title: '结束时间' });
      timeBox.appendChild(sIn);
      timeBox.appendChild(eIn);
      const text = el('div', { class: 'cue-text' });
      const enIn = el('textarea', { class: 'ce-input en', rows: '2', spellcheck: 'false' });
      enIn.value = cue.en || '';
      const zhIn = el('textarea', { class: 'ce-input zh', rows: '1', spellcheck: 'false' });
      zhIn.value = cue.zh || '';
      text.appendChild(enIn);
      text.appendChild(zhIn);
      node.appendChild(timeBox);
      node.appendChild(text);

      const commit = () => {
        cue.en = enIn.value.trim();
        cue.zh = zhIn.value.trim();
        cue.start = Math.max(0, S.parseTimestamp(sIn.value) ?? cue.start);
        cue.end = Math.max(cue.start + 0.2, S.parseTimestamp(eIn.value) ?? cue.end);
        cue.text = [cue.en, cue.zh].filter(Boolean).join('\n');
        cue.dirty = true;
        this.dirty = true;
        if (!this.dirtySet) this.dirtySet = new Set();
        this.dirtySet.add(index);
        node.classList.remove('editing');
        this.rebuildCue(index);
        this.opts.onEdited && this.opts.onEdited(index, cue);
      };
      const cancel = () => { node.classList.remove('editing'); this.rebuildCue(index); };
      [sIn, eIn, enIn, zhIn].forEach((input) => {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.stopPropagation(); cancel(); }
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || (e.target === sIn || e.target === eIn))) { e.preventDefault(); commit(); }
          if (e.key === 'Tab') {
            e.preventDefault();
            const order = [sIn, eIn, enIn, zhIn];
            const i = order.indexOf(e.target);
            const next = order[(i + (e.shiftKey ? -1 : 1) + order.length) % order.length];
            next.focus();
            next.select && next.select();
          }
        });
      });
      [sIn, eIn].forEach((input) => input.addEventListener('blur', () => { /* 时间戳留到提交时解析 */ }));
      [enIn, zhIn].forEach((input) => {
        input.addEventListener('blur', () => {
          setTimeout(() => {
            if (node.contains(document.activeElement)) return;
            commit();
          }, 130);
        });
      });
      const target = field === 'zh' ? zhIn : enIn;
      setTimeout(() => { target.focus(); target.setSelectionRange(target.value.length, target.value.length); }, 30);
    }

    // ── 编辑操作 ──
    shiftTimes(delta, index) {
      const targets = (index === undefined || index === null)
        ? this.cues
        : [this.cues[index]].filter(Boolean);
      for (const c of targets) {
        c.start = Math.max(0, c.start + delta);
        c.end = Math.max(c.start + 0.2, c.end + delta);
        c.dirty = true;
      }
      this.dirty = true;
      this.rerenderAll();
      return targets.length;
    }

    scaleTimes(factor) {
      for (const c of this.cues) {
        c.start = Math.max(0, c.start * factor);
        c.end = Math.max(c.start + 0.2, c.end * factor);
        c.dirty = true;
      }
      this.dirty = true;
      this.rerenderAll();
    }

    rerenderAll() {
      for (let i = 0; i < this.cues.length; i++) {
        const node = this.nodes[i];
        if (node && !node.classList.contains('editing')) {
          const timeEl = node.querySelector('.cue-time');
          if (timeEl) timeEl.textContent = U.fmtClock(this.cues[i].start);
        }
      }
    }

    splitCue(index, atTime) {
      const cue = this.cues[index];
      if (!cue) return false;
      let t = atTime;
      if (t === undefined || t === null || t <= cue.start + 0.15 || t >= cue.end - 0.15) t = cue.start + (cue.end - cue.start) / 2;
      const enParts = (cue.en || '').split(/(?<=[.!?。！？,;，；])\s+/);
      let left = cue.en;
      let right = '';
      if (enParts.length > 1) {
        const mid = Math.ceil(enParts.length / 2);
        left = enParts.slice(0, mid).join(' ').trim();
        right = enParts.slice(mid).join(' ').trim();
      } else {
        const words = (cue.en || '').split(/\s+/);
        const mid = Math.ceil(words.length / 2);
        left = words.slice(0, mid).join(' ');
        right = words.slice(mid).join(' ');
      }
      const zhParts = (cue.zh || '').split(/(?<=[。！？；;])/).filter(Boolean);
      const zhLeft = zhParts.length > 1 ? zhParts.slice(0, Math.ceil(zhParts.length / 2)).join('') : cue.zh;
      const zhRight = zhParts.length > 1 ? zhParts.slice(Math.ceil(zhParts.length / 2)).join('') : '';
      const originalEnd = cue.end;
      cue.en = left;
      cue.zh = (zhLeft || '').trim();
      cue.end = t;
      cue.text = [cue.en, cue.zh].filter(Boolean).join('\n');
      cue.dirty = true;
      const fresh = { start: t, end: originalEnd, en: right, zh: (zhRight || '').trim(), text: [right, zhRight].filter(Boolean).join('\n'), dirty: true };
      this.cues.splice(index + 1, 0, fresh);
      this.reindex();
      this.dirty = true;
      this.render();
      this.opts.onStructureChanged && this.opts.onStructureChanged();
      return true;
    }

    mergeWithNext(index) {
      const cue = this.cues[index];
      const next = this.cues[index + 1];
      if (!cue || !next) return false;
      cue.en = [cue.en, next.en].filter(Boolean).join(' ');
      cue.zh = [cue.zh, next.zh].filter(Boolean).join(' ');
      cue.end = next.end;
      cue.text = [cue.en, cue.zh].filter(Boolean).join('\n');
      cue.dirty = true;
      this.cues.splice(index + 1, 1);
      this.reindex();
      this.dirty = true;
      this.render();
      this.opts.onStructureChanged && this.opts.onStructureChanged();
      return true;
    }

    insertAfter(index, atTime) {
      const cue = this.cues[index];
      const t = atTime === undefined || atTime === null ? (cue ? cue.end : 0) : atTime;
      const fresh = { start: t, end: t + 2.5, en: '', zh: '', text: '', dirty: true };
      this.cues.splice(index + 1, 0, fresh);
      this.reindex();
      this.dirty = true;
      this.render();
      this.setEditing(true);
      this.startEditCue(index + 1, 'en');
      this.opts.onStructureChanged && this.opts.onStructureChanged();
      return true;
    }

    deleteCue(index) {
      if (!this.cues[index]) return false;
      this.cues.splice(index, 1);
      this.reindex();
      this.dirty = true;
      this.render();
      this.opts.onStructureChanged && this.opts.onStructureChanged();
      return true;
    }

    setBoundary(index, which, time) {
      const cue = this.cues[index];
      if (!cue) return false;
      if (which === 'start') cue.start = Math.min(time, cue.end - 0.2);
      else cue.end = Math.max(time, cue.start + 0.2);
      cue.dirty = true;
      this.dirty = true;
      this.rerenderAll();
      this.opts.onEdited && this.opts.onEdited(index, cue);
      return true;
    }

    reindex() {
      this.cues.forEach((c, i) => { c.index = i; });
    }

    getCues() { return this.cues; }

    cueAtTime(time) { return S.indexAt(this.cues, time); }

    /** 导出用：把带 dirty 标记的对象清理干净 */
    exportCues() {
      return this.cues.map((c) => ({ start: c.start, end: c.end, en: c.en || '', zh: c.zh || '', text: c.text || '' }));
    }
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  // ─────────────── 生词本 / 历史 视图 ───────────────
  function renderVocabList(container, items, opts) {
    clear(container);
    if (!items.length) {
      container.appendChild(el('div', { class: 'transcript-empty' }, [
        el('h3', { text: '生词本还是空的' }),
        el('p', { text: '查词后点「＋ 生词本」即可收藏，支持导出 CSV 到 Anki / 欧路词典。' })
      ]));
      return;
    }
    for (const it of items) {
      const entry = {
        cefr: it.cefr, examLevels: it.examLevels, isAcademic: it.isAcademic, rare: it.rare, pos: it.pos
      };
      const node = el('div', { class: 'vocab-item' }, [
        el('div', { class: 'vi-main' }, [
          el('div', { class: 'vi-word' }, [
            el('b', { text: it.word || it.lemma }),
            it.phonetic ? el('span', { class: 'ph', text: it.phonetic }) : null
          ]),
          it.translation ? el('div', { class: 'vi-trans', text: it.translation }) : null,
          it.enDef ? el('div', { class: 'vi-def', text: it.enDef }) : null,
          it.example ? el('div', { class: 'vi-ex', text: it.example }) : null,
          el('div', { class: 'vi-meta' }, [
            ...U.buildTags(entry).map((t) => el('span', { class: `tag ${t.cls}`, text: t.text })),
            it.source ? el('span', { class: 'muted small', text: it.source.slice(0, 46) }) : null,
            el('span', { class: 'muted small', text: U.fmtRelTime(it.addedAt) })
          ])
        ]),
        el('div', { class: 'vi-actions' }, [
          el('button', { class: 'icon-btn', title: '朗读', html: '🔊', onclick: () => opts.onSpeak && opts.onSpeak(it) }),
          el('button', { class: 'icon-btn', title: '跳转', html: '↗', onclick: () => opts.onLocate && opts.onLocate(it) }),
          el('button', { class: 'icon-btn', title: '删除', html: '✕', onclick: () => opts.onRemove && opts.onRemove(it) })
        ])
      ]);
      container.appendChild(node);
    }
  }

  function renderHistoryList(container, items, opts) {
    clear(container);
    if (!items.length) {
      container.appendChild(el('div', { class: 'transcript-empty' }, [el('h3', { text: '暂无记录' })]));
      return;
    }
    for (const it of items) {
      const node = el('div', {
        class: 'history-item',
        ondblclick: () => opts.onOpen && opts.onOpen(it)
      }, [
        el('div', { class: 'vi-main' }, [
          el('div', { class: 'hi-name', text: it.name || it.path }),
          el('div', { class: 'hi-path', text: it.path }),
          el('div', { class: 'vi-meta' }, [
            el('span', { class: 'muted small', text: U.fmtRelTime(it.openedAt) }),
            it.subtitlePath ? el('span', { class: 'tag', text: '含字幕' }) : null,
            it.position ? el('span', { class: 'muted small', text: `上次 ${U.fmtClock(it.position)}` }) : null
          ])
        ]),
        el('div', { class: 'vi-actions' }, [
          el('button', { class: 'icon-btn', title: '打开', html: '▶', onclick: () => opts.onOpen && opts.onOpen(it) }),
          el('button', { class: 'icon-btn', title: '在文件夹中显示', html: '📁', onclick: () => window.PLT.app.showItemInFolder(it.path) })
        ])
      ]);
      container.appendChild(node);
    }
  }

  function flashcard(container, items, onDone) {
    clear(container);
    if (!items.length) { onDone && onDone(); return; }
    let i = 0;
    const box = el('div', { class: 'flashcard' });
    const paint = () => {
      const it = items[i];
      clear(box);
      box.classList.remove('revealed');
      box.appendChild(el('div', { class: 'fc-word', text: it.word || it.lemma }));
      if (it.phonetic) box.appendChild(el('div', { class: 'fc-ph', text: it.phonetic }));
      box.appendChild(el('div', { class: 'vi-meta' }, U.buildTags(it).map((t) => el('span', { class: `tag ${t.cls}`, text: t.text }))));
      box.appendChild(el('div', { class: 'fc-answer' }, [
        el('div', { class: 'fc-t', text: it.translation || '—' }),
        it.enDef ? el('div', { class: 'fc-d', text: it.enDef }) : null,
        it.example ? el('div', { class: 'fc-d', html: `<em>${U.escapeHtml(it.example)}</em>` }) : null,
        it.exampleZh ? el('div', { class: 'fc-d', text: it.exampleZh, style: { fontFamily: 'var(--font-cn)' } }) : null
      ]));
      const bar = el('div', { class: 'sp-controls', style: { justifyContent: 'center' } }, [
        el('button', { class: 'cb-btn accent', text: '显示释义 (空格)', onclick: () => box.classList.add('revealed') }),
        el('button', { class: 'cb-btn', text: '下一个 →', onclick: () => { i = (i + 1) % items.length; paint(); } }),
        el('button', { class: 'cb-btn', text: '退出', onclick: () => onDone && onDone() })
      ]);
      box.appendChild(bar);
      box.appendChild(el('div', { class: 'muted small', text: `${i + 1} / ${items.length}` }));
    };
    paint();
    container.appendChild(box);
    const keyHandler = (e) => {
      if (e.key === ' ') { e.preventDefault(); box.classList.add('revealed'); }
      if (e.key === 'ArrowRight') { i = (i + 1) % items.length; paint(); }
      if (e.key === 'Escape') { document.removeEventListener('keydown', keyHandler); onDone && onDone(); }
    };
    document.addEventListener('keydown', keyHandler);
  }

  window.PLTTranscript = { Transcript, renderVocabList, renderHistoryList, flashcard };
}());

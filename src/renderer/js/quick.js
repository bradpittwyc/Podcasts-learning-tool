'use strict';
/**
 * quick.js — 屏幕取词浮窗（全局快捷键 Alt+Shift+W 唤出）
 * 接收主进程送来的文本 → 大模型按级别挑出难词 → 显示释义
 */
(function () {
  const U = window.PLTUtil;
  const S = window.PLTSubs;
  const { el, clear, toast } = U;

  const body = U.$('#qBody');
  let settings = null;
  let last = null;

  function levelLabel(id) {
    const map = {
      none: '全部单词', a2: 'A2+', b1: 'B1+', b2: 'B2+',
      ielts: '雅思+', toefl: '托福+', gre: 'GRE+', educated_native: '母语级'
    };
    return map[id] || id || '托福+';
  }

  async function boot() {
    settings = await window.PLT.settings.get();
    applyTheme(await window.PLT.theme.resolve());
    U.$('#qLevel').textContent = '级别：' + levelLabel(settings.lookup.level);
    U.$('#qClose').addEventListener('click', () => window.PLT.win.hideQuick());
    U.$('#qPin').addEventListener('click', async () => {
      const s = await window.PLT.win.state();
      await window.PLT.win.setAlwaysOnTop(!s.alwaysOnTop);
      U.$('#qPin').classList.toggle('on', !s.alwaysOnTop);
    });
    U.$('#qSpeak').addEventListener('click', () => speakAll());
    U.$('#qSave').addEventListener('click', saveAll);
    window.PLT.settings.onChanged((s) => { settings = s; U.$('#qLevel').textContent = '级别：' + levelLabel(s.lookup.level); });
    window.PLT.theme.onChanged(applyTheme);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') window.PLT.win.hideQuick();
    });
  }

  function applyTheme(t) {
    document.body.dataset.theme = t && t.dark ? 'dark' : 'light';
  }

  window.PLT.onQuickPayload((payload) => {
    last = payload || {};
    if (last.text) handleText(last.text);
    else if (last.dataUrl) handleImage(last.dataUrl);
    else showEmpty('没有拿到文字。可以改用「截图 OCR」或在应用内选中文本后按快捷键。');
  });

  function showEmpty(msg) {
    clear(body);
    body.appendChild(el('div', { class: 'dict-empty', text: msg }));
  }

  function loading(msg) {
    clear(body);
    body.appendChild(el('div', { class: 'dict-loading' }, [el('div', { class: 'spinner' }), el('span', { text: msg })]));
  }

  async function handleImage(dataUrl) {
    loading('正在识别截图文字…');
    const res = await window.PLT.screen.ocr(dataUrl, settings?.lookup ? undefined : undefined);
    if (!res || !res.ok) {
      showEmpty(`OCR 失败：${(res && (res.error || res.code)) || '未知错误'}`);
      return;
    }
    await handleText(res.text, 'OCR');
  }

  async function handleText(text, source) {
    const clean = String(text || '').trim();
    if (!clean) { showEmpty('识别结果为空，换个区域再试。'); return; }
    loading('正在按级别挑选难词…');
    const candidates = S.extractCandidates(clean).slice(0, 20);
    if (!candidates.length) {
      clear(body);
      body.appendChild(el('div', { class: 'quick-text', text: clean.slice(0, 300) }));
      body.appendChild(el('div', { class: 'dict-empty', text: '这段文字里没有可查询的英文单词。' }));
      return;
    }
    const res = await window.PLT.llm.lookup(
      candidates.map((c) => ({ word: c.word, context: clean.slice(0, 200) })),
      { level: settings?.lookup?.level, applyLevelFilter: true }
    );
    clear(body);
    body.appendChild(el('div', { class: 'quick-text', text: clean.slice(0, 400) }));
    if (!res.ok) {
      body.appendChild(el('div', { class: 'dict-error', text: describeError(res) }));
      return;
    }
    const entries = Object.values(res.entries || {});
    if (!entries.length) {
      body.appendChild(el('div', { class: 'skip-note', text: `这段文字里没有达到「${levelLabel(settings?.lookup?.level)}」级别的生词 —— 已为你省下这次翻译的 token。` }));
      // 仍然展示被跳过的词及其级别，便于确认
      const skipped = Object.entries(res.skipped || {}).slice(0, 12);
      if (skipped.length) {
        body.appendChild(el('div', { class: 'muted small', style: { marginTop: '8px' }, text: '这段里的词及级别：' }));
        const wrap = el('div', { class: 'q-tags' });
        for (const [w, info] of skipped) {
          wrap.appendChild(el('span', { class: `tag ${String(info.cefr || 'b1').toLowerCase()}`, text: `${w} ${info.cefr || ''}` }));
        }
        body.appendChild(wrap);
      }
      return;
    }
    for (const entry of entries) body.appendChild(renderEntry(entry));
  }

  function describeError(res) {
    if (res.code === 'NO_API_KEY') return '尚未配置大模型 API Key：请在主窗口 ⚙ 设置 → 大模型中填入。';
    return `查询失败：${res.error || res.code}`;
  }

  function renderEntry(entry) {
    const node = el('div', { class: 'q-item' }, [
      el('div', { class: 'q-head' }, [
        el('span', { class: 'q-word', text: entry.lemma || entry.word }),
        entry.phonetic ? el('span', { class: 'q-ph', text: entry.phonetic }) : null,
        el('span', { class: 'q-ph', text: entry.pos || '' })
      ]),
      entry.translation ? el('div', { class: 'q-trans', text: entry.translation }) : null,
      entry.enDef ? el('div', { class: 'q-en', text: entry.enDef }) : null,
      entry.example ? el('div', { class: 'q-en', html: `<em>${U.escapeHtml(entry.example)}</em>` }) : null,
      el('div', { class: 'q-tags' }, U.buildTags(entry).map((t) => el('span', { class: `tag ${t.cls}`, text: t.text })))
    ]);
    node.addEventListener('click', () => speak(entry.lemma || entry.word));
    node.addEventListener('dblclick', async () => {
      const r = await window.PLT.vocab.add({ ...entry, word: entry.lemma || entry.word, source: '屏幕取词' });
      if (r && r.ok) toast(`已加入生词本：${entry.lemma || entry.word}`, 'ok');
    });
    return node;
  }

  let audio = null;
  function speak(word) {
    if (!word) return;
    const mode = (settings && settings.lookup && settings.lookup.pronounce) || 'us';
    if (mode === 'none') return;
    if (audio) { try { audio.pause(); } catch (_) { /* ignore */ } }
    audio = new Audio(`https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${mode === 'uk' ? 1 : 2}`);
    audio.play().catch(() => { /* ignore */ });
  }

  function speakAll() {
    const first = body.querySelector('.q-word');
    speak(first ? first.textContent : '');
  }

  function saveAll() {
    const words = [...body.querySelectorAll('.q-word')].map((n) => n.textContent);
    if (!words.length) { toast('没有可收藏的词', 'warn'); return; }
    toast(`共 ${words.length} 个词：单击词条可朗读，双击词条即加入生词本`, 'warn', 4200);
  }

  boot();
}());

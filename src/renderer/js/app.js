'use strict';
/**
 * app.js — 应用主控
 *  文件打开/导入 → 播放器 → 字幕同步 → 文字区 → 分级取词 → 校对 → 保存
 */
(function () {
  const U = window.PLTUtil;
  const S = window.PLTSubs;
  const { $, $$, el, clear, toast, fmtClock, clamp, debounce } = U;

  // ── 错误收集（同时服务于 --smoke-test 诊断）──
  window.__pltErrors = window.__pltErrors || [];
  window.addEventListener('error', (e) => {
    window.__pltErrors.push(`error: ${e.message} @ ${e.filename}:${e.lineno}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    window.__pltErrors.push(`rejection: ${(r && (r.stack || r.message)) || String(r)}`);
  });
  function track(label, promise) {
    return Promise.resolve(promise).catch((err) => {
      window.__pltErrors.push(`${label}: ${err && (err.stack || err.message)}`);
      console.error('[plt]', label, err);
      return null;
    });
  }

  const state = {
    settings: null,
    media: null,          // {path,name,url,kind,...}
    subtitle: null,       // {path,name,format,encoding,count}
    mediaList: [],
    mediaIndex: -1,
    folderDir: null,      // 「文件夹导入」选中的目录（供字幕菜单列出全部字幕）
    folderSubtitles: [],
    loadedSubtitles: [],  // 本次会话已加载过的字幕
    loopOne: false,
    abFirst: null,
    sessionStart: Date.now()
  };

  let player = null;
  let transcript = null;
  let lookup = null;
  let dictPanel = null;
  let shadow = null;
  let settingsPanel = null;
  let rafSyncing = false;
  let lastCueIndex = -2;
  let levelWatchGeneration = 0;
  let openFilesHandler = null;
  let booted = false;

  // ══════════════════════════════════════════════════════════
  // 启动
  // ══════════════════════════════════════════════════════════
  async function boot() {
    state.settings = await window.PLT.settings.get();

    // ── 播放器 ──
    player = new window.PLTPlayer.Player($('#video'), {
      defaultRate: state.settings.player.rate,
      defaultVolume: state.settings.player.volume,
      muted: state.settings.player.muted
    });
    window.PLTPlayer.bindTransport(player, { seekbar: $('#seekbar'), miniTime: $('#miniTime') });
    player.setLoopMode(state.settings.player.loopMode || 'none');

    // ── 文字区 ──
    transcript = new window.PLTTranscript.Transcript($('#transcript'), {
      onSeekCue: (i, opts) => seekCue(i, opts),
      onReplayCue: (i) => replayCue(i),
      onLoopCue: (i) => loopCue(i),
      onWord: (word, cue, span) => onWordClick(word, cue, span),
      onAddVocab: (word, cue) => quickAddVocab(word, cue),
      onPickSubtitle: () => openSubtitleDialog(),
      onEditingChange: (on) => onEditingChange(on),
      onEdited: () => markDirty(),
      onStructureChanged: () => { syncLoopSegment(); markDirty(); }
    });

    // ── 分级取词 ──
    lookup = new window.PLTDict.Lookup({
      onCost: () => paintCost(),
      onStatus: (text, busy) => {
        $('#apiStatus').classList.toggle('busy', !!busy);
        if (text) $('#sbMode').textContent = text;
        else paintMode();
      }
    });
    await lookup.loadLevels();
    buildLevelSelect();

    dictPanel = new window.PLTDict.DictPanel({
      onLookup: (word, cue) => doLookup(word, cue),
      onReload: (word, cue) => doLookup(word, cue, true),
      onSave: (entry, cue) => saveVocab(entry, cue),
      onSpeak: (word, mode) => window.PLTDict.speak(word, mode),
      pronounce: () => state.settings.lookup.pronounce,
      levelLabel: () => levelLabelText(),
      onHide: () => paintMode()
    });

    shadow = new window.PLTShadow.Shadow({
      onToggle: (on) => { $('#btnShadow').classList.toggle('on', on); $('#miniShadow').classList.toggle('on', on); },
      onPlayOriginal: (i) => replayCue(i),
      originalDuration: () => {
        const cue = transcript.getCues()[transcript.currentIndex];
        return cue ? Math.max(0.6, cue.end - cue.start) : 2;
      },
      onGapEnd: () => { if (state.settings.shadowing.autoNextAfterRecord && shadow.enabled) goNextLine(); },
      onSetting: (k, v) => window.PLT.settings.patch({ shadowing: k === 'autoNext' ? { autoNextAfterRecord: v } : { gapFactor: v ? 0.5 : 0 } }),
      micDeviceId: () => state.settings.shadowing.micDeviceId
    });
    window.PLTShadow.instance = shadow;

    settingsPanel = new window.PLTSettings.SettingsPanel({
      onApplied: (s) => { state.settings = s; applySettings(s); }
    });

    applySettings(state.settings);
    applyTheme(await window.PLT.theme.resolve());
    paintPortable();
    updateSubtitleButton();

    bindUi();
    bindPlayerEvents();
    bindKeyboard();
    bindBridgeEvents();
    await refreshVocabCount();
    await loadHistory();
    startSyncLoop();

    // 命令行/关联打开（boot 期间到达的先缓存，避免丢事件）
    openFilesHandler = (files) => {
      const run = async () => {
        window.__pltOpenedFromHandshake = true;
        const media = files.filter((f) => S.MEDIA_EXT.includes(extOf(f)));
        const subs = files.filter((f) => S.SUBTITLE_EXT.includes(extOf(f)));
        if (media.length) await openMediaPaths(media);
        if (subs.length) await openSubtitlePaths(subs);
      };
      if (!booted) {
        window.__pltPendingFiles = [...(window.__pltPendingFiles || []), ...files];
        return;
      }
      track('open-files', run());
    };
    window.PLT.app.onOpenFiles((files) => openFilesHandler(files));

    if (window.PLT.app.onMenuAction) window.PLT.app.onMenuAction(handleMenuAction);

    // 供主进程冒烟测试读取运行状态（--smoke-test）
    window.__pltSmoke = {
      get cues() { return transcript.getCues(); },
      get currentCue() {
        const c = transcript.getCues()[transcript.currentIndex];
        return c ? { index: transcript.currentIndex, en: c.en, zh: c.zh, start: c.start, end: c.end } : null;
      },
      get media() { return state.media; },
      get subtitle() { return state.subtitle; },
      get words() { return transcript.words.size; },
      get highlightCount() { return document.querySelectorAll('#transcript .w.hit').length; },
      /** 供诊断/自动化：通过应用自身通道保存 API Key（DPAPI 与应用身份绑定，外部写入无法解密） */
      setApiKey: async (key) => {
        const res = await window.PLT.settings.setApiKey(key);
        state.settings = await window.PLT.settings.get();
        return { ...res, hasApiKey: !!state.settings.llm.hasApiKey, hint: state.settings.llm.apiKeyHint };
      },
      testLLM: () => window.PLT.settings.testLLM(),
      /** 直接调用取词引擎（端到端验证分级过滤与费用） */
      lookupWords: (items, options) => window.PLT.llm.lookup(items, options),
      /** 只读诊断：查看本次会话的取词统计 */
      costStats: () => ({ ...lookup.session, label: lookup.costLabel().text }),
      /** 模拟「文件夹导入」：走真实流程（扫描 → 弹列表 → 点击第 idx 行） */
      simulateFolderOpen: async (dir, idx = 0) => {
        window.__pltSmokeLog = [];
        await openFolderDialog(dir, idx);
        // 等待 onClose → loadMedia 完成
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const s = state.media;
          if (s && (window.__pltSmokeLog || []).some((m) => m.startsWith('folder open'))) break;
        }
        const rows = await window.PLT.file.scanFolder(dir);
        const media = rows.filter((x) => x && x.path && !x.error);
        return {
          rows: media.map((r) => ({ name: r.name, kind: r.kind, subtitle: !!r.subtitlePath })),
          log: window.__pltSmokeLog || [],
          modalStillOpen: !$('#modalHost').classList.contains('hidden'),
          opened: state.media ? state.media.name : null
        };
      },
      state: () => ({
        media: state.media ? state.media.name : null,
        subtitle: state.subtitle ? state.subtitle.name : null,
        cues: transcript.getCues().length,
        words: transcript.words.size,
        hits: document.querySelectorAll('#transcript .w.hit').length,
        level: state.settings.lookup.level,
        fontEn: getComputedStyle(document.documentElement).getPropertyValue('--font-en').trim(),
        fontCn: getComputedStyle(document.documentElement).getPropertyValue('--font-cn').trim(),
        levelOptions: [...document.querySelectorAll('#levelSelect option')].map((o) => o.value)
      })
    };

    // 首次使用提示
    if (!state.settings.llm.hasApiKey) {
      setTimeout(() => {
        toast('还没有配置大模型 API Key：点右上角 ⚙ 设置 → 大模型 填入（推荐 DeepSeek，便宜且中文好）。未配置时播放、字幕、校对功能完全可用。', 'warn', 9000);
        $('#apiStatus').classList.add('err');
        $('#apiStatus').title = '未配置大模型 API Key';
      }, 1200);
    } else {
      $('#apiStatus').classList.add('ok');
      $('#apiStatus').title = '大模型已就绪';
    }
  }

  function extOf(p) { const m = String(p).toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : ''; }
  function dirNameOf(p) { const i = Math.max(String(p).lastIndexOf('\\'), String(p).lastIndexOf('/')); return i > 0 ? String(p).slice(0, i) : ''; }

  // ══════════════════════════════════════════════════════════
  // 设置应用
  // ══════════════════════════════════════════════════════════
  function applySettings(s) {
    document.documentElement.style.setProperty('--font-en', s.ui.englishFont);
    document.documentElement.style.setProperty('--font-cn', s.ui.chineseFont);
    document.documentElement.style.setProperty('--font-ui', s.ui.uiFont);
    document.documentElement.style.setProperty('--tr-scale', String(s.ui.transcriptFontScale));
    document.documentElement.style.setProperty('--sub-scale', String(s.player.subtitleFontScale));
    document.body.classList.toggle('backdrop-on', !!s.ui.mica);
    if (!player || !transcript) return;
    transcript.setShowZh(!!s.ui.showChinese);
    transcript.setAutoScroll(!!s.ui.autoScroll);
    $('#btnExpandAll').classList.toggle('on', !!s.ui.showChinese);
    $('#subtitleOverlay').classList.toggle('hidden-sub', !s.player.subtitleOverlay);
    $('#btnSubtitleToggle').classList.toggle('on', !!s.player.subtitleOverlay);
    $('#miniSub').classList.toggle('on', !!s.player.subtitleOverlay);
    $('#btnShadow').classList.toggle('on', !$('#shadowPanel').classList.contains('hidden'));
    const loopMode = s.player.loopMode || 'none';
    player.setLoopMode(loopMode);
    $('#trLoop').classList.toggle('on', loopMode !== 'none');
    $('#loopBadge').classList.toggle('hidden', loopMode === 'none');
    $('#loopBadge').textContent = loopMode === 'one' ? '1' : '∞';
    if (lookup && lookup.levels.length) paintLevelLabel();
    if (player.current) player.applyDefaultPitch();
  }

  function applyTheme(t) {
    document.body.dataset.theme = t && t.dark ? 'dark' : 'light';
  }

  function paintPortable() {
    window.PLT.app.info().then((info) => {
      $('#sbPortable').textContent = info.portable ? `便携模式 · ${info.version}` : `v${info.version}`;
      $('#sbPortable').title = info.dataDir;
    });
  }

  function paintLevelLabel() {
    const id = state.settings.lookup.level;
    const lv = lookup.levels.find((l) => l.id === id);
    $('#sbMode').textContent = lv ? `取词：${lv.short || lv.label}` : '';
    paintLockButton();
  }

  function levelLabelText() {
    const lv = lookup.levels.find((l) => l.id === state.settings.lookup.level);
    return lv ? (lv.short || lv.label) : state.settings.lookup.level;
  }

  /** 级别锁定：锁定后低于所选级别的单词不可以取词（本地词典与 AI 都被拦下） */
  async function toggleLevelLock(force) {
    const next = force === undefined ? !state.settings.lookup.lockLevel : !!force;
    await window.PLT.settings.patch({ lookup: { lockLevel: next } });
    state.settings = await window.PLT.settings.get();
    paintLockButton();
    toast(next
      ? `已锁定：低于「${levelLabelText()}」的单词不可取词`
      : '已解锁：可点查任意单词（低级别词走本地词典，不产生 AI 费用）', 'ok', 4200);
  }

  function paintLockButton() {
    const btn = $('#btnLockLevel');
    if (!btn || !state.settings) return;
    const locked = !!state.settings.lookup.lockLevel;
    btn.classList.toggle('locked', locked);
    btn.setAttribute('aria-pressed', String(locked));
    btn.title = locked
      ? `已锁定：低于「${levelLabelText()}」的单词不可取词 —— 点击解锁`
      : `未锁定：可点查任意单词（低于「${levelLabelText()}」的词只用本地词典，不调用 AI）—— 点击锁定`;
  }

  function paintMode() {
    if (lookup && lookup.levels.length) paintLevelLabel();
  }

  function buildLevelSelect() {
    const sel = $('#levelSelect');
    clear(sel);
    const groups = [
      { label: '常用', ids: ['none', 'a2', 'b1', 'b2'] },
      { label: '考试级别', ids: ['ielts', 'toefl', 'gre'] },
      { label: '母语级', ids: ['educated_native'] }
    ];
    const byId = Object.fromEntries(lookup.levels.map((l) => [l.id, l]));
    for (const g of groups) {
      const og = el('optgroup', { label: g.label });
      for (const id of g.ids) {
        const l = byId[id];
        if (!l) continue;
        og.appendChild(el('option', { value: id, text: l.label, title: l.desc || '', selected: state.settings.lookup.level === id }));
      }
      sel.appendChild(og);
    }
    sel.value = state.settings.lookup.level;
    sel.addEventListener('change', async () => {
      await window.PLT.settings.patch({ lookup: { level: sel.value } });
      state.settings = await window.PLT.settings.get();
      paintLevelLabel();
      const lv = lookup.levels.find((l) => l.id === sel.value);
      toast(`取词级别：${lv ? lv.label : sel.value}${lv && lv.desc ? ' — ' + lv.desc : ''}`, 'ok');
      if (transcript.getCues().length) await autoScan({ silent: false });
    });
  }

  // ══════════════════════════════════════════════════════════
  // UI 绑定
  // ══════════════════════════════════════════════════════════
  function bindUi() {
    $('#btnMin').addEventListener('click', () => window.PLT.win.minimize());
    $('#btnMax').addEventListener('click', () => window.PLT.win.toggleMaximize());
    $('#btnClose').addEventListener('click', () => window.PLT.win.close());
    $('#titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('.menubar')) window.PLT.win.toggleMaximize(); });

    // 菜单
    for (const chip of $$('.menu-chip')) {
      chip.addEventListener('click', (e) => {
        const rect = chip.getBoundingClientRect();
        const items = menuItemsFor(chip.dataset.menu);
        U.contextMenu(rect.left, rect.bottom + 2, items);
        e.stopPropagation();
      });
    }

    $('#btnOpenMedia').addEventListener('click', () => openMediaDialog());
    $('#btnOpenSub').addEventListener('click', () => subtitleMenu());
    $('#btnOpenFolder').addEventListener('click', () => openFolderDialog());
    $('#dzOpen').addEventListener('click', () => openMediaDialog());
    $('#dzSub').addEventListener('click', () => openSubtitleDialog());
    $('#dzFolder').addEventListener('click', () => openFolderDialog());

    // 播放 / 上一句 / 下一句 / 重播 / 单句循环 / 倍速 的监听统一在 player.js 的
    // bindTransport() 里绑定 —— 这里不要再绑，否则一次点击会触发两次（播放按钮会自己抵消）
    $('#btnPrevLine').addEventListener('click', () => goPrevLine());
    $('#btnNextLine').addEventListener('click', () => goNextLine());
    $('#btnReplay').addEventListener('click', () => replayCue(transcript.currentIndex));
    $('#btnLoopLine').addEventListener('click', () => loopCue(transcript.currentIndex));
    $('#btnSubtitleToggle').addEventListener('click', () => toggleSubtitleOverlay());
    $('#miniSub').addEventListener('click', () => toggleSubtitleOverlay());
    $('#btnShadow').addEventListener('click', () => shadow.toggle());
    $('#miniShadow').addEventListener('click', () => shadow.toggle());
    $('#btnScreenOcr').addEventListener('click', () => screenLookup());
    $('#miniSub').classList.toggle('on', !!state.settings.player.subtitleOverlay);
    $('#btnScanAll').addEventListener('click', () => autoScan({ silent: false, force: true }));
    $('#btnSettings').addEventListener('click', () => settingsPanel.open());
    $('#btnLockLevel').addEventListener('click', () => toggleLevelLock());

    $('#trAB').addEventListener('click', () => {
      const res = player.cycleAB();
      paintAB();
      if (!res) toast('A-B 已清除');
      else if (player.ab.b === null) toast(`A 点已设为 ${fmtClock(player.ab.a)}，再点一次设置 B 点`);
      else toast(`A-B 复读：${fmtClock(player.ab.a)} → ${fmtClock(player.ab.b)}`, 'ok');
    });

    // 面板标签
    for (const tab of $$('.ph-tab')) {
      tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    }

    // 校对
    $('#btnEdit').addEventListener('click', () => transcript.setEditing(!transcript.editing));
    $('#btnShift').addEventListener('click', () => shiftDialog());
    $('#btnSaveSub').addEventListener('click', () => saveSubtitle());
    $('#btnExpandAll').addEventListener('click', async () => {
      const next = !state.settings.ui.showChinese;
      await window.PLT.settings.patch({ ui: { showChinese: next } });
      state.settings = await window.PLT.settings.get();
      transcript.setShowZh(next);
      $('#btnExpandAll').classList.toggle('on', next);
    });
    for (const btn of $$('#editbar [data-shift]')) {
      btn.addEventListener('click', () => {
        const delta = Number(btn.dataset.shift);
        const n = transcript.shiftTimes(delta, transcript.selectedIndex >= 0 ? transcript.selectedIndex : undefined);
        markDirty();
        toast(`已平移 ${delta > 0 ? '+' : ''}${delta}s（${n} 行）`, 'ok');
      });
    }
    $('#btnSplitCue').addEventListener('click', () => {
      const i = transcript.selectedIndex;
      if (i < 0) { toast('先点选一行字幕', 'warn'); return; }
      transcript.splitCue(i, player.currentTime);
      markDirty();
    });
    $('#btnMergeCue').addEventListener('click', () => {
      const i = transcript.selectedIndex;
      if (i < 0) { toast('先点选一行字幕', 'warn'); return; }
      if (!transcript.mergeWithNext(i)) toast('没有下一行可合并', 'warn');
      else markDirty();
    });
    $('#btnInsertCue').addEventListener('click', () => {
      const i = transcript.selectedIndex >= 0 ? transcript.selectedIndex : transcript.currentIndex;
      transcript.insertAfter(i, player.currentTime);
      markDirty();
    });
    $('#btnDeleteCue').addEventListener('click', () => {
      const i = transcript.selectedIndex;
      if (i < 0) { toast('先点选一行字幕', 'warn'); return; }
      transcript.deleteCue(i);
      markDirty();
    });
    $('#btnSetStart').addEventListener('click', () => {
      const i = transcript.selectedIndex;
      if (i < 0) { toast('先点选一行字幕', 'warn'); return; }
      transcript.setBoundary(i, 'start', player.currentTime);
      markDirty();
    });
    $('#btnSetEnd').addEventListener('click', () => {
      const i = transcript.selectedIndex;
      if (i < 0) { toast('先点选一行字幕', 'warn'); return; }
      transcript.setBoundary(i, 'end', player.currentTime);
      markDirty();
    });

    // 生词本
    $('#vocabSearch').addEventListener('input', U.debounce(() => paintVocab(), 200));
    $('#vocabSort').addEventListener('change', () => paintVocab());
    $('#btnVocabExport').addEventListener('click', async () => {
      const res = await window.PLT.vocab.export();
      if (res) toast(`已导出 ${res.count} 个词：${res.path}`, 'ok');
    });
    $('#btnVocabDrill').addEventListener('click', () => startFlashcards());
    $('#btnVocabClear').addEventListener('click', async () => {
      if (await U.confirm('清空全部生词？此操作不可恢复。')) {
        await window.PLT.vocab.clear();
        await refreshVocabCount();
        paintVocab();
        toast('生词本已清空', 'ok');
      }
    });
    $('#btnHistoryClear').addEventListener('click', async () => {
      await window.PLT.history.clear();
      await loadHistory();
      toast('历史记录已清空', 'ok');
    });

    // 拖放
    const stage = $('#stage');
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    ['dragenter', 'dragover'].forEach((evt) => document.addEventListener(evt, (e) => {
      stop(e);
      stage.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach((evt) => document.addEventListener(evt, (e) => {
      stop(e);
      if (evt === 'drop' || e.target === document || !e.relatedTarget) stage.classList.remove('dragover');
    }));
    document.addEventListener('drop', (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (files.length) handleDroppedFiles(files);
    });

    // 屏幕取词遮罩外的其它浮层
    $('#spClose').addEventListener('click', () => shadow.toggle(false));

    // 点击空白处关闭右键菜单由 util 处理
    $('#seekbar').setAttribute('aria-valuemin', '0');
  }

  function menuItemsFor(menu) {
    const map = {
      file: [
        { label: '打开媒体文件…', kbd: 'Ctrl+O', action: () => openMediaDialog() },
        { label: '打开字幕文件…', kbd: 'Ctrl+Shift+O', action: () => openSubtitleDialog() },
        { label: '批量导入文件夹…', action: () => openFolderDialog() },
        { sep: true },
        { label: '保存校对后的字幕…', kbd: 'Ctrl+S', action: () => saveSubtitle() },
        { label: '导出学习笔记 (Markdown)…', action: () => exportNotes() },
        { sep: true },
        { label: '打开数据目录', action: async () => window.PLT.app.openPath((await window.PLT.app.info()).dataDir) }
      ],
      play: [
        { label: '播放 / 暂停', kbd: '空格', action: () => player.toggle() },
        { label: '上一句', kbd: '↑', action: () => goPrevLine() },
        { label: '下一句', kbd: '↓', action: () => goNextLine() },
        { label: '重播当前句', kbd: 'Ctrl+R', action: () => replayCue(transcript.currentIndex) },
        { sep: true },
        { label: '减速', kbd: 'Ctrl+[', action: () => player.stepRate(-1) },
        { label: '加速', kbd: 'Ctrl+]', action: () => player.stepRate(1) },
        { label: '回到原速 1.0×', action: () => player.setRate(1) },
        { sep: true },
        { label: 'A-B 复读', action: () => $('#trAB').click() },
        { label: '清除 A-B', action: () => { player.clearAB(); paintAB(); } }
      ],
      learn: [
        { label: '查询选中文本', kbd: 'Ctrl+D', action: () => lookupSelection() },
        { label: '屏幕取词（截图 OCR）', kbd: 'Ctrl+Shift+S', action: () => screenLookup() },
        { label: '抓取前台程序选中文字', action: () => captureSelectionLookup() },
        { sep: true },
        { label: '扫描全文难词', kbd: 'Ctrl+Shift+D', action: () => autoScan({ silent: false, force: true }) },
        { label: '关闭全部中文（只看英文）', action: () => setChinese(false) },
        { label: '显示中文译文', action: () => setChinese(true) },
        { sep: true },
        { label: '生词本', action: () => switchTab('vocab') },
        { label: '闪卡复习', action: () => startFlashcards() },
        { label: '导出学习笔记…', action: () => exportNotes() }
      ],
      view: [
        { label: '放大界面', kbd: 'Ctrl+=', action: () => zoom(0.1) },
        { label: '缩小界面', kbd: 'Ctrl+-', action: () => zoom(-0.1) },
        { label: '重置缩放', kbd: 'Ctrl+0', action: () => zoom(0) },
        { sep: true },
        { label: '浅色', action: () => setTheme('light') },
        { label: '深色', action: () => setTheme('dark') },
        { label: '跟随系统', action: () => setTheme('system') },
        { sep: true },
        { label: '全屏播放', kbd: 'F', action: () => player.toggleFullscreen($('#stage')) },
        { label: '窗口置顶', action: async () => { const s = await window.PLT.win.state(); await window.PLT.win.setAlwaysOnTop(!s.alwaysOnTop); } }
      ],
      help: [
        { label: '使用说明（README）', action: () => window.PLT.app.openExternal('https://github.com/bradpittwyc/Podcasts-learning-tool#readme') },
        { label: '项目主页', action: () => window.PLT.app.openExternal('https://github.com/bradpittwyc/Podcasts-learning-tool') },
        { sep: true },
        { label: '快捷键一览', action: () => settingsPanel.open('advanced') },
        { label: 'OCR 可用性检测', action: async () => {
          const res = await window.PLT.screen.ocrProbe();
          if (res.ok) toast(`Windows OCR 可用（${res.lang || '默认语言'}）`, 'ok');
          else toast(`OCR 不可用：${res.error || res.code}`, 'err', 7000);
        } },
        { label: '关于', action: () => about() }
      ]
    };
    return map[menu] || [];
  }

  async function setChinese(on) {
    await window.PLT.settings.patch({ ui: { showChinese: on } });
    state.settings = await window.PLT.settings.get();
    transcript.setShowZh(on);
    $('#btnExpandAll').classList.toggle('on', on);
  }

  async function setTheme(theme) {
    await window.PLT.settings.patch({ ui: { theme } });
    state.settings = await window.PLT.settings.get();
    applyTheme(await window.PLT.theme.resolve());
  }

  let zoomLevel = 0;
  function zoom(delta) {
    if (delta === 0) zoomLevel = 0;
    else zoomLevel = clamp(zoomLevel + delta, -0.4, 0.8);
    document.documentElement.style.fontSize = `${100 + zoomLevel * 100}%`;
    document.body.style.zoom = String(1 + zoomLevel * 0.35);
  }

  function about() {
    window.PLT.app.info().then((info) => {
      U.modal({
        title: 'Podcasts Learning Tool',
        subtitle: `英语学习神器 · v${info.version}`,
        narrow: true,
        body: el('div', { class: 'form' }, [
          el('div', { class: 'skip-note', html: [
            '<b>功能</b><br>',
            '· 播放 MP4 / MP3 等音视频，0.25×~2.5× 变速不变调<br>',
            '· 导入 SRT / VTT / ASS / LRC / TXT 字幕，软件内校对、点击文字跳转时间戳<br>',
            '· 英文 Times New Roman、中文微软雅黑，逐词点击查词典<br>',
            '· 大模型分级取词：雅思 / 托福 / GRE / 母语级，只翻译目标级别及以上的词<br>',
            '· 屏幕取词：截图 OCR（Windows 内置，离线）或抓取前台选中文字<br>',
            '· 跟读录音、A-B 复读、单句循环、生词本与闪卡复习<br>',
            '· 绿色便携版：数据存于程序同目录，U 盘即插即用'
          ].join('<br>') }),
          el('div', { class: 'muted small', html: `Electron ${U.escapeHtml(info.electron)} · Chromium ${U.escapeHtml(info.chrome)} · Node ${U.escapeHtml(info.node)}<br>数据目录：${U.escapeHtml(info.dataDir)}` })
        ]),
        buttons: [
          { label: '打开数据目录', action: () => window.PLT.app.openPath(info.dataDir) },
          { label: '好', accent: true }
        ]
      });
    });
  }

  // ══════════════════════════════════════════════════════════
  // 播放器事件 → 字幕同步
  // ══════════════════════════════════════════════════════════
  function bindPlayerEvents() {
    player.on('loaded', (info) => {
      $('#stage').classList.add('has-media');
      $('#stage').classList.toggle('has-audio', info.kind === 'audio');
      $('#audioTitle').textContent = info.name;
      $('#sbFile').textContent = `${info.name}`;
      $('#sbFile').title = info.path;
      buildAudioBars();
      syncLoopSegment();
    });
    player.on('time', () => { if (!rafSyncing) { rafSyncing = true; requestAnimationFrame(() => { rafSyncing = false; }); } });
    player.on('state', () => { $('#miniPlay').classList.toggle('on', player.playing); });
    player.on('ended', () => {
      if (state.settings.player.autoPauseAtLineEnd) return;
      if (shadow && shadow.enabled) {
        const cue = transcript.getCues()[transcript.currentIndex];
        if (cue) shadow.startGap((cue.end - cue.start) * (state.settings.shadowing.gapFactor || 0.5));
      }
    });
    player.on('error', (err) => toast(`播放出错：${err.message}`, 'err', 7000));
  }

  function syncLoopSegment() {
    if (!$('#btnLoopLine').classList.contains('on')) { player.setSegmentLoop(null, null); return; }
    const cue = transcript.getCues()[transcript.currentIndex];
    if (!cue) { player.setSegmentLoop(null, null); return; }
    player.setSegmentLoop(cue.start, cue.end);
  }

  function startSyncLoop() {
    const step = () => {
      requestAnimationFrame(step);
      const cues = transcript.getCues();
      if (!cues.length) return;
      const idx = S.indexAt(cues, player.currentTime);
      if (idx !== lastCueIndex) {
        lastCueIndex = idx;
        wasPausedForCue = false;
        transcript.setCurrent(idx, { smooth: true });
        paintOverlay(cues[idx]);
        $('#sbLine').textContent = idx >= 0 ? `第 ${idx + 1} / ${cues.length} 句` : '';
        if (shadow && shadow.enabled) shadow.setCue(idx, cues[idx]);
        // 单句循环跟随当前句
        if ($('#btnLoopLine').classList.contains('on') && idx >= 0) {
          player.setSegmentLoop(cues[idx].start, cues[idx].end);
        }
        return;
      }
      // 精听模式：到达当前行末尾自动暂停
      if (state.settings.player.autoPauseAtLineEnd && idx >= 0 && !wasPausedForCue && player.playing) {
        const cue = cues[idx];
        if (player.currentTime >= cue.end - 0.1) {
          player.pause();
          wasPausedForCue = true;
        }
      }
    };
    requestAnimationFrame(step);
  }
  let wasPausedForCue = false;

  function paintOverlay(cue) {
    if (!cue) { $('#overlayEn').textContent = ''; $('#overlayZh').textContent = ''; return; }
    $('#overlayEn').textContent = cue.en || '';
    $('#overlayZh').textContent = state.settings.player.subtitleBilingual ? (cue.zh || '') : '';
  }

  function paintAB() {
    const bar = $('.seek-track');
    $$('.ab-marker, .ab-region').forEach((n) => n.remove());
    const dur = player.duration || 0;
    if (!dur) return;
    const { a, b } = player.ab;
    const pct = (t) => `${clamp((t / dur) * 100, 0, 100)}%`;
    if (a !== null) {
      const m = el('div', { class: 'ab-marker', style: { left: pct(a) } });
      bar.appendChild(m);
    }
    if (b !== null) {
      bar.appendChild(el('div', { class: 'ab-marker', style: { left: pct(b), background: '#ff8c42' } }));
    }
    if (a !== null && b !== null && b > a) {
      bar.appendChild(el('div', { class: 'ab-region', style: { left: pct(a), width: pct(b - a) } }));
    }
  }

  function buildAudioBars() {
    const bars = $('#audioBars');
    clear(bars);
    for (let i = 0; i < 28; i++) bars.appendChild(el('span', { style: { height: '16%' } }));
    if (window.__barTimer) clearInterval(window.__barTimer);
    window.__barTimer = setInterval(() => {
      if (!player.playing || player.mediaKind !== 'audio') return;
      const t = player.currentTime;
      [...bars.children].forEach((b, i) => {
        const v = Math.abs(Math.sin((t * 2.4) + i * 0.55) * Math.cos(t * 0.9 + i * 0.21));
        b.style.height = `${14 + v * 78}%`;
      });
    }, 90);
  }

  function syncToTime() { /* 保留占位：同步由 startSyncLoop 的 rAF 循环完成 */ }

  // ══════════════════════════════════════════════════════════
  // 导航
  // ══════════════════════════════════════════════════════════
  function seekCue(i, opts) {
    const cue = transcript.getCues()[i];
    if (!cue) return;
    player.seek(cue.start, { play: !!(opts && opts.play) });
    transcript.setCurrent(i, { forceScroll: true });
    lastCueIndex = i;
    paintOverlay(cue);
  }

  function replayCue(i) {
    const cue = transcript.getCues()[i];
    if (!cue) return;
    player.seek(cue.start, { play: true });
    transcript.setCurrent(i, { forceScroll: true });
    lastCueIndex = i;
  }

  function loopCue(i) {
    const on = !$('#btnLoopLine').classList.contains('on');
    $('#btnLoopLine').classList.toggle('on', on);
    if (on) {
      const cue = transcript.getCues()[i] || transcript.getCues()[transcript.currentIndex];
      if (!cue) { toast('没有可循环的句子', 'warn'); $('#btnLoopLine').classList.remove('on'); return; }
      player.setSegmentLoop(cue.start, cue.end);
      player.seek(cue.start, { play: true });
      toast('单句循环已开启（再按 L 关闭）', 'ok');
    } else {
      player.setSegmentLoop(null, null);
      toast('单句循环已关闭');
    }
  }

  function goPrevLine() {
    const i = Math.max(0, (transcript.currentIndex < 0 ? 0 : transcript.currentIndex) - 1);
    replayCue(i);
  }

  function goNextLine() {
    const cues = transcript.getCues();
    const i = clamp((transcript.currentIndex < 0 ? -1 : transcript.currentIndex) + 1, 0, cues.length - 1);
    replayCue(i);
  }

  function toggleSubtitleOverlay() {
    const on = !$('#subtitleOverlay').classList.contains('hidden-sub');
    $('#subtitleOverlay').classList.toggle('hidden-sub', on);
    $('#btnSubtitleToggle').classList.toggle('on', !on);
    $('#miniSub').classList.toggle('on', !on);
    window.PLT.settings.patch({ player: { subtitleOverlay: !on } });
    state.settings = { ...state.settings, player: { ...state.settings.player, subtitleOverlay: !on } };
    updateSubtitleButton();
    toast(on ? '已关闭字幕显示（正文区仍可点击跳转）' : '已恢复字幕显示', 'ok', 2600);
  }

  // ══════════════════════════════════════════════════════════
  // 文件打开
  // ══════════════════════════════════════════════════════════
  async function openMediaDialog() {
    const list = await window.PLT.dialog.openMedia();
    if (!list || !list.length) return;
    state.mediaList = list;
    state.mediaIndex = 0;
    state.folderDir = null;                    // 单文件打开：字幕菜单只列同目录
    await loadMedia(list[0]);
  }

  async function openMediaPaths(paths) {
    const list = [];
    for (const p of paths) {
      const info = await window.PLT.file.describe(p);
      if (info && !info.error) list.push(info);
      else window.__pltErrors.push('describe failed: ' + p + ' ' + JSON.stringify(info));
    }
    if (!list.length) { window.__pltErrors.push('openMediaPaths: no valid media in ' + JSON.stringify(paths)); return; }
    state.mediaList = list;
    state.mediaIndex = 0;
    if (!state.folderDir) state.folderDir = dirNameOf(list[0].path);
    await loadMedia(list[0]);
  }

  let loadSeq = 0;   // 媒体加载序号：并发调用时只保留最后一次，避免两次 load() 互相打断

  async function loadMedia(info) {
    const mySeq = ++loadSeq;
    const previousMedia = state.media;
    const previousSubtitle = state.subtitle;
    state.media = info;
    player.load(info);
    await window.PLT.history.add({ path: info.path, name: info.name, kind: info.kind, position: 0, subtitlePath: state.subtitle ? state.subtitle.path : null });
    await loadHistory();
    if (mySeq !== loadSeq) return;   // 期间又切了别的媒体 → 放弃本次的字幕处理

    // 自动找同名字幕
    const sibling = info.siblingSubtitle || (await window.PLT.file.findSiblingSubtitle(info.path) || {}).path || null;
    if (sibling) {
      await openSubtitlePaths([sibling], { silent: true });
      if (!state.subtitle || state.subtitle.path !== sibling) {
        // 字幕加载失败（例如文件损坏），清掉以免误配
        clearSubtitle('同名字幕加载失败');
      } else {
        toast(`已自动加载同名字幕：${String(sibling).split(/[\\/]/).pop()}`, 'ok', 4200);
      }
      return;
    }

    // 没有找到同名字幕：只有「换了一个媒体文件」时才清空上一部片的字幕，
    // 同一文件的手选字幕（例如用户自己导入的）保持不动，避免误清。
    if (!previousMedia || previousMedia.path !== info.path) {
      if (previousSubtitle) {
        clearSubtitle('该文件没有同名字幕，已清空上一部字幕');
      } else {
        toast('未找到同名字幕，点「字幕」按钮可从文件夹中选择或导入', 'warn', 5200);
        updateSubtitleButton();
      }
    }
    updateSubtitleButton();
  }

  /** 清空当前字幕（切换媒体且找不到同名字幕时调用 / 用户主动清除） */
  function clearSubtitle(reason) {
    state.subtitle = null;
    transcript.setCues([], {});
    transcript.setEditing(false);
    $('#btnEdit').classList.remove('on');
    $('#sbSubs').textContent = '无字幕';
    $('#sbSubs').title = '';
    $('#sbLine').textContent = '';
    $('#overlayEn').textContent = '';
    $('#overlayZh').textContent = '';
    lastCueIndex = -2;
    updateSubtitleButton();
    if (reason) toast(reason + '。可点「字幕」按钮选择字幕或导入字幕文件。', 'warn', 5600);
  }

  async function openSubtitleDialog() {
    const list = await window.PLT.dialog.openSubtitle();
    if (!list || !list.length) return;
    await applySubtitleResult(list[0]);
    if (list.length > 1) {
      toast(`已导入 ${list.length} 个字幕文件，当前使用「${list[0].name}」；切换到其他文件请再次点「字幕」按钮单独打开。`, 'warn', 6000);
    }
  }

  async function openSubtitlePaths(paths, opts) {
    for (const p of paths) {
      const res = await window.PLT.file.loadSubtitle(p);
      await applySubtitleResult(res);
    }
    if (!(opts && opts.silent) && paths.length) toast('字幕已加载', 'ok');
  }

  async function applySubtitleResult(res) {
    if (!res) return;
    if (res.error) { toast(`字幕加载失败：${res.error}`, 'err', 6000); return; }
    if (!res.cues || !res.cues.length) {
      if (res.format === 'text' || String(res.name || '').toLowerCase().endsWith('.txt')) {
        // 纯文本：需要时长来均分时间戳
        const dur = player.duration || 0;
        if (dur <= 0) {
          const v = await U.prompt('这是一份无时间轴的纯文本。请填写该音频/视频的总时长（秒），软件会按内容均分时间轴：', '600', { subtitle: '之后可在「校对」里微调每行时间' });
          const secs = Number(v);
          if (Number.isFinite(secs) && secs > 0) {
            res.cues = S.cuesFromText(await readText(res.path), 'text', { duration: secs });
          }
        }
      }
      if (!res.cues || !res.cues.length) {
        toast(`「${res.name || res.path}」没有解析出字幕行，格式可能是 ${res.format}，可尝试另存为 SRT/VTT 后再导入。`, 'err', 7000);
        return;
      }
    }
    state.subtitle = { path: res.path, name: res.name, format: res.format, encoding: res.encoding, count: res.cues.length };
    // 记录到「本次已加载的字幕」列表，便于用「字幕」按钮快速切回
    state.loadedSubtitles = (state.loadedSubtitles || []).filter((s) => s.path !== res.path);
    state.loadedSubtitles.unshift({ path: res.path, name: res.name, format: res.format, count: res.cues.length });
    state.loadedSubtitles = state.loadedSubtitles.slice(0, 12);
    transcript.setCues(res.cues, { path: res.path });
    transcript.setEditing(false);
    $('#btnEdit').classList.remove('on');
    $('#sbSubs').textContent = `${res.name} · ${res.cues.length} 行 · ${res.format.toUpperCase()}${res.encoding && res.encoding !== 'utf-8' ? ' · ' + res.encoding : ''}`;
    $('#sbSubs').title = res.path;
    $('#sbLine').textContent = '';
    lastCueIndex = -2;
    paintOverlay(null);
    transcript.setCurrent(-1);
    updateSubtitleButton();
    if (state.settings.lookup.autoScan && res.cues.length) {
      // 等 UI 稳定后再扫描，避免卡顿
      setTimeout(() => autoScan({ silent: true }), 500);
    } else {
      toast('字幕已加载。点击任意英文单词即可查词，或按 Ctrl+Shift+D 扫描全文难词。', 'ok', 5200);
    }
  }

  async function readText(path) {
    const res = await window.PLT.file.readText(path);
    return res && res.ok ? res.text : '';
  }

  // ══════════════════════════════════════════════════════════
  // 字幕选择（「字幕」按钮：选择 / 关闭 / 打开文件）
  // ══════════════════════════════════════════════════════════
  /** 字幕按钮标签：跟着当前加载的字幕走 */
  function updateSubtitleButton() {
    const btnLabel = $('#subLabel');
    const isOff = $('#subtitleOverlay').classList.contains('hidden-sub');
    if (btnLabel) {
      const name = state.subtitle ? (state.subtitle.name || '').replace(/\.[^.]+$/, '') : '';
      btnLabel.textContent = name ? name.slice(0, 14) : '字幕';
    }
    const btn = $('#btnOpenSub');
    if (btn) {
      btn.title = state.subtitle
        ? `当前字幕：${state.subtitle.name}（${state.subtitle.count} 行）${isOff ? ' · 已关闭显示' : ''}\n点击选择其他字幕 / 关闭字幕 / 打开字幕文件`
        : '未加载字幕 —— 点击选择文件夹里的字幕或打开字幕文件';
      btn.classList.toggle('on', !!state.subtitle);
    }
  }

  /** 收集可选字幕：① 媒体同目录 + 文件夹导入时扫描到的 ② 本次已加载过的 */
  async function collectSubtitles() {
    let files = [];
    try {
      files = await window.PLT.file.listSubtitles({ dir: state.folderDir || null, mediaPath: state.media ? state.media.path : null });
    } catch (_) { files = []; }
    const out = [];
    const seen = new Set();
    for (const f of files || []) {
      const key = String(f.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: f.path, name: f.name, matched: !!f.matched, source: state.folderDir ? '同目录/文件夹' : '同目录' });
    }
    for (const s of (state.loadedSubtitles || [])) {
      const key = String(s.path).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ path: s.path, name: s.name, matched: false, source: '本次已加载' });
    }
    return out;
  }

  async function subtitleMenu() {
    const btn = $('#btnOpenSub');
    const rect = btn.getBoundingClientRect();
    const items = [];
    const isOff = $('#subtitleOverlay').classList.contains('hidden-sub');

    items.push({
      label: isOff ? '✓ 恢复字幕显示' : '关闭字幕显示',
      kbd: 'Ctrl+H',
      action: () => { if (!isOff) toggleSubtitleOverlay(); }
    });
    items.push({ sep: true });

    let files = [];
    try { files = await collectSubtitles(); } catch (_) { files = []; }

    if (files.length) {
      items.push({ label: `可选字幕（${files.length}）`, action: () => { } });
      for (const f of files.slice(0, 14)) {
        const active = state.subtitle && state.subtitle.path === f.path;
        items.push({
          label: `${active ? '● ' : '　'}${f.name}${f.matched ? '（同名）' : ''}`,
          title: f.path,
          action: () => {
            if (active) { toast('这份字幕已经在使用中'); return; }
            applySubtitleByPath(f.path);
          }
        });
      }
      const others = files.filter((f) => !(state.subtitle && state.subtitle.path === f.path));
      if (others.length > 1) {
        items.push({
          label: '从列表中选择…',
          action: () => subtitlePickerModal(files)
        });
      }
    } else {
      items.push({ label: '（当前文件夹里没有找到字幕文件）', action: () => { } });
    }

    items.push({ sep: true });
    items.push({ label: '打开字幕文件…', kbd: 'Ctrl+Shift+O', action: () => openSubtitleDialog() });
    if (state.subtitle) items.push({ label: '清除当前字幕', action: () => clearSubtitle('已清除字幕') });

    U.contextMenu(rect.left, rect.bottom + 2, items);
  }

  async function applySubtitleByPath(path) {
    const res = await window.PLT.file.loadSubtitle(path);
    await applySubtitleResult(res);
  }

  /** 字幕较多时的完整列表弹窗 */
  function subtitlePickerModal(files) {
    let closeFn = null;
    U.modal({
      title: `选择字幕（${files.length}）`,
      subtitle: state.media ? `当前媒体：${state.media.name}` : '未加载媒体',
      body: el('div', { class: 'form', style: { maxHeight: '52vh', overflow: 'auto', paddingTop: '10px' } },
        files.map((f) => {
          const active = state.subtitle && state.subtitle.path === f.path;
          return el('button', {
            class: 'ctx-item',
            style: { borderBottom: '1px solid var(--divider)', gap: '8px' },
            title: f.path,
            onclick: () => {
              if (closeFn) closeFn(f.path);
              else applySubtitleByPath(f.path);
            }
          }, [
            el('span', { style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text: (active ? '● ' : '') + f.name }),
            f.matched ? el('span', { class: 'tag', text: '同名' }) : null,
            el('span', { class: 'muted small', text: f.source || '' })
          ]);
        })),
      buttons: [
        { label: '关闭字幕显示', action: () => { if (!$('#subtitleOverlay').classList.contains('hidden-sub')) toggleSubtitleOverlay(); } },
        { label: '打开其他文件…', action: () => openSubtitleDialog() },
        { label: '取消' }
      ],
      render: (_box, api) => { closeFn = api.close; },
      onClose: (result) => {
        if (typeof result === 'string' && result) applySubtitleByPath(result);
      }
    });
  }

  /**
   * 文件夹导入：扫描 → 弹出可点击列表 → 点击某项即载入该媒体（同名字幕自动配对）
   * @param {string} [dirOverride] 指定目录（自动化测试用，跳过系统对话框）
   * @param {number} [clickIndex]  自动点击第 N 行（自动化测试用，走真实 onclick 路径）
   */
  async function openFolderDialog(dirOverride, clickIndex) {
    const raw = dirOverride ? await window.PLT.file.scanFolder(dirOverride) : await window.PLT.dialog.openFolder();
    if (!raw || !raw.length) return;
    if (raw[0] && raw[0].error) { toast('扫描失败：' + raw[0].error, 'err'); return; }
    // 文件夹导入：记住目录，字幕菜单会列出该目录（含子目录）的全部字幕
    state.folderDir = dirOverride || dirNameOf(raw[0].path);
    state.folderSubtitles = raw.subtitles || [];
    const list = raw;

    const media = list.filter((x) => x && x.path && !x.error);
    const onlySubs = list.filter((x) => x && x.error);
    if (!media.length) {
      U.modal({
        title: '这个文件夹里没有找到音视频文件',
        subtitle: '扫描结果',
        narrow: true,
        body: el('div', { class: 'form', style: { paddingTop: '14px' } }, [
          el('div', { class: 'skip-note', html: `支持导入的媒体格式：<br><b>${S.MEDIA_EXT.join('  ')}</b><br><br>字幕格式：<br>${S.SUBTITLE_EXT.join('  ')}` }),
          el('div', { class: 'desc', text: '提示：可以只导入字幕文件，或直接把音视频拖进窗口。' })
        ]),
        buttons: [
          { label: '导入字幕文件', action: () => openSubtitleDialog() },
          { label: '选择单个媒体文件', accent: true, action: () => openMediaDialog() }
        ]
      });
      return;
    }
    if (onlySubs.length) toast(`${onlySubs.length} 个条目无法读取，已跳过`, 'warn');

    // 判断是否为递归扫描结果（有子目录时用相对路径显示，便于区分）
    const hasSubdir = media.some((x) => x.relative && /[\\/]/.test(x.relative));
    state.mediaList = media;
    state.mediaIndex = 0;

    // 构建播放列表：点击条目打开（通过 modal.close 触发 onClose 真正加载）
    let pick = -1;
    let closeFn = null;
    U.modal({
      title: `文件夹内找到 ${media.length} 个媒体文件`,
      subtitle: hasSubdir ? '已包含子文件夹；点击条目打开，同名字幕会自动加载' : '点击条目打开；同名字幕会自动加载',
      body: el('div', { class: 'form', style: { maxHeight: '52vh', overflow: 'auto', paddingTop: '10px' } },
        media.map((item, i) => el('button', {
          class: 'ctx-item',
          style: { borderBottom: '1px solid var(--divider)', gap: '8px' },
          title: item.path,
          onclick: () => {
            pick = i;
            if (closeFn) closeFn(i);
            else { $('#modalHost').classList.add('hidden'); loadMedia(media[i]); }
          }
        }, [
          el('span', {
            style: { flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            text: `${i + 1}. ${hasSubdir ? (item.relative || item.name) : item.name}`
          }),
          item.kind === 'audio' ? el('span', { class: 'tag', text: '音频' }) : null,
          item.size ? el('span', { class: 'muted small', text: U.fmtBytes(item.size) }) : null,
          el('span', { class: 'kbd', text: item.subtitlePath ? '✓ 有字幕' : '无字幕' })
        ]))),
      buttons: [{ label: '取消' }],
      render: (_box, api) => {
        closeFn = api.close;
        // 自动化测试：走真实 onclick（等同于用户点击第 N 行）
        if (typeof clickIndex === 'number' && clickIndex >= 0) {
          setTimeout(() => {
            const rows = document.querySelectorAll('#modalHost .ctx-item');
            const row = rows[Math.min(clickIndex, rows.length - 1)];
            if (row) row.click();
            else logSmoke('folder row not found');
          }, 120);
        }
      },
      onClose: async (result) => {
        const idx = (typeof result === 'number' && result >= 0) ? result : pick;
        if (idx < 0 || !media[idx]) return;
        state.mediaIndex = idx;
        try {
          await loadMedia(media[idx]);
          logSmoke(`folder open ok: ${media[idx].name}`);
        } catch (err) {
          window.__pltErrors.push('openFolder/loadMedia: ' + (err && (err.stack || err.message)));
          logSmoke('folder open FAILED: ' + (err && err.message));
          toast('打开失败：' + (err && err.message ? err.message : err), 'err', 8000);
        }
      }
    });
  }

  function logSmoke(msg) {
    window.__pltSmokeLog = window.__pltSmokeLog || [];
    window.__pltSmokeLog.push(msg);
  }

  async function handleDroppedFiles(files) {
    const mediaPaths = [];
    const subPaths = [];
    for (const f of files) {
      let p = '';
      try { p = window.PLT.app.pathForFile(f); } catch (_) { p = f.path || ''; }
      if (!p) continue;
      const ext = extOf(p);
      if (S.MEDIA_EXT.includes(ext)) mediaPaths.push(p);
      else if (S.SUBTITLE_EXT.includes(ext)) subPaths.push(p);
    }
    if (!mediaPaths.length && !subPaths.length) { toast('不支持的文件类型', 'warn'); return; }
    if (mediaPaths.length) {
      await openMediaPaths(mediaPaths);
      state.mediaList = mediaPaths;
    }
    if (subPaths.length) {
      for (const p of subPaths) {
        const res = await window.PLT.file.loadSubtitle(p);
        await applySubtitleResult(res);
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // 分级取词
  // ══════════════════════════════════════════════════════════
  async function onWordClick(word, cue, span) {
    // 单击：面板查询（手动点击忽略级别过滤）；已扫描过的词直接渲染，零成本
    $$('.w.active').forEach((n) => n.classList.remove('active'));
    if (span) span.classList.add('active');
    const cached = transcript.lookupWord(word);
    if (cached && cached.lemma && (cached.translation || cached.enDef)) {
      const entry = {
        word, lemma: cached.lemma, phonetic: cached.phonetic || '', pos: cached.pos || '',
        cefr: cached.cefr, examLevels: cached.examLevels || [], isAcademic: cached.isAcademic,
        isIdiom: cached.isIdiom, rare: cached.rare, translation: cached.translation || '',
        enDef: cached.enDef || '', example: cached.example || '', exampleZh: cached.exampleZh || ''
      };
      dictPanel.currentWord = word;
      dictPanel.render(word, { entry }, cue);
      paintMode();
      return;
    }
    const res = await dictPanel.load(word, cue);
    const result = dictPanel.current;
    if (result) {
      transcript.setWord(word, {
        status: result.translation ? 'hit' : 'queried',
        lemma: result.lemma, cefr: result.cefr, examLevels: result.examLevels,
        phonetic: result.phonetic, pos: result.pos, enDef: result.enDef,
        example: result.example, exampleZh: result.exampleZh,
        isAcademic: result.isAcademic, isIdiom: result.isIdiom, rare: result.rare,
        translation: result.translation, source: result.source
      });
    } else if (res && res.blocked) {
      // 级别锁定拦截：不高亮、不显示释义
      transcript.setWord(word, { status: 'blocked', cefr: res.cefr || '' });
    }
    paintCost();
  }

  async function doLookup(word, cue, force) {
    if (force) { /* 由缓存穿透，主进程会重新请求 */ }
    const res = await lookup.lookupWord(word, cue, {});
    if (res && res.error === 'NO_API_KEY') {
      // 只提示，不自动弹设置窗口 —— 弹窗会盖住整个界面并吞掉所有点击
      statusHint('未配置大模型 API Key：点这里或右上角 ⚙ 打开设置', 'err');
    }
    return res;
  }

  /** 状态灯提示（可点击打开设置），不打断当前操作 */
  function statusHint(text, kind) {
    const dot = $('#apiStatus');
    dot.className = 'status-dot' + (kind ? ' ' + kind : '');
    dot.title = text;
    dot.style.cursor = 'pointer';
    dot.onclick = () => settingsPanel.open('llm');
    if (text) toast(text, kind === 'err' ? 'warn' : 'ok', 6000);
  }

  async function quickAddVocab(word, cue) {
    const info = transcript.lookupWord(word);
    if (!info || (!info.translation && !info.enDef)) {
      const res = await lookup.lookupWord(word, cue, {});
      if (!res || res.error) { toast('查词失败，无法收藏', 'err'); return; }
      await saveVocab({ ...res.entry, word }, cue);
      return;
    }
    await saveVocab({ ...info, word: info.lemma || word }, cue);
  }

  async function saveVocab(entry, cue) {
    const item = {
      word: entry.lemma || entry.word,
      lemma: entry.lemma || entry.word,
      phonetic: entry.phonetic || '',
      pos: entry.pos || '',
      cefr: entry.cefr || '',
      examLevels: entry.examLevels || [],
      isAcademic: !!entry.isAcademic,
      isIdiom: !!entry.isIdiom,
      rare: !!entry.rare,
      translation: entry.translation || '',
      enDef: entry.enDef || '',
      example: entry.example || '',
      exampleZh: entry.exampleZh || '',
      source: cue ? (cue.en || '').slice(0, 120) : (state.media ? state.media.name : ''),
      mediaPath: state.media ? state.media.path : '',
      position: cue ? cue.start : null
    };
    const res = await window.PLT.vocab.add(item);
    await refreshVocabCount();
    paintVocab();
    return res;
  }

  async function refreshVocabCount() {
    const items = await window.PLT.vocab.list();
    $('#vocabCount').textContent = String(items.length);
    return items;
  }

  async function autoScan(opts) {
    const cues = transcript.getCues();
    if (!cues.length) { if (!(opts && opts.silent)) toast('没有字幕可扫描', 'warn'); return; }
    if (!state.settings.lookup.autoScan && !(opts && opts.force)) return;

    // 本地词典模式：不需要 API Key，0 费用、毫秒级；AI 只处理「本地没有 / 需要语境」的少数难词
    const useLocal = state.settings.lookup.localDict !== false;
    const onlyLocal = !!(opts && opts.onlyLocal);
    if (!useLocal && !state.settings.llm.hasApiKey) {
      if (!(opts && opts.silent)) toast('请先在设置里配置大模型 API Key（或打开本地词典）', 'warn');
      return;
    }

    const gen = ++levelWatchGeneration;
    const label = $('#scanLabel');
    label.textContent = '扫描中…';
    $('#btnScanAll').classList.add('on');
    const res = await lookup.scanAll(cues, {
      level: state.settings.lookup.level,
      limit: state.settings.lookup.autoScanLimit,
      onlyLocal
    });
    label.textContent = '扫描难词';
    $('#btnScanAll').classList.remove('on');
    if (gen !== levelWatchGeneration) return;
    if (!res) return;

    transcript.setWords(res.map);
    const hits = [...res.map.values()].filter((v) => v.status === 'hit').length;
    paintCost();

    const s = res.stats || {};
    const lvShort = lookup.levels.find((l) => l.id === state.settings.lookup.level)?.short || '';
    const costInfo = s.usage
      ? ` · AI 分析 ${s.llmWords || 0} 词/${s.usage.total_tokens} tokens（约 ¥${((s.usage.prompt_tokens || 0) * 0.14e-6 + (s.usage.completion_tokens || 0) * 0.28e-6).toFixed(4)}）`
      : ' · 全程本地词典，0 费用';
    const msg = `扫描完成：${s.scannedLines} 行 / ${s.uniqueWords} 个不同单词 → 标出 ${hits} 个「${lvShort}」及以上难词（本地命中 ${s.localHits || 0}）${costInfo}`;

    if (!(opts && opts.silent)) toast(msg, 'ok', 6500);
    else if (hits) toast(`已自动标出 ${hits} 个难词（${lvShort} 及以上）${s.usage ? '' : ' · 本地词典，0 费用'}`, 'ok', 5200);
    if (s.blockedCount) toast(`级别锁定：拦截了 ${s.blockedCount} 个低于级别的词`, 'warn', 4200);

    $('#sbCost').title = [
      `本地词典命中：${s.localHits || 0} 词（免费）`,
      `AI 分析：${s.llmWords || 0} 词`,
      `API 请求：${s.toApi || 0} 次，缓存命中 ${s.fromCache || 0} 词`,
      s.blockedCount ? `级别锁定拦截：${s.blockedCount} 词` : null
    ].filter(Boolean).join('\n');
  }

  function paintCost() {
    const c = lookup.costLabel();
    $('#sbCost').textContent = c.text;
  }

  // ══════════════════════════════════════════════════════════
  // 屏幕取词
  // ══════════════════════════════════════════════════════════
  async function screenLookup() {
    const grab = await window.PLTDict.screenCaptureLookup();
    if (!grab) return;
    if (!grab.dataUrl) { toast('截图失败', 'err'); return; }
    $('#apiStatus').classList.add('busy');
    const ocr = await window.PLTDict.ocrText(grab.dataUrl, { langs: 'en-US,zh-Hans-CN' });
    $('#apiStatus').classList.remove('busy');
    if (!ocr || !ocr.ok) {
      toast(`OCR 失败：${(ocr && (ocr.error || ocr.code)) || '未知错误'}。可在设置 → 高级 里做 OCR 可用性检测。`, 'err', 8000);
      return;
    }
    const text = String(ocr.text || '').trim();
    if (!text) { toast('没有识别到文字，试着框选更小的区域或放大字体后重试', 'warn'); return; }
    await lookupSelectionText(text, { source: 'OCR' });
  }

  async function captureSelectionLookup() {
    const res = await window.PLT.screen.captureSelection();
    if (res.ok && res.text) await lookupSelectionText(res.text, { source: '划词' });
    else toast('没有抓到选中文字。请先在浏览器/PDF 里选中文字再按快捷键，或改用「屏幕取词·截图 OCR」。', 'warn', 6500);
  }

  async function lookupSelection() {
    const sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel) { await lookupSelectionText(sel, { source: '选中文本' }); return; }
    await captureSelectionLookup();
  }

  async function lookupSelectionText(text, opts) {
    const candidates = S.extractCandidates(text);
    if (!candidates.length) { toast('这段文字里没有可查询的英文单词', 'warn'); return; }
    const force = !state.settings.lookup.filterMode || state.settings.lookup.filterMode === 'ai-judge';
    const res = await lookup.lookupText(text, { force });
    paintCost();
    if (res && res.code === 'NO_API_KEY') { toast('请先在设置里配置大模型 API Key', 'warn'); statusHint('未配置大模型 API Key：点这里打开设置', 'err'); return; }
    if (!res || !res.ok) { toast(`查询失败：${(res && res.error) || '未知错误'}`, 'err', 6000); return; }
    const entries = Object.values(res.entries || {});
    const skipped = Object.entries(res.skipped || {});
    U.modal({
      title: `屏幕取词结果 · ${opts && opts.source ? opts.source : ''}`,
      subtitle: `识别文本：${text.slice(0, 90)}${text.length > 90 ? '…' : ''}`,
      body: el('div', { class: 'form' }, [
        entries.length
          ? el('div', { class: 'section-title', text: `达到当前级别（${lookup.levels.find((l) => l.id === state.settings.lookup.level)?.label || ''}）的难词 ${entries.length} 个` })
          : el('div', { class: 'skip-note', text: '这段文字中没有达到所选级别的生词 —— 已为你节省这次翻译费用。' }),
        ...entries.map((e) => el('div', { class: 'q-item' }, [
          el('div', { class: 'q-head' }, [
            el('span', { class: 'q-word', text: e.lemma || e.word }),
            e.phonetic ? el('span', { class: 'q-ph', text: e.phonetic }) : null,
            el('span', { class: 'q-ph', text: e.pos || '' }),
            el('span', { style: { flex: '1' } }),
            el('button', { class: 'icon-btn', title: '朗读', html: '🔊', onclick: () => window.PLTDict.speak(e.lemma || e.word, state.settings.lookup.pronounce) }),
            el('button', { class: 'icon-btn', title: '加入生词本', html: '＋', onclick: async () => { await saveVocab(e, null); toast(`已收藏 ${e.lemma || e.word}`, 'ok'); } })
          ]),
          e.translation ? el('div', { class: 'q-trans', text: e.translation }) : null,
          e.enDef ? el('div', { class: 'q-en', text: e.enDef }) : null,
          e.example ? el('div', { class: 'q-en', html: `<em>${U.escapeHtml(e.example)}</em>` }) : null,
          el('div', { class: 'q-tags' }, U.buildTags(e).map((t) => el('span', { class: `tag ${t.cls}`, text: t.text })))
        ])),
        skipped.length ? el('div', { class: 'section-title', text: `低于级别、已跳过（${skipped.length} 个）` }) : null,
        skipped.length ? el('div', { class: 'q-tags' }, skipped.slice(0, 40).map(([w, info]) => el('span', { class: `tag ${String(info.cefr || 'b1').toLowerCase()}`, text: `${w}${info.cefr ? ' ' + info.cefr : ''}` }))) : null
      ]),
      buttons: [{ label: '好', accent: true }]
    });
  }

  // ══════════════════════════════════════════════════════════
  // 校对 / 保存 / 导出
  // ══════════════════════════════════════════════════════════
  function onEditingChange(on) {
    $('#btnEdit').classList.toggle('on', on);
    $('#editbar').classList.toggle('hidden', !on);
    $('#btnSplitCue').disabled = !on;
    if (on) toast('校对模式：双击任意句子的英文或中文即可修改；也可用工具条拆分/合并/平移时间轴', 'ok', 5200);
  }

  function markDirty() {
    transcript.dirty = true;
    $('#btnSaveSub').classList.add('on');
    $('#sbSubs').textContent = (state.subtitle ? `${state.subtitle.name} · ` : '') + `${transcript.getCues().length} 行 · 有未保存修改`;
  }

  async function saveSubtitle() {
    if (!transcript.getCues().length) { toast('没有字幕可保存', 'warn'); return; }
    if (transcript.editing) transcript.closeEditors();
    const base = state.subtitle ? state.subtitle.name.replace(/\.[^.]+$/, '') : (state.media ? state.media.name.replace(/\.[^.]+$/, '') : 'subtitle');
    const res = await window.PLT.dialog.saveSubtitle({
      cues: transcript.exportCues(),
      defaultName: `${base}.zh-en.srt`
    });
    if (!res) return;
    $('#btnSaveSub').classList.remove('on');
    state.subtitle = { ...(state.subtitle || {}), path: res.path, name: res.path.split(/[\\/]/).pop() };
    toast(`已保存 ${res.count} 行字幕：${res.path}`, 'ok', 5200);
  }

  async function exportNotes() {
    const cues = transcript.getCues();
    const vocabItems = await window.PLT.vocab.list();
    const mediaName = state.media ? state.media.name : '未加载媒体';
    const lines = [];
    lines.push(`# ${mediaName} — 学习笔记`);
    lines.push('');
    lines.push(`生成时间：${new Date().toLocaleString('zh-CN')}`);
    if (state.media) lines.push(`媒体路径：\`${state.media.path}\``);
    lines.push(`取词级别：${lookup.levels.find((l) => l.id === state.settings.lookup.level)?.label || ''}`);
    lines.push(`字幕行数：${cues.length}`);
    lines.push('');
    lines.push('## 生词表');
    lines.push('');
    lines.push('| 单词 | 音标 | 级别 | 考试 | 中文释义 | 原文 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const v of vocabItems) {
      lines.push(`| ${v.word || v.lemma} | ${v.phonetic || ''} | ${v.cefr || ''} | ${(v.examLevels || []).join('/')} | ${(v.translation || '').replace(/\|/g, '\\|')} | ${(v.source || '').replace(/\|/g, '\\|').slice(0, 60)} |`);
    }
    lines.push('');
    lines.push('## 双语字幕');
    lines.push('');
    cues.forEach((c, i) => {
      lines.push(`**[${fmtClock(c.start)}] ${i + 1}**`);
      lines.push('');
      if (c.en) lines.push(c.en);
      if (c.zh) lines.push(`> ${c.zh}`);
      lines.push('');
    });
    const res = await window.PLT.dialog.saveText({
      content: lines.join('\n'),
      defaultName: `${mediaName.replace(/\.[^.]+$/, '')}-notes.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: '纯文本', extensions: ['txt'] }]
    });
    if (res) toast(`学习笔记已导出：${res.path}`, 'ok', 5200);
  }

  async function shiftDialog() {
    const cues = transcript.getCues();
    if (!cues.length) { toast('没有字幕', 'warn'); return; }
    const input = el('input', { type: 'text', value: '0', placeholder: '例如 -0.35 表示整体提前 0.35 秒' });
    const scope = el('select', {}, [
      el('option', { value: 'all', text: `全部 ${cues.length} 行` }),
      el('option', { value: 'selected', text: '仅选中的这一行' })
    ]);
    U.modal({
      title: '时间轴平移',
      subtitle: '用于校正字幕与音频不同步的情况',
      narrow: true,
      body: el('div', { class: 'form', style: { paddingTop: '16px' } }, [
        el('div', { class: 'field' }, [el('label', { text: '偏移量（秒）' }), input]),
        el('div', { class: 'field' }, [el('label', { text: '作用范围' }), scope])
      ]),
      buttons: [
        { label: '取消' },
        {
          label: '应用', accent: true, action: () => {
            const delta = Number(input.value);
            if (!Number.isFinite(delta) || delta === 0) { toast('请输入非零数值', 'warn'); return false; }
            const n = transcript.shiftTimes(delta, scope.value === 'selected' ? transcript.selectedIndex : undefined);
            markDirty();
            toast(`已平移 ${delta > 0 ? '+' : ''}${delta}s（${n} 行）`, 'ok');
          }
        }
      ]
    });
    setTimeout(() => input.focus(), 80);
  }

  // ══════════════════════════════════════════════════════════
  // 生词本 / 历史 / 闪卡
  // ══════════════════════════════════════════════════════════
  async function paintVocab() {
    const q = $('#vocabSearch').value.trim().toLowerCase();
    let items = await window.PLT.vocab.list();
    if (q) {
      items = items.filter((it) => [it.word, it.lemma, it.translation, it.enDef].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    const sort = $('#vocabSort').value;
    if (sort === 'alpha') items = [...items].sort((a, b) => String(a.word || a.lemma).localeCompare(String(b.word || b.lemma)));
    else if (sort === 'level') items = [...items].sort((a, b) => String(b.cefr || '').localeCompare(String(a.cefr || '')));
    window.PLTTranscript.renderVocabList($('#vocabList'), items, {
      onSpeak: (it) => window.PLTDict.speak(it.word || it.lemma, state.settings.lookup.pronounce),
      onRemove: async (it) => { await window.PLT.vocab.remove(it.id); await refreshVocabCount(); paintVocab(); },
      onLocate: (it) => {
        if (it.mediaPath && state.media && it.mediaPath === state.media.path && it.position !== null && it.position !== undefined) {
          player.seek(it.position, { play: true });
          const idx = S.indexAt(transcript.getCues(), it.position);
          if (idx >= 0) seekCue(idx, {});
        } else {
          toast(it.mediaPath ? `该词来自：${it.mediaPath}` : '没有可跳转的位置', 'warn');
        }
      }
    });
  }

  async function loadHistory() {
    const items = await window.PLT.history.list();
    window.PLTTranscript.renderHistoryList($('#historyList'), items, {
      onOpen: async (it) => {
        await openMediaPaths([it.path]);
        if (it.position) setTimeout(() => player.seek(it.position), 700);
      }
    });
  }

  async function startFlashcards() {
    const items = await window.PLT.vocab.list();
    if (!items.length) { toast('生词本还是空的', 'warn'); return; }
    switchTab('vocab');
    window.PLTTranscript.flashcard($('#vocabList'), items, () => paintVocab());
  }

  function switchTab(tab) {
    for (const t of $$('.ph-tab')) t.classList.toggle('active', t.dataset.tab === tab);
    $('#transcript').classList.toggle('hidden', tab !== 'transcript');
    $('#vocabView').classList.toggle('hidden', tab !== 'vocab');
    $('#historyView').classList.toggle('hidden', tab !== 'history');
    $('#editbar').classList.toggle('hidden', tab !== 'transcript' || !transcript.editing);
    if (tab === 'vocab') paintVocab();
    if (tab === 'history') loadHistory();
  }

  // ══════════════════════════════════════════════════════════
  // 快捷键
  // ══════════════════════════════════════════════════════════
  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (isTyping(e)) {
        if (e.key === 'Escape' && transcript.editing) { transcript.setEditing(false); }
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key;

      if (ctrl && key === ',') { e.preventDefault(); settingsPanel.open(); return; }
      if (ctrl && key.toLowerCase() === 'o' && e.shiftKey) { e.preventDefault(); openSubtitleDialog(); return; }
      if (ctrl && key.toLowerCase() === 'o') { e.preventDefault(); openMediaDialog(); return; }
      if (ctrl && key.toLowerCase() === 's') { e.preventDefault(); saveSubtitle(); return; }
      if (ctrl && key.toLowerCase() === 'r') { e.preventDefault(); replayCue(transcript.currentIndex); return; }
      if (ctrl && key.toLowerCase() === 'h') { e.preventDefault(); toggleSubtitleOverlay(); return; }
      if (ctrl && key.toLowerCase() === 'd' && e.shiftKey) { e.preventDefault(); screenLookup(); return; }
      if (ctrl && key.toLowerCase() === 'd') { e.preventDefault(); lookupSelection(); return; }
      if (ctrl && key.toLowerCase() === 'e') { e.preventDefault(); exportNotes(); return; }
      if (ctrl && key === '[') { e.preventDefault(); player.stepRate(-1); return; }
      if (ctrl && key === ']') { e.preventDefault(); player.stepRate(1); return; }
      if (ctrl && (key === '=' || key === '+')) { e.preventDefault(); zoom(0.1); return; }
      if (ctrl && key === '-') { e.preventDefault(); zoom(-0.1); return; }
      if (ctrl && key === '0') { e.preventDefault(); zoom(0); return; }
      if (ctrl && key === 'ArrowLeft') { e.preventDefault(); goPrevLine(); return; }
      if (ctrl && key === 'ArrowRight') { e.preventDefault(); goNextLine(); return; }

      switch (key) {
        case ' ':
          e.preventDefault();
          player.toggle();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          player.nudge(e.shiftKey ? -10 : -5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          player.nudge(e.shiftKey ? 10 : 5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          goPrevLine();
          break;
        case 'ArrowDown':
          e.preventDefault();
          goNextLine();
          break;
        case 'Enter': {
          const i = transcript.selectedIndex >= 0 ? transcript.selectedIndex : transcript.currentIndex;
          if (i >= 0) { e.preventDefault(); seekCue(i, { play: true }); }
          break;
        }
        case 'f': case 'F':
          player.toggleFullscreen($('#stage'));
          break;
        case 'l': case 'L':
          loopCue(transcript.currentIndex);
          break;
        case 'a': case 'A':
          $('#trAB').click();
          break;
        case 'e': case 'E':
          transcript.setEditing(!transcript.editing);
          onEditingChange(transcript.editing);
          break;
        case 's': case 'S':
          shadow.toggle();
          break;
        case 'r': case 'R':
          replayCue(transcript.currentIndex);
          break;
        case 'n': case 'N':
          switchTab('vocab');
          break;
        case 'Escape':
          if (!$('#dictPanel').classList.contains('hidden')) dictPanel.hide();
          else if (transcript.editing) transcript.setEditing(false);
          break;
        default:
          break;
      }
    });
  }

  // ══════════════════════════════════════════════════════════
  // 主进程事件桥
  // ══════════════════════════════════════════════════════════
  function bindBridgeEvents() {
    window.PLT.settings.onChanged((s) => {
      state.settings = s;
      applySettings(s);
    });
    window.PLT.theme.onChanged((t) => { document.body.dataset.theme = t.dark ? 'dark' : 'light'; });
    window.PLT.win.onState(() => { });
  }

  function handleMenuAction(action) {
    const map = {
      'open-media': () => openMediaDialog(),
      'open-subtitle': () => openSubtitleDialog(),
      'open-folder': () => openFolderDialog(),
      'save-subtitle': () => saveSubtitle(),
      'export-notes': () => exportNotes(),
      'toggle-play': () => player.toggle(),
      'prev-line': () => goPrevLine(),
      'next-line': () => goNextLine(),
      'replay-line': () => replayCue(transcript.currentIndex),
      'speed-down': () => player.stepRate(-1),
      'speed-up': () => player.stepRate(1),
      'toggle-subtitle': () => toggleSubtitleOverlay(),
      'lookup-selection': () => lookupSelection(),
      'screen-ocr': () => screenLookup(),
      'scan-all': () => autoScan({ silent: false, force: true }),
      'show-vocab': () => switchTab('vocab'),
      'zoom-in': () => zoom(0.1),
      'zoom-out': () => zoom(-0.1),
      'zoom-reset': () => zoom(0),
      'theme-system': () => setTheme('system'),
      'theme-light': () => setTheme('light'),
      'theme-dark': () => setTheme('dark'),
      about: () => about()
    };
    const fn = map[action];
    if (fn) fn();
  }

  document.addEventListener('DOMContentLoaded', () => {
    boot()
      .then(async () => {
        booted = true;
        // 供诊断/自动化调用
        window.__pltOpenFile = (p) => (S.MEDIA_EXT.includes(extOf(p)) ? openMediaPaths([p]) : openSubtitlePaths([p]));
        // 处理在 boot 期间到达的“打开文件”请求
        const pending = window.__pltPendingFiles;
        if (pending && pending.length) {
          window.__pltPendingFiles = [];
          if (openFilesHandler) openFilesHandler(pending);
        }
        // 握手：渲染进程就绪，主进程此时才投递启动参数里的文件
        await window.PLT.app.ready().catch(() => { });
      })
      .catch((err) => {
        window.__pltErrors.push('boot: ' + (err && (err.stack || err.message)));
        console.error(err);
        toast('启动失败：' + err.message, 'err', 9000);
      });
  });
}());

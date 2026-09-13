'use strict';
/**
 * ui-probe.js — 真实 UI 交互回归探测（--smoke-test --smoke-ui）
 * 派发真实事件（click / pointerdown→move→up）并断言 DOM 与播放器状态。
 * 覆盖：播放图标切换、进度条拖动、点字幕跳转、字幕选择入口。
 */
function install(ctx) {
  const { js, log } = ctx;

  const run = async (name, code) => {
    const res = await js(code).catch((e) => ({ __execError: e.message }));
    log(`【${name}】` + JSON.stringify(res));
    return res;
  };

  const probe = async () => {
    const out = {};

    // 先在应用层记录诊断：暴露 seek 的实际入参
    await js(`(() => {
      window.__pltProbe = { seekCalls: [], clickCalls: [], dragCalls: [] };
      return true;
    })()`);

    // ───────── 0. 未加载媒体时播放类控件应不可用 ─────────
    out['0a 无媒体时播放键禁用'] = await run('0a', `(async () => {
      const off = window.__pltSmoke.playbackControlsState(true);
      const btn = document.getElementById('btnPlay');
      const disabledTitle = btn.getAttribute('title');
      btn.click();                                  // 禁用状态下点击应无任何效果
      await new Promise((r) => setTimeout(r, 400));
      const afterClickPaused = document.getElementById('video').paused;
      const restored = await window.__pltSmoke.restoreMedia();
      await new Promise((r) => setTimeout(r, 1500));
      const live = window.__pltSmoke.playbackControlsState(false);
      return {
        allDisabled: off.states.every((s) => s.disabled === true),
        disabledTitle,
        afterClickPaused,
        restored,
        liveAllEnabled: live.states.every((s) => s.disabled === false),
        live
      };
    })()`);

    // ───────── 1. 播放 / 暂停图标切换 ─────────
    // 先归零状态：暂停 + 回到开头
    await js(`(async () => {
      const v = document.getElementById('video');
      v.pause();
      v.currentTime = 0;
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);

    // 播放/暂停图标状态（用 visibility 切换，检查真实可见的图形）
    const iconState = `(() => {
      const vis = (el) => {
        if (!el) return false;
        const s = getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden';
      };
      const btn = document.getElementById('btnPlay');
      return {
        bodyPlaying: document.body.classList.contains('is-playing'),
        playVisible: vis(btn && btn.querySelector('.ic-play')),
        pauseVisible: vis(btn && btn.querySelector('.ic-pause')),
        trPauseVisible: vis(document.querySelector('#trPlay .ic-pause')),
        miniPauseVisible: vis(document.querySelector('#miniPlay .ic-pause')),
        playingClass: document.getElementById('stage').classList.contains('playing')
      };
    })()`;

    out['1a 初始（应为三角 + paused）'] = await run('1a', `${iconState.replace('})()', '})()')}`);
    out['1a'] = out['1a 初始（应为三角 + paused）'];
    out['1a 初始'] = { ...out['1a'], paused: await js(`document.getElementById('video').paused`) };

    out['1a2 按钮可点击性'] = await run('1a2', `(() => {
      const btn = document.getElementById('btnPlay');
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const stack = document.elementsFromPoint(cx, cy).map((n) => n.tagName + (n.id ? '#' + n.id : '') + '.' + (typeof n.className === 'string' ? n.className : ''));
      const host = document.getElementById('modalHost');
      const hs = getComputedStyle(host);
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        elementStack: stack.slice(0, 6),
        overlayStack: stack.filter((s) => s.startsWith('DIV.modal')),
        modalHost: {
          classes: host.className,
          childCount: host.childElementCount,
          display: hs.display,
          pointerEvents: hs.pointerEvents,
          zIndex: hs.zIndex,
          inlineStyle: host.getAttribute('style') || '',
          firstChildClass: host.firstElementChild ? host.firstElementChild.className : null,
          title: (host.querySelector('.modal-title') || {}).textContent || null,
          buttons: Array.from(host.querySelectorAll('.modal-foot button')).map((b) => b.textContent)
        },
        otherOverlays: Array.from(document.querySelectorAll('.modal-host, .ocr-overlay, .shadow-panel, .context-menu, .dict-panel'))
          .map((n) => ({ id: n.id, cls: n.className, display: getComputedStyle(n).display, count: n.childElementCount }))
      };
    })()`);

    // 用真实鼠标坐标点击（模拟用户一次点击：只派发一个 click，不做 pointer 组合）
    out['1b 真实坐标点击播放按钮'] = await run('1b', `(async () => {
      const btn = document.getElementById('btnPlay');
      const r = btn.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const target = document.elementFromPoint(cx, cy);
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, detail: 1, button: 0 }));
      await new Promise((r2) => setTimeout(r2, 1200));
      const v = document.getElementById('video');
      const st = ${iconState};
      return {
        target: target.tagName + '.' + (typeof target.className === 'string' ? target.className : ''),
        ...st,
        paused: v.paused, currentTime: v.currentTime
      };
    })()`);

    out['1c 再点一次（应回到三角 + paused）'] = await run('1c', `(async () => {
      document.getElementById('btnPlay').click();
      await new Promise((r) => setTimeout(r, 900));
      const st = ${iconState};
      return { ...st, paused: document.getElementById('video').paused };
    })()`);

    // 图标几何：检查三角与竖条是否真正居中、且切换时不跳动
    const geom = `(async () => {
      const btn = document.getElementById('btnPlay');
      const v = document.getElementById('video');
      const snap = () => {
        const btnRect = btn.getBoundingClientRect();
        const r = (sel) => {
          const el = btn.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { w: +b.width.toFixed(2), h: +b.height.toFixed(2), cx: +(b.left + b.width / 2).toFixed(2), cy: +(b.top + b.height / 2).toFixed(2) };
        };
        return {
          btn: { w: +btnRect.width.toFixed(2), h: +btnRect.height.toFixed(2), cx: +(btnRect.left + btnRect.width / 2).toFixed(2), cy: +(btnRect.top + btnRect.height / 2).toFixed(2) },
          play: r('.ic-play'),
          pause: r('.ic-pause'),
          playing: document.body.classList.contains('is-playing')
        };
      };
      const out = {};
      out.playing = snap();
      v.pause(); await new Promise((res) => setTimeout(res, 500));
      out.paused = snap();
      // 也看看传输栏那个播放按钮
      const tr = document.getElementById('trPlay');
      const trRect = tr.getBoundingClientRect();
      const trIcon = tr.querySelector('.ic-play').getBoundingClientRect();
      out.transport = {
        btnCy: +(trRect.top + trRect.height / 2).toFixed(2),
        iconCy: +(trIcon.top + trIcon.height / 2).toFixed(2),
        diff: +((trIcon.top + trIcon.height / 2) - (trRect.top + trRect.height / 2)).toFixed(2)
      };
      v.play().catch(() => {});
      return out;
    })()`;

    out['1e 播放图标几何'] = await run('1e', geom);
    out['1e'] = out['1e 播放图标几何'];
    out['1e 几何判定'] = await run('1e-geo', `(() => {
      const g = window.__pltLastGeom || null;
      return g;
    })()`);
    const geo = out['1e 播放图标几何'];
    if (geo && geo.playing && geo.paused) {
      out['1e 判定'] = {
        playCy_playing: geo.playing.play.cy,
        playCy_paused: geo.paused.play.cy,
        pauseCy_playing: geo.playing.pause.cy,
        pauseCy_paused: geo.paused.pause.cy,
        btnCy: geo.playing.btn.cy,
        jumpWhenToggling: +(geo.paused.play.cy - geo.playing.play.cy).toFixed(2),
        playOffCenterY: +(geo.playing.play.cy - geo.playing.btn.cy).toFixed(2),
        pauseOffCenterY: +(geo.playing.pause.cy - geo.playing.btn.cy).toFixed(2),
        playOffCenterX: +(geo.playing.play.cx - geo.playing.btn.cx).toFixed(2),
        pauseOffCenterX: +(geo.playing.pause.cx - geo.playing.btn.cx).toFixed(2),
        transportDiff: geo.transport ? geo.transport.diff : null
      };
    }

    // ───────── 2. 进度条拖动 ─────────
    out['2a 进度条几何'] = await run('2a', `(() => {
      const bar = document.getElementById('seekbar');
      const track = bar.querySelector('.seek-track');
      const rb = bar.getBoundingClientRect();
      const rt = track.getBoundingClientRect();
      return { barRect: { x: rb.x, y: rb.y, w: rb.width, h: rb.height },
               trackRect: { x: rt.x, y: rt.y, w: rt.width, h: rt.height },
               hasPointerCapture: typeof bar.setPointerCapture, duration: document.getElementById('video').duration };
    })()`);

    out['2b 拖动到 50%'] = await run('2b', `(async () => {
      const bar = document.getElementById('seekbar');
      const r = bar.getBoundingClientRect();
      const y = r.top + r.height / 2;
      const targetX = r.left + r.width * 0.5;
      const mk = (x, type) => new PointerEvent(type, { bubbles: true, cancelable: true, composed: true,
        clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1, button: 0 });
      const v = document.getElementById('video');
      const t0 = v.currentTime;
      bar.dispatchEvent(mk(r.left + 2, 'pointerdown'));
      await new Promise((res) => setTimeout(res, 90));
      const tDown = v.currentTime;
      bar.dispatchEvent(mk(targetX, 'pointermove'));
      await new Promise((res) => setTimeout(res, 90));
      const tMove = v.currentTime;
      bar.dispatchEvent(mk(targetX, 'pointerup'));
      await new Promise((res) => setTimeout(res, 250));
      return { t0, tDown, tMove, tUp: v.currentTime, duration: v.duration,
               expectAt50: (v.duration || 0) * 0.5, targetX, barLeft: r.left, barWidth: r.width,
               dragLog: window.__pltProbe.dragCalls };
    })()`);

    // 直接验证：用鼠标点进度条 75% 位置
    out['2c 直接点击 75% 处'] = await run('2c', `(async () => {
      const bar = document.getElementById('seekbar');
      const r = bar.getBoundingClientRect();
      const x = r.left + r.width * 0.75;
      const y = r.top + r.height / 2;
      bar.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 2, pointerType: 'mouse', isPrimary: true, buttons: 1, button: 0 }));
      await new Promise((res) => setTimeout(res, 300));
      const v = document.getElementById('video');
      return { time: v.currentTime, duration: v.duration, ratio: v.duration ? v.currentTime / v.duration : 0 };
    })()`);

    // ───────── 3. 点击字幕跳转 ─────────
    out['3a 点最后一行（应跳到 ~57s，保持暂停/不回到开头）'] = await run('3a', `(async () => {
      const v = document.getElementById('video');
      v.pause();
      v.currentTime = 1;
      await new Promise((r) => setTimeout(r, 500));
      const cues = document.querySelectorAll('#transcript .cue');
      const target = cues[cues.length - 1];
      const before = v.currentTime;
      target.click();
      await new Promise((r) => setTimeout(r, 900));
      return {
        clickedIndex: Number(target.dataset.index),
        before, after: v.currentTime,
        paused: v.paused,
        sbLine: document.getElementById('sbLine').textContent,
        currentCue: (document.querySelector('#transcript .cue.current') || {}).dataset
          ? Number(document.querySelector('#transcript .cue.current').dataset.index) : null,
        cueStarts: [cues[0].querySelector('.cue-time').textContent, target.querySelector('.cue-time').textContent],
        seekCalls: window.__pltProbe.seekCalls.slice(-6)
      };
    })()`);

    out['3b 点第 12 行'] = await run('3b', `(async () => {
      const v = document.getElementById('video');
      const cues = document.querySelectorAll('#transcript .cue');
      cues[11].click();
      await new Promise((r) => setTimeout(r, 800));
      return { after: v.currentTime, paused: v.paused,
        current: (document.querySelector('#transcript .cue.current') || { dataset: {} }).dataset.index,
        seekCalls: window.__pltProbe.seekCalls.slice(-4) };
    })()`);

    out['3c 用真实鼠标坐标双击一行（应重播该句）'] = await run('3c', `(async () => {
      const v = document.getElementById('video');
      const cues = document.querySelectorAll('#transcript .cue');
      const target = cues[20];
      const r = target.getBoundingClientRect();
      const x = r.left + 40, y = r.top + 10;
      const mk = (type, detail) => new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, detail, button: 0 });
      target.dispatchEvent(mk('click', 1));
      await new Promise((res) => setTimeout(res, 700));
      const afterSingle = v.currentTime;
      target.dispatchEvent(mk('click', 2));
      target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, clientX: x, clientY: y, detail: 2 }));
      await new Promise((res) => setTimeout(res, 700));
      return { afterSingle, afterDouble: v.currentTime, paused: v.paused,
        seekCalls: window.__pltProbe.seekCalls.slice(-6) };
    })()`);

    // ───────── 4. 字幕选择菜单 ─────────
    out['4a 字幕按钮与菜单'] = await run('4a', `(async () => {
      const btn = document.getElementById('btnOpenSub');
      const labelBefore = document.getElementById('subLabel').textContent;
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
      await new Promise((res) => setTimeout(res, 700));
      const menu = document.getElementById('contextMenu');
      const items = Array.from(menu.querySelectorAll('.ctx-item')).map((b) => b.textContent.trim());
      return {
        labelBefore,
        title: btn.getAttribute('title'),
        menuVisible: !menu.classList.contains('hidden'),
        items
      };
    })()`);

    // 点菜单里第一份字幕 → 应加载并更新按钮标签
    out['4b 菜单里选择一份字幕'] = await run('4b', `(async () => {
      const menu = document.getElementById('contextMenu');
      const items = Array.from(menu.querySelectorAll('.ctx-item'));
      const target = items.find((b) => /\\.(srt|vtt|ass|lrc|json)/i.test(b.textContent));
      if (!target) return { error: '菜单里没有可选字幕文件', items: items.map((b) => b.textContent.trim()) };
      const pickName = target.textContent.trim();
      target.click();
      await new Promise((res) => setTimeout(res, 1500));
      return {
        picked: pickName,
        subLabel: document.getElementById('subLabel').textContent,
        sbSubs: document.getElementById('sbSubs').textContent,
        cues: window.__pltSmoke.state().cues,
        overlay: document.getElementById('overlayEn').textContent.slice(0, 30)
      };
    })()`);

    // 关闭字幕显示
    out['4c 关闭字幕显示'] = await run('4c', `(async () => {
      const btn = document.getElementById('btnOpenSub');
      const r = btn.getBoundingClientRect();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
      await new Promise((res) => setTimeout(res, 600));
      const menu = document.getElementById('contextMenu');
      const off = Array.from(menu.querySelectorAll('.ctx-item')).find((b) => /关闭字幕/.test(b.textContent));
      if (!off) return { error: '没有「关闭字幕显示」项', items: Array.from(menu.querySelectorAll('.ctx-item')).map((b) => b.textContent.trim()) };
      off.click();
      await new Promise((res) => setTimeout(res, 600));
      const hidden = document.getElementById('subtitleOverlay').classList.contains('hidden-sub');
      // 再打开菜单确认出现「恢复字幕显示」
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 20, clientY: r.top + 10 }));
      await new Promise((res) => setTimeout(res, 500));
      const items2 = Array.from(document.getElementById('contextMenu').querySelectorAll('.ctx-item')).map((b) => b.textContent.trim());
      document.body.click();
      return { overlayHidden: hidden, hasRestoreItem: items2.some((t) => /恢复字幕显示/.test(t)), items2 };
    })()`);

    // ───────── 5. 真实查词（需要已配置 API Key）─────────
    out['5a 点击单词 → 词典面板'] = await run('5a', `(async () => {
      const spans = document.querySelectorAll('#transcript .w');
      const target = [...spans].find((s) => s.dataset.lower === 'squander') || spans[spans.length - 1];
      target.click();
      await new Promise((r) => setTimeout(r, 4000));
      const panel = document.getElementById('dictPanel');
      return {
        clicked: target.dataset.lower,
        panelVisible: !panel.classList.contains('hidden'),
        word: document.getElementById('dictWord').textContent,
        phonetic: document.getElementById('dictPhonetic').textContent,
        tags: [...document.querySelectorAll('#dictTags .tag')].map((t) => t.textContent),
        body: document.getElementById('dictBody').textContent.replace(/\\s+/g, ' ').slice(0, 240),
        cost: document.getElementById('sbCost').textContent
      };
    })()`);

    out['5b 扫描全文难词'] = await run('5b', `(async () => {
      const before = window.__pltSmoke.costStats();
      const scan = await window.__pltSmoke.scanNow();
      const after = window.__pltSmoke.costStats();
      const spans = [...document.querySelectorAll('#transcript .w')];
      return {
        // 规格：正文里不插中文、不加底色；只维护「可取词 / 被锁定」两种状态
        inlineChineseNodes: document.querySelectorAll('#transcript .wz').length,
        // 允许唯一的 .w.active（当前正在查的那个词）；其余单词不得有任何底色
        coloredWords: spans.filter((s) => !s.classList.contains('active')
          && getComputedStyle(s).backgroundColor !== 'rgba(0, 0, 0, 0)').length,
        lockedWords: spans.filter((s) => s.classList.contains('locked')).length,
        totalWords: spans.length,
        cost: document.getElementById('sbCost').textContent,
        apiCallsDelta: after.calls - before.calls,
        tokensDelta: after.totalTokens - before.totalTokens,
        scanLabel: document.getElementById('scanLabel').textContent,
        scan
      };
    })()`);

    out['5c 词典面板（真实请求）'] = await run('5c', `(async () => {
      const spans = document.querySelectorAll('#transcript .w');
      const target = [...spans].find((s) => s.dataset.lower === 'unprecedented') || spans[0];
      if (!target) return { error: '没有可点击的单词' };
      const before = window.__pltSmoke.costStats();
      target.click();
      await new Promise((r) => setTimeout(r, 5000));
      const after = window.__pltSmoke.costStats();
      return {
        clicked: target.dataset.lower,
        word: document.getElementById('dictWord').textContent,
        phonetic: document.getElementById('dictPhonetic').textContent,
        tags: [...document.querySelectorAll('#dictTags .tag')].map((t) => t.textContent),
        body: document.getElementById('dictBody').textContent.replace(/\\s+/g, ' ').slice(0, 200),
        apiCallsDelta: after.calls - before.calls,
        tokensDelta: after.totalTokens - before.totalTokens,
        cost: document.getElementById('sbCost').textContent
      };
    })()`);

    out['5d 计费链路诊断'] = await run('5d', `(() => ({
      trackLog: window.__pltProbe.trackLog || [],
      stats: window.__pltSmoke.costStats(),
      sbCostText: document.getElementById('sbCost').textContent
    }))()`);

    // 词典标题区的排版诊断（用户反馈“单词显示块有问题”）
    out['5e 词典标题排版'] = await run('5e', `(() => {
      const wordEl = document.getElementById('dictWord');
      const wrap = document.querySelector('.dict-word-wrap');
      const cs = getComputedStyle(wordEl);
      const r = wordEl.getBoundingClientRect();
      return {
        text: wordEl.textContent,
        childNodes: [...wordEl.childNodes].map((n) => (n.nodeType === 3 ? 'text:' + n.textContent : n.nodeName + ':' + n.textContent)),
        fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing, lineHeight: cs.lineHeight,
        rect: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        wrapDisplay: getComputedStyle(wrap).display,
        wrapFlexWrap: getComputedStyle(wrap).flexWrap,
        inlineWordCount: document.querySelectorAll('#dictWord span').length
      };
    })()`);

    // 单词渲染诊断：是否出现了嵌套/重复的单词节点
    out['5f 单词节点结构'] = await run('5f', `(() => {
      const cues = [...document.querySelectorAll('#transcript .cue')];
      const target = cues[0];
      const en = target.querySelector('.cue-en');
      const spans = [...en.querySelectorAll('.w')];
      const nested = spans.filter((s) => s.querySelector('.w')).length;
      const wz = [...en.querySelectorAll('.wz')];
      return {
        cueHtml: en.innerHTML.slice(0, 420),
        spanCount: spans.length,
        nestedSpanCount: nested,
        wzCount: wz.length,
        firstSpan: spans[0] ? { text: spans[0].textContent, cls: spans[0].className, bg: getComputedStyle(spans[0]).backgroundColor } : null,
        hitCount: spans.filter((s) => s.classList.contains('hit')).length,
        layerCount: en.querySelectorAll('.w > .w').length
      };
    })()`);

    // ───────── 6. 级别锁定（低于所选级别的词呈现为不可点击）─────────
    out['6a 切到 B2 + 锁定'] = await run('6a', `(async () => {
      // 选 B2 级别（大量常用词会低于它），再打开锁定
      const sel = document.getElementById('levelSelect');
      const before = { locked: document.getElementById('btnLockLevel').classList.contains('locked') };
      sel.value = 'b2';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      document.getElementById('btnLockLevel').click();
      await new Promise((r) => setTimeout(r, 1200));
      const s = await window.PLT.settings.get();
      return {
        before,
        level: s.lookup.level,
        lockLevel: s.lookup.lockLevel,
        btnLocked: document.getElementById('btnLockLevel').classList.contains('locked'),
        ariaPressed: document.getElementById('btnLockLevel').getAttribute('aria-pressed')
      };
    })()`);

    // 锁定时：低于级别的词应**预先**呈现为不可点击（无需先点一次）
    out['6b0 锁定后扫描原始返回'] = await run('6b0', `(async () => {
      const cues = window.__pltSmoke.cues.map((c) => ({ start: c.start, end: c.end, en: c.en, zh: c.zh, text: c.text }));
      const res = await window.PLT.llm.scanTranscript(cues, { level: 'b2', limit: 400 });
      const keys = (o) => Object.keys(o || {}).length;
      return {
        ok: res.ok,
        error: res.error,
        code: res.code,
        scannedLines: res.scannedLines,
        uniqueWords: res.uniqueWords,
        entries: keys(res.entries),
        below: keys(res.below),
        blocked: keys(res.blocked),
        skipped: keys(res.skipped),
        localHits: res.localHits,
        llmWords: res.llmWords,
        blockedCount: res.blockedCount,
        sampleBelow: Object.entries(res.below || {}).slice(0, 4),
        sampleEntries: Object.keys(res.entries || {}).slice(0, 6)
      };
    })()`);

    out['6b 低级别词呈禁用态'] = await run('6b', `(async () => {
      const before = window.__pltSmoke.costStats();
      const scan = await window.__pltSmoke.scanNow();
      const spans = [...document.querySelectorAll('#transcript .w')];
      const locked = spans.filter((s) => s.classList.contains('locked'));
      const sample = locked.slice(0, 8).map((s) => ({
        w: s.dataset.lower, cefr: s.dataset.cefr,
        cursor: getComputedStyle(s).cursor,
        struck: getComputedStyle(s).textDecorationLine.includes('line-through'),
        color: getComputedStyle(s).color,
        hasTitle: !!s.title
      }));
      const normal = spans.filter((s) => !s.classList.contains('locked'));
      return {
        totalWords: spans.length,
        lockedCount: locked.length,
        hitCount: spans.filter((s) => s.classList.contains('hit')).length,
        sample,
        // 规格：锁定词只改光标，不改颜色、不加删除线、不加提示
        allNotAllowed: sample.length > 0 && sample.every((s) => s.cursor === 'not-allowed'),
        noneStruck: sample.every((s) => s.struck === false),
        noneHasTitle: sample.every((s) => s.hasTitle === false),
        colorUnchanged: sample.length > 0 && normal.length > 0 && sample[0].color === getComputedStyle(normal[0]).color,
        scan,
        diag: window.__pltSmoke.lockDiag()
      };
    })()`);

    // 点击锁定词：应无面板、无请求、无提示
    out['6b2 点锁定词无反应'] = await run('6b2', `(async () => {
      const before = window.__pltSmoke.costStats();
      document.getElementById('dictPanel').classList.add('hidden');
      document.getElementById('paneBody').classList.remove('dict-open');
      const target = [...document.querySelectorAll('#transcript .w.locked')][0];
      if (!target) return { error: '没有锁定词可点' };
      target.click();
      await new Promise((r) => setTimeout(r, 1500));
      const after = window.__pltSmoke.costStats();
      return {
        clicked: target.dataset.lower,
        cefr: target.dataset.cefr,
        panelVisible: !document.getElementById('dictPanel').classList.contains('hidden'),
        apiCallsDelta: after.calls - before.calls,
        toastCount: document.querySelectorAll('#toastHost .toast').length
      };
    })()`);

    // 解锁 + 恢复级别，确认词重新可点
    out['6c 解锁后恢复可点'] = await run('6c', `(async () => {
      document.getElementById('btnLockLevel').click();
      await new Promise((r) => setTimeout(r, 1200));
      const spans = [...document.querySelectorAll('#transcript .w')];
      const locked = spans.filter((s) => s.classList.contains('locked')).length;
      const sel = document.getElementById('levelSelect');
      sel.value = 'toefl';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 1200));
      const s = await window.PLT.settings.get();
      return { level: s.lookup.level, lockLevel: s.lookup.lockLevel, lockedWordsAfterUnlock: locked };
    })()`);

    return out;
  };

  return { probe };
}

module.exports = { install };

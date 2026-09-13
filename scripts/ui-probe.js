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

    // ───────── 1. 播放 / 暂停图标切换 ─────────
    // 先归零状态：暂停 + 回到开头
    await js(`(async () => {
      const v = document.getElementById('video');
      v.pause();
      v.currentTime = 0;
      await new Promise((r) => setTimeout(r, 700));
      return true;
    })()`);

    out['1a 初始（应为播放图标 + paused）'] = await run('1a', `(() => ({
      icon: document.getElementById('playIcon').getAttribute('d'),
      paused: document.getElementById('video').paused,
      trIcon: document.getElementById('trPlayIcon').getAttribute('d'),
      miniIcon: document.getElementById('miniPlayIcon').getAttribute('d'),
      playingClass: document.getElementById('stage').classList.contains('playing')
    }))()`);

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
      return {
        target: target.tagName + '.' + (typeof target.className === 'string' ? target.className : ''),
        icon: document.getElementById('playIcon').getAttribute('d'),
        trIcon: document.getElementById('trPlayIcon').getAttribute('d'),
        miniIcon: document.getElementById('miniPlayIcon').getAttribute('d'),
        paused: v.paused, currentTime: v.currentTime,
        playingClass: document.getElementById('stage').classList.contains('playing'),
        playCalls: window.__pltProbe.playCalls || []
      };
    })()`);

    out['1c 再点一次（应回到播放图标 + paused）'] = await run('1c', `(async () => {
      document.getElementById('btnPlay').click();
      await new Promise((r) => setTimeout(r, 900));
      return { icon: document.getElementById('playIcon').getAttribute('d'),
               paused: document.getElementById('video').paused,
               playingClass: document.getElementById('stage').classList.contains('playing'),
               playCalls: (window.__pltProbe.playCalls || []).slice(-2) };
    })()`);

    out['1d 三个播放按钮图标是否一致'] = await run('1d', `(() => {
      const d = (id) => document.getElementById(id).getAttribute('d');
      return { playIcon: d('playIcon'), trPlayIcon: d('trPlayIcon'), miniPlayIcon: d('miniPlayIcon'), allEqual: d('playIcon') === d('trPlayIcon') && d('playIcon') === d('miniPlayIcon') };
    })()`);

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
      document.getElementById('btnScanAll').click();
      await new Promise((r) => setTimeout(r, 18000));
      const after = window.__pltSmoke.costStats();
      return {
        hits: document.querySelectorAll('#transcript .w.hit').length,
        inlineTranslations: [...document.querySelectorAll('#transcript .w.hit .wz')].slice(0, 10).map((n) => n.textContent),
        cost: document.getElementById('sbCost').textContent,
        apiCallsDelta: after.calls - before.calls,
        tokensDelta: after.totalTokens - before.totalTokens,
        cachedDelta: after.cachedHits - before.cachedHits,
        skippedDelta: after.skipped - before.skipped,
        scanLabel: document.getElementById('scanLabel').textContent,
        costTitle: document.getElementById('sbCost').title
      };
    })()`);

    out['5c 词典面板（真实请求）'] = await run('5c', `(async () => {
      const spans = document.querySelectorAll('#transcript .w.hit');
      const target = [...document.querySelectorAll('#transcript .w')].find((s) => s.dataset.lower === 'unprecedented') || spans[0];
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
      sbCostText: document.getElementById('sbCost').textContent,
      rawLookupShape: window.__lastLookupShape || null
    }))()`);

    return out;
  };

  return { probe };
}

module.exports = { install };

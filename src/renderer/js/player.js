'use strict';
/**
 * player.js — 媒体播放器（MP4 / MP3 等）
 *  · 速度 0.25× ~ 2.5×（HTML5 原生 rate，配合 preservesPitch 保持音高）
 *  · A-B 复读、单句循环、拖动预览、缓冲显示、画中画、全屏
 *  · 只负责媒体本身；字幕同步由 app.js 订阅事件完成
 */
(function () {
  const { el, clamp, fmtClock, toast } = window.PLTUtil;

  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5];

  /** 没有媒体时不按：播放 / 上一句 / 下一句 / 重播 / 循环 / A-B / 步进 / 静音 / 画中画 / 全屏 */
  const PLAYBACK_CONTROLS = ['btnPlay', 'btnPrevLine', 'btnNextLine', 'btnReplay', 'btnLoopLine',
    'trPlay', 'trPrev', 'trNext', 'trBack5', 'trFwd5', 'trLoop', 'trAB', 'trMute', 'trPip', 'trFull',
    'miniPlay', 'miniFull', 'btnShadow', 'miniShadow'];

  /** 单例引用，供外部（诊断 / 应用层）查询与刷新控件状态 */
  let activePlayer = null;

  /** 没有媒体时禁用播放类控件（并给出原因提示） */
  function paintPlaybackEnabled(hasMedia) {
    for (const id of PLAYBACK_CONTROLS) {
      const node = document.getElementById(id);
      if (!node) continue;
      if (!node.dataset.baseTitle) node.dataset.baseTitle = node.getAttribute('title') || '';
      node.disabled = !hasMedia;
      node.setAttribute('title', hasMedia
        ? node.dataset.baseTitle
        : '请先打开视频或音频文件');
    }
  }

  class Player {
    constructor(video, opts) {
      this.media = video;
      this.opts = opts || {};
      this.handlers = {};
      this.mediaKind = 'video';
      this.ab = { a: null, b: null, active: false };
      this.loopMode = 'none';
      this._lastEmit = 0;
      this._rafId = null;
      this._seeking = false;
      activePlayer = this;
      paintPlaybackEnabled(!!(video.currentSrc || video.src));
      this.bindMedia();
    }

    on(evt, fn) {
      (this.handlers[evt] = this.handlers[evt] || []).push(fn);
      return this;
    }

    emit(evt, payload) {
      for (const fn of (this.handlers[evt] || [])) {
        try { fn(payload); } catch (err) { console.error('[player]', evt, err); }
      }
    }

    bindMedia() {
      const m = this.media;
      const emitState = () => {
        // hasMedia 以「已装载的媒体」为准，而不是 URL ——
        // 卸载后 currentSrc 可能仍保留旧地址，不能用来判断。
        const hasMedia = !!this.current;
        const state = {
          playing: !m.paused && !m.ended,
          ready: m.readyState >= 2,
          ended: m.ended,
          rate: m.playbackRate,
          volume: m.volume,
          muted: m.muted,
          duration: Number.isFinite(m.duration) ? m.duration : 0,
          hasMedia
        };
        paintPlaybackEnabled(hasMedia);
        this.emit('state', state);
      };
      m.addEventListener('loadedmetadata', () => {
        this.applyDefaultPitch();
        this.emit('duration', Number.isFinite(m.duration) ? m.duration : 0);
        emitState();
      });
      m.addEventListener('durationchange', () => this.emit('duration', Number.isFinite(m.duration) ? m.duration : 0));
      m.addEventListener('play', () => { emitState(); this.startLoop(); });
      m.addEventListener('pause', () => { emitState(); this.stopLoop(); });
      m.addEventListener('ended', () => { emitState(); this.stopLoop(); this.emit('ended'); });
      m.addEventListener('ratechange', () => { emitState(); this.emit('rate', m.playbackRate); });
      m.addEventListener('volumechange', emitState);
      m.addEventListener('progress', () => this.emit('buffered', this.bufferedEnd()));
      m.addEventListener('timeupdate', () => this.tick());
      m.addEventListener('seeking', () => { this._seeking = true; this.emit('seeking', m.currentTime); });
      m.addEventListener('seeked', () => { this._seeking = false; this.emit('seeked', m.currentTime); });
      m.addEventListener('error', () => {
        const code = m.error ? m.error.code : -1;
        const map = { 1: '加载被中止', 2: '网络错误', 3: '解码失败（可能是编码格式不受支持，建议 H.264/AAC 的 MP4）', 4: '文件格式不受支持或文件损坏' };
        this.emit('error', { code, message: map[code] || '媒体加载失败' });
      });
      m.addEventListener('waiting', () => this.emit('waiting'));
      m.addEventListener('canplay', () => this.emit('canplay'));
      // 点击画面播放/暂停
      m.addEventListener('click', () => this.toggle());
    }

    applyDefaultPitch() {
      // 变速不变调（Chromium 支持）
      try { this.media.preservesPitch = true; this.media.webkitPreservesPitch = true; } catch (_) { /* ignore */ }
      const rate = Number(this.opts.defaultRate) || 1;
      this.setRate(rate, { silent: true });
      const vol = Number(this.opts.defaultVolume);
      if (Number.isFinite(vol)) this.setVolume(vol, { silent: true });
      if (this.opts.muted) this.media.muted = true;
    }

    // ── 加载 ──
    load(info) {
      this.current = info;
      this.mediaKind = info.kind || 'video';
      this.ab = { a: null, b: null, active: false };
      this.media.src = info.url;
      this.media.load();
      this.applyDefaultPitch();
      try { this.media.currentTime = Number(info.startAt) || 0; } catch (_) { /* ignore */ }
      this.emit('loaded', info);
    }

    unload() {
      try { this.media.pause(); } catch (_) { /* ignore */ }
      this.media.removeAttribute('src');
      this.media.load();
      this.current = null;
      this.emit('unloaded');
    }

    // ── 播放控制 ──
    async play() {
      const m = this.media;
      // 播到结尾后再按播放：从头开始（否则会停在末尾不动，看起来像“播放无效”）
      if (m.ended || (Number.isFinite(m.duration) && m.duration > 0 && m.currentTime >= m.duration - 0.06)) {
        try { m.currentTime = 0; } catch (_) { /* ignore */ }
      }
      try {
        await m.play();
      } catch (err) {
        if (err && err.name === 'NotAllowedError') toast('浏览器阻止了自动播放，请手动点击播放', 'warn');
        else this.emit('error', { message: err.message });
      }
    }

    pause() { this.media.pause(); }
    toggle() {
      if (this.media.paused || this.media.ended) this.play(); else this.pause();
    }
    get playing() { return !this.media.paused && !this.media.ended; }
    get currentTime() { return this.media.currentTime || 0; }
    get duration() { return Number.isFinite(this.media.duration) ? this.media.duration : 0; }

    seek(time, opts) {
      const d = this.duration;
      const t = clamp(Number(time) || 0, 0, d > 0 ? d - 0.01 : Number(time) || 0);
      const before = this.media.currentTime;
      try { this.media.currentTime = t; } catch (_) { /* ignore */ }
      // 极少数情况下（元数据未就绪 / seekable 区间缺失）赋值会被忽略，等元数据好了再补一次
      if (Math.abs(t - before) > 0.15) {
        const media = this.media;
        const retry = () => {
          try {
            if (Math.abs(media.currentTime - t) > 0.4) {
              media.currentTime = t;
            }
          } catch (_) { /* ignore */ }
        };
        if (media.readyState < 1) media.addEventListener('loadedmetadata', retry, { once: true });
        else setTimeout(retry, 60);
      }
      this.tick(true);
      if (opts && opts.play && this.media.paused) this.play();
    }

    nudge(delta) { this.seek(this.currentTime + delta); }

    setRate(rate, opts) {
      const r = clamp(Number(rate) || 1, 0.25, 2.5);
      this.media.playbackRate = r;
      if (!opts || !opts.silent) this.emit('rate', r);
      return r;
    }

    stepRate(dir) {
      const cur = this.media.playbackRate;
      let idx = RATES.findIndex((r) => Math.abs(r - cur) < 0.001);
      if (idx < 0) { idx = RATES.findIndex((r) => r > cur); if (idx < 0) idx = RATES.length - 1; }
      const next = RATES[clamp(idx + (dir > 0 ? 1 : -1), 0, RATES.length - 1)];
      return this.setRate(next);
    }

    setVolume(v, opts) {
      const val = clamp(Number(v), 0, 1);
      this.media.volume = val;
      if (val > 0) this.media.muted = false;
      if (!opts || !opts.silent) this.emit('volume', val);
      return val;
    }

    toggleMute() {
      this.media.muted = !this.media.muted;
      return this.media.muted;
    }

    bufferedEnd() {
      const b = this.media.buffered;
      if (!b || !b.length) return 0;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= this.media.currentTime && this.media.currentTime <= b.end(i)) return b.end(i);
      }
      return b.end(b.length - 1);
    }

    // ── A-B 复读 ──
    setABPoint(which, time) {
      const t = time === undefined ? this.currentTime : time;
      this.ab[which] = t;
      if (this.ab.a !== null && this.ab.b !== null && this.ab.b > this.ab.a) this.ab.active = true;
      else this.ab.active = false;
      this.emit('ab', { ...this.ab });
      return { ...this.ab };
    }

    clearAB() {
      this.ab = { a: null, b: null, active: false };
      this.emit('ab', { ...this.ab });
    }

    cycleAB() {
      const { a, b } = this.ab;
      if (a === null && b === null) return this.setABPoint('a');
      if (a !== null && b === null) {
        const point = this.currentTime;
        if (point <= a) return this.setABPoint('a', point);
        return this.setABPoint('b', point);
      }
      this.clearAB();
      return null;
    }

    setLoopMode(mode) {
      this.loopMode = mode;
      this.emit('loop', mode);
    }

    // ── 单句循环 / A-B 由 app 设置区间 ──
    setSegmentLoop(start, end) {
      this.segment = (start === null || end === null || end <= start) ? null : { start, end };
    }

    // ── 内部循环 ──
    startLoop() {
      if (this._rafId) return;
      const loop = () => {
        this._rafId = requestAnimationFrame(loop);
        this.enforceLoops();
      };
      this._rafId = requestAnimationFrame(loop);
    }

    stopLoop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    enforceLoops() {
      const t = this.currentTime;
      const seg = this.segment;
      if (seg && t >= seg.end - 0.045) {
        this.seek(seg.start);
        return;
      }
      if (this.ab.active) {
        const { a, b } = this.ab;
        if (b !== null && t >= b - 0.03) {
          this.seek(a);
          return;
        }
      }
    }

    tick(force) {
      const now = performance.now();
      if (!force && now - this._lastEmit < 60) return;
      this._lastEmit = now;
      this.emit('time', { current: this.currentTime, duration: this.duration, buffered: this.bufferedEnd() });
    }

    // ── 画中画 / 全屏 ──
    async togglePip() {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await this.media.requestPictureInPicture();
      } catch (err) {
        toast('画中画不可用：' + err.message, 'warn');
      }
    }

    toggleFullscreen(container) {
      const box = container || this.media.parentElement;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (box.requestFullscreen) box.requestFullscreen();
    }

    fadeVolume(from, to, ms) {
      const steps = Math.max(6, Math.round(ms / 40));
      const delta = (to - from) / steps;
      let i = 0;
      const startVol = from;
      const timer = setInterval(() => {
        i++;
        this.media.volume = clamp(startVol + delta * i, 0, 1);
        if (i >= steps) clearInterval(timer);
      }, 40);
    }
  }

  /**
   * 绑定传输控件（进度条 / 按钮 / 速度 / 音量）
   */
  function bindTransport(player, ui) {
    const { $, $$ } = window.PLTUtil;
    const seekbar = ui.seekbar || $('#seekbar');
    const progress = $('#seekProgress');
    const buffered = $('#seekBuffered');
    const thumb = $('#seekThumb');
    const curTime = $('#curTime');
    const durTime = $('#durTime');

    const paint = (p) => {
      const dur = p.duration || 0;
      const pct = dur > 0 ? (p.current / dur) * 100 : 0;
      progress.style.width = `${clamp(pct, 0, 100)}%`;
      thumb.style.left = `${clamp(pct, 0, 100)}%`;
      const bpct = dur > 0 ? (p.buffered / dur) * 100 : 0;
      buffered.style.width = `${clamp(bpct, 0, 100)}%`;
      curTime.textContent = fmtClock(p.current);
      durTime.textContent = fmtClock(dur);
      if (ui.miniTime) ui.miniTime.textContent = `${fmtClock(p.current)} / ${fmtClock(dur)}`;
    };
    player.on('time', paint);
    player.on('duration', (d) => paint({ current: player.currentTime, duration: d, buffered: player.bufferedEnd() }));

    // 拖动进度
    let dragging = false;
    const timeFromEvent = (e) => {
      const rect = seekbar.getBoundingClientRect();
      const ratio = clamp((e.clientX - rect.left) / rect.width, 0, 1);
      const t = ratio * (player.duration || 0);
      return t;
    };
    const startDrag = (e) => {
      if (!player.duration) return;
      dragging = true;
      try { seekbar.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有真实 pointer，忽略 */ }
      player.seek(timeFromEvent(e));
    };
    const moveDrag = (e) => { if (dragging) player.seek(timeFromEvent(e)); };
    const endDrag = () => { dragging = false; };
    seekbar.addEventListener('pointerdown', startDrag);
    seekbar.addEventListener('pointermove', moveDrag);
    seekbar.addEventListener('pointerup', endDrag);
    seekbar.addEventListener('pointercancel', endDrag);
    seekbar.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') { player.nudge(e.shiftKey ? 10 : 5); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { player.nudge(e.shiftKey ? -10 : -5); e.preventDefault(); }
    });

    // 速度
    const rateLabel = $('#btnRate');
    const paintRate = (r) => {
      const txt = `${(Math.round(r * 100) / 100).toFixed(r % 1 === 0 ? 1 : 2).replace(/0$/, '').replace(/\.$/, '.0')}×`;
      rateLabel.textContent = txt;
      $$('#ratePresets .rate-chip').forEach((b) => b.classList.toggle('active', Math.abs(Number(b.dataset.rate) - r) < 0.001));
    };
    player.on('rate', paintRate);

    $('#btnSlow').addEventListener('click', () => player.stepRate(-1));
    $('#btnFast').addEventListener('click', () => player.stepRate(1));
    rateLabel.addEventListener('click', (e) => {
      // 点击速度按钮弹出预设菜单
      const rect = rateLabel.getBoundingClientRect();
      window.PLTUtil.contextMenu(rect.left - 40, rect.bottom + 4, RATES.map((rate) => ({
        label: `${rate}×${rate === 1 ? '（原速）' : ''}`,
        action: () => player.setRate(rate)
      })));
      e.stopPropagation();
    });
    $$('#ratePresets .rate-chip').forEach((btn) => {
      btn.addEventListener('click', () => player.setRate(Number(btn.dataset.rate)));
    });

    // 音量
    const vol = $('#volume');
    vol.addEventListener('input', () => player.setVolume(Number(vol.value)));
    $('#trMute').addEventListener('click', () => { player.toggleMute(); paintMute(); });
    const paintMute = () => {
      $('#trMute').classList.toggle('on', player.media.muted || player.media.volume === 0);
    };
    player.on('state', paintMute);

    // 播放状态图标：暂停时显示三角，播放中显示两道竖（用 CSS 类切换，避免内联 d 属性出错）
    const paintPlay = (playing) => {
      document.body.classList.toggle('is-playing', !!playing);
      const stage = document.getElementById('stage');
      if (stage) stage.classList.toggle('playing', !!playing);
      for (const id of ['trPlay', 'miniPlay']) {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('playing', !!playing);
      }
    };
    player.on('state', (s) => paintPlay(s.playing));
    paintPlay(player.playing);

    const toggle = () => player.toggle();
    $('#btnPlay').addEventListener('click', toggle);
    $('#trPlay').addEventListener('click', toggle);
    $('#miniPlay').addEventListener('click', toggle);
    $('#trBack5').addEventListener('click', () => player.nudge(-5));
    $('#trFwd5').addEventListener('click', () => player.nudge(5));
    $('#trPip').addEventListener('click', () => player.togglePip());
    $('#trFull').addEventListener('click', () => player.toggleFullscreen(document.getElementById('stage')));
    $('#miniFull').addEventListener('click', () => player.toggleFullscreen(document.getElementById('stage')));

    // 循环模式按钮
    const loopBadge = $('#loopBadge');
    $('#trLoop').addEventListener('click', () => {
      const order = ['none', 'one', 'all'];
      const next = order[(order.indexOf(player.loopMode) + 1) % order.length];
      player.setLoopMode(next);
      $('#trLoop').classList.toggle('on', next !== 'none');
      loopBadge.classList.toggle('hidden', next === 'none');
      loopBadge.textContent = next === 'one' ? '1' : '∞';
      toast(next === 'none' ? '循环：关闭' : next === 'one' ? '循环：单句重复' : '循环：整篇重复');
    });

    return { paint, paintRate };
  }

  window.PLTPlayer = {
    Player,
    bindTransport,
    RATES,
    /** 刷新播放类控件的可用状态（诊断 / 应用层用） */
    refreshEnabled: () => paintPlaybackEnabled(!!(activePlayer && activePlayer.current)),
    /** 强制设置控件可用状态（诊断用，绕过媒体状态推断） */
    forceEnabled: (hasMedia) => paintPlaybackEnabled(!!hasMedia),
    /** 读取控件禁用状态（诊断用） */
    enabledStates: () => PLAYBACK_CONTROLS.map((id) => {
      const n = document.getElementById(id);
      return { id, disabled: n ? n.disabled : null };
    })
  };
}());

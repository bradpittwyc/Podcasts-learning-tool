'use strict';
/**
 * ytplayer.js — YouTube 在线播放后端
 *
 * 用 YouTube IFrame API 播放在线视频，对外暴露**与本地 Player 完全一致**的接口，
 * 这样上层（传输栏 / 快捷键 / A-B 复读 / 倍速）不用区分「本地文件」还是「在线视频」。
 *
 * 先天限制（不是 bug）：YouTube 不把字幕文本暴露给第三方嵌入播放器，
 * 所以在线模式下拿不到字幕 → 点句跳转、全文扫描、分级取词、跟读都不可用。
 * 需要这些功能就走「下载到本地」那条路。
 */
(function () {
  const { clamp, toast } = window.PLTUtil;

  /** YouTube 只支持这几个倍速（本地 <video> 能到 2.5×，这里到 2× 封顶） */
  const YT_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  let apiPromise = null;

  /** 懒加载 IFrame API（只加载一次） */
  function loadApi() {
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve, reject) => {
      if (window.YT && window.YT.Player) { resolve(window.YT); return; }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') { try { prev(); } catch (_) { /* ignore */ } }
        resolve(window.YT);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.async = true;
      s.onerror = () => reject(new Error('无法加载 YouTube 播放器（请检查网络）'));
      document.head.appendChild(s);
      setTimeout(() => { if (!(window.YT && window.YT.Player)) reject(new Error('加载 YouTube 播放器超时')); }, 15000);
    });
    return apiPromise;
  }

  class YtPlayer {
    /**
     * @param {HTMLElement} host 放 iframe 的容器
     * @param {object} opts { defaultRate, defaultVolume, muted, autoplay }
     */
    constructor(host, opts) {
      this.host = host;
      this.opts = opts || {};
      this.handlers = {};
      this.impl = null;
      this.current = null;
      this.mediaKind = 'video';
      this.ab = { a: null, b: null, active: false };
      this.loopMode = 'none';
      this.segment = null;
      this._rafId = null;
      this._lastEmit = 0;
      this._ready = false;
      // 传输栏的静音图标直接读 player.media.muted —— 这里给个同步的影子对象
      this.media = {
        muted: !!this.opts.muted,
        volume: Number.isFinite(Number(this.opts.defaultVolume)) ? Number(this.opts.defaultVolume) : 1,
        paused: true
      };
    }

    // ── 事件 ──
    on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); return this; }
    emit(evt, payload) {
      for (const fn of (this.handlers[evt] || [])) {
        try { fn(payload); } catch (err) { console.error('[ytplayer]', evt, err); }
      }
    }

    // ── 加载 ──
    async load(info) {
      this.current = info;
      this.ab = { a: null, b: null, active: false };
      this.segment = null;
      this._ready = false;

      const YT = await loadApi();
      this.stopLoop();
      this.host.innerHTML = '';
      const mount = document.createElement('div');
      this.host.appendChild(mount);

      const playerVars = {
        enablejsapi: 1,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        cc_load_policy: 0,
        start: Math.floor(Number(info.startAt) || 0)
      };
      // file:// 下 origin 会被 YouTube 拒绝，只在 http(s) 里带上
      if (/^https?:$/.test(window.location.protocol)) playerVars.origin = window.location.origin;

      await new Promise((resolve) => {
        this.impl = new YT.Player(mount, {
          videoId: info.id,
          playerVars,
          events: {
            onReady: () => {
              this._ready = true;
              this.impl.setVolume(Math.round(this.media.volume * 100));
              if (this.media.muted) this.impl.mute(); else this.impl.unMute();
              this.setRate(Number(this.opts.defaultRate) || 1, { silent: true });
              // 补上 name / path：上层（状态栏、舞台样式）是按本地文件的字段读的
              this.emit('loaded', { ...info, name: info.title || info.id, path: info.url });
              this.emit('duration', this.duration);
              this.emit('state', this.snapshot());
              resolve();
            },
            onStateChange: (e) => {
              // -1 未开始 / 0 结束 / 1 播放中 / 2 暂停 / 3 缓冲 / 5 已提示
              this.media.paused = e.data !== 1;
              this.emit('state', this.snapshot());
              if (e.data === 1) this.startLoop(); else this.stopLoop();
              if (e.data === 0) this.emit('ended');
              if (e.data === YT.PlayerState.PLAYING) this.emit('canplay');
            },
            onError: (e) => {
              const map = {
                2: '链接里的视频 ID 无效',
                5: '这个视频无法在网页播放器中播放',
                100: '视频不存在或已被删除',
                101: '版权方禁止嵌入播放（请改用「下载到本地」）',
                150: '版权方禁止嵌入播放（请改用「下载到本地」）'
              };
              this.emit('error', { code: e.data, message: map[e.data] || ('YouTube 播放错误 ' + e.data) });
            }
          }
        });
      });

      // 自动播放（用户是「粘贴链接 → 想直接看」，所以这里就是要自动播）
      if (this.opts.autoplay !== false) this.play();
    }

    unload() {
      this.stopLoop();
      try { if (this.impl && this.impl.destroy) this.impl.destroy(); } catch (_) { /* ignore */ }
      this.impl = null;
      this.host.innerHTML = '';
      this.current = null;
      this._ready = false;
      this.emit('unloaded');
    }

    snapshot() {
      return {
        playing: this.playing,
        ready: this._ready,
        ended: false,
        rate: this.rate,
        volume: this.media.volume,
        muted: this.media.muted,
        duration: this.duration,
        hasMedia: !!this.current
      };
    }

    // ── 播放控制 ──
    play() {
      if (!this.impl) return;
      try { this.impl.playVideo(); } catch (_) { /* ignore */ }
      // 浏览器/YouTube 可能拦自动播放（未静音）：给个可操作的提示，别静默失败
      setTimeout(() => {
        if (!this.playing && this._ready) {
          toast('浏览器阻止了自动播放，点一下画面或播放键即可', 'warn', 5000);
        }
      }, 1200);
    }
    pause() { try { this.impl && this.impl.pauseVideo(); } catch (_) { /* ignore */ } }
    toggle() { if (this.playing) this.pause(); else this.play(); }

    get playing() {
      try { return !!this.impl && this.impl.getPlayerState() === 1; } catch (_) { return false; }
    }
    get currentTime() {
      try { return this.impl ? (this.impl.getCurrentTime() || 0) : 0; } catch (_) { return 0; }
    }
    get duration() {
      try { const d = this.impl ? this.impl.getDuration() : 0; return Number.isFinite(d) ? d : 0; } catch (_) { return 0; }
    }

    seek(time, opts) {
      if (!this.impl) return;
      const d = this.duration;
      const t = clamp(Number(time) || 0, 0, d > 0 ? d - 0.05 : Number(time) || 0);
      try { this.impl.seekTo(t, true); } catch (_) { /* ignore */ }
      this.tick(true);
      if (opts && opts.play && !this.playing) this.play();
    }
    nudge(delta) { this.seek(this.currentTime + delta); }

    get rate() { try { return this.impl ? (this.impl.getPlaybackRate() || 1) : 1; } catch (_) { return 1; } }

    /** YouTube 只认固定的几档倍速，这里就近吸附到合法档位 */
    setRate(rate, opts) {
      const wanted = clamp(Number(rate) || 1, YT_RATES[0], YT_RATES[YT_RATES.length - 1]);
      let best = YT_RATES[0];
      for (const r of YT_RATES) if (Math.abs(r - wanted) < Math.abs(best - wanted)) best = r;
      try { this.impl && this.impl.setPlaybackRate(best); } catch (_) { /* ignore */ }
      if (!opts || !opts.silent) this.emit('rate', best);
      return best;
    }

    stepRate(dir) {
      const cur = this.rate;
      let idx = YT_RATES.findIndex((r) => Math.abs(r - cur) < 0.001);
      if (idx < 0) { idx = YT_RATES.findIndex((r) => r > cur); if (idx < 0) idx = YT_RATES.length - 1; }
      return this.setRate(YT_RATES[clamp(idx + (dir > 0 ? 1 : -1), 0, YT_RATES.length - 1)]);
    }

    setVolume(v, opts) {
      const val = clamp(Number(v), 0, 1);
      this.media.volume = val;
      if (val > 0) this.media.muted = false;
      try {
        this.impl && this.impl.setVolume(Math.round(val * 100));
        if (val > 0 && this.media.muted === false) this.impl.unMute();
      } catch (_) { /* ignore */ }
      if (!opts || !opts.silent) this.emit('volume', val);
      return val;
    }

    toggleMute() {
      this.media.muted = !this.media.muted;
      try {
        if (this.media.muted) this.impl && this.impl.mute();
        else this.impl && this.impl.unMute();
      } catch (_) { /* ignore */ }
      this.emit('state', this.snapshot());
      return this.media.muted;
    }

    bufferedEnd() {
      // YouTube 不给缓冲区间，用「已播到哪儿」近似，进度条不至于永远空白
      try { return this.duration; } catch (_) { return 0; }
    }

    async togglePip() {
      toast('在线播放不支持画中画（下载到本地后可用）', 'warn');
    }

    toggleFullscreen(container) {
      const box = container || this.host;
      try {
        if (document.fullscreenElement) document.exitFullscreen();
        else if (box.requestFullscreen) box.requestFullscreen();
      } catch (_) { /* ignore */ }
    }

    applyDefaultPitch() { /* YouTube 没有 preservesPitch 概念，空实现保持接口一致 */ }

    fadeVolume() { /* 在线模式不支持淡入淡出，空实现 */ }

    // ── A-B 复读 / 区间循环（与本地 Player 同逻辑） ──
    setABPoint(which, time) {
      const t = time === undefined ? this.currentTime : time;
      this.ab[which] = t;
      this.ab.active = !!(this.ab.a !== null && this.ab.b !== null && this.ab.b > this.ab.a);
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
    setLoopMode(mode) { this.loopMode = mode; this.emit('loop', mode); }
    setSegmentLoop(start, end) {
      this.segment = (start === null || end === null || end <= start) ? null : { start, end };
    }

    startLoop() {
      if (this._rafId) return;
      const loop = () => { this._rafId = requestAnimationFrame(loop); this.enforceLoops(); this.tick(); };
      this._rafId = requestAnimationFrame(loop);
    }
    stopLoop() {
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    enforceLoops() {
      const t = this.currentTime;
      const seg = this.segment;
      if (seg && t >= seg.end - 0.045) { this.seek(seg.start); return; }
      if (this.ab.active) {
        const { a, b } = this.ab;
        if (b !== null && t >= b - 0.03) { this.seek(a); return; }
      }
    }
    tick(force) {
      const now = performance.now();
      if (!force && now - this._lastEmit < 60) return;
      this._lastEmit = now;
      this.emit('time', { current: this.currentTime, duration: this.duration, buffered: this.bufferedEnd() });
    }

    dispose() { this.unload(); }
  }

  window.PLTYtPlayer = { YtPlayer, loadApi, YT_RATES };
}());

'use strict';
/**
 * shadow.js — 跟读（shadowing）练习
 *  · 麦克风录音（MediaRecorder）+ 电平指示
 *  · 录完自动下一句 / 原句后留跟读间隔（自动暂停）
 *  · A/B 对比播放、录音保存
 */
(function () {
  const U = window.PLTUtil;
  const { el, clear, toast, clamp } = U;

  class Shadow {
    constructor(opts) {
      this.opts = opts || {};
      this.panel = U.$('#shadowPanel');
      this.lineEl = U.$('#spLine');
      this.meterEl = U.$('#spMeter');
      this.hintEl = U.$('#spHint');
      this.recBtn = U.$('#spRec');
      this.playBtn = U.$('#spPlayRec');
      this.saveBtn = U.$('#spSaveRec');
      this.compareBtn = U.$('#spCompare');
      this.enabled = false;
      this.recording = false;
      this.recorder = null;
      this.chunks = [];
      this.blobUrl = null;
      this.blob = null;
      this.stream = null;
      this.analyser = null;
      this.audioCtx = null;
      this.rafId = null;
      this.gapTimer = null;
      this.currentCue = null;
      this.currentIndex = -1;
      this.bind();
    }

    bind() {
      U.$('#spClose').addEventListener('click', () => this.toggle(false));
      this.recBtn.addEventListener('click', () => this.toggleRecord());
      this.playBtn.addEventListener('click', () => this.playRecording());
      this.saveBtn.addEventListener('click', () => this.saveRecording());
      this.compareBtn.addEventListener('click', () => this.abCompare());
      U.$('#spAutoNext').addEventListener('change', (e) => this.opts.onSetting && this.opts.onSetting('autoNext', e.target.checked));
      U.$('#spGap').addEventListener('change', (e) => {
        if (this.opts.onSetting) this.opts.onSetting('gap', e.target.checked);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !this.panel.classList.contains('hidden') && !this.recording) this.toggle(false);
      });
    }

    toggle(on) {
      const next = on === undefined ? this.panel.classList.contains('hidden') : !!on;
      this.panel.classList.toggle('hidden', !next);
      this.enabled = next;
      this.opts.onToggle && this.opts.onToggle(next);
      if (!next) { this.stopGapTimer(); this.stopLevelMeter(); }
      if (next && !this.opts.onSetting) { /* noop */ }
      return next;
    }

    setCue(index, cue) {
      this.currentIndex = index;
      this.currentCue = cue;
      clear(this.lineEl);
      if (!cue) {
        this.lineEl.appendChild(document.createTextNode('选择一句字幕开始跟读'));
        return;
      }
      this.lineEl.appendChild(el('div', { text: cue.en || '' }));
      if (cue.zh) this.lineEl.appendChild(el('div', { class: 'cn', text: cue.zh }));
    }

    /** 原句播完后进入跟读间隙 */
    startGap(seconds) {
      this.stopGapTimer();
      let left = Math.max(0.6, seconds);
      const tick = () => {
        if (left <= 0) {
          this.hintEl.textContent = '轮到你了 🎙 点「开始录音」或直接跟读';
          this.opts.onGapEnd && this.opts.onGapEnd(this.currentIndex);
          return;
        }
        this.hintEl.textContent = `跟读时间 ${left.toFixed(1)}s …`;
        left -= 0.1;
        this.gapTimer = setTimeout(tick, 100);
      };
      tick();
    }

    stopGapTimer() {
      if (this.gapTimer) { clearTimeout(this.gapTimer); this.gapTimer = null; }
    }

    // ── 录音 ──
    async toggleRecord() {
      if (this.recording) { this.stopRecord(); return; }
      await this.startRecord();
    }

    async startRecord() {
      try {
        const constraints = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };
        const devId = this.opts.micDeviceId && this.opts.micDeviceId();
        if (devId) constraints.audio.deviceId = { exact: devId };
        this.stream = await navigator.mediaDevices.getUserMedia(constraints);
      } catch (err) {
        toast('无法访问麦克风：' + err.message, 'err');
        return false;
      }
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) this.chunks.push(e.data); });
      this.recorder.addEventListener('stop', () => {
        const type = this.recorder.mimeType || 'audio/webm';
        this.blob = new Blob(this.chunks, { type });
        if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
        this.blobUrl = URL.createObjectURL(this.blob);
        this.playBtn.disabled = false;
        const secs = (this.recordSeconds || 0).toFixed(1);
        this.hintEl.textContent = `录音完成（${secs}s）。可播放、A/B 对比或保存。`;
        // 与原文相似度（基于系统语音识别，若可用）
        this.recognizeAndScore();
      });
      this.recorder.start(120);
      this.recording = true;
      this.recordStartedAt = Date.now();
      this.recBtn.textContent = '■ 停止录音';
      this.recBtn.classList.add('recording');
      this.hintEl.textContent = '正在录音… 请跟读这句话';
      this.startLevelMeter();
      this.stopGapTimer();
      return true;
    }

    stopRecord() {
      if (!this.recording) return;
      this.recordSeconds = (Date.now() - this.recordStartedAt) / 1000;
      this.recording = false;
      try { this.recorder.stop(); } catch (_) { /* ignore */ }
      try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
      this.recBtn.textContent = '● 开始录音';
      this.recBtn.classList.remove('recording');
      this.stopLevelMeter();
    }

    startLevelMeter() {
      try {
        this.audioCtx = this.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        const src = this.audioCtx.createMediaStreamSource(this.stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 512;
        src.connect(this.analyser);
        const data = new Uint8Array(this.analyser.frequencyBinCount);
        const loop = () => {
          if (!this.recording) return;
          this.rafId = requestAnimationFrame(loop);
          this.analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] - 128) / 128);
          this.meterEl.style.width = `${clamp(peak * 180, 0, 100)}%`;
        };
        loop();
      } catch (err) {
        console.warn('[shadow] 电平指示不可用', err.message);
      }
    }

    stopLevelMeter() {
      if (this.rafId) cancelAnimationFrame(this.rafId);
      this.rafId = null;
      this.meterEl.style.width = '0%';
    }

    playRecording() {
      if (!this.blobUrl) { toast('还没有录音', 'warn'); return; }
      const audio = new Audio(this.blobUrl);
      audio.play().catch((err) => toast('播放失败：' + err.message, 'err'));
      this.hintEl.textContent = '播放你的跟读…';
    }

    /** A/B 对比：原句 → 停顿 → 你的录音 */
    async abCompare() {
      if (!this.blobUrl) { toast('还没有录音', 'warn'); return; }
      this.hintEl.textContent = 'A/B 对比中：先听原句…';
      if (this.opts.onPlayOriginal) await this.opts.onPlayOriginal(this.currentIndex);
      const wait = Math.max(600, (this.opts.originalDuration ? this.opts.originalDuration() : 2) * 1000 + 500);
      setTimeout(() => {
        this.hintEl.textContent = '现在播放你的跟读…';
        this.playRecording();
      }, wait);
    }

    async recognizeAndScore() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SR || !this.currentCue || !this.blob) return;
      // 简化处理：用系统识别实时录制会打断录音，这里只给时长建议
      const words = (this.currentCue.en || '').split(/\s+/).filter(Boolean).length;
      const dur = this.recordSeconds || 0;
      const expected = words * 0.42;
      const ratio = expected > 0 ? dur / expected : 1;
      let tip = '';
      if (ratio > 1.45) tip = '你的语速偏慢，可以再连贯一些。';
      else if (ratio < 0.6) tip = '你的语速偏快，注意每个词的收尾音。';
      else tip = '节奏和原句接近 👍';
      this.hintEl.textContent = `录音 ${dur.toFixed(1)}s / 原句约 ${expected.toFixed(1)}s · ${tip}`;
    }

    async saveRecording() {
      if (!this.blob) { toast('还没有录音', 'warn'); return; }
      const buf = await this.blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const b64 = btoa(bin);
      const mime = this.blob.type || 'audio/webm';
      const dataUrl = `data:${mime};base64,${b64}`;
      const name = `shadowing-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.webm`;
      const res = await window.PLT.record.save({ dataUrl, defaultName: name });
      if (res && res.path) toast('已保存：' + res.path, 'ok');
    }

    /** 保存到媒体同目录（批量跟读时方便归档） */
    async saveToDir(dir, index) {
      if (!this.blob) return null;
      const buf = await this.blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      const CH = 0x8000;
      for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
      const dataUrl = `data:${this.blob.type || 'audio/webm'};base64,${btoa(bin)}`;
      return window.PLT.record.saveToDir({ dataUrl, dir, name: `shadowing-line${(index ?? this.currentIndex) + 1}.webm` });
    }
  }

  window.PLTShadow = { Shadow };
}());

'use strict';
/**
 * youtube.js（渲染层）—「粘贴链接 → 播放」的完整流程
 *
 * 流程：
 *   链接输入 → 解析出 videoId → 取标题（oEmbed）→ 让用户选
 *     ├─ 在线速听：YouTube IFrame 播放器，秒开，但**没有字幕文本**
 *     └─ 下载到本地：yt-dlp 抓音视频 + 字幕 → 当普通本地文件打开，全部功能照常
 *
 * 本模块只管流程与界面，真正的播放由 ytplayer.js 负责，
 * 真正的文件落地由主进程 youtube.js 负责。
 */
(function () {
  const { $, el, modal, confirm, toast } = window.PLTUtil;

  let hooks = null;         // 由 app.js 注入
  let ytPlayer = null;      // 懒创建，只建一次（避免重复挂载 iframe）
  let progressUi = null;    // 当前下载进度弹窗

  function init(h) {
    hooks = h;
    window.PLT.youtube.onProgress((p) => {
      if (!progressUi) return;
      if (p.phase === 'installing') progressUi.set(p.percent, `正在下载 yt-dlp… ${p.percent}%`);
      else if (p.phase === 'downloading') progressUi.set(p.percent, `正在下载视频… ${p.percent}%`);
      else if (p.phase === 'done') progressUi.set(100, '下载完成，正在载入…');
    });
  }

  // ══════════════════════════════════════════════════════════
  // 入口
  // ══════════════════════════════════════════════════════════

  async function openLink(initialUrl) {
    if (!hooks) { toast('播放器还没初始化完成', 'warn'); return; }
    const url = initialUrl || await askUrl();
    if (!url) return;

    const parsed = await window.PLT.youtube.parse(url);
    if (!parsed) {
      toast('没认出这是 YouTube 链接。支持 youtube.com / youtu.be / shorts / 直播链接。', 'warn', 6000);
      return;
    }

    const meta = await window.PLT.youtube.meta(parsed.url).catch(() => ({ ok: false }));
    const title = (meta && meta.ok && meta.title) || `YouTube 视频 ${parsed.id}`;

    const choice = await askMode(parsed, title, meta);
    if (choice === 'online') await startOnline(parsed, title);
    else if (choice === 'download') await startDownload(parsed, title);
  }

  // ══════════════════════════════════════════════════════════
  // 两个对话框
  // ══════════════════════════════════════════════════════════

  function askUrl() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };

      const input = el('input', {
        type: 'text',
        placeholder: 'https://www.youtube.com/watch?v=… 或 https://youtu.be/…',
        style: { width: '100%' }
      });
      const pasteBtn = el('button', {
        class: 'cb-btn', text: '粘贴',
        onclick: async () => {
          const t = await window.PLT.clipboard.read();
          if (t) { input.value = String(t).trim(); input.focus(); }
        }
      });
      const hint = el('div', {
        class: 'muted small',
        style: { marginTop: '12px', lineHeight: '1.8' },
        html: '在线播放 = 秒开，但拿不到字幕文本（点句跳转 / 跟读 / 取词用不了）<br>'
          + '下载到本地 = 需要 yt-dlp，下载后所有功能照常'
      });

      modal({
        title: '打开在线视频链接',
        subtitle: '支持 youtube.com / youtu.be / shorts / 直播链接',
        body: el('div', { class: 'form', style: { paddingTop: '16px' } }, [
          el('div', { style: { display: 'flex', gap: '8px' } }, [input, pasteBtn]),
          hint
        ]),
        buttons: [
          { label: '取消', action: () => finish(null) },
          { label: '继续', accent: true, action: () => finish(input.value.trim() || null) }
        ],
        render: (box, api) => {
          setTimeout(() => input.focus(), 40);
          input.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter') return;
            e.preventDefault();
            const v = input.value.trim() || null;
            finish(v);
            api.close(v);
          });
        },
        onClose: () => finish(null)
      });
    });
  }

  async function askMode(parsed, title, meta) {
    const st = await window.PLT.youtube.toolStatus().catch(() => null);
    const dlpReady = !!(st && st.ytdlpReady);
    const ffmpegReady = !!(st && st.ffmpeg);

    const rows = [];
    rows.push(el('div', { class: 'form-row', style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, [
      el('div', { style: { flex: '1' } }, [
        el('div', { text: '在线速听', style: { fontWeight: '600' } }),
        el('div', {
          class: 'muted small', style: { lineHeight: '1.7', marginTop: '4px' },
          text: '立刻播放，不用下载。倍速、A-B 复读可用；没有字幕文本，点句跳转 / 取词 / 跟读不可用。'
        })
      ])
    ]));
    rows.push(el('div', { class: 'form-row', style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, [
      el('div', { style: { flex: '1' } }, [
        el('div', { text: '下载到本地（全功能）', style: { fontWeight: '600' } }),
        el('div', {
          class: 'muted small', style: { lineHeight: '1.7', marginTop: '4px' },
          html: `存到 <code>${st ? st.downloadDir : '数据目录'}</code>，之后当本地文件播放，全部功能照常。`
            + (dlpReady ? '' : '<br><span style="color:#e5a23c">首次使用需下载 yt-dlp（约 30MB）</span>')
            + (dlpReady && !ffmpegReady ? '<br><span style="color:#e5a23c">没装 ffmpeg → 只下载音频（字幕照常）</span>' : '')
        })
      ])
    ]));

    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };
      const head = el('div', {}, [
        el('div', { text: title, style: { fontWeight: '600', fontSize: '14px', marginBottom: '10px' } }),
        el('div', {
          class: 'muted small',
          text: (meta && meta.author ? '频道：' + meta.author + ' · ' : '') + 'ID：' + parsed.id
        })
      ]);
      modal({
        title: '怎么播放这个视频？',
        body: el('div', { class: 'form', style: { paddingTop: '14px' } }, [head, el('div', { style: { marginTop: '14px', display: 'grid', gap: '14px' } }, rows)]),
        buttons: [
          { label: '取消', action: () => finish(null) },
          { label: '下载到本地', action: () => finish('download') },
          { label: '在线速听', accent: true, action: () => finish('online') }
        ],
        onClose: () => finish(null)
      });
    });
  }

  function progressModal(title) {
    const label = el('div', { class: 'muted small', text: '准备中…' });
    const fill = el('div', { style: { height: '100%', width: '0%', background: '#4c8dff', transition: 'width .25s' } });
    const bar = el('div', {
      style: { height: '6px', background: 'rgba(127,127,127,.25)', borderRadius: '4px', overflow: 'hidden', marginTop: '10px' }
    }, [fill]);
    const api = modal({
      title,
      narrow: true,
      dismissable: false,
      body: el('div', { class: 'form', style: { paddingTop: '16px' } }, [label, bar]),
      buttons: [{
        label: '取消下载',
        action: async () => { try { await window.PLT.youtube.cancel(); } catch (_) { /* ignore */ } }
      }],
      onClose: () => { progressUi = null; }   // 用户按 Esc 关窗时也要解绑，否则后续进度会打到已销毁的节点
    });
    progressUi = {
      set: (pct, text) => { fill.style.width = `${Math.max(0, Math.min(100, pct))}%`; label.textContent = text || `${pct}%`; },
      close: () => { progressUi = null; try { api.close(null); } catch (_) { /* ignore */ } }
    };
    return progressUi;
  }

  // ══════════════════════════════════════════════════════════
  // 路径一：在线播放
  // ══════════════════════════════════════════════════════════

  async function startOnline(parsed, title) {
    try {
      await window.PLTYtPlayer.loadApi();
    } catch (err) {
      toast(err.message + '。可改用「下载到本地」', 'err', 6000);
      return;
    }

    const host = $('#ytHost');
    if (!ytPlayer) {
      const s = hooks.getSettings();
      ytPlayer = new window.PLTYtPlayer.YtPlayer(host, {
        defaultRate: (s.player && s.player.rate) || 1,
        defaultVolume: (s.player && s.player.volume),
        muted: !!(s.player && s.player.muted),
        autoplay: true
      });
    }
    hooks.playback().use(ytPlayer, 'youtube');
    hooks.onEnterOnline({ id: parsed.id, url: parsed.url, title });
    await ytPlayer.load({ kind: 'youtube', id: parsed.id, url: parsed.url, title, startAt: parsed.start || 0 });
  }

  /** 退出在线模式（切回本地文件前必须调，否则 YouTube 还在后台响） */
  function exitOnline() {
    try { hooks.playback().use(hooks.localBackend(), 'local'); } catch (_) { /* ignore */ }
    try { hooks.onExitOnline(); } catch (_) { /* ignore */ }
    try { if (ytPlayer) ytPlayer.unload(); } catch (_) { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════════
  // 路径二：下载到本地
  // ══════════════════════════════════════════════════════════

  async function startDownload(parsed, title) {
    let st = await window.PLT.youtube.toolStatus().catch(() => null);
    if (!st || !st.ytdlpReady) {
      const go = await confirm(
        '「下载到本地」需要 yt-dlp（开源命令行工具，约 30MB），本应用不会把它打进安装包，'
        + '而是在你第一次使用时从 GitHub 官方发布页下载到本机数据目录。现在下载吗？',
        { title: '需要 yt-dlp', okLabel: '下载' }
      );
      if (!go) return;
      const ui = progressModal('准备下载工具');
      const r = await window.PLT.youtube.installTool();
      ui.close();
      if (!r || !r.ok) {
        toast('yt-dlp 下载失败：' + ((r && r.error) || '未知错误'), 'err', 8000);
        return;
      }
      toast('yt-dlp 已就绪：' + r.path, 'ok', 5000);
      st = await window.PLT.youtube.toolStatus().catch(() => null);
    }

    const ui = progressModal('下载到本地');
    ui.set(0, '开始下载…');
    const res = await window.PLT.youtube.download({ url: parsed.url, id: parsed.id });
    ui.close();

    if (!res || !res.ok) {
      if (res && res.code === 'CANCELED') { toast('已取消下载', 'warn'); return; }
      if (res && res.code === 'NO_YTDLP') { toast('找不到 yt-dlp，请到设置里指定路径或重新安装', 'err', 8000); return; }
      toast('下载失败：' + ((res && res.error) || '未知错误'), 'err', 9000);
      return;
    }

    exitOnline();
    toast(`已下载：${title}`, 'ok', 4000);
    await hooks.openLocal(res.media);
    // 字幕文件名和媒体名不完全一致（带语言码），自动配对可能失败 → 这里显式挂上
    if (res.subtitles && res.subtitles.length) {
      await hooks.openSubtitle(res.subtitles[0]);
    }
  }

  window.PLTYoutube = {
    init,
    openLink,
    exitOnline,
    get mode() { return hooks ? hooks.playback().kind : 'none'; }
  };
}());

'use strict';
/**
 * updater-ui.js — 自动更新的界面层
 *
 * 主进程 updater.js 只负责状态机，这里负责把它呈现出来：
 *   · 状态栏右侧的小提示（有新版本时才出现）
 *   · 设置 →「高级」里的「软件更新」区块
 *   · 帮助菜单「检查更新…」弹出的更新面板（进度条 / 下载 / 立即重启安装）
 */
(function () {
  const U = window.PLTUtil;
  const { el, toast, fmtBytes } = U;
  let state = {
    phase: 'idle', mode: 'none', current: '', latest: '', notes: '',
    percent: 0, transferred: 0, total: 0, error: '', releaseUrl: '', assetName: '', savedTo: ''
  };
  let badge = null;
  let subscribers = [];

  const PHASE_TEXT = {
    idle: '尚未检查',
    checking: '正在检查更新…',
    uptodate: '已是最新版本',
    available: '发现新版本',
    downloading: '正在下载更新…',
    downloaded: '更新已下载完成',
    installing: '正在安装，程序即将重启…',
    error: '检查更新失败',
    unsupported: '当前运行方式不支持自动更新'
  };

  function phaseText(s) {
    if (s.phase === 'available' && s.latest) return `发现新版本 v${s.latest}`;
    if (s.phase === 'downloading') return `正在下载更新… ${s.percent || 0}%`;
    if (s.phase === 'downloaded') return `更新已下载完成（v${s.latest}）`;
    return PHASE_TEXT[s.phase] || s.phase;
  }

  /** 状态栏角标：只有「有更新 / 下载中 / 待安装」才显示 */
  function paintBadge() {
    if (!badge) return;
    const show = ['available', 'downloading', 'downloaded'].includes(state.phase);
    badge.classList.toggle('hidden', !show);
    if (!show) return;
    if (state.phase === 'available') badge.textContent = `⬆ 有新版本 v${state.latest}`;
    else if (state.phase === 'downloading') badge.textContent = `⬇ 下载中 ${state.percent || 0}%`;
    else badge.textContent = '✔ 更新待安装';
    badge.title = '点击查看更新详情';
  }

  function apply(next) {
    const prevPhase = state.phase;
    state = Object.assign({}, state, next || {});
    paintBadge();
    for (const fn of subscribers) { try { fn(state); } catch (_) {} }
    // 后台自动检查发现新版本时，用 toast 提醒（不打断）
    if (prevPhase !== 'available' && state.phase === 'available') {
      toast(`发现新版本 v${state.latest} —— 点状态栏右下角或「帮助 → 检查更新」升级`, 'ok', 7000);
    }
  }

  async function refresh() {
    try { apply(await window.PLT.update.state()); } catch (_) {}
  }

  async function check() {
    apply({ phase: 'checking', error: '' });
    const res = await window.PLT.update.check();
    apply(res);
    return res;
  }

  async function download() {
    const res = await window.PLT.update.download();
    apply(res);
    return res;
  }

  async function install() {
    const res = await window.PLT.update.install();
    if (res && res.ok === false) toast(res.error || '安装失败', 'err', 8000);
    return res;
  }

  function progressBar() {
    const wrap = el('div', { class: 'upd-bar' }, [el('div', { class: 'upd-bar-fill' })]);
    const fill = wrap.firstChild;
    const sync = (s) => {
      const pct = s.phase === 'downloaded' || s.phase === 'installing' ? 100 : (s.percent || 0);
      fill.style.width = pct + '%';
      wrap.classList.toggle('hidden', !['downloading', 'downloaded', 'installing'].includes(s.phase));
    };
    subscribers.push(sync);
    sync(state);
    return wrap;
  }

  /** 帮助菜单「检查更新…」弹出的面板 */
  function modal() {
    const body = document.createDocumentFragment();
    const line = el('div', { class: 'upd-line' });
    const detail = el('div', { class: 'muted small upd-detail' });
    const notes = el('div', { class: 'skip-note upd-notes hidden' });
    const bar = progressBar();

    const btnCheck = el('button', { class: 'cb-btn', text: '检查更新', onclick: async () => { await check(); } });
    const btnGet = el('button', { class: 'cb-btn', text: '下载更新' });
    const btnInstall = el('button', { class: 'cb-btn accent', text: '立即重启并安装' });
    const btnPage = el('button', { class: 'cb-btn', text: '打开发布页', onclick: () => window.PLT.update.openRelease() });

    body.appendChild(line);
    body.appendChild(bar);
    body.appendChild(detail);
    body.appendChild(notes);
    body.appendChild(el('div', { class: 'row-gap' }, [btnCheck, btnGet, btnInstall, btnPage]));

    const sync = (s) => {
      line.textContent = phaseText(s);
      line.className = 'upd-line' + (s.phase === 'error' ? ' err' : '');
      const bits = [`当前版本 v${s.current || '?'}`];
      if (s.latest) bits.push(`最新版本 v${s.latest}`);
      if (s.phase === 'downloading' && s.total) bits.push(`${fmtBytes(s.transferred)} / ${fmtBytes(s.total)}`);
      if (s.savedTo) bits.push(`保存到：${s.savedTo}`);
      if (s.mode === 'portable') bits.push('便携版：下载完成后会自动替换 exe 并重启');
      if (s.error) bits.push(s.error);
      detail.textContent = bits.join(' · ');
      notes.classList.toggle('hidden', !s.notes);
      if (s.notes) notes.textContent = String(s.notes).slice(0, 1200);
      btnGet.classList.toggle('hidden', s.phase !== 'available');
      btnInstall.classList.toggle('hidden', !['downloaded', 'available'].includes(s.phase));
      if (s.phase === 'available') btnInstall.classList.add('hidden');   // 先下载再安装
      btnCheck.disabled = s.phase === 'checking' || s.phase === 'downloading';
      btnGet.disabled = s.phase === 'downloading';
    };
    btnGet.addEventListener('click', () => download());
    btnInstall.addEventListener('click', () => install());
    subscribers.push(sync);
    sync(state);

    U.modal({
      title: '软件更新',
      subtitle: '更新来自 GitHub Release（bradpittwyc/Podcasts-learning-tool）',
      narrow: true,
      body,
      buttons: [{ label: '关闭', accent: true }]
    });

    if (state.phase === 'idle' || state.phase === 'error') check();
  }

  /** 设置面板「高级」里的区块 */
  function section(settings) {
    const wrap = el('div', {});
    wrap.appendChild(el('div', { class: 'section-title', text: '软件更新' }));

    const status = el('div', { class: 'skip-note' });
    const bar = progressBar();
    const sync = (s) => {
      status.innerHTML = [
        `当前版本：<b>v${U.escapeHtml(s.current || '?')}</b> · 更新方式：${s.mode === 'portable' ? '便携版（下载后自动替换 exe）' : (s.mode === 'installer' ? '安装版（静默安装）' : '开发模式（不检查）')}`,
        `状态：${U.escapeHtml(phaseText(s))}${s.error ? '（' + U.escapeHtml(s.error) + '）' : ''}`
      ].join('<br>');
    };
    subscribers.push(sync);
    sync(state);
    wrap.appendChild(status);
    wrap.appendChild(bar);

    const auto = el('input', { type: 'checkbox' });
    auto.checked = settings.update ? settings.update.autoCheck !== false : true;
    auto.addEventListener('change', async () => {
      await window.PLT.settings.patch({ update: { autoCheck: auto.checked } });
      toast(auto.checked ? '已开启启动时自动检查更新' : '已关闭启动时自动检查更新', 'ok');
    });
    wrap.appendChild(el('label', { class: 'check-row' }, [auto, el('span', { text: '启动后自动检查更新（发现新版本只在状态栏提示，不会自动下载）' })]));

    wrap.appendChild(el('div', { class: 'row-gap' }, [
      el('button', { class: 'cb-btn', text: '检查更新', onclick: async () => { const r = await check(); if (r && r.phase === 'uptodate') toast('已是最新版本 v' + r.latest, 'ok'); } }),
      el('button', { class: 'cb-btn', text: '更新详情…', onclick: () => modal() }),
      el('button', { class: 'cb-btn', text: '打开发布页', onclick: () => window.PLT.update.openRelease() })
    ]));
    return wrap;
  }

  function init() {
    badge = document.getElementById('sbUpdate');
    if (badge) {
      badge.classList.add('hidden');
      badge.addEventListener('click', () => modal());
    }
    if (window.PLT.update && window.PLT.update.onStatus) window.PLT.update.onStatus((s) => apply(s));
    refresh();
  }

  window.PLTUpdate = {
    init,
    refresh,
    check,
    download,
    install,
    modal,
    section,
    getState: () => state,
    // 测试接缝：让冒烟测试直接注入一份状态，验证角标/进度条/按钮的渲染
    // （真实更新链路由 --smoke-update 真连 GitHub 验证，这里只管界面）
    __inject: (s) => apply(s)
  };
})();

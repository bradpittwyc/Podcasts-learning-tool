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

  const REPO_LABEL = '更新来自 GitHub Release · bradpittwyc/Podcasts-learning-tool';

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

  /** 各阶段对应的图标 / 配色 / 文案（面板顶部那块状态区用） */
  function statusMeta(s) {
    switch (s.phase) {
      case 'checking': return { cls: 'busy', icon: '⟳', title: '正在检查更新…', sub: '正在读取发布页上的最新版本' };
      case 'uptodate': return { cls: 'ok', icon: '✓', title: '已是最新版本', sub: `当前版本 v${s.current || '?'} 就是最新版` };
      case 'available': return { cls: 'new', icon: '⬆', title: `发现新版本 v${s.latest}`, sub: `当前版本 v${s.current || '?'} → 可升级到 v${s.latest}` };
      case 'downloading': return { cls: 'busy', icon: '⬇', title: `正在下载更新… ${s.percent || 0}%`, sub: s.total ? `${fmtBytes(s.transferred)} / ${fmtBytes(s.total)}` : '正在下载' };
      case 'downloaded': return { cls: 'ok', icon: '✓', title: `更新已下载完成`, sub: `v${s.latest} 已就绪，重启后生效` };
      case 'installing': return { cls: 'busy', icon: '⟳', title: '正在安装…', sub: '程序即将自动重启' };
      case 'error': return { cls: 'err', icon: '!', title: '检查更新失败', sub: s.error || '' };
      case 'unsupported': return { cls: 'muted', icon: '–', title: '当前运行方式不支持自动更新', sub: s.error || '打包成安装版 / 便携版后即可自动更新' };
      default: return { cls: 'muted', icon: '?', title: '尚未检查更新', sub: '点下面的「检查更新」试试' };
    }
  }

  function relTime(ts) {
    if (!ts) return '—';
    const d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return `${Math.floor(d / 60000)} 分钟前`;
    if (d < 86400000) return `${Math.floor(d / 3600000)} 小时前`;
    return `${Math.floor(d / 86400000)} 天前`;
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

    // ① 状态区：圆形状态徽标 + 标题 + 说明
    const dot = el('div', { class: 'upd-dot', text: '?' });
    const title = el('div', { class: 'upd-title upd-line' });        // 保留 .upd-line 供断言使用
    const sub = el('div', { class: 'upd-sub' });
    const status = el('div', { class: 'upd-status' }, [dot, el('div', { class: 'upd-status-text' }, [title, sub])]);

    // ② 信息网格：当前版本 / 最新版本 / 更新方式 / 上次检查
    const infoCur = el('div', { class: 'upd-v' });
    const infoLatest = el('div', { class: 'upd-v' });
    const infoMode = el('div', { class: 'upd-v' });
    const infoLast = el('div', { class: 'upd-v' });
    const grid = el('div', { class: 'upd-grid' }, [
      el('div', { class: 'upd-k', text: '当前版本' }), infoCur,
      el('div', { class: 'upd-k', text: '更新方式' }), infoMode,
      el('div', { class: 'upd-k', text: '最新版本' }), infoLatest,
      el('div', { class: 'upd-k', text: '上次检查' }), infoLast
    ]);

    // ③ 进度条 + 进度数字
    const bar = progressBar();
    const barPct = el('div', { class: 'upd-pct hidden' });

    // ④ 更新说明（限高滚动）
    const notesTitle = el('div', { class: 'upd-notes-title hidden', text: '更新说明' });
    const notes = el('div', { class: 'upd-notes skip-note hidden' });

    const btnCheck = el('button', { class: 'cb-btn', text: '检查更新', onclick: async () => { await check(); } });
    const btnGet = el('button', { class: 'cb-btn accent', text: '下载更新' });
    const btnInstall = el('button', { class: 'cb-btn accent', text: '立即重启并安装' });
    const btnPage = el('button', { class: 'cb-btn subtle', text: '打开发布页', onclick: () => window.PLT.update.openRelease() });
    const hint = el('div', { class: 'upd-hint', text: '只提示、不自动下载；可在 设置 → 高级 → 软件更新 里关掉自动检查' });

    body.appendChild(status);
    body.appendChild(grid);
    body.appendChild(bar);
    body.appendChild(barPct);
    body.appendChild(notesTitle);
    body.appendChild(notes);
    body.appendChild(el('div', { class: 'row-gap' }, [btnCheck, btnGet, btnInstall, btnPage]));
    body.appendChild(hint);

    const sync = (s) => {
      const meta = statusMeta(s);
      title.textContent = meta.title;
      sub.textContent = meta.sub;
      dot.textContent = meta.icon;
      dot.className = 'upd-dot ' + meta.cls;
      title.className = 'upd-title upd-line' + (meta.cls === 'err' ? ' err' : '');
      infoCur.textContent = 'v' + (s.current || '?');
      infoLatest.textContent = s.latest ? 'v' + s.latest : '—';
      infoMode.textContent = s.mode === 'portable' ? '便携版（下载后自动换 exe）'
        : s.mode === 'installer' ? '安装版（静默原地升级）' : '开发模式（不检查）';
      infoLast.textContent = relTime(s.lastCheck);
      barPct.textContent = `${s.percent || 0}%`;
      const showsPct = ['downloading', 'downloaded', 'installing'].includes(s.phase);
      barPct.classList.toggle('hidden', !showsPct);
      notes.classList.toggle('hidden', !s.notes);
      notesTitle.classList.toggle('hidden', !s.notes);
      if (s.notes) notes.textContent = String(s.notes).slice(0, 1600);
      btnGet.classList.toggle('hidden', s.phase !== 'available');
      btnInstall.classList.toggle('hidden', s.phase !== 'downloaded');
      btnCheck.disabled = s.phase === 'checking' || s.phase === 'downloading';
      btnGet.disabled = s.phase === 'downloading';
    };
    btnGet.addEventListener('click', () => download());
    btnInstall.addEventListener('click', () => install());
    subscribers.push(sync);
    sync(state);

    U.modal({
      title: '软件更新',
      subtitle: '更新来自 GitHub Release · bradpittwyc/Podcasts-learning-tool',
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

    const dot = el('div', { class: 'upd-dot', text: '?' });
    const title = el('div', { class: 'upd-title' });
    const sub = el('div', { class: 'upd-sub' });
    const status = el('div', { class: 'upd-status' }, [dot, el('div', { class: 'upd-status-text' }, [title, sub])]);
    const bar = progressBar();
    const barPct = el('div', { class: 'upd-pct hidden' });

    const sync = (s) => {
      const meta = statusMeta(s);
      dot.textContent = meta.icon;
      dot.className = 'upd-dot ' + meta.cls;
      title.textContent = meta.title;
      sub.textContent = `${meta.sub}${s.mode && s.mode !== 'none' ? '' : ''}`;
      barPct.textContent = `${s.percent || 0}%`;
      barPct.classList.toggle('hidden', !['downloading', 'downloaded', 'installing'].includes(s.phase));
    };
    subscribers.push(sync);
    sync(state);

    wrap.appendChild(status);
    wrap.appendChild(bar);
    wrap.appendChild(barPct);

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
      el('button', { class: 'cb-btn subtle', text: '打开发布页', onclick: () => window.PLT.update.openRelease() })
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

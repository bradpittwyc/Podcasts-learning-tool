'use strict';
/**
 * util.js — DOM / 格式化 / 通知 / 模态框 / 快捷键 工具
 */
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => { if (t) clearTimeout(t); t = setTimeout(() => { t = null; fn(...args); }, ms); };
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    let lastArgs = null;
    return (...args) => {
      const now = Date.now();
      lastArgs = args;
      if (now - last >= ms) { last = now; fn(...args); }
      else if (!timer) {
        timer = setTimeout(() => { timer = null; last = Date.now(); fn(...lastArgs); }, ms - (now - last));
      }
    };
  }

  const fmtClock = (sec) => {
    const s = Math.max(0, Number(sec) || 0);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = Math.floor(s % 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  };

  const fmtBytes = (n) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(n) || 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  };

  const fmtRelTime = (ts) => {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const min = 60000;
    if (diff < min) return '刚刚';
    if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
    if (diff < 30 * 24 * 60 * min) return `${Math.floor(diff / (24 * 60 * min))} 天前`;
    return new Date(ts).toLocaleDateString('zh-CN');
  };

  // ── Toast ──
  let lastToastKey = '';
  let lastToastAt = 0;
  function toast(message, type, ms) {
    const host = $('#toastHost');
    if (!host) return;
    const text = String(message ?? '');
    // 3 秒内相同内容只显示一次，避免重复提示堆叠
    const key = type + '|' + text;
    const now = Date.now();
    if (key === lastToastKey && now - lastToastAt < 3000) return;
    lastToastKey = key;
    lastToastAt = now;

    const node = el('div', { class: `toast ${type || ''}` }, [
      el('div', { class: 'toast-msg', text })
    ]);
    host.appendChild(node);
    // 最多同时显示 3 条
    while (host.children.length > 3) host.firstChild.remove();
    const life = ms || (type === 'err' ? 6500 : 3400);
    const kill = () => {
      if (!node.isConnected) return;
      node.classList.add('out');
      setTimeout(() => node.remove(), 240);
    };
    node.addEventListener('click', kill);
    setTimeout(kill, life);
    return node;
  }

  // ── 模态框 ──
  function modal(opts) {
    const host = $('#modalHost');
    const box = el('div', { class: `modal ${opts.narrow ? 'narrow' : ''}` });
    const head = el('div', { class: 'modal-head' }, [
      el('div', {}, [
        el('div', { class: 'modal-title', text: opts.title || '' }),
        opts.subtitle ? el('div', { class: 'modal-sub', text: opts.subtitle }) : null
      ])
    ]);
    const closeBtn = el('button', { class: 'icon-btn', title: '关闭', html: '&times;', style: { marginLeft: 'auto' } });
    head.appendChild(closeBtn);
    const body = el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);
    box.appendChild(head);
    box.appendChild(body);

    const api = {
      box,
      body,
      close(result) {
        host.classList.add('hidden');
        clear(host);
        document.removeEventListener('keydown', onKey, true);
        if (opts.onClose) opts.onClose(result);
      }
    };

    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); api.close(null); }
    }

    if (opts.buttons && opts.buttons.length) {
      const foot = el('div', { class: 'modal-foot' });
      for (const b of opts.buttons) {
        foot.appendChild(el('button', {
          class: `cb-btn ${b.accent ? 'accent' : ''}`,
          text: b.label,
          onclick: () => {
            const r = b.action ? b.action(api) : undefined;
            if (r === false) return;
            if (b.keepOpen) return;
            api.close(r);
          }
        }));
      }
      box.appendChild(foot);
    }

    closeBtn.addEventListener('click', () => api.close(null));
    host.addEventListener('mousedown', (e) => { if (e.target === host && opts.dismissable !== false) api.close(null); });
    document.addEventListener('keydown', onKey, true);

    clear(host);
    host.appendChild(box);
    host.classList.remove('hidden');
    if (opts.render) opts.render(box, api);
    return api;
  }

  function confirm(message, opts) {
    return new Promise((resolve) => {
      modal({
        title: (opts && opts.title) || '确认',
        narrow: true,
        body: el('div', { class: 'form', style: { paddingTop: '18px' } }, [el('div', { text: message, style: { lineHeight: '1.7', fontSize: '13px' } })]),
        buttons: [
          { label: '取消', action: () => resolve(false) },
          { label: (opts && opts.okLabel) || '确定', accent: true, action: () => resolve(true) }
        ],
        onClose: () => resolve(false)
      });
    });
  }

  function prompt(title, value, opts) {
    return new Promise((resolve) => {
      let closeFn = null;
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; resolve(v); };
      const input = el('input', { type: 'text', value: value ?? '', style: { width: '100%' } });
      modal({
        title,
        narrow: true,
        subtitle: opts && opts.subtitle,
        body: el('div', { class: 'form', style: { paddingTop: '18px' } }, [input]),
        buttons: [
          { label: '取消', action: () => finish(null) },
          { label: '确定', accent: true, action: () => finish(input.value) }
        ],
        render: (box, api) => {
          closeFn = api.close;
          setTimeout(() => { input.focus(); input.select(); }, 40);
        },
        onClose: () => finish(null)
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const v = input.value;
          if (closeFn) closeFn(v); else finish(v);
        }
      });
    });
  }

  // ── 右键菜单 ──
  function contextMenu(x, y, items) {
    const menu = $('#contextMenu');
    clear(menu);
    for (const item of items) {
      if (!item || item.sep) { menu.appendChild(el('div', { class: 'ctx-sep' })); continue; }
      menu.appendChild(el('button', {
        class: 'ctx-item',
        onclick: () => { hideContextMenu(); item.action && item.action(); }
      }, [
        el('span', { text: item.label }),
        item.kbd ? el('span', { class: 'kbd', text: item.kbd }) : null
      ]));
    }
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${clamp(x, 4, window.innerWidth - rect.width - 4)}px`;
    menu.style.top = `${clamp(y, 4, window.innerHeight - rect.height - 4)}px`;
  }

  function hideContextMenu() { $('#contextMenu').classList.add('hidden'); }

  document.addEventListener('mousedown', (e) => {
    const menu = $('#contextMenu');
    if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target)) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);

  // ── 快捷键描述（mac 风格显示）──
  function prettyAccel(accel) {
    return String(accel || '')
      .replace(/CommandOrControl|CmdOrCtrl|Ctrl/gi, 'Ctrl')
      .replace(/Shift/gi, 'Shift')
      .replace(/Alt/gi, 'Alt')
      .replace(/Space/gi, '空格');
  }

  // ── 简易存储（界面偏好）──
  const ls = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('plt.' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch (_) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('plt.' + key, JSON.stringify(value)); } catch (_) { /* ignore */ }
    }
  };

  // ── 文本相似度（跟读对比，字符级 Levenshtein）──
  function similarity(a, b) {
    const s1 = String(a || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
    const s2 = String(b || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
    if (!s1 && !s2) return 1;
    if (!s1 || !s2) return 0;
    const m = s1.length;
    const n = s2.length;
    if (m * n > 400000) return 0; // 过长不做精细比对
    let prev = new Array(n + 1);
    let cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return 1 - prev[n] / Math.max(m, n);
  }

  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  const LEVEL_TAG_CLASS = {
    IELTS: 'ielts', TOEFL: 'toefl', GRE: 'gre', ACADEMIC: 'academic', NATIVE: 'native'
  };

  function cefrTagClass(entry) {
    if (!entry) return '';
    if (entry.rare) return 'native';
    return String(entry.cefr || 'b1').toLowerCase().replace('+', '');
  }

  function buildTags(entry, opts) {
    const tags = [];
    if (!entry) return tags;
    if (entry.cefr) tags.push({ cls: cefrTagClass(entry), text: entry.cefr });
    for (const ex of (entry.examLevels || [])) {
      tags.push({ cls: LEVEL_TAG_CLASS[String(ex).toUpperCase()] || '', text: ex });
    }
    if (entry.isAcademic) tags.push({ cls: 'academic', text: '学术' });
    if (entry.isIdiom) tags.push({ cls: 'academic', text: '习语' });
    if (entry.rare) tags.push({ cls: 'native', text: '生僻' });
    if (entry.pos) tags.push({ cls: '', text: entry.pos });
    if (opts && opts.cached) tags.push({ cls: 'cached', text: '缓存' });
    return tags;
  }

  function renderTags(entry, opts) {
    const wrap = el('div', { class: 'dict-tags' });
    for (const t of buildTags(entry, opts)) wrap.appendChild(el('span', { class: `tag ${t.cls}`, text: t.text }));
    return wrap;
  }

  window.PLTUtil = {
    $, $$, el, clear, escapeHtml, clamp, debounce, throttle,
    fmtClock, fmtBytes, fmtRelTime,
    toast, modal, confirm, prompt, contextMenu, hideContextMenu,
    prettyAccel, ls, similarity, download,
    buildTags, renderTags, cefrTagClass
  };
}());

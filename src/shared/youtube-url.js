'use strict';
/**
 * youtube-url.js — YouTube 链接解析（纯函数，不依赖 Electron）
 *
 * 放在 shared/ 是为了让主进程和 `npm test` 的自检脚本共用同一份实现，
 * 避免「界面认得出的链接，自检里认不出」这种两套逻辑漂移。
 */

/** YouTube 的 videoId 固定 11 位 */
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/** 认可的域名（含各国家二级域与隐私增强域） */
const HOST_RE = /(?:^|\.)(?:youtube\.com|youtube-nocookie\.com|youtu\.be)$/i;

/**
 * 从任意形态的 YouTube 链接里取出 videoId。
 * 覆盖：watch?v= / youtu.be/<id> / shorts/<id> / embed/<id> / live/<id> / v/<id>
 * 也接受直接粘进来的 11 位裸 ID。
 *
 * @param {string} input
 * @returns {{id:string, url:string, list:string|null, start:number}|null}
 */
function parseUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return null;

  if (VIDEO_ID_RE.test(raw)) return build(raw, null, 0);

  let u;
  try { u = new URL(raw.startsWith('http') ? raw : 'https://' + raw); } catch (_) { return null; }
  // 去掉 www. / m. / music. 等前缀后比对主域
  const mainHost = u.hostname.replace(/^(?:www\.|m\.|music\.)/i, '');
  if (!HOST_RE.test(mainHost)) return null;

  const list = u.searchParams.get('list') || null;
  const start = parseStart(u.searchParams.get('t') || u.searchParams.get('start'));

  const host = mainHost.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);

  let id = u.searchParams.get('v');
  if (id && !VIDEO_ID_RE.test(id)) id = null;

  if (!id) {
    if (host === 'youtu.be') {
      if (seg.length && VIDEO_ID_RE.test(seg[0])) id = seg[0];
    } else {
      const idx = seg.findIndex((s) => ['shorts', 'embed', 'live', 'v'].includes(s.toLowerCase()));
      const cand = idx >= 0 ? seg[idx + 1] : null;
      if (cand && VIDEO_ID_RE.test(cand)) id = cand;
    }
  }
  if (!id) return null;
  return build(id, list, start);
}

/** t 参数可能是 `90`、`1m30s`、`1h2m3s` */
function parseStart(raw) {
  const s = String(raw || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s);
  const h = (s.match(/(\d+)h/) || [])[1];
  const m = (s.match(/(\d+)m/) || [])[1];
  const sec = (s.match(/(\d+)s/) || [])[1];
  if (!h && !m && !sec) return 0;
  return (Number(h) || 0) * 3600 + (Number(m) || 0) * 60 + (Number(sec) || 0);
}

function build(id, list, start) {
  const qs = new URLSearchParams();
  if (list) qs.set('list', list);
  if (start) qs.set('t', String(start));
  const q = qs.toString();
  return { id, url: `https://www.youtube.com/watch?v=${id}${q ? '&' + q : ''}`, list: list || null, start: start || 0 };
}

module.exports = { parseUrl, parseStart, VIDEO_ID_RE };

'use strict';
/**
 * publish-release.js — 把构建产物发到 GitHub Release（自动更新专用上传器）
 *
 * 为什么不用 `gh release upload`：
 *   1. gh 会把文件名里的空格自动换成点（Podcasts Learning Tool-... → Podcasts.Learning.Tool-...），
 *      而 electron-updater 是**严格按 latest.yml 里写的文件名**去拼下载地址的 ——
 *      名字一旦对不上，安装版的自动更新就会 404。这里必须由我们指定确切资产名。
 *   2. 中文 release 正文经 PowerShell 传递会被编码搞坏。
 *
 * 用法：
 *   node scripts/publish-release.js --tag v1.0.2 --title "…" --notes .github/RELEASE_NOTES.md \
 *        --asset "release\xxx-Portable-1.0.2.exe=Podcasts-Learning-Tool-Portable-1.0.2.exe" \
 *        --asset "release-public\latest.yml=latest.yml" --latest
 *
 * 令牌：优先 GH_TOKEN / GITHUB_TOKEN，其次 `gh auth token`。
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const REPO = { owner: 'bradpittwyc', repo: 'Podcasts-learning-tool' };
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}`;

function parseArgs(argv) {
  const out = { assets: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tag') out.tag = argv[++i];
    else if (a === '--title') out.title = argv[++i];
    else if (a === '--notes') out.notes = argv[++i];
    else if (a === '--asset') out.assets.push(argv[++i]);
    else if (a === '--latest') out.latest = true;
    else if (a === '--draft') out.draft = true;
  }
  return out;
}

function token() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execSync('gh auth token', { encoding: 'utf8' }).trim(); } catch (_) { return ''; }
}

const TOKEN = token();
if (!TOKEN) { console.error('× 找不到 GitHub 令牌（设置 GH_TOKEN 或先 gh auth login）'); process.exit(1); }

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PLT-Release-Publisher',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* 上传资产接口返回体可能为空 */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function ensureRelease(args) {
  const body = {
    tag_name: args.tag,
    name: args.title || args.tag,
    body: args.notes ? fs.readFileSync(args.notes, 'utf8') : '',
    draft: !!args.draft,
    prerelease: false,
    make_latest: args.latest ? 'true' : 'false'
  };
  let r = await api(`${API}/releases`, { method: 'POST', body: JSON.stringify(body) });
  if (r.status === 422) {
    console.log('· Release 已存在，改为更新正文');
    const cur = await api(`${API}/releases/tags/${args.tag}`);
    if (!cur.ok) throw new Error('取已有 Release 失败：' + cur.text.slice(0, 200));
    r = await api(`${API}/releases/${cur.json.id}`, { method: 'PATCH', body: JSON.stringify(body) });
  }
  if (!r.ok) throw new Error('创建 Release 失败：' + r.status + ' ' + r.text.slice(0, 300));
  return r.json;
}

async function uploadAsset(releaseId, file, name) {
  if (!fs.existsSync(file)) throw new Error('文件不存在：' + file);
  const size = fs.statSync(file).size;
  // 同名资产先删掉（--clobber 语义）
  const list = await api(`${API}/releases/${releaseId}/assets?per_page=100`);
  const dup = (list.json || []).find((a) => a.name === name);
  if (dup) { await api(`${API}/releases/assets/${dup.id}`, { method: 'DELETE' }); console.log('  · 已删除同名旧资产'); }

  const buf = fs.readFileSync(file);
  const res = await api(
    `https://uploads.github.com/repos/${REPO.owner}/${REPO.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: buf }
  );
  if (!res.ok) throw new Error(`上传 ${name} 失败：${res.status} ${res.text.slice(0, 200)}`);
  console.log(`  ✓ ${name}  ${(size / 1048576).toFixed(2)}MB`);
  return res.json;
}

(async () => {
  const args = parseArgs(process.argv);
  if (!args.tag) { console.error('× 缺少 --tag'); process.exit(1); }
  console.log(`发布 ${args.tag} → ${REPO.owner}/${REPO.repo}`);
  const rel = await ensureRelease(args);
  console.log(`· Release id=${rel.id}（${rel.html_url}）`);
  for (const spec of args.assets) {
    const [file, name] = spec.includes('=') ? spec.split(/=(?=[^\\/]*$)/) : [spec, path.basename(spec)];
    await uploadAsset(rel.id, file, name || path.basename(file));
  }
  const final = await api(`${API}/releases/${rel.id}`);
  console.log('\n=== 最终资产 ===');
  for (const a of final.json.assets) console.log(`  ${a.name}  ${(a.size / 1048576).toFixed(2)}MB`);
  console.log('\n完成。');
})().catch((err) => { console.error('× ' + err.message); process.exit(1); });

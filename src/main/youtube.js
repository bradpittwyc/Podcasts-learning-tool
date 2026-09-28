'use strict';
/**
 * youtube.js — 在线视频（YouTube）支持：链接解析 / 元数据 / 下载落地
 *
 * 两条路，由用户在界面上选：
 *   1) 在线速听：渲染层直接用 YouTube IFrame API 播，零依赖、秒开，但没有字幕文本
 *      （拿不到字幕 → 点句跳转 / 分级取词 / 跟读这些功能用不了）
 *   2) 下载到本地：调 yt-dlp 把音视频 + 字幕抓下来，之后当普通本地文件播放 —— 全部功能照常。
 *
 * 依赖说明：yt-dlp 不随仓库分发（体积大且更新频繁），首次使用时可一键下载到数据目录；
 * ffmpeg 只影响「能不能合并视频+音频」，缺了就自动降级为只下音频。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { app, net } = require('electron');

const { settings, getDataDir } = require('./store');
const { parseUrl } = require('../shared/youtube-url');   // 纯函数，与自检共用同一份实现

const TOOL_DIR_NAME = 'tools';
const YT_DIR_NAME = 'YouTube';
const DLP_RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

const MEDIA_EXT = new Set(['.mp4', '.m4a', '.mp3', '.webm', '.mkv', '.mov', '.opus', '.ogg', '.flac', '.wav']);
const SUB_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.lrc', '.json']);

// ══════════════════════════════════════════════════════════
// 链接解析
// ══════════════════════════════════════════════════════════

/**
 * 取标题 / 作者 / 缩略图：走 YouTube 公开 oEmbed，不需要 Key。
 * 失败时退化为 { title: null }，界面用 videoId 兜底，不阻塞播放。
 */
async function fetchMeta(videoUrl) {
  const endpoint = 'https://www.youtube.com/oembed?' +
    new URLSearchParams({ url: videoUrl, format: 'json' }).toString();
  try {
    const res = await net.fetch(endpoint, { headers: { 'User-Agent': 'Podcasts-Learning-Tool' } });
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const j = await res.json();
    return { ok: true, title: j.title || null, author: j.author_name || null, thumbnail: j.thumbnail_url || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════
// 外部工具探测 / 安装
// ══════════════════════════════════════════════════════════

function toolsDir() {
  return path.join(getDataDir(), TOOL_DIR_NAME);
}

function defaultDownloadDir() {
  return path.join(getDataDir(), YT_DIR_NAME);
}

function downloadDir() {
  return settings().get('yt.downloadDir', '') || defaultDownloadDir();
}

function isFile(p) {
  try { return !!p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch (_) { return false; }
}

/** yt-dlp 在哪：设置里指定的 → 数据目录 tools → 程序资源目录 → PATH */
function findYtDlp() {
  const configured = String(settings().get('yt.dlpPath', '') || '').trim();
  if (configured && isFile(configured)) return configured;

  const candidates = [];
  try { candidates.push(path.join(toolsDir(), 'yt-dlp.exe')); } catch (_) { }
  try { candidates.push(path.join(process.resourcesPath || '', 'yt-dlp.exe')); } catch (_) { }
  try { candidates.push(path.join(app.getAppPath(), 'yt-dlp.exe')); } catch (_) { }
  for (const c of candidates) if (isFile(c)) return c;

  try {
    const r = spawnSync('yt-dlp', ['--version'], { windowsHide: true });
    if (!r.error && r.status === 0) return 'yt-dlp';
  } catch (_) { /* ignore */ }
  return null;
}

function hasFfmpeg() {
  try {
    const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true });
    return !r.error && r.status === 0;
  } catch (_) { return false; }
}

function toolStatus() {
  const dlp = findYtDlp();
  return {
    ytdlp: dlp,
    ytdlpReady: !!dlp,
    ffmpeg: hasFfmpeg(),
    downloadDir: downloadDir(),
    toolsDir: toolsDir()
  };
}

/** 一键下载 yt-dlp.exe 到数据目录 tools\（进度回调 0~100） */
async function installYtDlp(onProgress) {
  const dir = toolsDir();
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'yt-dlp.exe');
  const tmp = target + '.part';

  const res = await net.fetch(DLP_RELEASE_URL, {
    headers: { 'User-Agent': 'Podcasts-Learning-Tool', Accept: 'application/octet-stream' }
  });
  if (!res.ok) throw new Error('下载失败：HTTP ' + res.status);

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, target);

  if (typeof onProgress === 'function') onProgress(100);
  return { path: target, bytes: buf.length };
}

// ══════════════════════════════════════════════════════════
// 下载任务
// ══════════════════════════════════════════════════════════

const jobs = new Map();   // jobId → { proc, canceled }
let jobSeq = 0;

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return false;
  job.canceled = true;
  try { job.proc.kill('SIGKILL'); } catch (_) { /* ignore */ }
  jobs.delete(jobId);
  return true;
}

/** 取消全部进行中的下载（界面上只有一个下载入口，够用） */
function cancelAll() {
  let n = 0;
  for (const id of [...jobs.keys()]) if (cancelJob(id)) n++;
  return n;
}

/**
 * 跑 yt-dlp。每个视频落到 <downloadDir>/<videoId>/ 下，
 * 结束后直接列目录取回媒体与字幕 —— 不依赖 stdout 里的文件名，更稳。
 * @param {{url:string, id:string, onProgress?:Function}} opts
 * @returns {Promise<{media:string, subtitles:string[], dir:string}>}
 */
function downloadVideo(opts) {
  const dlp = findYtDlp();
  if (!dlp) return Promise.reject(new Error('NO_YTDLP'));

  const id = opts.id;
  const dir = path.join(downloadDir(), id);
  fs.mkdirSync(dir, { recursive: true });

  const withVideo = settings().get('yt.preferVideo', true) !== false && hasFfmpeg();
  const args = [
    '--newline',
    '--no-playlist',
    '--no-part',
    '--windows-filenames',
    '-o', path.join(dir, '%(title).180B.%(ext)s'),
    '--write-subs', '--write-auto-subs',
    '--sub-langs', 'en.*,en',
    '--sub-format', 'vtt/srt/best',
    opts.url
  ];
  // 格式：有 ffmpeg 就合成 mp4；没有就只能拿音频（字幕仍然能下）
  args.splice(3, 0, '-f', withVideo
    ? 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b'
    : 'ba[ext=m4a]/ba/b');
  if (withVideo) args.splice(args.length - 1, 0, '--merge-output-format', 'mp4');

  const jobId = ++jobSeq;
  const proc = spawn(dlp, args, { windowsHide: true, cwd: dir });
  const job = { proc, canceled: false, id: jobId };
  jobs.set(jobId, job);

  return new Promise((resolve, reject) => {
    let stderr = '';
    let lastPct = -1;

    const pump = (chunk) => {
      const text = chunk.toString('utf8');
      for (const line of text.split(/[\r\n]+/)) {
        const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
        if (m) {
          const pct = Math.floor(Number(m[1]));
          if (pct !== lastPct) {
            lastPct = pct;
            if (typeof opts.onProgress === 'function') opts.onProgress(pct, line.trim());
          }
        }
      }
    };

    proc.stdout.on('data', pump);
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    proc.on('error', (err) => { jobs.delete(jobId); reject(err); });
    proc.on('close', (code) => {
      jobs.delete(jobId);
      if (job.canceled) { reject(new Error('CANCELED')); return; }
      if (code !== 0) {
        reject(new Error(`yt-dlp 退出码 ${code}：${(stderr || '').split('\n').filter(Boolean).slice(-3).join(' | ')}`));
        return;
      }
      try {
        const result = collectOutput(dir);
        if (!result.media) throw new Error('下载完成但没找到媒体文件：' + dir);
        resolve(result);
      } catch (err) { reject(err); }
    });
  });
}

/** 从输出目录里挑出媒体文件（取最大的那个）与字幕文件 */
function collectOutput(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const full = path.join(dir, e.name);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (_) { /* ignore */ }
      return { name: e.name, full, size, ext: path.extname(e.name).toLowerCase() };
    });

  const mediaCandidates = entries
    .filter((e) => MEDIA_EXT.has(e.ext) && e.size > 0)
    // .part / .f*.temp 这类中间文件不算
    .filter((e) => !/\.(part|temp|ytdl)$/i.test(e.name))
    .sort((a, b) => b.size - a.size);

  const subtitles = entries
    .filter((e) => SUB_EXT.has(e.ext))
    // 自动生成的字幕名字里带语言码，取最大的那份英文即可
    .sort((a, b) => b.size - a.size);

  return {
    dir,
    media: mediaCandidates.length ? mediaCandidates[0].full : null,
    subtitles: subtitles.map((s) => s.full)
  };
}

module.exports = {
  parseUrl,
  fetchMeta,
  toolStatus,
  installYtDlp,
  downloadVideo,
  cancelJob,
  cancelAll,
  findYtDlp,
  hasFfmpeg,
  downloadDir,
  defaultDownloadDir,
  collectOutput
};

'use strict';
/**
 * make-sample.js — 生成用于自测/演示的样例媒体与字幕
 *   node scripts/make-sample.js
 * 产物（默认写入 samples/，已在 .gitignore 中忽略）：
 *   samples/english-podcast.mp4   60 秒 H.264 + AAC 视频（带时间码画面）
 *   samples/english-podcast.mp3   60 秒 MP3 音频
 *   samples/english-podcast.srt   中英双语字幕（含 A2~C2 各级别词汇，便于验证分级取词）
 *   samples/english-podcast.txt   纯文本讲义（验证无时间轴自动断句）
 * 需要系统 PATH 中存在 ffmpeg / ffprobe。
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'samples');
const DURATION = 60;

const LINES = [
  ['Welcome to the Podcasts Learning Tool demo.', '欢迎使用播客学习工具演示。'],
  ['Today we explore how scientists measure the ocean.', '今天我们来看看科学家如何测量海洋。'],
  ['The expedition relied on meticulous planning.', '这次探险依赖于一丝不苟的规划。'],
  ['Their instruments could withstand immense pressure.', '他们的仪器能够承受巨大的压力。'],
  ['A submarine descended into the abyssal zone.', '一艘潜艇下潜到了深渊带。'],
  ['The data revealed an unprecedented ecosystem.', '数据揭示了一个前所未有的生态系统。'],
  ['Creatures thrive in complete darkness.', '生物在完全黑暗中繁衍生息。'],
  ['Bioluminescence flickers along the trench walls.', '生物发光沿着海沟壁闪烁。'],
  ['Researchers catalogued every specimen carefully.', '研究人员仔细编目了每一个标本。'],
  ['The findings challenge a long-held assumption.', '这些发现挑战了一个长期存在的假设。'],
  ['Most textbooks oversimplify the deep sea.', '大多数教科书把深海过于简单化了。'],
  ['Nutrients drift down from the surface.', '营养物质从海面漂落下来。'],
  ['The team deployed autonomous gliders.', '团队部署了自主滑翔机。'],
  ['Each glider transmitted data every hour.', '每台滑翔机每小时传输一次数据。'],
  ['This ubiquity of sensors transformed the field.', '传感器的这种普遍存在改变了这个领域。'],
  ['Funding remains a perennial problem.', '资金仍然是一个长期存在的问题。'],
  ['Nevertheless, the crew persisted.', '尽管如此，船员们坚持了下来。'],
  ['They documented species previously unknown to science.', '他们记录了此前科学界未知的物种。'],
  ['The implications for medicine are profound.', '这对医学的意义是深远的。'],
  ['Compounds from sponges may fight infections.', '海绵中的化合物可能对抗感染。'],
  ['Conservation policies must keep pace.', '保护政策必须跟上步伐。'],
  ['We should not squander this fragile heritage.', '我们不应挥霍这份脆弱的遗产。'],
  ['Thank you for listening, and keep learning.', '感谢收听，继续学习。'],
  ['Subscribe for more episodes like this one.', '订阅以获取更多类似节目。']
];

const SRT_ZH_EN = (() => {
  const per = DURATION / LINES.length;
  let out = '';
  LINES.forEach(([en, zh], i) => {
    const fmt = (s) => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = Math.floor(s % 60);
      const ms = Math.round((s - Math.floor(s)) * 1000);
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
    };
    const start = i * per + 0.15;
    const end = (i + 1) * per - 0.25;
    out += `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${en}\n${zh}\n\n`;
  });
  return out;
})();

function which(exe) {
  const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [exe], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function run(exe, args) {
  const r = spawnSync(exe, args, { stdio: 'inherit' });
  return r.status === 0;
}

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const srtPath = path.join(OUT, 'english-podcast.srt');
  fs.writeFileSync(srtPath, '\uFEFF' + SRT_ZH_EN, 'utf8');
  console.log('✓ 字幕：' + srtPath);

  const txtPath = path.join(OUT, 'english-podcast.txt');
  fs.writeFileSync(txtPath, LINES.map(([en]) => en).join(' '), 'utf8');
  console.log('✓ 纯文本：' + txtPath);

  const ffmpeg = which('ffmpeg');
  if (!ffmpeg) {
    console.log('! 未找到 ffmpeg，跳过媒体生成（字幕样例已就绪，可直接导入任意本地音视频）');
    return;
  }

  const video = path.join(OUT, 'english-podcast.mp4');
  console.log('· 生成 MP4（约 60 秒，可能需要十几秒）…');
  const okVideo = run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=0x10243f:s=960x540:d=${DURATION}:r=24`,
    '-f', 'lavfi', '-i', `sine=frequency=220:duration=${DURATION}:sample_rate=44100`,
    '-vf', "drawtext=fontfile='C\\:/Windows/Fonts/segoeui.ttf':text='Podcasts Learning Tool  %{pts\\:hms}':fontcolor=white:fontsize=34:x=(w-text_w)/2:y=(h-text_h)/2-40," +
           "drawtext=fontfile='C\\:/Windows/Fonts/segoeui.ttf':text='Demo Episode - Deep Sea Science':fontcolor=0x9ad4ff:fontsize=26:x=(w-text_w)/2:y=(h-text_h)/2+20",
    '-af', 'volume=0.25',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '48',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart',
    video
  ]);
  console.log(okVideo ? '✓ 视频：' + video : '✗ MP4 生成失败（检查 ffmpeg 是否带 libx264/aac）');

  const mp3 = path.join(OUT, 'english-podcast.mp3');
  console.log('· 生成 MP3…');
  const okMp3 = run(ffmpeg, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `sine=frequency=330:duration=${DURATION}:sample_rate=44100`,
    '-af', 'volume=0.25', '-c:a', 'libmp3lame', '-b:a', '128k', mp3
  ]);
  console.log(okMp3 ? '✓ 音频：' + mp3 : '✗ MP3 生成失败');

  console.log('\n完成。用法：启动应用后把 samples\\english-podcast.mp4 拖进去（同名字幕会自动加载）。');
}

main();

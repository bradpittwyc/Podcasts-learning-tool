'use strict';
// 分析冒烟 trace：打印 UI 探测失败项与关键行
const fs = require('fs');
const file = process.argv[2] || 'samples/d2-trace.txt';
const t = fs.readFileSync(file, 'utf8');

const want = process.argv.slice(3);
for (const line of t.split('\n')) {
  const clean = line.replace(/^\[[^\]]+\]\s*/, '');
  if (/UI 探测异常|结果：|页面错误/.test(clean)) console.log(clean.slice(0, 400));
  if (want.length && want.some((w) => clean.includes(w))) console.log(clean.slice(0, 900));
}

// 定位失败的断言
const i = t.indexOf('"1b 真实坐标点击播放按钮"');
if (i > 0) {
  try {
    const start = t.indexOf('{', t.indexOf('UI 探测结果'));
    const json = t.slice(start, t.indexOf('\n[', start));
    const obj = JSON.parse(json.replace(/^\[[^\]]+\]\s*/, ''));
    const checks = [
      ['1a 暂停态显示三角', obj['1a'] && obj['1a'].playVisible === true && obj['1a'].pauseVisible === false],
      ['1b 播放中显示两道竖', obj['1b 真实坐标点击播放按钮'] && obj['1b 真实坐标点击播放按钮'].pauseVisible === true
        && obj['1b 真实坐标点击播放按钮'].playVisible === false && obj['1b 真实坐标点击播放按钮'].paused === false],
      ['1c 再点回到三角', obj['1c 再点一次（应回到三角 + paused）'] && obj['1c 再点一次（应回到三角 + paused）'].playVisible === true
        && obj['1c 再点一次（应回到三角 + paused）'].paused === true],
      ['1d 三处图标同步', obj['1d 三个播放按钮图标是否同步'] && obj['1d 三个播放按钮图标是否同步'].allSynced === true],
      ['2b 进度条拖动到 50%', obj['2b 拖动到 50%'] && obj['2b 拖动到 50%'].tUp > 20],
      ['3a 点字幕跳转（不回到开头）', obj['3a 点最后一行（应跳到 ~57s，保持暂停/不回到开头）'] && obj['3a 点最后一行（应跳到 ~57s，保持暂停/不回到开头）'].after > 30],
      ['4a 字幕菜单可用', obj['4a 字幕按钮与菜单'] && obj['4a 字幕按钮与菜单'].menuVisible],
      ['5a 点词出释义', obj['5a 点击单词 → 词典面板'] && obj['5a 点击单词 → 词典面板'].panelVisible]
    ];
    console.log('\n=== 断言明细 ===');
    for (const [name, ok] of checks) console.log((ok ? 'PASS ' : 'FAIL ') + name);
  } catch (err) {
    console.log('解析 UI 探测结果失败：' + err.message);
  }
}

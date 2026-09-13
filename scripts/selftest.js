'use strict';
/**
 * selftest.js — 无界面自检（node scripts/selftest.js）
 * 校验字幕解析、编码嗅探、序列化、分词、级别分级逻辑，以及关键文件完整性。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}

function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b), `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const S = require(path.join(ROOT, 'src', 'renderer', 'js', 'subtitles.js'));

console.log('\n=== 1. 时间戳 ===');
eq('parseTimestamp 00:01:02,345', S.parseTimestamp('00:01:02,345'), 62.345);
eq('parseTimestamp 00:01:02.345', S.parseTimestamp('00:01:02.345'), 62.345);
eq('parseTimestamp 1:02.5', S.parseTimestamp('1:02.5'), 62.5);
eq('parseTimestamp 62.5', S.parseTimestamp('62.5'), 62.5);
eq('formatTimestamp srt', S.formatTimestamp(62.345, 'srt'), '00:01:02,345');
eq('formatTimestamp vtt', S.formatTimestamp(62.345, 'vtt'), '00:01:02.345');
eq('formatClock 62', S.formatClock(62), '01:02');
eq('formatClock 3725', S.formatClock(3725), '1:02:05');

console.log('\n=== 2. 双语拆分 ===');
const bi = S.splitBilingual('Hello world, this is a test.\n你好世界，这是一次测试。');
eq('英文行提取', bi.en, 'Hello world, this is a test.');
eq('中文行提取', bi.zh, '你好世界，这是一次测试。');
const mixed = S.splitBilingual('I love 北京 very much');
ok('混排拆分含中文', mixed.zh.includes('北京'), mixed.zh);
ok('混排拆分含英文', mixed.en.includes('I love'), mixed.en);

console.log('\n=== 3. SRT 解析 ===');
const srt = `1
00:00:01,000 --> 00:00:03,500
Hello there.
你好。

2
00:00:04,000 --> 00:00:07,250
<i>This is</i> a test.
这是一次测试。
`;
const cues = S.cuesFromText(srt, 'srt');
eq('cue 数量', cues.length, 2);
eq('第 1 行开始时间', cues[0].start, 1);
eq('第 1 行结束时间', cues[0].end, 3.5);
eq('第 1 行英文', cues[0].en, 'Hello there.');
eq('第 1 行中文', cues[0].zh, '你好。');
eq('HTML 标签剥离', cues[1].en, 'This is a test.');
eq('indexAt(5)', S.indexAt(cues, 5), 1);
eq('indexAt(0.5)', S.indexAt(cues, 0.5), -1);
eq('indexAt(100)', S.indexAt(cues, 100), 1);

console.log('\n=== 4. VTT / ASS / LRC / JSON ===');
const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
First line
第一行

00:00:03.000 --> 00:00:04.000
Second line
第二行
`;
const vc = S.cuesFromText(vtt, 'vtt');
eq('VTT 行数', vc.length, 2);
eq('VTT 英文', vc[1].en, 'Second line');

const ass = `[Script Info]
Title: test
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\i1}Hello{\\i0} world
Dialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,你好世界
`;
const ac = S.cuesFromText(ass, 'ass');
eq('ASS 行数', ac.length, 2);
eq('ASS 标签剥离', ac[0].en, 'Hello world');
eq('ASS 中文', ac[1].zh, '你好世界');

const lrc = `[ti:Song]
[offset:0]
[00:01.00]First lyric line
[00:03.50]Second lyric line
`;
const lc = S.cuesFromText(lrc, 'lrc');
eq('LRC 行数', lc.length, 2);
eq('LRC 第一行开始', lc[0].start, 1);
eq('LRC 第一行结束=下一行开始', lc[0].end, 3.5);

const json = JSON.stringify({ cues: [{ start: 1, end: 2, en: 'Hello', zh: '你好' }] });
const jc = S.cuesFromText(json, 'json');
eq('JSON 行数', jc.length, 1);
eq('JSON 中文', jc[0].zh, '你好');

console.log('\n=== 5. 纯文本断句 ===');
const plain = 'This is sentence one. This is sentence two! And a third one?';
const pc = S.cuesFromText(plain, 'text', { duration: 30 });
eq('纯文本断句为 3 句', pc.length, 3);
ok('时间戳递增', pc[1].start >= pc[0].end - 0.01, `${pc[1].start} vs ${pc[0].end}`);
ok('覆盖总时长≈30s', Math.abs(pc[pc.length - 1].end - 30) < 1.5, String(pc[pc.length - 1].end));

console.log('\n=== 6. 序列化往返 ===');
const outSrt = S.serialize(cues, 'srt', { bilingual: true });
const back = S.cuesFromText(outSrt, 'srt');
eq('SRT 往返行数', back.length, 2);
eq('SRT 往返英文', back[0].en, 'Hello there.');
eq('SRT 往返中文', back[0].zh, '你好。');
const outVtt = S.serialize(cues, 'vtt');
ok('VTT 头正确', outVtt.startsWith('WEBVTT'), outVtt.slice(0, 20));
const outJson = JSON.parse(S.serialize(cues, 'json'));
eq('JSON 导出 cues 长度', outJson.cues.length, 2);

console.log('\n=== 7. 正文分词 ===');
const parts = S.tokenizeLine("I'm reading a well-known book, aren't I?");
const words = parts.filter((p) => p.type === 'word').map((p) => p.lower);
eq('分词结果', words, ["i'm", 'reading', 'a', 'well-known', 'book', "aren't", 'i']);
const cands = S.extractCandidates('The quick brown fox jumps over the lazy dog.').map((c) => c.lower);
ok('候选词跳过 the/a', !cands.includes('the') && !cands.includes('a'), cands.join(','));
ok('候选词含 quick', cands.includes('quick'));
const lem = S.guessLemmas('running');
ok('guessLemmas(running) 含 run', lem.includes('run'), lem.join(','));
ok('guessLemmas(studies) 含 study', S.guessLemmas('studies').includes('study'));
ok('guessLemmas(happier) 含 happy-ish', S.guessLemmas('happier').includes('happi') || S.guessLemmas('happier').includes('happy'));

console.log('\n=== 8. 编码嗅探 ===');
const utf8 = Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello 中文\n', 'utf8');
eq('UTF-8 识别', S.sniffEncoding(utf8), 'utf-8');
const utf8bom = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), utf8]);
eq('UTF-8 BOM 识别', S.sniffEncoding(utf8bom), 'utf-8');
const utf16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('Hello', 'utf16le')]);
eq('UTF-16LE 识别', S.sniffEncoding(utf16), 'utf-16le');
const gbk = Buffer.from([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7]); // "你好世界" in GBK
eq('GBK 识别', S.sniffEncoding(gbk), 'gb18030');
const decoded = S.decodeBuffer(Buffer.concat([Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n'), gbk, Buffer.from('\n')]));
ok('GBK 解码内容含中文', /[\u4E00-\u9FFF]/.test(decoded.text), decoded.text);

console.log('\n=== 9. 文件读写往返 ===');
const tmp = path.join(os.tmpdir(), 'plt-selftest');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const srtFile = path.join(tmp, 'sample.srt');
fs.writeFileSync(srtFile, srt, 'utf8');
const loaded = S.loadSubtitleFile(srtFile);
eq('loadSubtitleFile 行数', loaded.count, 2);
eq('loadSubtitleFile 格式', loaded.format, 'srt');
const saved = S.saveSubtitleFile(path.join(tmp, 'out.vtt'), loaded.cues, { bilingual: true });
eq('saveSubtitleFile 格式', saved.format, 'vtt');
const reload = S.loadSubtitleFile(path.join(tmp, 'out.vtt'));
eq('VTT 回读行数', reload.count, 2);
const mediaFile = path.join(tmp, 'episode01.mp4');
fs.writeFileSync(mediaFile, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
eq('同名字幕查找', S.findSiblingSubtitle(mediaFile), null);
fs.writeFileSync(path.join(tmp, 'episode01.srt'), srt, 'utf8');
eq('同名字幕查找(存在)', path.basename(S.findSiblingSubtitle(mediaFile) || ''), 'episode01.srt');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n=== 10. 级别分级逻辑 ===');
// llm.js 依赖 electron，这里用轻量复刻校验规则（与 llm.js 保持一致）
const CEFR_RANK = { A1: 0, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6, 'C2+': 7 };
const LEVEL_RANK = { none: 0, a2: 2, b1: 3, b2: 4, ielts: 5, toefl: 5, gre: 6, educated_native: 7 };
function meets(entry, target) {
  const t = LEVEL_RANK[target] ?? 0;
  if (t === 0) return true;
  const ranks = [];
  if (entry.cefr && CEFR_RANK[entry.cefr] !== undefined) ranks.push(CEFR_RANK[entry.cefr]);
  if (entry.rare) ranks.push(7);
  if (entry.isIdiom) ranks.push(5);
  if (entry.isAcademic) ranks.push(5);
  for (const ex of (entry.examLevels || [])) {
    if (ex === 'GRE') ranks.push(6);
    else if (ex === 'TOEFL' || ex === 'IELTS') ranks.push(5);
  }
  if (!ranks.length) ranks.push(3);
  return Math.max(...ranks) >= t;
}
ok('A2 词不达托福级别', !meets({ cefr: 'A2' }, 'toefl'));
ok('B1 词不达托福级别', !meets({ cefr: 'B1' }, 'toefl'));
ok('C1 词达到托福级别', meets({ cefr: 'C1' }, 'toefl'));
ok('C1 词达到雅思级别', meets({ cefr: 'C1' }, 'ielts'));
ok('C1 词不达 GRE 级别', !meets({ cefr: 'C1' }, 'gre'));
ok('C2 词达到 GRE 级别', meets({ cefr: 'C2' }, 'gre'));
ok('生僻词达到母语级', meets({ cefr: 'C2', rare: true }, 'educated_native'));
ok('学术词达到托福级别', meets({ cefr: 'B2', isAcademic: true }, 'toefl'));
ok('none 级别全部通过', meets({ cefr: 'A1' }, 'none'));
ok('TOEFL 标记词达到 GRE 以下任何级别', meets({ cefr: 'B2', examLevels: ['TOEFL'] }, 'toefl'));

console.log('\n=== 11. 工程文件完整性 ===');
const required = [
  'package.json', 'README.md', 'LICENSE', '.gitignore',
  'build/icon.ico', 'build/icon.png',
  'scripts/ocr.ps1', 'scripts/make-icon.js',
  'src/main/main.js', 'src/main/store.js', 'src/main/llm.js', 'src/main/ocr.js', 'src/main/screen-text.js',
  'src/preload/preload.js',
  'src/renderer/index.html', 'src/renderer/quick.html',
  'src/renderer/js/app.js', 'src/renderer/js/util.js', 'src/renderer/js/subtitles.js', 'src/renderer/js/player.js',
  'src/renderer/js/transcript.js', 'src/renderer/js/dict.js', 'src/renderer/js/shadow.js', 'src/renderer/js/settings.js',
  'src/renderer/css/tokens.css', 'src/renderer/css/app.css', 'src/renderer/css/player.css',
  'src/renderer/css/transcript.css', 'src/renderer/css/panels.css'
];
for (const rel of required) {
  const p = path.join(ROOT, rel);
  ok(`存在 ${rel}`, fs.existsSync(p) && fs.statSync(p).size > 0, fs.existsSync(p) ? '文件为空' : '缺失');
}

console.log('\n=== 12. 语法检查（渲染进程脚本） ===');
const rendererScripts = fs.readdirSync(path.join(ROOT, 'src', 'renderer', 'js')).filter((f) => f.endsWith('.js'));
for (const f of rendererScripts) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', f), 'utf8');
  try { new Function(src); ok(`语法 ${f}`, true); }
  catch (err) { ok(`语法 ${f}`, false, err.message); }
}
for (const f of ['main.js', 'store.js', 'llm.js', 'ocr.js', 'screen-text.js']) {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', f), 'utf8');
  try { new Function(src); ok(`语法 main/${f}`, true); }
  catch (err) { ok(`语法 main/${f}`, false, err.message); }
}

console.log('\n=== 13. HTML 结构 ===');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
for (const id of ['video', 'transcript', 'dictPanel', 'levelSelect', 'seekbar', 'ratePresets', 'subtitleOverlay', 'shadowPanel', 'ocrOverlay', 'modalHost', 'vocabList']) {
  ok(`index.html 含 #${id}`, html.includes(`id="${id}"`));
}
const scriptOrder = ['js/util.js', 'js/subtitles.js', 'js/player.js', 'js/transcript.js', 'js/dict.js', 'js/shadow.js', 'js/settings.js', 'js/app.js'];
let lastIdx = -1;
let orderOk = true;
for (const s of scriptOrder) {
  const i = html.indexOf(s);
  if (i < 0 || i < lastIdx) { orderOk = false; break; }
  lastIdx = i;
}
ok('脚本加载顺序正确', orderOk);
ok('Times New Roman 已配置', fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'tokens.css'), 'utf8').includes('Times New Roman'));
ok('微软雅黑已配置', fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'css', 'tokens.css'), 'utf8').includes('YaHei'));

console.log('\n=== 14. package.json 打包配置 ===');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
ok('main 指向 src/main/main.js', pkg.main === 'src/main/main.js');
const targets = (pkg.build.win.target || []).map((t) => t.target);
ok('含 nsis 安装包目标', targets.includes('nsis'));
ok('含 portable 便携目标', targets.includes('portable'));
ok('portable 有独立文件名', !!pkg.build.portable.artifactName);
ok('图标存在且被引用', pkg.build.win.icon === 'build/icon.ico' && fs.existsSync(path.join(ROOT, 'build/icon.ico')));

console.log(`\n${'='.repeat(52)}`);
console.log(`自检结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(52) + '\n');
process.exit(fail ? 1 : 0);

import '../models/subtitle.dart';

/// SRT / VTT 字幕解析。
/// 算法移植自桌面版 src/renderer/js/subtitles.js：
/// 按空行切块 -> 找含 "-->" 的时间轴行 -> 解析起止毫秒 -> 余下行为文本。
class SubtitleParser {
  const SubtitleParser._();

  static SubtitleTrack parse(String raw,
      {String name = 'subtitle', bool isVtt = false}) {
    final cues = <Cue>[];
    final normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
    final blocks = normalized.split('\n\n');

    for (final block in blocks) {
      final lines =
          block.split('\n').where((l) => l.trim().isNotEmpty).toList();
      if (lines.isEmpty) continue;

      final timeIdx = lines.indexWhere((l) => l.contains('-->'));
      if (timeIdx < 0) continue;

      final times = _parseTimes(lines[timeIdx], isVtt);
      if (times == null) continue;

      final textLines = lines.sublist(timeIdx + 1);
      final text = textLines.join('\n').trim();
      if (text.isEmpty) continue;

      cues.add(Cue(startMs: times[0], endMs: times[1], text: text));
    }

    cues.sort((a, b) => a.startMs.compareTo(b.startMs));
    return SubtitleTrack(name: name, cues: cues);
  }

  /// 尝试自动识别格式：以 "WEBVTT" 开头即为 VTT。
  static SubtitleTrack parseAuto(String raw, {String name = 'subtitle'}) {
    final isVtt = raw.trimLeft().toUpperCase().startsWith('WEBVTT');
    return parse(raw, name: name, isVtt: isVtt);
  }

  static List<int>? _parseTimes(String line, bool isVtt) {
    final parts = line.split('-->');
    if (parts.length < 2) return null;
    final start = _toMs(parts[0].trim(), isVtt);
    // end 可能带 VTT 位置信息（如 "align:start position:0%"），取首个 token。
    final endRaw = parts[1].trim().split(RegExp(r'\s+')).first;
    final end = _toMs(endRaw, isVtt);
    if (start == null || end == null) return null;
    return [start, end];
  }

  static int? _toMs(String t, bool isVtt) {
    final comma = t.indexOf(',');
    final dot = t.indexOf('.');
    late String main;
    late String msPart;
    if (comma >= 0) {
      main = t.substring(0, comma);
      msPart = t.substring(comma + 1);
    } else if (dot >= 0) {
      main = t.substring(0, dot);
      msPart = t.substring(dot + 1);
    } else {
      main = t;
      msPart = '0';
    }
    final hms = main.split(':');
    if (hms.length != 3) return null;
    final h = int.tryParse(hms[0]);
    final m = int.tryParse(hms[1]);
    final s = int.tryParse(hms[2]);
    if (h == null || m == null || s == null) return null;
    msPart = msPart.replaceAll(RegExp(r'[^0-9]'), '');
    int ms = 0;
    if (msPart.isNotEmpty) {
      ms = int.tryParse(msPart.padRight(3, '0').substring(0, 3)) ?? 0;
    }
    return ((h * 3600 + m * 60 + s) * 1000) + ms;
  }
}

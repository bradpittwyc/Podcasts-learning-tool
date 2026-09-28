/// 字幕数据模型：单条 Cue + 整条字幕轨。
/// 对应桌面版 subtitles.js 的解析结果，供播放器点句跳转与 Transcript 渲染复用。
class Cue {
  final int startMs;
  final int endMs;
  final String text;

  const Cue({required this.startMs, required this.endMs, required this.text});

  Duration get start => Duration(milliseconds: startMs);
  Duration get end => Duration(milliseconds: endMs);

  /// 播放位置是否落在本句区间（含尾点，便于末句高亮）。
  bool contains(int ms) => ms >= startMs && ms <= endMs;
}

class SubtitleTrack {
  final String name;
  final List<Cue> cues;

  const SubtitleTrack({required this.name, required this.cues});

  /// 返回播放位置所在的 Cue（用于字幕叠加层高亮）。
  Cue? cueAt(int ms) {
    for (final c in cues) {
      if (c.contains(ms)) return c;
    }
    return null;
  }

  /// 返回播放位置所在句子的下标；用于 Transcript 列表自动滚动。
  int indexAt(int ms) {
    for (int i = 0; i < cues.length; i++) {
      if (cues[i].contains(ms)) return i;
    }
    return -1;
  }
}

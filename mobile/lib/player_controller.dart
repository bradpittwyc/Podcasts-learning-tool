import 'dart:io';
import 'package:video_player/video_player.dart';
import 'package:flutter/foundation.dart';
import 'models/subtitle.dart';
import 'services/subtitle_parser.dart';

/// 播放器状态中枢：封装 video_player，向外广播播放位置，驱动字幕叠加与 Transcript 高亮。
/// 对应桌面版 main.js 的播放控制 + renderer 的播放状态。
class PlayerController extends ChangeNotifier {
  VideoPlayerController? _vc;
  SubtitleTrack? track;

  Duration position = Duration.zero;
  Duration duration = Duration.zero;

  Cue? get currentCue => track?.cueAt(position.inMilliseconds);
  int get currentIndex => track?.indexAt(position.inMilliseconds) ?? -1;
  bool get isReady => _vc?.value.isInitialized ?? false;
  bool get isPlaying => _vc?.value.isPlaying ?? false;
  VideoPlayerController? get raw => _vc;

  Future<void> loadMedia(String path) async {
    await _vc?.dispose();
    _vc = VideoPlayerController.file(File(path));
    _vc!.addListener(_onUpdate);
    await _vc!.initialize();
    duration = _vc!.value.duration;
    notifyListeners();
  }

  void _onUpdate() {
    if (_vc == null) return;
    position = _vc!.value.position;
    duration = _vc!.value.duration;
    notifyListeners();
  }

  Future<void> loadSubtitleText(String raw) async {
    track = SubtitleParser.parseAuto(raw);
    notifyListeners();
  }

  void seekTo(Duration d) => _vc?.seekTo(d);
  void seekToMs(int ms) => _vc?.seekTo(Duration(milliseconds: ms));
  void play() => _vc?.play();
  void pause() => _vc?.pause();
  void toggle() => isPlaying ? pause() : play();

  @override
  void dispose() {
    _vc?.removeListener(_onUpdate);
    _vc?.dispose();
    super.dispose();
  }
}

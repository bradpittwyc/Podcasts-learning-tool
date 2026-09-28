import 'dart:async';
import 'package:flutter/material.dart';
import 'package:record/record.dart';
import 'package:audioplayers/audioplayers.dart';
import 'package:path_provider/path_provider.dart';
import 'package:podcasts_learning_tool/player_controller.dart';
import 'package:podcasts_learning_tool/models/subtitle.dart';

/// 跟读（Shadowing）：听原句 -> 录音跟读 -> 回放对比（对应桌面版 shadow.js）。
class ShadowPanel extends StatefulWidget {
  final PlayerController controller;
  const ShadowPanel({super.key, required this.controller});

  @override
  State<ShadowPanel> createState() => _ShadowPanelState();
}

class _ShadowPanelState extends State<ShadowPanel> {
  final AudioRecorder _rec = AudioRecorder();
  final AudioPlayer _ap = AudioPlayer();
  String? _recPath;
  bool _recording = false;
  bool _hasPermission = false;

  @override
  void initState() {
    super.initState();
    _checkPerm();
  }

  Future<void> _checkPerm() async {
    final p = await _rec.hasPermission();
    if (mounted) setState(() => _hasPermission = p);
  }

  @override
  void dispose() {
    unawaited(_rec.dispose());
    _ap.dispose();
    super.dispose();
  }

  Cue? get _cue {
    final c = widget.controller;
    if (c.track != null && c.track!.cues.isNotEmpty) {
      final idx = c.currentIndex;
      return idx >= 0 ? c.track!.cues[idx] : c.track!.cues[0];
    }
    return null;
  }

  Future<void> _listenOriginal() async {
    final cue = _cue;
    if (cue == null) return;
    widget.controller.seekToMs(cue.startMs);
    widget.controller.play();
  }

  Future<void> _toggleRecord() async {
    if (_recording) {
      final path = await _rec.stop();
      if (mounted) setState(() {
        _recording = false;
        _recPath = path;
      });
    } else {
      if (!_hasPermission) {
        final p = await _rec.hasPermission();
        if (mounted) setState(() => _hasPermission = p);
        if (!p) return;
      }
      final dir = await getTemporaryDirectory();
      final cue = _cue;
      final name = 'shadow_${cue?.startMs ?? 0}.m4a';
      await _rec.start(const RecordConfig(), path: '${dir.path}/$name');
      if (mounted) setState(() => _recording = true);
    }
  }

  Future<void> _playRecord() async {
    if (_recPath == null) return;
    await _ap.play(DeviceFileSource(_recPath!));
  }

  @override
  Widget build(BuildContext context) {
    final cue = _cue;
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('跟读练习',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          const SizedBox(height: 12),
          Expanded(
            child: SingleChildScrollView(
              child: Text(
                cue?.text ?? '（无字幕，请先加载字幕）',
                style: const TextStyle(fontSize: 16, height: 1.5),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            children: [
              ElevatedButton.icon(
                onPressed: _listenOriginal,
                icon: const Icon(Icons.volume_up),
                label: const Text('听原句'),
              ),
              ElevatedButton.icon(
                onPressed: _toggleRecord,
                icon: Icon(_recording ? Icons.stop : Icons.mic),
                label: Text(_recording ? '停止录音' : '录音跟读'),
              ),
              if (_recPath != null)
                ElevatedButton.icon(
                  onPressed: _playRecord,
                  icon: const Icon(Icons.play_arrow),
                  label: const Text('回放对比'),
                ),
            ],
          ),
          if (!_hasPermission)
            const Padding(
              padding: EdgeInsets.only(top: 8),
              child: Text('需麦克风权限（系统弹窗授权）',
                  style: TextStyle(color: Colors.orange)),
            ),
        ],
      ),
    );
  }
}

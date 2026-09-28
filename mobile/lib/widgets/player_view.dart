import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';
import 'package:podcasts_learning_tool/player_controller.dart';
import 'package:podcasts_learning_tool/utils/time_util.dart';

/// 播放器 + 字幕叠加 + 控制条（对应桌面版 player.js + 字幕渲染）。
class PlayerView extends StatelessWidget {
  final PlayerController controller;
  const PlayerView({super.key, required this.controller});

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (ctx, _) {
        final vc = controller.raw;
        if (vc == null || !controller.isReady) {
          return const AspectRatio(
            aspectRatio: 16 / 9,
            child: Center(child: Text('未加载媒体')),
          );
        }
        return Column(
          children: [
            AspectRatio(
              aspectRatio: vc.value.aspectRatio,
              child: Stack(
                children: [
                  VideoPlayer(vc),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 8,
                    child: _subtitleOverlay(controller.currentCue?.text),
                  ),
                ],
              ),
            ),
            _controls(context),
          ],
        );
      },
    );
  }

  Widget _subtitleOverlay(String? text) {
    if (text == null || text.isEmpty) return const SizedBox.shrink();
    return Container(
      color: Colors.black54,
      padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 8),
      child: Text(
        text,
        textAlign: TextAlign.center,
        style: const TextStyle(color: Colors.white, fontSize: 16),
      ),
    );
  }

  Widget _controls(BuildContext context) {
    final vc = controller.raw!;
    return Row(
      children: [
        IconButton(
          icon: Icon(controller.isPlaying ? Icons.pause : Icons.play_arrow),
          onPressed: controller.toggle,
        ),
        Text(formatMs(controller.position.inMilliseconds)),
        Expanded(
          child: VideoProgressIndicator(
            vc,
            allowScrubbing: true,
            padding: const EdgeInsets.symmetric(horizontal: 8),
          ),
        ),
        Text(formatMs(controller.duration.inMilliseconds)),
      ],
    );
  }
}

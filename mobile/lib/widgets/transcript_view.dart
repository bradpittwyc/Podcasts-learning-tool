import 'package:flutter/material.dart';
import 'package:podcasts_learning_tool/player_controller.dart';
import 'package:podcasts_learning_tool/services/dict_service.dart';
import 'package:podcasts_learning_tool/widgets/dict_sheet.dart';

/// 字幕句子列表：点句跳转、点单词查词（对应桌面版 transcript.js）。
class TranscriptView extends StatelessWidget {
  final PlayerController controller;
  final DictService dict;
  final ScrollController? scrollController;

  const TranscriptView({
    super.key,
    required this.controller,
    required this.dict,
    this.scrollController,
  });

  @override
  Widget build(BuildContext context) {
    // 注意：track 判空必须放在 ListenableBuilder 内部——若放在外面，
    // 「尚未加载字幕」分支不含监听者，加载字幕后的 notifyListeners 无人响应，界面永远不刷新。
    return ListenableBuilder(
      listenable: controller,
      builder: (ctx, _) {
        final track = controller.track;
        if (track == null || track.cues.isEmpty) {
          return const Center(child: Text('尚未加载字幕'));
        }
        final cur = controller.currentIndex;
        return ListView.builder(
          controller: scrollController,
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: track.cues.length,
          itemBuilder: (c, i) {
            final cue = track.cues[i];
            final active = i == cur;
            return Padding(
              padding: const EdgeInsets.symmetric(vertical: 2, horizontal: 8),
              child: Material(
                color: active
                    ? Theme.of(context).colorScheme.primaryContainer
                    : null,
                borderRadius: BorderRadius.circular(8),
                child: InkWell(
                  onTap: () => controller.seekToMs(cue.startMs),
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: _sentenceText(context, cue, active),
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _sentenceText(BuildContext context, cue, bool active) {
    // 按空白切分并保留空格 token，逐词可点查词。
    final tokens = cue.text.split(RegExp(r'(\s+)'));
    return Wrap(
      children: tokens.map((w) {
        if (RegExp(r'^\s+$').hasMatch(w)) return Text(w);
        return GestureDetector(
          onTap: () {
            final clean =
                w.replaceAll(RegExp(r"[^\w']", caseSensitive: false), '');
            if (clean.isNotEmpty) {
              showDictSheet(context, clean, dict);
            }
          },
          child: Text(
            '$w ',
            style: TextStyle(
              fontSize: active ? 17 : 15,
              fontWeight: active ? FontWeight.w600 : FontWeight.normal,
            ),
          ),
        );
      }).toList(),
    );
  }
}

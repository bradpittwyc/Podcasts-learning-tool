import 'dart:io';
import 'package:flutter/material.dart';
import 'package:podcasts_learning_tool/player_controller.dart';
import 'package:podcasts_learning_tool/services/dict_service.dart';
import 'package:podcasts_learning_tool/services/media_service.dart';
import 'package:podcasts_learning_tool/widgets/player_view.dart';
import 'package:podcasts_learning_tool/widgets/transcript_view.dart';
import 'package:podcasts_learning_tool/widgets/shadow_panel.dart';

/// 首页：横竖屏自适应布局。
/// 竖屏（手机竖持 / 平板竖持）：顶部视频 → 当前句高亮条 → 字幕/跟读单栏。
/// 横屏宽屏（平板）：左侧播放器 + 右侧字幕/跟读双栏。
/// 横屏窄屏（手机）：上方播放器 + 下方 Tab 单栏。
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final PlayerController _controller = PlayerController();
  final DictService _dict = DictService();
  final ScrollController _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    _controller.dispose();
    super.dispose();
  }

  Future<void> _openBoth() async {
    final (media, subtitle) = await MediaService.pickBoth();
    if (media != null) await _controller.loadMedia(media);
    if (subtitle != null) {
      final txt = await File(subtitle).readAsString();
      await _controller.loadSubtitleText(txt);
    }
  }

  Future<void> _openSubtitle() async {
    final p = await MediaService.pickSubtitle();
    if (p == null) return;
    final txt = await File(p).readAsString();
    await _controller.loadSubtitleText(txt);
  }

  Future<void> _openSettings() async {
    final (k, b, m) = await _dict.loadSettings();
    final keyC = TextEditingController(text: k ?? '');
    final baseC = TextEditingController(text: b ?? 'https://api.openai.com/v1');
    final modelC = TextEditingController(text: m ?? 'gpt-4o-mini');
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('大模型设置'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
                controller: keyC,
                decoration: const InputDecoration(labelText: 'API Key')),
            TextField(
                controller: baseC,
                decoration: const InputDecoration(labelText: 'Base URL')),
            TextField(
                controller: modelC,
                decoration: const InputDecoration(labelText: 'Model')),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('取消')),
          TextButton(
            onPressed: () {
              _dict.saveSettings(
                apiKey: keyC.text,
                baseUrl: baseC.text,
                model: modelC.text,
              );
              Navigator.pop(ctx);
            },
            child: const Text('保存'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Podcasts Learning Tool'),
        actions: [
          IconButton(
            icon: const Icon(Icons.video_library),
            tooltip: '打开媒体 / 字幕',
            onPressed: _openBoth,
          ),
          IconButton(
            icon: const Icon(Icons.subtitles),
            tooltip: '打开字幕',
            onPressed: _openSubtitle,
          ),
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: '设置',
            onPressed: _openSettings,
          ),
        ],
      ),
      body: OrientationBuilder(
        builder: (ctx, orientation) {
          // 竖屏（手机竖持 / 平板竖持）：上下单栏重排，模块重新定位。
          if (orientation == Orientation.portrait) {
            return _buildPortrait();
          }
          // 横屏：宽屏平板用双栏，窄屏手机用单栏（沿用原逻辑）。
          return LayoutBuilder(
            builder: (c, constraints) {
              final isTablet = constraints.maxWidth >= 600;
              if (isTablet) {
                return Row(
                  children: [
                    Expanded(
                      flex: 3,
                      child: SingleChildScrollView(
                        child: PlayerView(controller: _controller),
                      ),
                    ),
                    Expanded(flex: 2, child: _tabbedPanel()),
                  ],
                );
              }
              return Column(
                children: [
                  PlayerView(controller: _controller),
                  Expanded(child: _tabbedPanel()),
                ],
              );
            },
          );
        },
      ),
    );
  }

  /// 竖屏布局：视频置顶 → 当前句高亮条 → 字幕/跟读主体。
  Widget _buildPortrait() {
    return Column(
      children: [
        // 模块1：视频播放器（顶部常驻）
        PlayerView(controller: _controller),
        // 模块2：当前句高亮条（实时显示正在播放的句子，点按回到该句）
        _currentCueBar(),
        // 模块3：字幕 / 跟读 主内容区
        Expanded(child: _tabbedPanel()),
      ],
    );
  }

  /// 当前句条：始终展示播放进度对应的字幕句，方便跟读时对照原文。
  Widget _currentCueBar() {
    return ListenableBuilder(
      listenable: _controller,
      builder: (ctx, _) {
        final cue = _controller.currentCue;
        return Material(
          color: Theme.of(ctx).colorScheme.primaryContainer.withValues(alpha: 0.55),
          child: InkWell(
            onTap: cue == null ? null : () => _controller.seekToMs(cue.startMs),
            child: Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Icon(Icons.subtitles, size: 18),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      cue?.text ?? '当前句将显示在这里',
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                      maxLines: 3,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  Widget _tabbedPanel() {
    return DefaultTabController(
      length: 2,
      child: Column(
        children: [
          const TabBar(
            tabs: [Tab(text: '字幕'), Tab(text: '跟读')],
          ),
          Expanded(
            child: TabBarView(
              children: [
                TranscriptView(
                  controller: _controller,
                  dict: _dict,
                  scrollController: _scroll,
                ),
                ShadowPanel(controller: _controller),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

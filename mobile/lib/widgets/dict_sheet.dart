import 'package:flutter/material.dart';
import 'package:podcasts_learning_tool/services/dict_service.dart';

/// 点词后从底部弹出的释义面板（对应桌面版右侧查词卡）。
void showDictSheet(BuildContext context, String word, DictService dict,
    {Level level = Level.ielts}) {
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => DictSheetContent(word: word, dict: dict, level: level),
  );
}

class DictSheetContent extends StatefulWidget {
  final String word;
  final DictService dict;
  final Level level;
  const DictSheetContent({
    super.key,
    required this.word,
    required this.dict,
    required this.level,
  });

  @override
  State<DictSheetContent> createState() => _DictSheetContentState();
}

class _DictSheetContentState extends State<DictSheetContent> {
  WordEntry? _entry;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final e = await widget.dict.lookup(widget.word, level: widget.level);
    if (mounted) setState(() => _loading = false);
    if (mounted) setState(() => _entry = e);
  }

  @override
  Widget build(BuildContext ctx) {
    final theme = Theme.of(ctx);
    return Padding(
      padding: EdgeInsets.fromLTRB(
        20,
        16,
        20,
        MediaQuery.of(ctx).viewInsets.bottom + 20,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.word, style: theme.textTheme.headlineSmall),
          const SizedBox(height: 8),
          if (_loading) const LinearProgressIndicator(),
          if (!_loading && _entry != null) ...[
            if (_entry!.phonetic != null)
              Text(_entry!.phonetic!,
                  style: const TextStyle(fontStyle: FontStyle.italic)),
            const SizedBox(height: 6),
            Text(_entry!.definition, style: theme.textTheme.bodyLarge),
            const SizedBox(height: 8),
            Chip(label: Text(_entry!.level.label)),
            if (_entry!.example != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text('例：${_entry!.example!}',
                    style: const TextStyle(color: Colors.grey)),
              ),
          ],
        ],
      ),
    );
  }
}

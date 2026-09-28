import 'dart:convert';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'lemma.dart';

/// 词汇难度分级（对应桌面版：雅思/托福/GRE/母语级…）。
enum Level { cet4, cet6, ielts, toefl, gre, native }

extension LevelExt on Level {
  String get label {
    switch (this) {
      case Level.cet4:
        return '四级';
      case Level.cet6:
        return '六级';
      case Level.ielts:
        return '雅思';
      case Level.toefl:
        return '托福';
      case Level.gre:
        return 'GRE';
      case Level.native:
        return '母语级';
    }
  }

  static const List<Level> all = [
    Level.cet4,
    Level.cet6,
    Level.ielts,
    Level.toefl,
    Level.gre,
    Level.native,
  ];
}

class WordEntry {
  final String word;
  final String lemma;
  final String? phonetic;
  final String definition;
  final Level level;
  final String? example;

  const WordEntry({
    required this.word,
    required this.lemma,
    this.phonetic,
    required this.definition,
    required this.level,
    this.example,
  });
}

/// 查词服务：先查本地内置词典（含 lemmatize），未命中再走 LLM 分级查词。
class DictService {
  static const String _keyPrefsKey = 'llm_api_key';
  static const String _basePrefsKey = 'llm_base_url';
  static const String _modelPrefsKey = 'llm_model';

  final Map<String, WordEntry> _local = {};

  DictService() {
    _loadBuiltin();
  }

  // 内置极小本地词典（演示用；后续从 assets/local-dict.json.gz 加载完整词表）。
  void _loadBuiltin() {
    const entries = <String, (String, Level)>{
      'apple': ('苹果', Level.cet4),
      'run': ('跑；经营；运行', Level.cet4),
      'episode': ('（剧集的）一集', Level.cet6),
      'shadow': ('影子；阴影；跟读', Level.ielts),
      'podcast': ('播客', Level.cet6),
      'subtitle': ('字幕', Level.cet4),
      'vocabulary': ('词汇', Level.cet4),
      'pronunciation': ('发音', Level.cet4),
      'fluent': ('流利的', Level.cet6),
      'comprehension': ('理解（力）', Level.ielts),
    };
    entries.forEach((w, e) {
      _local[w] = WordEntry(
        word: w,
        lemma: Lemmatizer.lemmatize(w),
        definition: e.$1,
        level: e.$2,
      );
    });
  }

  Future<WordEntry?> lookupLocal(String word) async {
    final lower = word.toLowerCase();
    final direct = _local[lower];
    if (direct != null) return direct;
    return _local[Lemmatizer.lemmatize(word)];
  }

  Future<WordEntry> lookup(String word,
      {Level level = Level.ielts, bool useLlm = true}) async {
    final local = await lookupLocal(word);
    if (local != null) return local;
    if (!useLlm) {
      return WordEntry(
        word: word,
        lemma: Lemmatizer.lemmatize(word),
        definition: '（本地词典未收录）',
        level: level,
      );
    }
    return _lookupLlm(word, level);
  }

  Future<WordEntry> _lookupLlm(String word, Level level) async {
    final prefs = await SharedPreferences.getInstance();
    final key = prefs.getString(_keyPrefsKey);
    final base = prefs.getString(_basePrefsKey) ?? 'https://api.openai.com/v1';
    final model = prefs.getString(_modelPrefsKey) ?? 'gpt-4o-mini';
    if (key == null || key.isEmpty) {
      return WordEntry(
        word: word,
        lemma: Lemmatizer.lemmatize(word),
        definition: '（未配置大模型 Key，请在设置中填写）',
        level: level,
      );
    }
    final system = '你是一位面向中国英语学习者的英汉词典。'
        '针对 CEFR 等级 ${level.label} 的学习者，给出单词 "$word" 的简明中文释义、音标与一个英文例句。'
        '仅返回 JSON：{"phonetic": "...", "definition": "...", "example": "..."}';
    try {
      final resp = await http.post(
        Uri.parse('$base/chat/completions'),
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer $key',
        },
        body: jsonEncode({
          'model': model,
          'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': word},
          ],
          'response_format': {'type': 'json_object'},
        }),
      );
      if (resp.statusCode != 200) {
        return WordEntry(
          word: word,
          lemma: Lemmatizer.lemmatize(word),
          definition: '（查询失败：${resp.statusCode}）',
          level: level,
        );
      }
      final data = jsonDecode(resp.body);
      final content = data['choices'][0]['message']['content'] as String;
      final j = jsonDecode(content) as Map<String, dynamic>;
      return WordEntry(
        word: word,
        lemma: Lemmatizer.lemmatize(word),
        phonetic: j['phonetic'] as String?,
        definition: (j['definition'] as String?) ?? '',
        level: level,
        example: j['example'] as String?,
      );
    } catch (e) {
      return WordEntry(
        word: word,
        lemma: Lemmatizer.lemmatize(word),
        definition: '（查询异常：$e）',
        level: level,
      );
    }
  }

  Future<void> saveSettings({
    String? apiKey,
    String? baseUrl,
    String? model,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    if (apiKey != null) await prefs.setString(_keyPrefsKey, apiKey);
    if (baseUrl != null) await prefs.setString(_basePrefsKey, baseUrl);
    if (model != null) await prefs.setString(_modelPrefsKey, model);
  }

  Future<(String?, String?, String?)> loadSettings() async {
    final prefs = await SharedPreferences.getInstance();
    return (
      prefs.getString(_keyPrefsKey),
      prefs.getString(_basePrefsKey),
      prefs.getString(_modelPrefsKey),
    );
  }
}

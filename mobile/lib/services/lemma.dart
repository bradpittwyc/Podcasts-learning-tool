/// 词形还原（lemmatization）。
/// 移植桌面版 shared/lemma.js 的思路：先用不规则表，再用规则去后缀。
/// 完整词典很大，移动端先用精简版；后续可从 assets/lemma.json 加载扩展表。
class Lemmatizer {
  const Lemmatizer._();

  static const Map<String, String> _irregular = {
    'was': 'be', 'were': 'be', 'is': 'be', 'am': 'be', 'been': 'be', 'being': 'be',
    'went': 'go', 'gone': 'go', 'goes': 'go',
    'did': 'do', 'done': 'do', 'does': 'do', 'doing': 'do',
    'had': 'have', 'has': 'have', 'having': 'have',
    'better': 'good', 'best': 'good', 'worse': 'bad', 'worst': 'bad',
    'more': 'many', 'most': 'many', 'much': 'many',
    'children': 'child', 'men': 'man', 'women': 'woman', 'people': 'person',
    'thought': 'think', 'taught': 'teach',
    'saw': 'see', 'seen': 'see', 'seeing': 'see',
    'made': 'make', 'making': 'make',
    'came': 'come', 'coming': 'come',
    'took': 'take', 'taken': 'take', 'taking': 'take',
    'gave': 'give', 'given': 'give', 'giving': 'give',
    'got': 'get', 'gotten': 'get', 'getting': 'get',
    'said': 'say', 'saying': 'say',
    'found': 'find', 'finding': 'find',
    'told': 'tell',
    'left': 'leave', 'leaving': 'leave',
    'felt': 'feel', 'feeling': 'feel',
    'brought': 'bring',
    'kept': 'keep',
    'built': 'build',
    'spoke': 'speak', 'spoken': 'speak', 'speaking': 'speak',
    'read': 'read', 'reading': 'read',
    'led': 'lead',
    'met': 'meet',
    'paid': 'pay',
    'put': 'put', 'set': 'set', 'cut': 'cut', 'fit': 'fit', 'hit': 'hit',
    'sat': 'sit', 'stood': 'stand',
    'understood': 'understand', 'lost': 'lose', 'won': 'win',
    'began': 'begin', 'begun': 'begin', 'beginning': 'begin',
    'ran': 'run', 'running': 'run',
    'drew': 'draw', 'drawn': 'draw', 'drawing': 'draw',
    'flew': 'fly', 'flown': 'fly', 'flying': 'fly',
    'knew': 'know', 'known': 'know', 'knowing': 'know',
    'grew': 'grow', 'grown': 'grow', 'growing': 'grow',
    'threw': 'throw', 'thrown': 'throw',
    'broke': 'break', 'broken': 'break',
    'chose': 'choose', 'chosen': 'choose',
    'wrote': 'write', 'written': 'write', 'writing': 'write',
    'ate': 'eat', 'eaten': 'eat',
    'drove': 'drive', 'driven': 'drive',
    'rose': 'rise', 'risen': 'rise',
    'fell': 'fall', 'fallen': 'fall',
    'rang': 'ring', 'rung': 'ring',
    'sang': 'sing', 'sung': 'sing',
    'swam': 'swim', 'swum': 'swim',
    'held': 'hold',
    'spent': 'spend', 'sent': 'send',
    'caught': 'catch', 'bought': 'buy', 'fought': 'fight',
    'sought': 'seek',
  };

  static String lemmatize(String word) {
    final w = word.toLowerCase().replaceAll(RegExp(r"[^a-z']"), '');
    if (w.isEmpty) return word;
    final irr = _irregular[w];
    if (irr != null) return irr;
    return _stripSuffix(w);
  }

  static String _stripSuffix(String w) {
    const suffixes = [
      'ies', 'ied',
      'sses', 'shes', 'ches', 'xes', 'zes',
      'ing', 'ed', 'es', 's',
      'ness', 'ment', 'tion', 'sion', 'ity',
      'ful', 'less', 'able', 'ible', 'ous', 'ive', 'ize', 'ise',
      'er', 'est', 'ly', 'al', 'y',
    ];
    for (final suf in suffixes) {
      if (w.length > suf.length + 2 && w.endsWith(suf)) {
        var stem = w.substring(0, w.length - suf.length);
        if (suf == 'ing' || suf == 'ed') {
          // 还原双写尾字母：stopped -> stop, running -> run
          if (stem.length >= 2 && stem[stem.length - 1] == stem[stem.length - 2]) {
            stem = stem.substring(0, stem.length - 1);
          }
        } else if (suf == 'ies' || suf == 'ied') {
          stem = '$stem=y';
        }
        return stem;
      }
    }
    return w;
  }
}

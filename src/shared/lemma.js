'use strict';
/**
 * lemma.js — 词形还原（主进程 / 构建脚本 / 渲染进程共用，无依赖）
 * 只做规则化的后缀还原，用于把 walls / running / studied 这类词形映射回原形。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PLTLemma = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  /** 高频功能词与不规则词形：必须永远视为最基础级别（A1） */
  const FUNCTION_WORDS = new Set(('the a an and or but if then than that this these those there here of to in on at by for with from as ' +
    'is are was were be been being am do does did done have has had having will would shall should can could may might must ' +
    'not no nor so such it its i you he she they we me him her them us my your his their our mine yours theirs who whom whose ' +
    'which what when where why how all any both each few more most other some only own same too very just also again further ' +
    'once during before after above below up down out off over under into about against between while because ' +
    'along across around behind beside beyond despite except inside near outside since though through throughout toward towards ' +
    'unless until upon within without among whilst whereas indeed however therefore moreover nevertheless otherwise ' +
    'go goes went gone going get gets got gotten make makes made making take takes took taken taking come comes came coming ' +
    'see sees saw seen seeing know knows knew known knowing think thinks thought thinking say says said saying ' +
    'give gives gave given giving find finds found finding tell tells told telling become becomes became becoming ' +
    'show shows showed shown leave leaves left leaving feel feels felt feeling put puts putting bring brings brought ' +
    'begin begins began begun keep keeps kept hold holds held write writes wrote written stand stands stood hear hears heard ' +
    'let lets mean means meant set sets meet meets met run runs ran running pay pays paid sit sits sat speak speaks spoke spoken ' +
    'lie lies lay lain lead leads led read reads grow grows grew grown lose loses lost fall falls fell fallen send sends sent ' +
    'build builds built understand understands understood draw draws drew drawn break breaks broke broken spend spends spent ' +
    'cut cuts rise rises rose risen drive drives drove driven buy buys bought wear wears wore worn choose chooses chose chosen ' +
    'one two three first second next last many much little less least long short good better best well bad worse worst ' +
    'big small large great high low new old young same different other another every each both either neither ' +
    'yes okay ok please thanks thank hi hello bye').split(/\s+/).filter(Boolean));

  /**
   * 返回词形候选（含自身），按「最可能」排序。
   * @param {string} word
   * @returns {string[]}
   */
  function candidateForms(word) {
    const w = String(word || '').toLowerCase().trim();
    if (!w) return [];
    const out = [w];
    const seen = new Set(out);
    const add = (x) => { if (x && x.length > 2 && !seen.has(x)) { seen.add(x); out.push(x); } };
    const undouble = (s) => (/([bdfglmnprtz])\1$/.test(s) ? s.slice(0, -1) : s);

    if (/ies$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ves$/.test(w)) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe'); }
    if (/(ches|shes|sses|xes|zes)$/.test(w)) add(w.slice(0, -2));
    if (/s$/.test(w) && !/ss$/.test(w) && !/us$/.test(w)) add(w.slice(0, -1));
    if (/ing$/.test(w)) {
      const stem = w.slice(0, -3);
      add(stem); add(undouble(stem)); add(stem + 'e');
      if (/y$/.test(stem)) add(stem.slice(0, -1) + 'ie');
    }
    if (/ied$/.test(w)) add(w.slice(0, -3) + 'y');
    if (/ed$/.test(w)) {
      const stem = w.slice(0, -2);
      add(stem); add(undouble(stem)); add(w.slice(0, -1));
      if (/i$/.test(stem)) add(stem.slice(0, -1) + 'y');
    }
    if (/er$/.test(w)) { add(w.slice(0, -2)); add(undouble(w.slice(0, -2))); add(w.slice(0, -1)); }
    if (/est$/.test(w)) { add(w.slice(0, -3)); add(undouble(w.slice(0, -3))); add(w.slice(0, -2)); }
    if (/ly$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -2) + 'e'); }
    if (/ally$/.test(w)) add(w.slice(0, -4) + 'al');
    return out;
  }

  function isFunctionWord(word) { return FUNCTION_WORDS.has(String(word || '').toLowerCase()); }

  return { candidateForms, isFunctionWord, FUNCTION_WORDS };
}));

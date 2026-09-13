'use strict';
/**
 * settings.js — 设置面板（大模型 / 取词级别 / 外观 / 播放 / 高级）
 * 所有改动即时生效并持久化（明文 Key 只在主进程用 safeStorage 加密保存）
 */
(function () {
  const U = window.PLTUtil;
  const { el, clear, toast } = U;

  const PRESETS = {
    deepseek: { label: 'DeepSeek（推荐，最省钱）', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', docs: 'https://platform.deepseek.com/' },
    openai: { label: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', docs: 'https://platform.openai.com/api-keys' },
    moonshot: { label: 'Moonshot 月之暗面', baseURL: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', docs: 'https://platform.moonshot.cn/' },
    dashscope: { label: '阿里通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', docs: 'https://bailian.console.aliyun.com/' },
    zhipu: { label: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', docs: 'https://open.bigmodel.cn/' },
    siliconflow: { label: 'SiliconFlow 硅基流动', baseURL: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', docs: 'https://cloud.siliconflow.cn/' },
    ollama: { label: '本地 Ollama（免费/离线）', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5:7b', docs: 'https://ollama.com/' },
    custom: { label: '自定义（OpenAI 兼容）', baseURL: '', model: '' }
  };

  class SettingsPanel {
    constructor(opts) {
      this.opts = opts || {};
      this.settings = null;
      this.activeTab = 'llm';
      this.apiKeyDraft = '';
      this.testResult = null;
      this.cacheInfo = null;
    }

    async open(tab) {
      this.settings = await window.PLT.settings.get();
      this.activeTab = tab || this.activeTab;
      this.render();
    }

    async patch(patch) {
      this.settings = await window.PLT.settings.patch(patch);
      this.opts.onApplied && this.opts.onApplied(this.settings);
    }

    render() {
      const s = this.settings;
      const modal = U.modal({
        title: '设置',
        subtitle: `数据目录：${s.meta.dataDir}${s.meta.portable ? '（便携模式）' : ''}`,
        body: document.createDocumentFragment(),
        buttons: [
          { label: '恢复默认', action: async (api) => { if (await U.confirm('恢复所有设置为默认值？（生词本与查词缓存不受影响）')) { this.settings = await window.PLT.settings.reset(); this.render(); this.opts.onApplied && this.opts.onApplied(this.settings); toast('已恢复默认设置', 'ok'); } return false; } },
          { label: '关闭', accent: true }
        ]
      });
      const box = modal.body;
      const tabs = el('div', { class: 'tabs' });
      const defs = [
        ['llm', '大模型'], ['level', '取词级别'], ['appearance', '外观'], ['play', '播放'], ['advanced', '高级']
      ];
      for (const [id, label] of defs) {
        tabs.appendChild(el('button', {
          class: `tab ${this.activeTab === id ? 'active' : ''}`,
          text: label,
          onclick: () => { this.activeTab = id; this.render(); }
        }));
      }
      box.appendChild(tabs);
      const form = el('div', { class: 'form' });
      box.appendChild(form);
      this['render' + this.activeTab[0].toUpperCase() + this.activeTab.slice(1)](form);
    }

    // ── 控件工厂 ──
    field(label, control, desc) {
      return el('div', { class: 'field' }, [
        el('label', { text: label }),
        control,
        desc ? el('div', { class: 'desc', text: desc }) : null
      ]);
    }

    input(path, opts) {
      const s = this.settings;
      const value = path.split('.').reduce((a, k) => (a ? a[k] : undefined), s);
      const node = el('input', {
        type: (opts && opts.type) || 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: (opts && opts.placeholder) || '',
        min: opts && opts.min, max: opts && opts.max, step: opts && opts.step,
        style: opts && opts.style
      });
      const commit = U.debounce(() => {
        let v = node.value;
        if (node.type === 'number') v = Number(v);
        this.patch(setDeep(path, v));
      }, 420);
      node.addEventListener('input', commit);
      node.addEventListener('change', () => {
        let v = node.value;
        if (node.type === 'number') v = Number(v);
        this.patch(setDeep(path, v));
      });
      return node;
    }

    select(path, options, opts) {
      const s = this.settings;
      const value = path.split('.').reduce((a, k) => (a ? a[k] : undefined), s);
      const node = el('select', { style: opts && opts.style });
      for (const opt of options) {
        node.appendChild(el('option', { value: opt.value, text: opt.label, selected: String(opt.value) === String(value) }));
      }
      node.addEventListener('change', () => {
        let v = node.value;
        if (v === 'true') v = true;
        if (v === 'false') v = false;
        this.patch(setDeep(path, v));
      });
      return node;
    }

    switchRow(label, path, desc) {
      const s = this.settings;
      const value = !!path.split('.').reduce((a, k) => (a ? a[k] : undefined), s);
      const box = el('input', { type: 'checkbox', checked: value });
      box.addEventListener('change', () => this.patch(setDeep(path, box.checked)));
      return el('div', { class: 'switch-row' }, [
        el('div', {}, [el('div', { class: 'label', text: label }), desc ? el('div', { class: 'desc', text: desc }) : null]),
        box
      ]);
    }

    range(path, min, max, step, fmt) {
      const s = this.settings;
      const value = Number(path.split('.').reduce((a, k) => (a ? a[k] : undefined), s));
      const label = el('span', { class: 'kbd-hint', text: (fmt || String)(value) });
      const node = el('input', { type: 'range', min, max, step, value, style: { flex: '1' } });
      node.addEventListener('input', () => { label.textContent = (fmt || String)(Number(node.value)); });
      node.addEventListener('change', () => this.patch(setDeep(path, Number(node.value))));
      return el('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, [node, label]);
    }

    // ── 各标签页 ──
    renderLlm(form) {
      const s = this.settings;
      form.appendChild(el('div', { class: 'section-title', text: '服务商' }));
      const providerSelect = this.select('llm.provider', Object.entries(PRESETS).map(([k, v]) => ({ value: k, label: v.label })));
      providerSelect.addEventListener('change', async () => {
        const p = PRESETS[providerSelect.value];
        if (p && p.baseURL) {
          await this.patch({ llm: { provider: providerSelect.value, baseURL: p.baseURL, model: p.model } });
          this.render();
        }
      });
      form.appendChild(this.field('服务商预设', providerSelect, '选择后会自动填入接口地址与模型名；也可选「自定义」手动填写任何 OpenAI 兼容接口。'));

      const row = el('div', { class: 'field-row' });
      row.appendChild(this.field('接口地址 Base URL', this.input('llm.baseURL', { placeholder: 'https://api.deepseek.com/v1' })));
      row.appendChild(this.field('模型 Model', this.input('llm.model', { placeholder: 'deepseek-chat' })));
      form.appendChild(row);

      const keyInput = el('input', { type: 'password', placeholder: s.llm.hasApiKey ? `已保存：${s.llm.apiKeyHint}（留空则不修改）` : 'sk-...' });
      const keyRow = el('div', { style: { display: 'flex', gap: '8px' } }, [
        keyInput,
        el('button', {
          class: 'cb-btn accent', text: '保存 Key',
          onclick: async () => {
            const v = keyInput.value.trim();
            if (!v) { toast('请输入 API Key', 'warn'); return; }
            const res = await window.PLT.settings.setApiKey(v);
            keyInput.value = '';
            await this.open('llm');
            toast(res.encrypted ? 'API Key 已加密保存（Windows 凭据保护）' : 'API Key 已保存（当前系统不支持加密，明文存储）', res.encrypted ? 'ok' : 'warn');
          }
        }),
        el('button', {
          class: 'cb-btn', text: '清除',
          onclick: async () => { await window.PLT.settings.setApiKey(''); await this.open('llm'); toast('已清除 API Key'); }
        })
      ]);
      form.appendChild(this.field('API Key', keyRow, s.meta.encrypted
        ? '使用 Electron safeStorage（Windows DPAPI）加密后保存在本地，不会上传到任何第三方。'
        : '⚠️ 当前系统不支持安全加密，Key 将以明文保存在本地设置文件中，请注意保管。'));

      const testRow = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } });
      const testBtn = el('button', { class: 'cb-btn', text: '测试连接' });
      const testOut = el('span', { class: 'muted small', text: '' });
      testBtn.addEventListener('click', async () => {
        testOut.textContent = '正在测试…';
        testBtn.disabled = true;
        const res = await window.PLT.settings.testLLM();
        testBtn.disabled = false;
        if (res.ok) {
          testOut.innerHTML = `<span style="color:#3fb950">✓ 连接成功</span> · ${res.ms}ms · ${U.escapeHtml(res.model || '')}`;
          toast('大模型连接正常', 'ok');
        } else {
          testOut.innerHTML = `<span style="color:#e5534b">✕ ${U.escapeHtml(res.error || res.code || '失败')}</span>`;
          toast('连接失败：' + (res.error || res.code), 'err');
        }
      });
      testRow.appendChild(testBtn);
      testRow.appendChild(testOut);
      form.appendChild(this.field('连通性', testRow, '会发送一个极小的请求验证 Key 与接口是否可用（约消耗几个 token）。'));

      form.appendChild(el('div', { class: 'section-title', text: '调用参数（省 token 调优）' }));
      const r2 = el('div', { class: 'field-row-3' });
      r2.appendChild(this.field('温度', this.input('llm.temperature', { type: 'number', min: 0, max: 1, step: 0.1 }), '越低越稳定，词典建议 0.1~0.3'));
      r2.appendChild(this.field('最大输出 tokens', this.input('llm.maxTokens', { type: 'number', min: 256, max: 8192, step: 256 })));
      r2.appendChild(this.field('超时(ms)', this.input('llm.timeoutMs', { type: 'number', min: 5000, max: 180000, step: 1000 })));
      form.appendChild(r2);
      const r3 = el('div', { class: 'field-row' });
      r3.appendChild(this.field('批量词数/次请求', this.input('llm.batchSize', { type: 'number', min: 4, max: 60, step: 1 }), '一次请求里合并多少个词，越大越省钱但单次耗时更长'));
      r3.appendChild(this.field('单行最多查词数', this.input('lookup.maxWordsPerRequest', { type: 'number', min: 1, max: 60, step: 1 })));
      form.appendChild(r3);

      const help = el('div', { class: 'skip-note' }, [
        el('b', { text: '费用参考：' }),
        document.createTextNode('以 DeepSeek 为例，约 ¥1 / 百万输入 tokens。按「托福及以上」级别取词，一集 30 分钟播客通常只需 ¥0.05~0.2；结果会本地缓存，同一个词永不重复付费。')
      ]);
      form.appendChild(help);
    }

    renderLevel(form) {
      const s = this.settings;
      form.appendChild(el('div', { class: 'section-title', text: '取词难度（核心省钱开关）' }));
      form.appendChild(this.field(
        '只解释该级别及以上的单词',
        this.select('lookup.level', [
          { value: 'none', label: '不筛选（全部单词，最省事但也最费 token）' },
          { value: 'a2', label: 'A2 基础及以上' },
          { value: 'b1', label: 'B1 中级及以上' },
          { value: 'b2', label: 'B2 中高级及以上' },
          { value: 'ielts', label: '雅思 IELTS 核心词及以上' },
          { value: 'toefl', label: '托福 TOEFL 核心学术词及以上' },
          { value: 'gre', label: 'GRE 高阶词及以上' },
          { value: 'educated_native', label: 'Educated Native 受过良好教育的母语级' }
        ]),
        '低于该级别的常用词不会被标记为「难词」；但所有单词都可以点选查询（由大模型结合语境给释义）。'
      ));

      form.appendChild(el('div', { class: 'section-title', text: '离线本地词典（0 费用）' }));
      const dictInfo = el('div', { class: 'skip-note' });
      const paintDict = async () => {
        const st = await window.PLT.dict.stats();
        clear(dictInfo);
        if (!st.loaded) {
          dictInfo.appendChild(el('b', { text: '本地词典未加载：' }));
          dictInfo.appendChild(document.createTextNode(st.error || '未知错误'));
          return;
        }
        dictInfo.appendChild(el('b', { text: `已内置 ${st.size.toLocaleString()} 个词条` }));
        dictInfo.appendChild(el('div', { class: 'muted small', style: { marginTop: '4px' }, html:
          `数据来源：${U.escapeHtml(st.source || 'ECDICT')}<br>含音标、词性、中文释义、CEFR 级别与雅思/托福/GRE 标签；加载耗时 ${st.loadMs || 0}ms` }));
      };
      paintDict();
      form.appendChild(dictInfo);
      form.appendChild(this.switchRow(
        '优先使用本地词典（强烈建议开启）',
        'lookup.localDict',
        '常见词直接在本地查，不产生任何费用；只有本地未收录、生僻、学术或多义的词才交给 AI 结合语境解释。'
      ));
      form.appendChild(this.switchRow(
        '对“需要语境”的词追加 AI 分析',
        'lookup.llmForContext',
        '本地词典能给出释义，但不了解这句话里的具体含义（如专业术语、典故）。关闭后完全离线、0 费用。'
      ));

      form.appendChild(el('div', { class: 'section-title', text: '其他' }));
      form.appendChild(this.switchRow('释义用中文', 'lookup.explainInChinese', '关闭后释义为纯英文'));
      form.appendChild(this.switchRow('启用 AI 查词缓存', 'lookup.cacheEnabled', 'AI 查过的词在同一语境下只付费一次'));
      form.appendChild(this.switchRow('加载字幕后自动扫描全文难词', 'lookup.autoScan', '本地词典扫描是毫秒级且免费，建议开启'));
      form.appendChild(this.field(
        '自动扫描的最大行数',
        this.input('lookup.autoScanLimit', { type: 'number', min: 0, max: 4000, step: 20 }),
        '本地扫描很快，一般无需限制；仅影响需要 AI 分析时的 token 上限。'
      ));
      form.appendChild(this.field('发音口音', this.select('lookup.pronounce', [
        { value: 'us', label: '美音' }, { value: 'uk', label: '英音' }, { value: 'none', label: '使用系统语音合成' }
      ])));

      const info = el('div', { class: 'skip-note' });
      const paint = async () => {
        const stats = await window.PLT.llm.cacheStats();
        clear(info);
        info.appendChild(el('b', { text: 'AI 查词缓存：' }));
        info.appendChild(document.createTextNode(`已缓存 ${stats.total} 条（含释义 ${stats.explained} 条 / 跳过 ${stats.skipped} 条）`));
        info.appendChild(el('div', { class: 'muted small', text: stats.path, style: { marginTop: '4px', wordBreak: 'break-all' } }));
      };
      paint();
      form.appendChild(info);
      form.appendChild(el('button', {
        class: 'cb-btn', text: '清空 AI 查词缓存',
        onclick: async () => {
          if (!await U.confirm('清空后再次查词会重新调用大模型（会产生费用），确定继续？')) return;
          await window.PLT.llm.clearCache();
          await paint();
          toast('缓存已清空', 'ok');
        }
      }));
    }

    renderAppearance(form) {
      const s = this.settings;
      form.appendChild(el('div', { class: 'section-title', text: '主题' }));
      form.appendChild(this.field('主题', this.select('ui.theme', [
        { value: 'system', label: '跟随系统' }, { value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }
      ]), '变更会同时切换 Windows 窗口材质（Mica / 亚克力）。'));
      form.appendChild(this.field('窗口材质', this.select('ui.backdrop', [
        { value: 'acrylic', label: '亚克力 Acrylic（Win11 推荐）' },
        { value: 'mica', label: '云母 Mica' },
        { value: 'tabbed', label: 'Tabbed' },
        { value: 'none', label: '纯色（性能最好）' }
      ]), '仅 Windows 11 支持；不生效时自动回退为纯色。'));

      form.appendChild(el('div', { class: 'section-title', text: '字体' }));
      form.appendChild(this.field('英文正文字体', this.input('ui.englishFont'), '默认 Times New Roman'));
      form.appendChild(this.field('中文正文字体', this.input('ui.chineseFont'), '默认 微软雅黑 Microsoft YaHei'));
      form.appendChild(this.field('界面字体', this.input('ui.uiFont'), '默认 Segoe UI Variable'));
      form.appendChild(this.field('正文字号', this.range('ui.transcriptFontScale', 0.8, 1.8, 0.05, (v) => `${Math.round(v * 100)}%`)));
      form.appendChild(this.field('字幕浮层字号', this.range('player.subtitleFontScale', 0.7, 1.8, 0.05, (v) => `${Math.round(v * 100)}%`)));
      form.appendChild(this.switchRow('显示中文译文', 'ui.showChinese'));
      form.appendChild(this.switchRow('自动滚动到当前句', 'ui.autoScroll'));
      form.appendChild(this.switchRow('高亮难词（按级别）', 'ui.highlightTargetWords'));
    }

    renderPlay(form) {
      const s = this.settings;
      form.appendChild(el('div', { class: 'section-title', text: '默认播放' }));
      form.appendChild(this.field('默认速度', this.select('player.rate', [
        { value: 0.25, label: '0.25×' }, { value: 0.5, label: '0.5×' }, { value: 0.75, label: '0.75×' },
        { value: 1, label: '1.0×' }, { value: 1.25, label: '1.25×' }, { value: 1.5, label: '1.5×' },
        { value: 1.75, label: '1.75×' }, { value: 2, label: '2.0×' }, { value: 2.5, label: '2.5×（最快）' }
      ]), '加速最高 2.5×，慢速最低 0.25×；变速不变调。'));
      form.appendChild(this.field('默认音量', this.range('player.volume', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)));
      form.appendChild(this.field('循环模式', this.select('player.loopMode', [
        { value: 'none', label: '不循环' }, { value: 'one', label: '单句重复' }, { value: 'all', label: '整篇循环' }
      ])));
      form.appendChild(this.switchRow('显示视频内嵌字幕浮层', 'player.subtitleOverlay'));
      form.appendChild(this.switchRow('浮层显示中英双语', 'player.subtitleBilingual'));
      form.appendChild(this.switchRow('每句播完自动暂停（精听模式）', 'player.autoPauseAtLineEnd'));

      form.appendChild(el('div', { class: 'section-title', text: '跟读' }));
      form.appendChild(this.field('跟读间隔系数', this.range('shadowing.gapFactor', 0.2, 2, 0.1, (v) => `${v.toFixed(1)}× 原句时长`)));
      form.appendChild(this.switchRow('录完自动跳下一句', 'shadowing.autoNextAfterRecord'));
    }

    async renderAdvanced(form) {
      const s = this.settings;
      form.appendChild(el('div', { class: 'section-title', text: '全局快捷键（任意程序内可用）' }));
      form.appendChild(this.field('屏幕取词 / 划词翻译', this.input('hotkeys.quickLookup', { placeholder: 'Alt+Shift+W' }), '在浏览器或 PDF 里选中英文后按下，即可弹出释义浮窗；若没有选中文字，会自动让主窗口进入截图 OCR。'));
      form.appendChild(this.field('播放 / 暂停', this.input('hotkeys.playPause', { placeholder: 'Alt+Shift+Space' })));
      form.appendChild(this.field('重播当前句', this.input('hotkeys.repeatLine', { placeholder: 'Alt+Shift+R' })));

      form.appendChild(el('div', { class: 'section-title', text: '应用内快捷键' }));
      const keys = [
        ['空格', '播放 / 暂停'], ['← / →', '后退 / 前进 5 秒'], ['Shift + ← / →', '后退 / 前进 10 秒'],
        ['↑ / ↓', '上一句 / 下一句'], ['Enter', '从选中句开始播放'], ['Ctrl + R', '重播当前句'],
        ['Ctrl + [ / ]', '减速 / 加速'], ['Ctrl + H', '显示或隐藏字幕'], ['Ctrl + D', '查询选中文本'],
        ['Ctrl + Shift + S', '屏幕取词（截图 OCR）'], ['Ctrl + Shift + D', '扫描全文难词'], ['F', '全屏'], ['L', '单句循环'], ['Ctrl + ,', '设置']
      ];
      const list = el('div', { style: { display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr', gap: '6px 14px', alignItems: 'center' } });
      for (const [k, v] of keys) {
        list.appendChild(el('span', { class: 'kbd-hint', text: k }));
        list.appendChild(el('span', { class: 'muted small', text: v }));
      }
      form.appendChild(list);

      form.appendChild(el('div', { class: 'section-title', text: '数据与诊断' }));
      const info = el('div', { class: 'skip-note' });
      const appInfo = await window.PLT.app.info();
      info.innerHTML = [
        `版本：${U.escapeHtml(appInfo.version)} · Electron ${U.escapeHtml(appInfo.electron)}`,
        `便携模式：${appInfo.portable ? '是（数据保存在程序同目录）' : '否（数据在用户目录）'}`,
        `数据目录：${U.escapeHtml(appInfo.dataDir)}`
      ].join('<br>');
      form.appendChild(info);
      form.appendChild(el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
        el('button', { class: 'cb-btn', text: '打开数据目录', onclick: () => window.PLT.app.openPath(appInfo.dataDir) }),
        el('button', {
          class: 'cb-btn', text: '重建全局快捷键',
          onclick: async () => { await this.patch({ hotkeys: { ...this.settings.hotkeys } }); toast('已重新注册全局快捷键', 'ok'); }
        }),
        el('button', {
          class: 'cb-btn', text: 'OCR 可用性检测',
          onclick: async () => {
            const res = await window.PLT.screen.ocrProbe();
            if (res.ok) {
              toast(`Windows OCR 引擎可用（识别语言：${res.lang || '系统默认'}）。截图取词会在首次使用时请求屏幕录制权限。`, 'ok', 5200);
            } else if (res.code === 'NO_OCR_ENGINE') {
              toast('Windows OCR 引擎不可用：请在「设置 → 时间和语言 → 语言和区域 → 添加语言」中安装英语（美国）语言包（含光学字符识别组件）。', 'err', 9000);
            } else {
              toast(`OCR 检测失败：${res.error || res.code}`, 'err', 8000);
            }
          }
        })
      ]));
    }
  }

  function setDeep(path, value) {
    const parts = String(path).split('.');
    const out = {};
    let cur = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = value;
      else cur = (cur[p] = {});
    });
    return out;
  }

  window.PLTSettings = { SettingsPanel, PRESETS };
}());

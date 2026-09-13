'use strict';
/**
 * preload.js — 上下文隔离桥
 * 仅暴露白名单方法，渲染进程无法直接触碰 Node/Electron 能力。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const on = (channel, handler) => {
  const wrapped = (_e, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('PLT', {
  // ── 窗口 ──
  win: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    state: () => invoke('window:state'),
    setAlwaysOnTop: (flag) => invoke('window:setAlwaysOnTop', flag),
    setFullScreen: (flag) => invoke('window:setFullScreen', flag),
    hideQuick: () => invoke('window:hideQuick'),
    onState: (cb) => on('window:state', cb)
  },

  app: {
    info: () => invoke('app:info'),
    ready: () => invoke('app:ready'),
    openExternal: (url) => invoke('app:openExternal', url),
    openPath: (p) => invoke('app:openPath', p),
    showItemInFolder: (p) => invoke('app:showItemInFolder', p),
    pathForFile: (file) => {
      try { return webUtils.getPathForFile(file); } catch (_) { return ''; }
    },
    onOpenFiles: (cb) => on('app:open-files', cb),
    onMenuAction: (cb) => on('menu:action', cb)
  },

  theme: {
    set: (theme) => invoke('theme:set', theme),
    resolve: () => invoke('theme:resolve'),
    setBackdrop: (b) => invoke('ui:setBackdrop', b),
    onChanged: (cb) => on('theme:changed', cb)
  },

  settings: {
    get: () => invoke('settings:get'),
    patch: (patch) => invoke('settings:patch', patch),
    reset: () => invoke('settings:reset'),
    setApiKey: (key) => invoke('settings:setApiKey', key),
    testLLM: () => invoke('settings:testLLM'),
    onChanged: (cb) => on('settings:changed', cb)
  },

  dialog: {
    openMedia: () => invoke('dialog:openMedia'),
    openSubtitle: () => invoke('dialog:openSubtitle'),
    openFolder: () => invoke('dialog:openFolder'),
    saveSubtitle: (payload) => invoke('dialog:saveSubtitle', payload),
    saveText: (payload) => invoke('dialog:saveText', payload)
  },

  file: {
    loadSubtitle: (p) => invoke('file:loadSubtitle', p),
    readText: (p) => invoke('file:readText', p),
    describe: (p) => invoke('file:describe', p),
    scanFolder: (dir) => invoke('file:scanFolder', dir),
    listSubtitles: (payload) => invoke('file:listSubtitles', payload),
    findSiblingSubtitle: (p) => invoke('file:findSiblingSubtitle', p),
    autoSaveSubtitle: (payload) => invoke('file:autoSaveSubtitle', payload)
  },

  llm: {
    lookup: (requests, options) => invoke('llm:lookup', { requests, options }),
    lookupWord: (word, context, options) => invoke('llm:lookupWord', { word, context, options }),
    scanLine: (text, context, options) => invoke('llm:scanLine', { text, context, options }),
    scanTranscript: (cues, options) => invoke('llm:scanTranscript', { cues, options }),
    levels: () => invoke('llm:levels'),
    cacheStats: () => invoke('llm:cacheStats'),
    clearCache: () => invoke('llm:clearCache')
  },

  dict: {
    stats: () => invoke('dict:stats'),
    lookup: (requests, options) => invoke('dict:lookup', { requests, options })
  },

  screen: {
    captureSelection: () => invoke('screen:captureSelection'),
    captureSources: () => invoke('screen:captureSources'),
    ocr: (dataUrl, langs) => invoke('screen:ocr', { dataUrl, langs }),
    ocrProbe: () => invoke('screen:ocrProbe'),
    displayBounds: () => invoke('screen:displayBounds'),
    showQuick: (payload) => invoke('screen:showQuick', payload)
  },

  clipboard: {
    read: () => invoke('clipboard:read'),
    write: (t) => invoke('clipboard:write', t)
  },

  vocab: {
    list: () => invoke('vocab:list'),
    add: (item) => invoke('vocab:add', item),
    remove: (idOrWord) => invoke('vocab:remove', idOrWord),
    update: (id, patch) => invoke('vocab:update', { id, patch }),
    clear: () => invoke('vocab:clear'),
    export: () => invoke('vocab:export')
  },

  history: {
    list: () => invoke('history:list'),
    add: (item) => invoke('history:add', item),
    clear: () => invoke('history:clear')
  },

  record: {
    save: (payload) => invoke('record:save', payload),
    saveToDir: (payload) => invoke('record:saveToDir', payload)
  },

  onQuickPayload: (cb) => on('quick:payload', cb)
});

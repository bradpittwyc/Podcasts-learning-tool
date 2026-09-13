/**
 * API Key 读取链路探针（诊断用，不输出明文）
 * 用法：electron.exe scripts/key-probe.js [portableDir] [userDataDir]
 */
const path = require('path');
const fs = require('fs');
const { app, safeStorage } = require('electron');

const portableDir = process.argv[2] || '';
const userDataDir = process.argv[3] || '';
if (portableDir) process.env.PORTABLE_EXECUTABLE_DIR = portableDir;
if (userDataDir) app.setPath('userData', userDataDir);

app.whenReady().then(() => {
  const out = {
    portableEnv: process.env.PORTABLE_EXECUTABLE_DIR || '(none)',
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    exe: app.getPath('exe'),
    encAvailable: safeStorage.isEncryptionAvailable(),
  };
  try { out.backend = safeStorage.getSelectedStorageBackend(); } catch (_) {}
  try {
    const store = require('../src/main/store');
    out.debugKey = store.debugKey();
    out.hasApiKey = store.hasApiKey();
    const k = store.getApiKey();
    out.keyLen = k ? k.length : 0;
    out.keyHead = k ? k.slice(0, 6) + '…' : '';
    // 直接对漫游目录的密文做一次解密，判断是不是 DPAPI 本身的问题
    const roaming = path.join(app.getPath('appData'), 'Podcasts Learning Tool', 'settings.json');
    if (fs.existsSync(roaming)) {
      const j = JSON.parse(fs.readFileSync(roaming, 'utf8').replace(/^\uFEFF/, ''));
      const enc = (j.llm && j.llm.apiKeyEnc) || '';
      out.roamingEncLen = enc.length;
      if (enc) {
        try {
          out.roamingDecrypt = safeStorage.decryptString(Buffer.from(enc, 'base64')).length + ' chars OK';
        } catch (e) { out.roamingDecrypt = 'FAIL: ' + e.message; }
      }
    }
  } catch (err) {
    out.error = err.message;
  }
  console.log('PROBE ' + JSON.stringify(out, null, 2));
  app.exit(0);
});

const fs = require('fs');
const path = 'popup/popup.js';
let src = fs.readFileSync(path, 'utf8');

const m1 = "  $('layout').value = s.layout || 'trans-top';";
const a1 = [
  "  $('layout').value = s.layout || 'trans-top';",
  "  const tc = await chrome.storage.local.get({ vtTranslate: { provider: 'auto', apiKey: '' } });",
  '  const tcfg = tc.vtTranslate || {};',
  "  $('provider').value = tcfg.provider || 'auto';",
  "  $('apiKey').value = tcfg.apiKey || '';",
  '  toggleKeyRow();',
].join('\n');
if (!src.includes(m1)) { console.error('m1 not found'); process.exit(1); }
src = src.replace(m1, a1);

const m2 = 'function saveSettings() {';
const a2 = [
  'function toggleKeyRow() {',
  "  $('keyRow').style.display = $('provider').value === 'deepseek' ? 'flex' : 'none';",
  '}',
  'function saveTranslateCfg() {',
  '  chrome.storage.local.set({',
  '    vtTranslate: {',
  "      provider: $('provider').value,",
  "      apiKey: ($('apiKey').value || '').trim()",
  '    }',
  '  });',
  '}',
  '',
  m2,
].join('\n');
if (!src.includes(m2)) { console.error('m2 not found'); process.exit(1); }
src = src.replace(m2, a2);

const m3 = "['mode', 'model', 'targetLang', 'fontSize', 'layout'].forEach(id => {";
const a3 = [
  "$('provider').addEventListener('change', () => {",
  '  toggleKeyRow();',
  '  saveTranslateCfg();',
  "  setStatus($('provider').value === 'deepseek' ? '已切换 DeepSeek 翻译（填入 Key 生效）' : '已切换自动翻译');",
  '});',
  "$('apiKey').addEventListener('change', () => {",
  '  saveTranslateCfg();',
  "  setStatus('API Key 已保存');",
  '});',
  '',
  m3,
].join('\n');
if (!src.includes(m3)) { console.error('m3 not found'); process.exit(1); }
src = src.replace(m3, a3);

fs.writeFileSync(path, src);
console.log('popup.js splice done');
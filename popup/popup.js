'use strict';
const $ = id => document.getElementById(id);
let tab = null, lastPing = null, translateSettings = {};
let initialized = false;
let startAttempt = 0;
const controls = ['mode', 'model', 'sourceLang', 'targetLang', 'fontSize', 'layout', 'isolateAudio',
  'provider', 'apiKey', 'deepseekModel', 'videoSource', 'startBtn', 'stopBtn'];
for (const id of controls) $(id).disabled = true;
function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').style.color = error ? '#f87171' : '#94a3b8';
}
async function sendMsg(message) {
  try { return await chrome.runtime.sendMessage(message) || { ok: false, error: '扩展未响应，请重新加载' }; }
  catch (error) { return { ok: false, error: error.message }; }
}
function toggleKeyRow() {
  const display = $('provider').value === 'deepseek' ? 'flex' : 'none';
  $('keyRow').style.display = display;
  $('deepseekModelRow').style.display = display;
}
async function saveTranslateCfg() {
  if (!initialized) return;
  translateSettings = { ...translateSettings, provider: $('provider').value,
    apiKey: $('apiKey').value.trim(), model: $('deepseekModel').value };
  await chrome.storage.local.set({ vtTranslate: translateSettings });
}
async function saveSettings() {
  if (!initialized) return;
  const settings = { mode: $('mode').value, model: $('model').value, sourceLang: $('sourceLang').value,
    targetLang: $('targetLang').value, fontSize: Number($('fontSize').value) || 22, layout: $('layout').value,
    isolateAudio: $('isolateAudio').checked };
  await chrome.storage.local.set({ vtSettings: settings });
  if (tab?.id != null) chrome.tabs.sendMessage(tab.id, { type: 'vt-settings', settings }).catch(() => {});
}
async function ping() {
  if (!tab) return;
  lastPing = await sendMsg({ type: 'probe-tab', tabId: tab.id });
  const previous = $('videoSource').value;
  $('videoSource').replaceChildren(new Option('自动锁定主视频', 'auto'));
  (lastPing.sources || []).forEach((source, index) => {
    const value = JSON.stringify({ frameId: source.frameId, videoId: source.videoId });
    const label = '视频 ' + (index + 1) + ' · ' + source.width + '×' + source.height + (source.playing ? ' · 播放中' : ' · 已暂停');
    $('videoSource').add(new Option(label, value));
  });
  if ([...$('videoSource').options].some(option => option.value === previous)) $('videoSource').value = previous;
  else if (previous && previous !== 'auto') {
    const missing = new Option('原目标已移除，请重新选择', previous);
    missing.disabled = true;
    $('videoSource').add(missing);
    $('videoSource').value = previous;
  }
  $('videoInfo').textContent = lastPing.ok
    ? lastPing.videos + ' 个' + (lastPing.playing ? '（播放中）' : '') + (lastPing.hasCaptions ? ' · 可读字幕' : '')
    : '请刷新视频页面';
}
async function load() {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const stored = await chrome.storage.local.get(['vtSettings', 'vtTranslate']);
  const settings = { mode: 'auto', model: 'base', sourceLang: 'auto', targetLang: 'zh-CN', fontSize: 22, layout: 'trans-top', ...stored.vtSettings };
  for (const id of ['mode', 'model', 'sourceLang', 'targetLang', 'fontSize', 'layout']) $(id).value = String(settings[id]);
  $('isolateAudio').checked = settings.isolateAudio !== false;
  translateSettings = stored.vtTranslate || {};
  $('provider').value = translateSettings.provider || 'auto';
  $('apiKey').value = translateSettings.apiKey || '';
  $('deepseekModel').value = ['deepseek-v4-flash', 'deepseek-v4-pro'].includes(translateSettings.model) ? translateSettings.model : 'deepseek-v4-flash';
  toggleKeyRow();
  await ping();
  const response = await sendMsg({ type: 'get-state' });
  if (response.state?.active && response.state.tabId === tab?.id) {
    setStatus(response.state.mode === 'audio' ? '音频识别运行中 · 已锁定主视频' : '字幕翻译运行中 · 已锁定主视频');
    const selection = JSON.stringify({ frameId: response.state.targetFrameId, videoId: response.state.targetVideoId });
    if ([...$('videoSource').options].some(option => option.value === selection)) $('videoSource').value = selection;
  }
}
$('startBtn').addEventListener('click', async () => {
  if (!initialized) return;
  const attempt = ++startAttempt;
  if (!tab) { setStatus('没有找到当前标签页', true); return; }
  $('startBtn').disabled = true;
  try {
    await saveSettings();
    await saveTranslateCfg(); // Persist a just-pasted key before the worker starts.
    if (attempt !== startAttempt) return;
    if ($('provider').value === 'deepseek' && !$('apiKey').value.trim()) { setStatus('请先填写 DeepSeek API Key', true); return; }
    await ping();
    if (attempt !== startAttempt) return;
    if (!lastPing?.ok) { setStatus(lastPing?.error || '请刷新视频页面', true); return; }
    const supportsAudio = !!chrome.tabCapture?.getMediaStreamId;
    const chosen = $('mode').value;
    const source = $('videoSource').value === 'auto' ? null : JSON.parse($('videoSource').value);
    const selected = source && lastPing.sources?.find(item => item.frameId === source.frameId && item.videoId === source.videoId);
    if (source && !selected) { setStatus('原视频已移除，请重新选择翻译目标', true); return; }
    const hasCaptions = selected ? selected.hasCaptions : lastPing.hasCaptions;
    const mode = chosen === 'auto' ? (hasCaptions || !supportsAudio ? 'captions' : 'audio') : chosen;
    if (mode === 'audio' && !supportsAudio) { setStatus('此浏览器不支持音频捕获，请选择字幕识别', true); return; }
    setStatus(mode === 'audio' ? '正在连接声音并加载语音模型…' : '正在读取播放器字幕…');
    const response = await sendMsg({ type: mode === 'audio' ? 'start-capture' : 'start-captions', tabId: tab.id,
      model: $('model').value, sourceLang: $('sourceLang').value, targetLang: $('targetLang').value,
      source, isolateAudio: $('isolateAudio').checked });
    if (attempt !== startAttempt) return;
    setStatus(response.ok ? (mode === 'audio' ? '已启动；模型就绪后开始识别' : '字幕翻译已启动') : response.error || '启动失败', !response.ok);
  } catch (error) { if (attempt === startAttempt) setStatus(error.message, true); }
  finally { if (attempt === startAttempt) $('startBtn').disabled = false; }
});
$('stopBtn').addEventListener('click', async () => {
  if (!initialized || !tab) return;
  const attempt = ++startAttempt;
  $('startBtn').disabled = true;
  $('stopBtn').disabled = true;
  const response = await sendMsg({ type: 'stop-capture', tabId: tab?.id });
  if (attempt === startAttempt) {
    setStatus(response.ok ? '已停止' : response.error, !response.ok);
    $('startBtn').disabled = false;
    $('stopBtn').disabled = false;
  }
});
$('provider').addEventListener('change', () => { toggleKeyRow(); saveTranslateCfg().catch(error => setStatus(error.message, true)); });
$('isolateAudio').addEventListener('change', () => saveSettings().then(() => setStatus('声音隔离设置已保存，重新开始翻译后生效'), error => setStatus(error.message, true)));
for (const id of ['apiKey', 'deepseekModel']) $(id).addEventListener('change', () => {
  saveTranslateCfg().then(() => setStatus('翻译设置已保存'), error => setStatus(error.message, true));
});
for (const id of ['mode', 'model', 'sourceLang', 'targetLang', 'fontSize', 'layout']) $(id).addEventListener('change', () => {
  saveSettings().then(() => { if (!['fontSize', 'layout'].includes(id)) setStatus('设置已保存，重新开始翻译后生效'); }, error => setStatus(error.message, true));
});
chrome.runtime.onMessage.addListener(message => {
  if (message?.type !== 'vt-status' || !message.status) return;
  if (message.tabId != null && message.tabId !== tab?.id) return;
  const status = message.status;
  if (status.state === 'loading') setStatus('加载模型 ' + Math.round(status.progress || 0) + '% · ' + (status.detail || ''));
  else if (status.state === 'error') setStatus(status.detail || '出错', true);
  else if (['listening', 'starting', 'hint', 'stopped'].includes(status.state)) setStatus(status.detail || status.state);
});
load().then(() => {
  initialized = true;
  for (const id of controls) $(id).disabled = false;
}).catch(error => setStatus(error.message, true));

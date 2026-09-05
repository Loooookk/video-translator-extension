import { createTranslator } from './lib/translation.js';

let captureState = null;
let translateConfig = { provider: 'auto', apiKey: '' };
const frames = new Map(), requests = new Map();
let audioQueue = [], audioRunning = false, audioSequence = 0, context = [];
let lifecycle = Promise.resolve();
const translator = createTranslator({ getConfig: () => translateConfig });
const ready = (async () => {
  const saved = await chrome.storage.local.get(['vtState', 'vtTranslate']);
  translateConfig = { ...translateConfig, ...saved.vtTranslate };
  captureState = saved.vtState || null;
  if (captureState?.active && captureState.mode === 'audio') {
    try {
      const state = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-state' });
      if (!state?.active || state.sessionId !== captureState.sessionId) captureState.active = false;
    } catch { captureState.active = false; }
    await saveState();
  }
})().catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.vtTranslate) {
    translateConfig = { provider: 'auto', apiKey: '', ...changes.vtTranslate.newValue };
    translator.clear();
  }
});
async function saveState() { await chrome.storage.local.set({ vtState: captureState }); }
function active(id) { return captureState?.active && captureState.sessionId === id; }
function currentTimeline(message) {
  return active(message.sessionId) && (message.playbackEpoch ?? 0) === (captureState.playbackEpoch ?? 0);
}

async function resetPlayback(message, sender) {
  await ready;
  if (!active(message.sessionId) || sender.tab?.id !== captureState.tabId ||
      sender.frameId !== captureState.targetFrameId || !Number.isSafeInteger(message.playbackEpoch) ||
      message.playbackEpoch <= (captureState.playbackEpoch ?? 0)) {
    return { ok: false, cancelled: true };
  }
  captureState = { ...captureState, playbackEpoch: message.playbackEpoch };
  audioQueue = [];
  context = [];
  for (const controller of requests.values()) controller.abort();
  requests.clear();
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'audio-reset',
    sessionId: message.sessionId, playbackEpoch: message.playbackEpoch }).catch(() => {});
  await saveState();
  return { ok: true };
}
function status(state, detail, extra = {}) {
  const message = { type: 'vt-status', tabId: captureState?.tabId, sessionId: captureState?.sessionId, status: { state, detail, ...extra } };
  chrome.runtime.sendMessage(message).catch(() => {});
  if (captureState?.tabId != null) chrome.tabs.sendMessage(captureState.tabId, message).catch(() => {});
}
function largestFrame(tabId) {
  if (captureState?.active && captureState.tabId === tabId && Number.isInteger(captureState.targetFrameId)) return captureState.targetFrameId;
  const entries = frames.get(tabId);
  let frameId = null, area = 0;
  for (const [id, item] of entries || []) {
    if (Date.now() - item.at > 8000) { entries.delete(id); continue; }
    if (item.area > area) { area = item.area; frameId = id; }
  }
  return frameId;
}
function sourceCandidates(tabId) {
  const result = [];
  for (const [frameId, frame] of frames.get(tabId) || []) {
    if (Date.now() - frame.at > 8000) continue;
    for (const video of frame.candidates || []) result.push({ ...video, frameId, documentId: frame.documentId });
  }
  return result.sort((a, b) => Number(b.playing) - Number(a.playing) || b.area - a.area);
}
async function probeTab(tabId) {
  frames.delete(tabId);
  try { await chrome.tabs.sendMessage(tabId, { type: 'vt-probe' }); }
  catch { return { ok: false, error: '请刷新视频页面后重试；浏览器内置页面不支持扩展' }; }
  await new Promise(resolve => setTimeout(resolve, 120));
  const items = [...(frames.get(tabId)?.values() || [])];
  const sources = sourceCandidates(tabId);
  const recommended = sources.find(item => item.playing && item.area >= 7200);
  return { ok: true, videos: items.reduce((n, item) => n + (item.videos || 0), 0),
    playing: items.reduce((n, item) => n + (item.playing || 0), 0),
    hasCaptions: !!recommended?.hasCaptions, sources };
}
async function chooseSource(message) {
  if (!sourceCandidates(message.tabId).length) await probeTab(message.tabId);
  const candidates = sourceCandidates(message.tabId);
  const selected = message.source
    ? candidates.find(item => item.frameId === message.source.frameId && item.videoId === message.source.videoId)
    : candidates.find(item => item.playing && item.area >= 7200);
  if (!selected) throw new Error('未找到主视频，请先播放视频，再在翻译目标中选择它');
  if (!selected.playing) throw new Error('请先播放所选视频，再开始翻译');
  return selected;
}
async function activateSource(state) {
  await chrome.tabs.sendMessage(state.tabId, { type: 'media-session-start', ...state });
  const response = await chrome.tabs.sendMessage(state.tabId, {
    type: state.mode === 'audio' ? 'audio-mode-on' : 'captions-start', ...state
  }, { frameId: state.targetFrameId });
  if (!response?.ok) throw new Error(response?.error || '所选主视频已变化，请刷新视频列表后重试');
}
async function sendToFrame(tabId, message, frameId = largestFrame(tabId)) {
  try {
    if (frameId == null) await chrome.tabs.sendMessage(tabId, message);
    else await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch { /* A navigated frame must not break the next subtitle. */ }
}
function serialize(action) {
  lifecycle = lifecycle.catch(() => {}).then(async () => { await ready; return action(); });
  return lifecycle;
}
async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error('此浏览器不支持音频识别，请使用字幕识别');
  if (!(await chrome.offscreen.hasDocument())) await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html', reasons: ['USER_MEDIA'], justification: '本地语音识别并回放捕获的标签页声音'
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-state' });
      if (response?.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('音频组件未能启动，请重新加载扩展');
}
async function stop() {
  const previous = captureState;
  if (captureState) captureState = { ...captureState, active: false };
  audioQueue = []; context = [];
  for (const controller of requests.values()) controller.abort();
  requests.clear();
  try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-stop', sessionId: previous?.sessionId }); } catch {}
  if (previous?.tabId != null) {
    await sendToFrame(previous.tabId, { type: 'audio-mode-off', sessionId: previous.sessionId }, null);
    await sendToFrame(previous.tabId, { type: 'captions-stop', sessionId: previous.sessionId }, null);
  }
  await saveState();
  return { ok: true };
}
async function start(message, mode) {
  await stop();
  if (translateConfig.provider === 'deepseek' && !translateConfig.apiKey?.trim()) throw new Error('请先填写 DeepSeek API Key');
  if (!Number.isInteger(message.tabId)) throw new Error('没有找到当前视频标签页');
  const selected = await chooseSource(message);
  const sessionId = crypto.randomUUID();
  captureState = { active: true, sessionId, tabId: message.tabId, mode, model: message.model || 'base', playbackEpoch: 0,
    targetFrameId: selected.frameId, targetVideoId: selected.videoId, targetDocumentId: selected.documentId,
    isolateAudio: message.isolateAudio !== false,
    sourceLang: message.sourceLang || 'auto', targetLang: message.targetLang || 'zh-CN', startedAt: Date.now() };
  audioSequence = 0;
  try {
    if (mode === 'audio') {
      await ensureOffscreen();
      await activateSource(captureState);
      // The worker owns the capture ID, independent of the short-lived popup.
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: message.tabId });
      const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'init-capture', ...captureState, streamId });
      if (!response?.ok) throw new Error('音频组件未响应，请重新加载扩展');
    } else await activateSource(captureState);
    await saveState();
    return { ok: true, state: captureState };
  } catch (error) { await stop(); throw error; }
}
function queueAudio(message) {
  if (!currentTimeline(message) || captureState.mode !== 'audio' || message.tabId !== captureState.tabId) return;
  if (!String(message.text || '').trim()) return;
  const index = audioQueue.findIndex(item => item.utteranceId === message.utteranceId);
  if (index >= 0) audioQueue[index] = message;
  else audioQueue.push(message);
  if (audioQueue.length > 2) { audioQueue.shift(); status('hint', '翻译接口暂时跟不上语速，已跳过过期片段，正在处理最新内容'); }
  runAudioQueue();
}
async function runAudioQueue() {
  if (audioRunning) return;
  audioRunning = true;
  try {
    while (audioQueue.length) {
      const message = audioQueue.shift();
      if (!currentTimeline(message)) continue;
      // A worker restart must not send sequence 1 to a page already at sequence 100.
      const seq = audioSequence = Math.max(audioSequence + 1, Date.now());
      const controller = new AbortController();
      requests.set('audio', controller);
      const envelope = { source: 'audio', sessionId: message.sessionId, playbackEpoch: message.playbackEpoch ?? 0, seq, original: message.text };
      await sendToFrame(message.tabId, { type: 'translation-pending', ...envelope });
      let firstAt = null, updatedAt = 0;
      const started = Date.now();
      const publish = (text, final = false) => {
        if (!currentTimeline(message) || controller.signal.aborted) return;
        const now = Date.now();
        if (!final && updatedAt && now - updatedAt < 70) return;
        if (firstAt === null) firstAt = now;
        updatedAt = now;
        sendToFrame(message.tabId, { type: 'translation', ...envelope, translated: text, partial: !final });
      };
      try {
        const result = await translator.translate({ text: message.text, target: message.targetLang, source: message.srcLang,
          context: context.filter(item => item.id !== message.utteranceId).map(item => item.text), signal: controller.signal, onUpdate: publish });
        publish(result.text, true);
        if (currentTimeline(message) && !controller.signal.aborted) {
          context = context.filter(item => item.id !== message.utteranceId);
          context.push({ id: message.utteranceId, text: message.text }); context = context.slice(-3);
          status('trace', '识别 ' + (message.asrMs || 0) + 'ms；翻译首字 ' + ((firstAt || Date.now()) - started) + 'ms；片段末尾至首字约 ' + Math.max(0, (firstAt || Date.now()) - message.capturedAt) + 'ms；' + result.via);
        }
      } catch (error) {
        if (currentTimeline(message) && !controller.signal.aborted) {
          status('error', error.message);
          await sendToFrame(message.tabId, { type: 'translation', ...envelope, translated: '', untranslated: true, error: error.message });
        }
      } finally { if (requests.get('audio') === controller) requests.delete('audio'); }
    }
  } finally { audioRunning = false; }
}
async function translateCaption(message, sender) {
  await ready;
  const tabId = sender.tab?.id;
  if (!currentTimeline(message) || captureState.mode !== 'captions' || tabId !== captureState.tabId) return { ok: false, cancelled: true };
  const chosen = largestFrame(tabId);
  if (chosen !== null && chosen !== (sender.frameId || 0)) return { ok: false, ignored: true };
  const key = (message.prefetch ? 'prefetch:' + message.text : 'caption') + ':' + (sender.frameId || 0);
  if (message.prefetch && (requests.has(key) || [...requests.keys()].filter(x => x.startsWith('prefetch:')).length >= 2)) return { ok: false };
  requests.get(key)?.abort();
  const controller = new AbortController(); requests.set(key, controller);
  const envelope = { source: 'caption', sessionId: message.sessionId, playbackEpoch: message.playbackEpoch ?? 0, seq: message.seq, original: message.text };
  const publish = (text, final = false) => {
    if (!message.prefetch && currentTimeline(message) && !controller.signal.aborted) sendToFrame(tabId,
      { type: 'translation', ...envelope, translated: text, partial: !final }, sender.frameId || 0);
  };
  try {
    const result = await translator.translate({ text: message.text, target: captureState.targetLang,
      source: message.lang || captureState.sourceLang,
      signal: controller.signal, onUpdate: publish });
    publish(result.text, true);
    if (!currentTimeline(message) || controller.signal.aborted) return { ok: false, cancelled: true, seq: message.seq };
    return { ok: true, translated: result.text, seq: message.seq };
  } catch (error) {
    if (!message.prefetch && !controller.signal.aborted && currentTimeline(message)) status('error', error.message);
    return { ok: false, error: error.message, seq: message.seq, cancelled: controller.signal.aborted };
  } finally { if (requests.get(key) === controller) requests.delete(key); }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || message.target === 'offscreen') return;
  const reply = promise => promise.then(respond, error => respond({ ok: false, error: error.message }));
  if (message.type === 'vt-area' || message.type === 'vt-frame-state') {
    if (sender.tab?.id != null) {
      if (!frames.has(sender.tab.id)) frames.set(sender.tab.id, new Map());
      frames.get(sender.tab.id).set(sender.frameId || 0, { ...message, documentId: sender.documentId, at: Date.now() });
    }
    reply(ready.then(() => ({ active: !!captureState?.active && sender.tab?.id === captureState.tabId,
      sessionId: captureState?.sessionId })));
    return true;
  } else if (message.type === 'probe-tab') {
    reply(probeTab(message.tabId)); return true;
  } else if (message.type === 'media-session-info') {
    reply(ready.then(async () => {
      if (!captureState?.active || sender.tab?.id !== captureState.tabId) return { active: false };
      const isTarget = (sender.frameId || 0) === captureState.targetFrameId;
      if (isTarget && captureState.targetDocumentId && sender.documentId !== captureState.targetDocumentId) {
        await serialize(stop);
        status('hint', '主视频页面已切换，请重新选择翻译目标');
        return { active: false };
      }
      return { active: true, state: captureState, isTarget };
    })); return true;
  } else if (message.type === 'vt-playback-reset') {
    reply(resetPlayback(message, sender)); return true;
  } else if (message.type === 'vt-target-lost') {
    serialize(async () => {
      if (active(message.sessionId) && sender.tab?.id === captureState.tabId && (sender.frameId || 0) === captureState.targetFrameId) {
        await stop(); status('hint', '主视频已移除，请重新选择翻译目标');
      }
    });
  } else if (message.type === 'get-state') { reply(ready.then(() => ({ ok: true, state: captureState }))); return true;
  } else if (message.type === 'start-capture' || message.type === 'start-captions') {
    reply(serialize(() => start(message, message.type === 'start-capture' ? 'audio' : 'captions'))); return true;
  } else if (message.type === 'stop-capture' || message.type === 'stop-captions') {
    reply(serialize(() => {
      if (captureState?.active && message.tabId != null && message.tabId !== captureState.tabId) {
        return { ok: false, error: '翻译正在另一个标签页运行，请在该标签页停止' };
      }
      return stop();
    })); return true;
  } else if (message.type === 'transcript') { ready.then(() => queueAudio(message));
  } else if (message.type === 'caption') { reply(translateCaption(message, sender)); return true;
  } else if (message.type === 'caption-cancel') {
    if (currentTimeline(message) && sender.tab?.id === captureState.tabId) requests.get('caption:' + (sender.frameId || 0))?.abort();
  } else if (message.type === 'asr-status') {
    ready.then(() => { if (active(message.sessionId)) status(message.state, message.detail, { progress: message.progress }); });
  } else if (message.type === 'offscreen-stopped') {
    serialize(async () => { if (active(message.sessionId)) { status('error', message.error || '音频捕获已结束'); await stop(); } });
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  frames.delete(tabId);
  serialize(() => { if (captureState?.tabId === tabId) return stop(); });
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') serialize(() => { if (captureState?.tabId === tabId) return stop(); });
});

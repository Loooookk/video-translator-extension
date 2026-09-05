import { pipeline, env, LogitsProcessor, LogitsProcessorList } from '../vendor/transformers.min.js';
import { SpeechSegmenter, cleanTranscript, computeRms } from './audio-utils.js';
import { createLanguageProcessor } from './whisper-language.js';
env.allowRemoteModels = true;
env.allowLocalModels = false;
env.remoteHost = 'https://hf-mirror.com/';
env.remotePathTemplate = '{model}/resolve/{revision}/';
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/');
let transcriber = null, loadedModel = null, modelPromise = null, recognitionTask = null;
let current = null;
function post(message) { chrome.runtime.sendMessage({ target: 'background', ...message }).catch(() => {}); }
function status(session, state, detail, extra = {}) {
  if (session && current !== session) return;
  post({ type: 'asr-status', sessionId: session?.id, state, detail, ...extra });
}
async function loadModel(session) {
  if (modelPromise) await modelPromise.catch(() => {});
  if (recognitionTask) await recognitionTask;
  if (current !== session) return;
  if (transcriber && loadedModel === session.model) return;
  modelPromise = (async () => {
    if (transcriber) { await transcriber.dispose(); transcriber = null; loadedModel = null; }
    status(session, 'loading', '正在加载多语言 Whisper ' + session.model + '，首次使用需要下载模型', { progress: 0 });
    transcriber = await pipeline('automatic-speech-recognition', 'Xenova/whisper-' + session.model, {
      device: 'wasm', dtype: 'q8',
      progress_callback: p => { if (typeof p?.progress === 'number') status(session, 'loading', p.file?.split('/').pop() || '', { progress: p.progress }); }
    });
    loadedModel = session.model;
  })();
  try { await modelPromise; } finally { modelPromise = null; }
}
async function startCapture(message) {
  await stopCapture();
  const session = {
    id: message.sessionId, tabId: message.tabId, model: ['tiny', 'base', 'small'].includes(message.model) ? message.model : 'base',
    sourceLang: message.sourceLang || 'auto', targetLang: message.targetLang || 'zh-CN', playbackEpoch: message.playbackEpoch ?? 0,
    ready: false, queue: [], segmenter: new SpeechSegmenter(), lastText: new Map(), lastSpeechAt: Date.now(), lastRms: 0
  };
  current = session;
  status(session, 'starting', '正在连接标签页声音');
  try {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false
    });
    if (current !== session) { media.getTracks().forEach(t => t.stop()); return; }
    session.stream = media;
    session.audio = new AudioContext({ sampleRate: 16000 });
    session.source = session.audio.createMediaStreamSource(media);
    // tabCapture suppresses normal playback. Restore sound before model downloads.
    session.source.connect(session.audio.destination);
    await session.audio.resume();
    await session.audio.audioWorklet.addModule(chrome.runtime.getURL('offscreen/pcm-worklet.js'));
    if (current !== session) return;
    session.worklet = new AudioWorkletNode(session.audio, 'pcm-worklet', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1]
    });
    session.source.connect(session.worklet);
    session.worklet.connect(session.audio.destination);
    session.clockOrigin = Date.now() - session.audio.currentTime * 1000;
    session.worklet.port.onmessage = event => {
      if (current !== session || !session.ready || !event.data?.pcm) return;
      const { pcm, endTime } = event.data;
      if (session.dropBefore != null && endTime <= session.dropBefore) return;
      session.lastRms = computeRms(pcm);
      const capturedAt = session.clockOrigin + endTime * 1000;
      for (const segment of session.segmenter.push(pcm, capturedAt)) enqueue(session, segment);
    };
    for (const track of media.getAudioTracks()) track.addEventListener('ended', () => {
      if (current === session) failSession(session, '标签页音频已停止，请重新开始翻译');
    });
    await loadModel(session);
    if (current !== session) return;
    session.ready = true; session.lastSpeechAt = Date.now();
    session.hintTimer = setInterval(() => {
      post({ type: 'capture-heartbeat', sessionId: session.id });
      if (Date.now() - session.lastSpeechAt > 15000) status(session, 'hint', session.lastRms < 0.002
        ? '未收到清晰声音，请检查播放器音量和当前是否有对话'
        : '已收到声音，尚未识别出文字；可指定原语言或换用更大语音模型');
    }, 10000);
    status(session, 'listening', '收音已连接，原语言：' + session.sourceLang);
  } catch (error) { if (current === session) await failSession(session, '音频识别启动失败：' + (error?.message || error)); }
}
function enqueue(session, segment) {
  segment.playbackEpoch = session.playbackEpoch;
  const index = session.queue.findIndex(item => item.utteranceId === segment.utteranceId);
  if (index >= 0) session.queue[index] = segment;
  else session.queue.push(segment);
  if (session.queue.length > 3) { session.queue.shift(); status(session, 'hint', '本机识别速度跟不上播放，已跳过过期音频；可选择 tiny 或视频自带字幕'); }
  runQueue();
}
function runQueue() {
  if (recognitionTask || !current?.ready) return;
  recognitionTask = (async () => {
    while (current?.ready && current.queue.length) {
      const session = current, segment = session.queue.shift(), started = Date.now();
      try {
        const options = {
          task: 'transcribe', language: session.sourceLang === 'auto' ? null : session.sourceLang,
          return_timestamps: false, chunk_length_s: 0, do_sample: false, max_new_tokens: 224
        };
        let detection = null;
        if (session.sourceLang === 'auto') {
          detection = createLanguageProcessor(transcriber.model, LogitsProcessor);
          options.decoder_input_ids = detection.decoderInputIds;
          options.forced_decoder_ids = null;
          options.logits_processor = new LogitsProcessorList();
          options.logits_processor.push(detection.processor);
        }
        const result = await transcriber(segment.pcm, options);
        if (current !== session || segment.playbackEpoch !== session.playbackEpoch) continue;
        const text = cleanTranscript(result?.text);
        if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
        const previous = session.lastText.get(segment.utteranceId);
        if (text === previous && !segment.final) continue;
        session.lastText.set(segment.utteranceId, text);
        if (session.lastText.size > 8) session.lastText.delete(session.lastText.keys().next().value);
        session.lastSpeechAt = Date.now();
        post({ type: 'transcript', sessionId: session.id, playbackEpoch: session.playbackEpoch, tabId: session.tabId, text,
          targetLang: session.targetLang,
          srcLang: detection ? (detection.processor.probability >= 0.5 ? detection.processor.language : 'auto') : session.sourceLang,
          detectedLanguage: detection?.processor.language, languageProbability: detection?.processor.probability,
          utteranceId: segment.utteranceId,
          revision: segment.revision, final: segment.final, capturedAt: segment.capturedAt, asrMs: Date.now() - started });
      } catch (error) {
        if (segment.playbackEpoch === session.playbackEpoch) status(session, 'error', '语音识别失败：' + (error?.message || error));
      }
    }
  })().finally(() => { recognitionTask = null; });
}
async function failSession(session, detail) {
  status(session, 'error', detail);
  await stopCapture(session.id);
  post({ type: 'offscreen-stopped', sessionId: session.id, error: detail });
}
async function stopCapture(sessionId) {
  const session = current;
  if (!session || (sessionId && sessionId !== session.id)) return;
  current = null; session.ready = false; session.queue.length = 0;
  clearInterval(session.hintTimer);
  try { session.worklet?.port.close(); session.worklet?.disconnect(); session.source?.disconnect(); } catch {}
  session.stream?.getTracks().forEach(t => t.stop());
  await session.audio?.close().catch(() => {});
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.target !== 'offscreen') return;
  if (message.type === 'offscreen-state') respond({ ok: true, active: !!current, sessionId: current?.id, playbackEpoch: current?.playbackEpoch });
  else if (message.type === 'audio-reset') {
    if (!current || message.sessionId !== current.id || !Number.isSafeInteger(message.playbackEpoch) || message.playbackEpoch <= current.playbackEpoch) {
      respond({ ok: false }); return;
    }
    current.playbackEpoch = message.playbackEpoch;
    current.queue.length = 0;
    current.segmenter = new SpeechSegmenter();
    current.lastText.clear();
    current.lastSpeechAt = Date.now();
    current.dropBefore = current.audio?.currentTime;
    respond({ ok: true });
  }
  else if (message.type === 'init-capture') {
    startCapture(message).catch(error => post({ type: 'offscreen-stopped', sessionId: message.sessionId, error: error.message }));
    respond({ ok: true });
  } else if (message.type === 'offscreen-stop') { stopCapture(message.sessionId).then(() => respond({ ok: true })); return true; }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createTranslator, readDeepSeekStream } from '../lib/translation.js';
import { SpeechSegmenter, cleanTranscript } from '../offscreen/audio-utils.js';
import { createLanguageProcessor } from '../offscreen/whisper-language.js';

const encoder = new TextEncoder();
const config = { provider: 'deepseek', apiKey: 'test-key-not-real' };
const jsonResponse = text => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
const event = (content, reason = null) => 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: reason }] }) + '\r\n\r\n';
function streamResponse(text, stride = 1) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += stride) controller.enqueue(bytes.slice(i, i + stride));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
function translator(fetchImpl, overrides = {}) {
  return createTranslator({ getConfig: () => config, fetchImpl, ...overrides });
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  assert.fail('Expected async event did not arrive');
}

test('SSE handles UTF-8 split at every byte, CRLF, comments and final event', async () => {
  const updates = [];
  const result = await readDeepSeekStream(streamResponse(': keepalive\r\n\r\n' + event('你') + event('好，日本。', 'stop') + 'data: [DONE]'), text => updates.push(text));
  assert.equal(result, '你好，日本。'); assert.deepEqual(updates, ['你', '你好，日本。']);
});
test('translation is displayed before the response finishes', async () => {
  let controller, finished = false;
  const updates = [];
  const response = new Response(new ReadableStream({ start(c) { controller = c; } }));
  const promise = readDeepSeekStream(response, text => updates.push(text)).then(text => { finished = true; return text; });
  controller.enqueue(encoder.encode(event('不')));
  await until(() => updates.length === 1);
  assert.equal(finished, false);
  controller.enqueue(encoder.encode(event('可以。', 'stop') + 'data: [DONE]\n\n'));
  assert.equal(await promise, '不可以。');
});
test('truncated and malformed streams are rejected instead of cached as complete', async () => {
  await assert.rejects(readDeepSeekStream(streamResponse(event('片段'))), { code: 'INCOMPLETE' });
  await assert.rejects(readDeepSeekStream(streamResponse(event('片段', 'length'))), { code: 'INCOMPLETE' });
  await assert.rejects(readDeepSeekStream(streamResponse('data: broken\n\n')), { code: 'STREAM' });
});
test('timeout covers a hanging response body after successful headers', async () => {
  const transport = translator(async (url, { signal }) => new Response(new ReadableStream({ start(controller) {
    signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
  } })), { timeoutMs: 25 });
  await assert.rejects(transport.translate({ text: 'Hello' }), { code: 'TIMEOUT' });
});
for (const [http, code] of [[401, 'AUTH'], [402, 'BALANCE'], [429, 'RATE_LIMIT']]) test('DeepSeek HTTP ' + http + ' is visible, with no silent provider switch', async () => {
  let calls = 0;
  const transport = translator(async url => { calls++; assert.match(url, /api.deepseek.com/); return new Response('', { status: http }); });
  await assert.rejects(transport.translate({ text: 'はい' }), { code });
  assert.equal(calls, 1);
});
test('DeepSeek uses non-thinking streaming and preserves parentheses and context', async () => {
  let body;
  const transport = translator(async (url, options) => { body = JSON.parse(options.body); return jsonResponse('不，服用 10 毫克。'); });
  await transport.translate({ text: 'No, take (10 mg).', source: 'en', context: ['We discussed the dose.'] });
  assert.equal(body.stream, true); assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(JSON.parse(body.messages[1].content), { source_language: 'en', previous: ['We discussed the dose.'], current: 'No, take (10 mg).' });
});
test('cache distinguishes full text beyond the old 120-character prefix and source language', async () => {
  let calls = 0;
  const transport = translator(async () => { calls++; return jsonResponse('译文' + calls); });
  const prefix = 'a'.repeat(130);
  const first = await transport.translate({ text: prefix + ' yes', source: 'en' });
  const second = await transport.translate({ text: prefix + ' no', source: 'en' });
  assert.notEqual(first.text, second.text);
  await transport.translate({ text: prefix + ' yes', source: 'ja' });
  assert.equal((await transport.translate({ text: prefix + ' yes', source: 'en' })).cached, true);
  assert.equal(calls, 3);
});
test('auto provider does not race a missing DeepSeek key against a valid Google response', async () => {
  const urls = [];
  const transport = createTranslator({ getConfig: () => ({ provider: 'auto' }), fetchImpl: async url => {
    urls.push(url); return new Response(JSON.stringify([[['你好', 'Hello']]]));
  } });
  assert.equal((await transport.translate({ text: 'Hello', source: 'auto' })).text, '你好');
  assert.equal(urls.length, 1); assert.match(urls[0], /sl=auto/);
});
test('free providers use first successful result even if another fails first', async () => {
  const transport = createTranslator({ getConfig: () => ({ provider: 'auto' }), fetchImpl: async url => {
    if (url.includes('googleapis')) return new Response('', { status: 503 });
    assert.match(url, /ja%7Czh-CN/);
    return new Response(JSON.stringify({ responseStatus: 200, responseData: { translatedText: '是的' } }));
  } });
  assert.equal((await transport.translate({ text: 'はい', source: 'ja' })).text, '是的');
});
test('stop cancellation interrupts streaming and does not cache an incomplete result', async () => {
  const controller = new AbortController(); let calls = 0;
  const transport = translator(async (url, { signal }) => {
    if (++calls === 2) return jsonResponse('完成');
    return new Response(new ReadableStream({ start(stream) {
      stream.enqueue(encoder.encode(event('部分')));
      signal.addEventListener('abort', () => stream.error(new DOMException('Aborted', 'AbortError')));
    } }));
  });
  const pending = transport.translate({ text: 'Hello', signal: controller.signal, onUpdate: () => controller.abort() });
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal((await transport.translate({ text: 'Hello' })).text, '完成');
  assert.equal(calls, 2);
});
test('short Japanese, English, negation and legitimate repeated replies survive cleaning', () => {
  for (const text of ['はい', 'いいえ', 'No.', 'Yes.', 'Thank you.', 'No, no!', '行く。行かない。', 'dose (10 mg)']) assert.equal(cleanTranscript(text), text);
  assert.equal(cleanTranscript('[Music]'), '');
});
test('utterances grow without cutting prior words, with first snapshot at 0.8 seconds', () => {
  const segmenter = new SpeechSegmenter();
  let snapshots = [];
  for (let i = 0; i < 20; i++) snapshots.push(...segmenter.push(new Float32Array(1280).fill(0.1), i * 80));
  assert.equal(snapshots[0].pcm.length, 12800);
  assert.equal(snapshots[1].pcm.length, 25600);
  assert.equal(snapshots[0].utteranceId, snapshots[1].utteranceId);
  assert.ok(snapshots[1].revision > snapshots[0].revision);
});
test('short spoken replies flush at a pause; silence creates no hallucination jobs', () => {
  const segmenter = new SpeechSegmenter();
  for (let i = 0; i < 30; i++) assert.deepEqual(segmenter.push(new Float32Array(1280)), []);
  segmenter.push(new Float32Array(1280).fill(0.1)); segmenter.push(new Float32Array(1280).fill(0.1));
  let results = [];
  for (let i = 0; i < 4; i++) results.push(...segmenter.push(new Float32Array(1280)));
  assert.equal(results.length, 1); assert.equal(results[0].final, true);
  const id = results[0].utteranceId;
  for (let i = 0; i < 2; i++) segmenter.push(new Float32Array(1280).fill(0.1));
  for (let i = 0; i < 4; i++) results.push(...segmenter.push(new Float32Array(1280)));
  assert.ok(results[1].utteranceId > id);
});

class Element {
  constructor(tag = 'DIV') { this.tagName = tag; this.nodeType = 1; this.children = []; this.style = {}; this.events = new Map(); this.isConnected = true; this.textContent = ''; }
  addEventListener(name, fn) { if (!this.events.has(name)) this.events.set(name, new Set()); this.events.get(name).add(fn); }
  removeEventListener(name, fn) { this.events.get(name)?.delete(fn); }
  dispatch(name) { for (const fn of this.events.get(name) || []) fn({ target: this }); }
  appendChild(child) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; }
  insertBefore(child, ref) { if (child.parentNode) child.parentNode.removeChild(child); child.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, child); }
  get firstChild() { return this.children[0]; }
  attachShadow() { this.shadowRoot = new Element(); return this.shadowRoot; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(['video', 'audio'].includes(selector) ? child.tagName === selector.toUpperCase() : child.className === selector.slice(1)) ? [child] : [], ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest() { return null; }
  getBoundingClientRect() { return { width: 960, height: 540, right: 960, top: 0, bottom: 540 }; }
}
const contentCode = readFileSync(new URL('../content/content.js', import.meta.url), 'utf8');
function contentHarness(track = null) {
  const video = new Element('VIDEO'); Object.assign(video, { paused: false, ended: false, muted: false, currentTime: 0, textTracks: track ? [track] : [] });
  const html = new Element('HTML'); html.appendChild(video);
  const sent = [], listeners = [], timers = new Map(), observers = []; let timerId = 0;
  const document = { documentElement: html, createElement: tag => new Element(tag.toUpperCase()), querySelectorAll: selector => html.querySelectorAll(selector), addEventListener() {} };
  const window = { innerWidth: 1280, innerHeight: 720 }; window.top = window;
  const chrome = { storage: { local: { get(value, callback) { callback({}); } } }, runtime: {
    onMessage: { addListener(fn) { listeners.push(fn); } },
    sendMessage(message, callback) { sent.push({ message, callback }); return Promise.resolve({ ok: true }); }
  } };
  vm.runInNewContext(contentCode, { document, window, chrome, MutationObserver: class { constructor(fn) { observers.push(fn); } observe() {} },
    setInterval: fn => { timers.set(++timerId, { fn, delay: 100 }); return timerId; }, clearInterval: id => timers.delete(id),
    setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame: () => 1, console });
  return { video, sent, timers, chrome, dispatch: message => { let response; listeners[0](message, {}, value => { response = value; }); return response; },
    addMedia: media => { html.appendChild(media); for (const observer of observers) observer([{ addedNodes: [media], removedNodes: [] }]); },
    removeMedia: media => { html.removeChild(media); media.isConnected = false; for (const observer of observers) observer([{ addedNodes: [], removedNodes: [media] }]); },
    zh: () => html.children.find(x => x.id === 'vt-overlay-host').shadowRoot.querySelector('.zh').textContent,
    sub: () => html.children.find(x => x.id === 'vt-overlay-host').shadowRoot.querySelector('.vt-sub') };
}
function makeTrack(cues) { const track = new Element(); return Object.assign(track, { kind: 'subtitles', language: 'en', mode: 'disabled', cues, activeCues: [cues[0]] }); }
function audioMessage(seq, text, extra = {}) { return { type: 'translation', source: 'audio', sessionId: 's1', seq, original: 'source', translated: text, ...extra }; }

test('subtitle accepts short replies, similar negation corrections, and ignores old sequences', () => {
  const h = contentHarness(); h.dispatch({ type: 'audio-mode-on', sessionId: 's1' });
  h.dispatch(audioMessage(1, '是')); assert.equal(h.zh(), '是');
  h.dispatch(audioMessage(2, '他今天会来这里。', { partial: true }));
  h.dispatch(audioMessage(2, '他今天不会来这里。')); assert.equal(h.zh(), '他今天不会来这里。');
  h.dispatch(audioMessage(2, '他今天会来这里。', { partial: true })); assert.equal(h.zh(), '他今天不会来这里。');
  h.dispatch(audioMessage(1, '旧字幕')); assert.equal(h.zh(), '他今天不会来这里。');
});
test('identical subtitle reappears after auto-hide and stale sessions cannot display', () => {
  const h = contentHarness(); h.dispatch({ type: 'audio-mode-on', sessionId: 's1' });
  h.dispatch(audioMessage(1, '是'));
  [...h.timers.values()].find(x => x.delay === 12000).fn(); assert.equal(h.sub().style.display, 'none');
  h.dispatch(audioMessage(2, '是')); assert.equal(h.sub().style.display, 'block');
  h.dispatch({ type: 'audio-mode-off', sessionId: 's1' });
  h.dispatch({ type: 'audio-mode-on', sessionId: 's2' });
  h.dispatch(audioMessage(999, '旧会话')); assert.equal(h.sub().style.display, 'none');
});
test('caption requests follow the current cue, ignore late replies, clear gaps and restore tracks', () => {
  const cues = [{ text: 'First', startTime: 0, endTime: 1 }, { text: 'Second', startTime: 2, endTime: 3 }];
  const track = makeTrack(cues), h = contentHarness(track);
  h.dispatch({ type: 'captions-start', sessionId: 's1', targetLang: 'zh-CN' });
  assert.equal(track.mode, 'hidden');
  const first = h.sent.find(x => x.message.type === 'caption' && !x.message.prefetch);
  h.video.currentTime = 2; track.activeCues = [cues[1]]; track.dispatch('cuechange');
  const second = h.sent.filter(x => x.message.type === 'caption' && !x.message.prefetch).at(-1);
  second.callback({ ok: true, translated: '第二句' }); first.callback({ ok: true, translated: '第一句' });
  assert.equal(h.zh(), '第二句');
  h.video.currentTime = 4; track.activeCues = []; track.dispatch('cuechange');
  second.callback({ ok: true, translated: '迟到的第二句' }); assert.equal(h.sub().style.display, 'none');
  h.dispatch({ type: 'captions-stop', sessionId: 's1' }); assert.equal(track.mode, 'disabled');
});
test('all simultaneous cue lines are translated and upcoming cues are prefetched', () => {
  const cues = [{ text: 'Line one', startTime: 0, endTime: 1 }, { text: 'Line two', startTime: 0, endTime: 1 }, { text: 'Next', startTime: 2, endTime: 3 }];
  const track = makeTrack(cues); track.activeCues = cues.slice(0, 2);
  const h = contentHarness(track); h.dispatch({ type: 'captions-start', sessionId: 's1' });
  assert.equal(h.sent.find(x => x.message.type === 'caption' && !x.message.prefetch).message.text, 'Line one Line two');
  assert.ok(h.sent.some(x => x.message.prefetch && x.message.text === 'Next'));
});

const backgroundCode = readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
function workerHarness({ fetchImpl = async () => jsonResponse('你好'), savedState = null, captureFailure = false } = {}) {
  const listeners = [], sent = [], storage = { vtTranslate: config, vtState: savedState };
  const chrome = {
    storage: { local: { get: async () => storage, set: async values => Object.assign(storage, structuredClone(values)) }, onChanged: { addListener() {} } },
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, sendMessage: async message => {
      sent.push(message);
      if (message.type === 'offscreen-state') return { ok: true, active: !!savedState?.active, sessionId: savedState?.sessionId };
      return { ok: true };
    } },
    offscreen: { hasDocument: async () => true, createDocument: async () => {} },
    tabCapture: { getMediaStreamId: async () => { if (captureFailure) throw new Error('capture denied'); sent.push({ type: 'stream-id' }); return 'stream'; } },
    tabs: { sendMessage: async (tabId, message, options) => { sent.push({ ...message, tabId, frameId: options?.frameId }); return { ok: true }; },
      onRemoved: { addListener() {} }, onUpdated: { addListener() {} } }
  };
  vm.runInNewContext(backgroundCode, { chrome, createTranslator: options => createTranslator({ ...options, fetchImpl }),
    AbortController, crypto: globalThis.crypto, setTimeout, clearTimeout, console });
  listeners[0]({ type: 'vt-frame-state', area: 518400, videos: 1, playing: 1,
    candidates: [{ videoId: '1', width: 960, height: 540, area: 518400, playing: true }] },
    { tab: { id: 1 }, frameId: 0, documentId: 'main-document' }, () => {});
  return { sent, storage,
    call: (message, sender = {}) => new Promise(resolve => { const keep = listeners[0](message, sender, resolve); if (!keep) resolve(); }),
    emit: (message, sender = {}) => listeners[0](message, sender, () => {}) };
}
test('worker acquires capture ID, stops streaming, ignores old capture completion, and keeps new session', async () => {
  let signal;
  const h = workerHarness({ fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    } }));
  } });
  const started = await h.call({ type: 'start-capture', tabId: 1, model: 'base', sourceLang: 'ja' });
  assert.equal(started.ok, true); assert.ok(h.sent.some(x => x.type === 'stream-id'));
  h.emit({ type: 'transcript', sessionId: started.state.sessionId, tabId: 1, text: 'はい', utteranceId: 1, capturedAt: Date.now() });
  await until(() => signal);
  await h.call({ type: 'stop-capture' }); assert.equal(signal.aborted, true);
  const next = await h.call({ type: 'start-capture', tabId: 1 });
  h.emit({ type: 'offscreen-stopped', sessionId: started.state.sessionId });
  await tick(); assert.equal((await h.call({ type: 'get-state' })).state.sessionId, next.state.sessionId);
  assert.equal((await h.call({ type: 'get-state' })).state.active, true);
  await h.call({ type: 'stop-capture' });
});
test('worker restores an actual live offscreen session after restart', async () => {
  const h = workerHarness({ savedState: { active: true, mode: 'audio', sessionId: 'live', tabId: 1 } });
  assert.equal((await h.call({ type: 'get-state' })).state.active, true);
});
test('capture failure is returned and rolls back active state', async () => {
  const h = workerHarness({ captureFailure: true });
  assert.equal((await h.call({ type: 'start-capture', tabId: 1 })).ok, false);
  assert.equal((await h.call({ type: 'get-state' })).state.active, false);
});
test('prefetched caption is cached and no future subtitle is displayed prematurely', async () => {
  let calls = 0;
  const h = workerHarness({ fetchImpl: async () => { calls++; return jsonResponse('预先译好'); } });
  h.emit({ type: 'vt-frame-state', area: 900000,
    candidates: [{ videoId: '1', area: 900000, playing: true }] }, { tab: { id: 1 }, frameId: 2 });
  const start = await h.call({ type: 'start-captions', tabId: 1 });
  const sender = { tab: { id: 1 }, frameId: 2 };
  const message = { type: 'caption', sessionId: start.state.sessionId, text: 'Next sentence', lang: 'en', seq: 1 };
  await h.call({ ...message, prefetch: true }, sender);
  assert.equal(h.sent.filter(x => x.type === 'translation').length, 0);
  assert.equal((await h.call(message, sender)).translated, '预先译好');
  assert.equal(calls, 1); assert.equal(h.sent.find(x => x.type === 'translation').frameId, 2);
  await h.call({ type: 'stop-capture' });
});

test('restored worker emits increasing timestamp sequences instead of restarting at one', async () => {
  const h = workerHarness({ savedState: { active: true, mode: 'audio', sessionId: 'live', tabId: 1 } });
  await h.call({ type: 'get-state' });
  const started = Date.now();
  h.emit({ type: 'transcript', sessionId: 'live', tabId: 1, text: 'Hello', utteranceId: 1, capturedAt: started });
  await until(() => h.sent.some(x => x.type === 'translation'));
  assert.ok(h.sent.find(x => x.type === 'translation').seq >= started);
  await h.call({ type: 'stop-capture' });
});
test('caption source uses the track language, not the underlying audio language', async () => {
  let source;
  const h = workerHarness({ fetchImpl: async (url, options) => {
    source = JSON.parse(JSON.parse(options.body).messages[1].content).source_language;
    return jsonResponse('你好');
  } });
  const start = await h.call({ type: 'start-captions', tabId: 1, sourceLang: 'ja' });
  await h.call({ type: 'caption', sessionId: start.state.sessionId, text: 'Hello', lang: 'en', seq: 1 }, { tab: { id: 1 }, frameId: 0 });
  assert.equal(source, 'en'); await h.call({ type: 'stop-capture' });
});

const offscreenCode = readFileSync(new URL('../offscreen/offscreen.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '');
function offscreenHarness({ load, media } = {}) {
  const messages = [], listeners = [], graph = [], worklets = [];
  let disposeCount = 0;
  const defaultPipeline = async () => ({ text: 'はい' }); defaultPipeline.dispose = async () => { disposeCount++; };
  const track = new Element(); track.stop = () => graph.push('track-stop');
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class AudioContext {
    constructor() { this.currentTime = 0; this.destination = 'speakers'; this.audioWorklet = { addModule: async () => {} }; }
    createMediaStreamSource() { return { connect: target => graph.push(target), disconnect: () => {} }; }
    resume() { return Promise.resolve(); } close() { return Promise.resolve(); }
  }
  class AudioWorkletNode {
    constructor() { this.port = { close() {} }; worklets.push(this); }
    connect() {} disconnect() {}
  }
  vm.runInNewContext(offscreenCode, {
    pipeline: async (...args) => { graph.push('load-' + args[1]); return load ? load(...args) : defaultPipeline; },
    env: { backends: { onnx: { wasm: {} } } }, SpeechSegmenter, cleanTranscript, createLanguageProcessor,
    LogitsProcessor: class {}, LogitsProcessorList: Array,
    computeRms: data => Math.sqrt(data.reduce((sum, x) => sum + x * x, 0) / data.length),
    chrome: { runtime: { getURL: path => path, sendMessage: async message => { messages.push(message); }, onMessage: { addListener: fn => listeners.push(fn) } } },
    navigator: { mediaDevices: { getUserMedia: media || (async () => stream) } }, AudioContext, AudioWorkletNode,
    setInterval: () => 1, clearInterval() {}, console
  });
  const call = message => new Promise(resolve => { const keep = listeners[0]({ target: 'offscreen', ...message }, {}, resolve); if (!keep) resolve(); });
  return { messages, graph, worklets, track, stream, call, disposed: () => disposeCount };
}

test('audio playback is connected before downloading the model, and model changes really reload', async () => {
  const h = offscreenHarness();
  await h.call({ type: 'init-capture', sessionId: 'a', model: 'tiny' });
  await until(() => h.messages.some(x => x.state === 'listening'));
  assert.ok(h.graph.indexOf('speakers') < h.graph.indexOf('load-Xenova/whisper-tiny'));
  await h.call({ type: 'offscreen-stop', sessionId: 'a' });
  await h.call({ type: 'init-capture', sessionId: 'b', model: 'base' });
  await until(() => h.messages.some(x => x.sessionId === 'b' && x.state === 'listening'));
  assert.ok(h.graph.includes('load-Xenova/whisper-base')); assert.equal(h.disposed(), 1);
  await h.call({ type: 'offscreen-stop', sessionId: 'b' });
});
test('stopping during getUserMedia prevents stale startup and closes the late stream', async () => {
  let resolveMedia;
  const h = offscreenHarness({ media: () => new Promise(resolve => { resolveMedia = resolve; }) });
  await h.call({ type: 'init-capture', sessionId: 'a', model: 'base' });
  await until(() => resolveMedia);
  await h.call({ type: 'offscreen-stop', sessionId: 'a' });
  resolveMedia(h.stream); await tick();
  assert.ok(h.graph.includes('track-stop'));
  assert.ok(!h.messages.some(x => x.state === 'listening'));
});
test('an in-flight recognition cannot emit text after stop or corrupt a new model', async () => {
  let complete;
  const h = offscreenHarness({ load: async () => {
    const transcribe = () => new Promise(resolve => { complete = resolve; });
    transcribe.dispose = async () => {}; return transcribe;
  } });
  await h.call({ type: 'init-capture', sessionId: 'a', model: 'base', sourceLang: 'ja' });
  await until(() => h.messages.some(x => x.state === 'listening'));
  for (let i = 0; i < 10; i++) h.worklets[0].port.onmessage({ data: { pcm: new Float32Array(1280).fill(0.1), endTime: (i + 1) * 0.08 } });
  await until(() => complete);
  await h.call({ type: 'offscreen-stop', sessionId: 'a' });
  await h.call({ type: 'init-capture', sessionId: 'b', model: 'tiny' });
  complete({ text: '旧会话文本' });
  await until(() => h.messages.some(x => x.sessionId === 'b' && x.state === 'listening'));
  assert.ok(!h.messages.some(x => x.type === 'transcript'));
  await h.call({ type: 'offscreen-stop', sessionId: 'b' });
});

test('automatic language detection restricts language tokens and forces transcription without a second encoder pass', () => {
  const model = { generation_config: { lang_to_id: { '<|en|>': 10, '<|ja|>': 11, '<|zh|>': 12 },
    task_to_id: { transcribe: 20 }, no_timestamps_token_id: 21, decoder_start_token_id: 9 } };
  const { processor, decoderInputIds } = createLanguageProcessor(model, class {});
  assert.deepEqual(decoderInputIds, [[9]]);
  const data = new Float32Array(32).fill(-10); data[0] = 1000; data[10] = 1; data[11] = 4; data[12] = 2;
  processor._call([[9]], { data });
  assert.equal(processor.language, 'ja'); assert.ok(processor.probability > 0.8);
  assert.equal(data[0], -Infinity); assert.equal(data[11], 4);
  processor._call([[9, 11]], { data }); assert.equal(data[20], 0); assert.equal(data[11], -Infinity);
  processor._call([[9, 11, 20]], { data }); assert.equal(data[21], 0);
  data.fill(3); processor._call([[9, 11, 20, 21]], { data }); assert.equal(data[0], 3);
});
test('missing multilingual metadata raises an actionable error instead of silently defaulting to English', () => {
  assert.throws(() => createLanguageProcessor({ config: {} }, class {}), /多语言/);
});
test('PCM worklet batches messages and correctly downmixes channels', () => {
  let Processor; const messages = [];
  const scope = vm.createContext({ AudioWorkletProcessor: class { constructor() { this.port = { postMessage: message => messages.push(message) }; } },
    registerProcessor: (name, value) => { Processor = value; }, currentFrame: 0, sampleRate: 16000 });
  vm.runInContext(readFileSync(new URL('../offscreen/pcm-worklet.js', import.meta.url), 'utf8'), scope);
  const processor = new Processor();
  for (let i = 0; i < 10; i++) { processor.process([[new Float32Array(128).fill(0.25), new Float32Array(128).fill(0.75)]]); scope.currentFrame += 128; }
  assert.equal(messages.length, 1); assert.equal(messages[0].pcm.length, 1280);
  assert.equal(messages[0].pcm[0], 0.5); assert.equal(messages[0].endTime, 0.08);
});

function mediaElement(tag = 'VIDEO', { muted = false, width = 240, height = 135 } = {}) {
  const media = new Element(tag);
  Object.assign(media, { muted, paused: false, ended: false, currentTime: 0, textTracks: [] });
  media.getBoundingClientRect = () => ({ width, height, left: 0, top: 0, right: width, bottom: height });
  return media;
}
function selectMain(h, extra = {}) {
  const state = { sessionId: 'isolation', mode: 'audio', isolateAudio: true, targetVideoId: '1', ...extra };
  h.dispatch({ type: 'media-session-start', ...state });
  assert.equal(h.dispatch({ type: 'audio-mode-on', ...state }).ok, true);
  return state;
}
test('main video stays selected when a larger advertisement appears and when the main video pauses', () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad);
  selectMain(h);
  const largeAd = mediaElement('VIDEO', { width: 1280, height: 720 }); h.addMedia(largeAd);
  h.dispatch({ type: 'vt-probe' });
  assert.equal(h.sent.filter(x => x.message.type === 'vt-frame-state').at(-1).message.area, 960 * 540);
  assert.equal(h.video.muted, false); assert.equal(ad.muted, true); assert.equal(largeAd.muted, true);
  h.video.paused = true; h.video.dispatch('pause');
  assert.equal(h.sent.filter(x => x.message.type === 'vt-frame-state').at(-1).message.area, 960 * 540);
  assert.equal(largeAd.muted, true);
});
test('stopping restores each video and audio element to its original mute state', () => {
  const h = contentHarness(), ad = mediaElement(), alreadyMuted = mediaElement('VIDEO', { muted: true }), audio = mediaElement('AUDIO');
  h.video.muted = true;
  for (const media of [ad, alreadyMuted, audio]) h.addMedia(media);
  selectMain(h);
  assert.equal(h.video.muted, false);
  for (const media of [ad, alreadyMuted, audio]) assert.equal(media.muted, true);
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' });
  assert.equal(h.video.muted, true); assert.equal(ad.muted, false); assert.equal(alreadyMuted.muted, true); assert.equal(audio.muted, false);
});
test('new ad players are muted and cannot unmute themselves during isolation', () => {
  const h = contentHarness(); selectMain(h);
  const ad = mediaElement('AUDIO'); h.addMedia(ad); assert.equal(ad.muted, true);
  ad.muted = false; ad.dispatch('volumechange'); assert.equal(ad.muted, true);
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' });
  ad.muted = false; ad.dispatch('volumechange'); assert.equal(ad.muted, false);
});
test('user can still mute the main video without isolation forcing it back on', () => {
  const h = contentHarness(); selectMain(h);
  h.video.muted = true; h.video.dispatch('volumechange');
  h.addMedia(mediaElement());
  assert.equal(h.video.muted, true);
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' }); assert.equal(h.video.muted, true);
});
test('unselected frames mute their media and do not show audio subtitles', () => {
  const h = contentHarness();
  h.dispatch({ type: 'media-session-start', sessionId: 'isolation', mode: 'audio', isolateAudio: true });
  assert.equal(h.video.muted, true);
  h.dispatch(audioMessage(1, '广告译文', { sessionId: 'isolation' }));
  assert.equal(h.sub().style.display, 'none');
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' }); assert.equal(h.video.muted, false);
});
test('disabled isolation leaves other players audible', () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad);
  selectMain(h, { isolateAudio: false });
  assert.equal(ad.muted, false);
  const nextAd = mediaElement('AUDIO'); h.addMedia(nextAd); assert.equal(nextAd.muted, false);
});
test('late iframe joins an active isolation session and repeated notifications preserve original state', () => {
  const h = contentHarness();
  const state = { sessionId: 'isolation', mode: 'audio', isolateAudio: true, targetVideoId: '1' };
  h.sent.find(x => x.message.type === 'media-session-info').callback({ active: true, state, isTarget: false });
  assert.equal(h.video.muted, true);
  h.dispatch({ type: 'media-session-start', ...state });
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' }); assert.equal(h.video.muted, false);
});
test('late session handshake cannot re-mute a page after translation has stopped', () => {
  const h = contentHarness(), callback = h.sent.find(x => x.message.type === 'media-session-info').callback;
  selectMain(h);
  h.dispatch({ type: 'audio-mode-off', sessionId: 'isolation' });
  callback({ active: true, state: { sessionId: 'stale', mode: 'audio', isolateAudio: true }, isTarget: false });
  assert.equal(h.video.muted, false);
});
test('targeted start arriving before broadcast start still preserves the selected video', () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad);
  const state = { sessionId: 'isolation', mode: 'audio', isolateAudio: true, targetVideoId: '1' };
  assert.equal(h.dispatch({ type: 'audio-mode-on', ...state }).ok, true);
  h.dispatch({ type: 'media-session-start', ...state });
  assert.equal(h.video.muted, false); assert.equal(ad.muted, true);
  h.dispatch(audioMessage(1, '主视频译文', { sessionId: 'isolation' })); assert.equal(h.zh(), '主视频译文');
});
test('removing the target reports loss instead of selecting an advertisement', () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad); selectMain(h);
  h.dispatch(audioMessage(1, '主视频字幕', { sessionId: 'isolation' }));
  h.removeMedia(h.video);
  assert.ok(h.sent.some(x => x.message.type === 'vt-target-lost' && x.message.sessionId === 'isolation'));
  assert.equal(ad.muted, true);
  assert.equal(h.sub().style.display, 'none');
  h.dispatch(audioMessage(2, '迟到字幕', { sessionId: 'isolation' }));
  assert.equal(h.sub().style.display, 'none');
});
test('caption mode locks the selected player without muting page audio', () => {
  const track = makeTrack([{ text: 'Main caption', startTime: 0, endTime: 10 }]);
  const h = contentHarness(track), ad = mediaElement(); h.addMedia(ad);
  const state = { sessionId: 'isolation', mode: 'captions', isolateAudio: true, targetVideoId: '1' };
  h.dispatch({ type: 'media-session-start', ...state });
  h.dispatch({ type: 'captions-start', ...state });
  assert.equal(h.video.muted, false); assert.equal(ad.muted, false);
  assert.equal(h.sent.find(x => x.message.type === 'caption' && !x.message.prefetch).message.text, 'Main caption');
});
test('worker keeps routing to the chosen frame after a larger advertising iframe reports itself', async () => {
  const h = workerHarness(), start = await h.call({ type: 'start-capture', tabId: 1 });
  h.emit({ type: 'vt-frame-state', area: 1000000, candidates: [{ videoId: 'ad', area: 1000000, playing: true }] }, { tab: { id: 1 }, frameId: 7, documentId: 'ad-document' });
  h.emit({ type: 'transcript', tabId: 1, sessionId: start.state.sessionId, text: 'Main speech', utteranceId: 1, capturedAt: Date.now() });
  await until(() => h.sent.some(x => x.type === 'translation'));
  assert.equal(h.sent.find(x => x.type === 'translation').frameId, 0);
  const info = await h.call({ type: 'media-session-info' }, { tab: { id: 1 }, frameId: 7, documentId: 'ad-document' });
  assert.equal(info.active, true); assert.equal(info.isTarget, false);
  await h.call({ type: 'stop-capture' });
});
test('user can select a smaller video explicitly and a missing selection never falls back to an ad', async () => {
  const h = workerHarness();
  h.emit({ type: 'vt-frame-state', area: 10000, candidates: [{ videoId: 'chosen', area: 10000, playing: true }] }, { tab: { id: 1 }, frameId: 7, documentId: 'chosen-document' });
  const start = await h.call({ type: 'start-capture', tabId: 1, source: { frameId: 7, videoId: 'chosen' } });
  assert.equal(start.state.targetFrameId, 7); assert.equal(start.state.targetVideoId, 'chosen');
  assert.ok(h.sent.some(x => x.type === 'audio-mode-on' && x.frameId === 7));
  await h.call({ type: 'stop-capture' });
  const failed = await h.call({ type: 'start-capture', tabId: 1, source: { frameId: 7, videoId: 'gone' } });
  assert.equal(failed.ok, false);
  assert.equal((await h.call({ type: 'get-state' })).state.active, false);
});
test('navigating the selected iframe stops the old capture rather than accepting a different document', async () => {
  const h = workerHarness(); await h.call({ type: 'start-capture', tabId: 1 });
  const info = await h.call({ type: 'media-session-info' }, { tab: { id: 1 }, frameId: 0, documentId: 'replacement-ad-document' });
  assert.equal(info.active, false);
  assert.equal((await h.call({ type: 'get-state' })).state.active, false);
});

test('extension disconnect restores temporarily muted media without requiring a page reload', () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad); selectMain(h);
  assert.equal(ad.muted, true);
  h.chrome.runtime.sendMessage = () => { throw new Error('Extension context invalidated.'); };
  h.dispatch({ type: 'vt-probe' });
  assert.equal(ad.muted, false);
});
test('a missed stop notification is reconciled by the next frame report', async () => {
  const h = contentHarness(), ad = mediaElement(); h.addMedia(ad); selectMain(h);
  h.chrome.runtime.sendMessage = () => Promise.resolve({ active: false });
  h.dispatch({ type: 'vt-probe' }); await tick();
  assert.equal(ad.muted, false);
});
test('seeking clears subtitles immediately and rejects late translations from the previous position', () => {
  const h = contentHarness(); selectMain(h);
  h.dispatch(audioMessage(1, '旧位置的字幕', { sessionId: 'isolation' }));
  h.video.currentTime = 120; h.video.dispatch('seeking');
  const reset = h.sent.find(x => x.message.type === 'vt-playback-reset');
  assert.ok(reset); assert.equal(h.sub().style.display, 'none');
  h.dispatch(audioMessage(2, '迟到的旧位置字幕', { sessionId: 'isolation', playbackEpoch: 0 }));
  assert.equal(h.sub().style.display, 'none');
  h.dispatch(audioMessage(3, '新位置字幕', { sessionId: 'isolation', playbackEpoch: reset.message.playbackEpoch }));
  assert.equal(h.zh(), '新位置字幕');
});
test('subtitles are positioned on the selected video instead of the bottom of the webpage', () => {
  const h = contentHarness();
  h.video.getBoundingClientRect = () => ({ left: 100, top: 100, right: 740, bottom: 460, width: 640, height: 360 });
  selectMain(h); h.dispatch(audioMessage(1, '字幕', { sessionId: 'isolation' }));
  assert.equal(h.sub().style.left, '420px');
  assert.ok(parseFloat(h.sub().style.bottom) > 260);
  assert.ok(parseFloat(h.sub().style.maxWidth) <= 640);
});
test('stop from another tab does not shut down the active video translation', async () => {
  const h = workerHarness(); await h.call({ type: 'start-capture', tabId: 1 });
  const response = await h.call({ type: 'stop-capture', tabId: 99 });
  assert.equal(response.ok, false);
  assert.equal((await h.call({ type: 'get-state' })).state.active, true);
  await h.call({ type: 'stop-capture', tabId: 1 });
});
test('playback reset cancels translations, advances the timeline and tells the audio processor to flush', async () => {
  let signal;
  const h = workerHarness({ fetchImpl: async (url, options) => {
    signal = options.signal;
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')));
    } }));
  } });
  const start = await h.call({ type: 'start-capture', tabId: 1 });
  h.emit({ type: 'transcript', sessionId: start.state.sessionId, tabId: 1, playbackEpoch: 0, text: 'Old speech', utteranceId: 1, capturedAt: Date.now() });
  await until(() => signal);
  const reset = await h.call({ type: 'vt-playback-reset', sessionId: start.state.sessionId, playbackEpoch: 1 }, { tab: { id: 1 }, frameId: 0 });
  assert.equal(reset?.ok, true); assert.equal(signal.aborted, true);
  assert.ok(h.sent.some(x => x.type === 'audio-reset' && x.playbackEpoch === 1));
  assert.equal((await h.call({ type: 'get-state' })).state.playbackEpoch, 1);
  await h.call({ type: 'stop-capture' });
});

const popupRegressionSource = await (await import('node:fs/promises')).readFile(new URL('../popup/popup.js', import.meta.url), 'utf8');
function popupRegressionHarness(storedPromise) {
  const elements = new Map(), sent = [], writes = [];
  let statusListener, probeOverride;
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'videoSource' ? 'auto' : '', checked: false, disabled: false,
      textContent: '', style: {}, options: [], handlers: new Map(),
      addEventListener(name, callback) { this.handlers.set(name, callback); },
      replaceChildren(...options) { this.options = options; this.value = options[0]?.value || ''; },
      add(option) { this.options.push(option); }
    });
    return elements.get(id);
  };
  const probe = { ok: true, videos: 1, playing: 1, hasCaptions: false,
    sources: [{ frameId: 0, videoId: '1', width: 960, height: 540, playing: true, hasCaptions: false }] };
  const chrome = {
    tabs: { query: async () => [{ id: 1 }], sendMessage: async () => ({ ok: true }) },
    tabCapture: { getMediaStreamId() {} },
    storage: { local: {
      get: () => storedPromise || Promise.resolve({ vtSettings: { mode: 'audio' } }),
      set: async value => { writes.push(value); }
    } },
    runtime: {
      onMessage: { addListener: listener => { statusListener = listener; } },
      sendMessage: async message => {
        sent.push(message);
        if (message.type === 'probe-tab') return probeOverride ? probeOverride() : probe;
        return { ok: true };
      }
    }
  };
  vm.runInNewContext(popupRegressionSource, {
    document: { getElementById: get }, chrome,
    Option: function(text, value) { this.text = text; this.value = value; }
  });
  return { get, sent, writes, probe,
    click: id => get(id).handlers.get('click')(),
    status: message => statusListener(message),
    deferProbe: fn => { probeOverride = fn; }
  };
}
test('popup cannot overwrite saved settings or stop a session before initialization finishes', async () => {
  let finish;
  const h = popupRegressionHarness(new Promise(resolve => { finish = resolve; }));
  assert.equal(h.get('startBtn').disabled, true);
  assert.equal(h.get('apiKey').disabled, true);
  await h.click('startBtn');
  await h.click('stopBtn');
  assert.equal(h.writes.length, 0);
  assert.equal(h.sent.some(message => message.type === 'stop-capture'), false);
  finish({ vtTranslate: { provider: 'deepseek', apiKey: 'saved-test-key', model: 'deepseek-v4-flash' } });
  await until(() => !h.get('startBtn').disabled);
  assert.equal(h.get('apiKey').value, 'saved-test-key');
  assert.equal(h.get('apiKey').disabled, false);
  assert.equal(h.writes.length, 0);
});
test('stopping during a pending video probe prevents the popup from starting capture afterward', async () => {
  const h = popupRegressionHarness();
  await until(() => !h.get('startBtn').disabled);
  let finish;
  h.deferProbe(() => new Promise(resolve => { finish = resolve; }));
  const starting = h.click('startBtn');
  await until(() => !!finish);
  await h.click('stopBtn');
  finish(h.probe);
  await starting;
  assert.equal(h.sent.some(message => message.type === 'start-capture'), false);
  assert.equal(h.sent.find(message => message.type === 'stop-capture').tabId, 1);
  assert.equal(h.get('status').textContent, '已停止');
  assert.equal(h.get('startBtn').disabled, false);
});
test('popup ignores translation status from another tab', async () => {
  const h = popupRegressionHarness();
  await until(() => !h.get('startBtn').disabled);
  h.status({ type: 'vt-status', tabId: 2, status: { state: 'error', detail: 'unrelated error' } });
  assert.equal(h.get('status').textContent, '');
  h.status({ type: 'vt-status', tabId: 1, status: { state: 'listening', detail: 'current video' } });
  assert.equal(h.get('status').textContent, 'current video');
});

const resetRegressionSource = await (await import('node:fs/promises')).readFile(new URL('../offscreen/offscreen.js', import.meta.url), 'utf8');
function audioResetRegressionHarness(session, model) {
  const sent = [];
  let listener;
  const scope = {
    env: { backends: { onnx: { wasm: {} } } }, SpeechSegmenter,
    cleanTranscript: text => String(text || '').trim(),
    chrome: { runtime: {
      getURL: path => path,
      sendMessage: async message => { sent.push(message); },
      onMessage: { addListener: fn => { listener = fn; } }
    } }
  };
  vm.runInNewContext(resetRegressionSource.replace(/^import .*;\n/gm, '') + `
    globalThis.installResetFixture = (session, model) => { current = session; transcriber = model; };
    globalThis.runResetFixture = () => { runQueue(); return recognitionTask; };
    globalThis.enqueueResetFixture = segment => { enqueue(current, segment); return recognitionTask; };
  `, scope);
  scope.installResetFixture(session, model);
  return { sent, run: scope.runResetFixture, enqueue: scope.enqueueResetFixture,
    reset(message) {
      let response;
      listener({ target: 'offscreen', type: 'audio-reset', ...message }, {}, value => { response = value; });
      return response;
    }
  };
}
test('audio reset drops an in-flight recognition result and resumes on the new playback epoch', async () => {
  let finish, calls = 0;
  const segment = { pcm: new Float32Array(16000), utteranceId: 1, revision: 1, final: true, capturedAt: Date.now(), playbackEpoch: 0 };
  const session = { id: 'reset-audio', tabId: 1, ready: true, playbackEpoch: 0, sourceLang: 'en', targetLang: 'zh-CN',
    queue: [segment], segmenter: new SpeechSegmenter(), lastText: new Map(), audio: { currentTime: 4 } };
  const h = audioResetRegressionHarness(session, async () => {
    if (++calls === 1) return new Promise(resolve => { finish = resolve; });
    return { text: 'new position' };
  });
  const pending = h.run();
  const oldSegmenter = session.segmenter;
  assert.equal(h.reset({ sessionId: session.id, playbackEpoch: 1 }).ok, true);
  assert.notEqual(session.segmenter, oldSegmenter);
  assert.equal(session.dropBefore, 4);
  finish({ text: 'old position' });
  await pending;
  assert.equal(h.sent.some(message => message.type === 'transcript'), false);
  await h.enqueue({ ...segment, utteranceId: 2 });
  const transcript = h.sent.find(message => message.type === 'transcript');
  assert.equal(transcript.text, 'new position');
  assert.equal(transcript.playbackEpoch, 1);
  assert.equal(session.ready, true);
});
test('stale or foreign audio reset requests do not flush the current recording', () => {
  const session = { id: 'current-audio', playbackEpoch: 2, queue: ['keep'], lastText: new Map() };
  const h = audioResetRegressionHarness(session, async () => ({ text: '' }));
  assert.equal(h.reset({ sessionId: 'old-audio', playbackEpoch: 3 }).ok, false);
  assert.equal(h.reset({ sessionId: session.id, playbackEpoch: 1 }).ok, false);
  assert.equal(session.playbackEpoch, 2);
  assert.deepEqual(session.queue, ['keep']);
});

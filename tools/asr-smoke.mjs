// Real local ASR smoke test. No audio or API key is sent to a translation service.
import { pipeline, env, LogitsProcessor, LogitsProcessorList } from '@huggingface/transformers';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createLanguageProcessor } from '../offscreen/whisper-language.js';

const model = process.argv.find(arg => ['tiny', 'base', 'small'].includes(arg)) || 'base';
const download = process.argv.includes('--download');
env.allowLocalModels = !download;
env.cacheDir = process.env.VT_MODEL_CACHE || path.join(tmpdir(), 'vt-whisper-smoke-cache');
env.remoteHost = 'https://hf-mirror.com/';
const nativeFetch = globalThis.fetch;
globalThis.fetch = (url, options = {}) => nativeFetch(url, { ...options,
  signal: AbortSignal.any([AbortSignal.timeout(25000), ...(options.signal ? [options.signal] : [])]) });
const deadline = setTimeout(() => { console.error('ASR test timed out'); process.exit(2); }, 90000);
function readPcm(filename) {
  const bytes = readFileSync(new URL('../test/' + filename, import.meta.url));
  let offset = 12, format, data;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4), id = bytes.toString('ascii', offset, offset + 4);
    const chunk = bytes.subarray(offset + 8, offset + 8 + size);
    if (id === 'fmt ') format = { code: chunk.readUInt16LE(0), channels: chunk.readUInt16LE(2), rate: chunk.readUInt32LE(4), bits: chunk.readUInt16LE(14) };
    if (id === 'data') data = chunk;
    offset += 8 + size + size % 2;
  }
  assert.deepEqual(format, { code: 1, channels: 1, rate: 16000, bits: 16 });
  assert.ok(data);
  return Float32Array.from({ length: data.length / 2 }, (_, index) => data.readInt16LE(index * 2) / 32768);
}
let transcribe;
try {
  transcribe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-' + model,
    { dtype: 'q8', device: 'cpu', local_files_only: !download });
  for (const [file, expectedLanguage] of [['speech16k.wav', 'en'], ['speech-ja16k.wav', 'ja'], ['speech-ru16k.wav', 'ru']]) {
    const audio = readPcm(file), { processor, decoderInputIds } = createLanguageProcessor(transcribe.model, LogitsProcessor);
    const processors = new LogitsProcessorList(); processors.push(processor);
    const started = Date.now();
    const result = await transcribe(audio, { task: 'transcribe', decoder_input_ids: decoderInputIds,
      forced_decoder_ids: null, logits_processor: processors, chunk_length_s: 0, return_timestamps: false, max_new_tokens: 224 });
    console.log(JSON.stringify({ model, backend: 'node-cpu', file, seconds: audio.length / 16000,
      language: processor.language, probability: processor.probability, inferenceMs: Date.now() - started, text: result.text }));
    assert.equal(processor.language, expectedLanguage);
    assert.ok(result.text?.trim());
  }
} catch (error) { console.error('ASR smoke test: ' + error.message); process.exitCode = 2; }
finally { await transcribe?.dispose(); clearTimeout(deadline); }

export function computeRms(data) {
  let energy = 0;
  for (const value of data) energy += value * value;
  return data.length ? Math.sqrt(energy / data.length) : 0;
}
export function cleanTranscript(text) {
  return String(text || '').replace(/\[(?:music|applause|silence|音楽|音乐|拍手)\]|\((?:music|applause|silence)\)/gi, ' ').replace(/\s+/g, ' ').trim();
}

// Growing utterances can be revised without deleting similar or short replies.
export class SpeechSegmenter {
  constructor({ sampleRate = 16000, partialSeconds = 0.8, silenceSeconds = 0.32, maxSeconds = 8, threshold = 0.002 } = {}) {
    Object.assign(this, { sampleRate, partialSeconds, silenceSeconds, maxSeconds, threshold });
    this.nextId = 0; this.preRoll = new Float32Array(0); this.reset();
  }
  reset() {
    this.parts = []; this.length = 0; this.voiced = 0; this.silence = 0;
    this.lastPartial = 0; this.id = null; this.revision = 0;
  }
  snapshot(final, capturedAt) {
    const pcm = new Float32Array(this.length);
    let offset = 0;
    for (const part of this.parts) { pcm.set(part, offset); offset += part.length; }
    return { pcm, utteranceId: this.id, revision: ++this.revision, final, capturedAt };
  }
  push(data, capturedAt = Date.now()) {
    if (!data.length) return [];
    const speech = computeRms(data) >= this.threshold;
    if (this.id === null) {
      if (!speech) { this.preRoll = data.slice(-Math.round(this.sampleRate * 0.16)); return []; }
      this.id = ++this.nextId; this.parts = [this.preRoll]; this.length = this.preRoll.length;
      this.preRoll = new Float32Array(0);
    }
    this.parts.push(data); this.length += data.length;
    this.silence = speech ? 0 : this.silence + data.length;
    if (speech) this.voiced += data.length;
    const final = this.silence >= this.silenceSeconds * this.sampleRate || this.length >= this.maxSeconds * this.sampleRate;
    const ready = this.voiced >= 0.12 * this.sampleRate;
    if (final) { const result = ready ? [this.snapshot(true, capturedAt)] : []; this.reset(); return result; }
    if (ready && this.length - this.lastPartial >= this.partialSeconds * this.sampleRate) {
      this.lastPartial = this.length; return [this.snapshot(false, capturedAt)];
    }
    return [];
  }
}

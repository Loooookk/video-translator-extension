// Batch PCM messages. Playback has its own direct audio graph connection.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = new Float32Array(1280); this.offset = 0; }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.[0]) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i];
      this.buffer[this.offset++] = sample / channels.length;
      if (this.offset === this.buffer.length) {
        this.port.postMessage({ pcm: this.buffer, endTime: (currentFrame + i + 1) / sampleRate }, [this.buffer.buffer]);
        this.buffer = new Float32Array(1280); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PcmWorklet);

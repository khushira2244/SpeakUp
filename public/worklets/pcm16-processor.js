// AudioWorklet: microphone -> 16 kHz mono PCM16 chunks for AssemblyAI streaming.
// Loaded by src/components/live-mic/stream-session.ts. Plain JS on purpose:
// worklet modules are fetched by URL and cannot go through the app bundler.
//
// The browser may not give us a 16 kHz AudioContext (Firefox/Safari often run at
// 44.1 or 48 kHz), so this resamples from the context's `sampleRate` by
// averaging input samples over each output sample (a box filter).

const MIN_CHUNK_MS = 50; // AssemblyAI rejects audio messages shorter than this

class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.chunkSamples = Math.round((this.targetRate * (o.chunkMs || 100)) / 1000);
    this.minSamples = Math.round((this.targetRate * MIN_CHUNK_MS) / 1000);
    this.ratio = sampleRate / this.targetRate; // input samples per output sample
    this.buffer = new Int16Array(this.chunkSamples);
    this.filled = 0;
    this.acc = 0;
    this.accCount = 0;
    this.pos = 0;
    this.energy = 0;
    this.port.onmessage = (event) => {
      if (event.data === "flush") this.flush();
    };
  }

  push(sample) {
    const s = sample > 1 ? 1 : sample < -1 ? -1 : sample;
    this.buffer[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    this.energy += s * s;
    if (this.filled === this.chunkSamples) this.emit(this.chunkSamples);
  }

  emit(count) {
    const level = Math.sqrt(this.energy / Math.max(1, this.filled));
    const pcm = this.buffer.slice(0, count).buffer;
    this.port.postMessage({ pcm, level }, [pcm]);
    this.buffer = new Int16Array(this.chunkSamples);
    this.filled = 0;
    this.energy = 0;
  }

  // Send whatever is buffered, padded with silence up to the minimum chunk size.
  flush() {
    if (this.filled === 0) return;
    const count = Math.max(this.filled, this.minSamples);
    this.emit(count);
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    if (this.ratio === 1) {
      for (let i = 0; i < channel.length; i++) this.push(channel[i]);
      return true;
    }
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.accCount++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.push(this.acc / this.accCount);
        this.acc = 0;
        this.accCount = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-processor", Pcm16Processor);

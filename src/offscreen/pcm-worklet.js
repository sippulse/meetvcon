// Converts the two merged input channels (0 = microphone, 1 = Meet tab) into
// separate mono 16-bit PCM buffers of ~100 ms, one stream per source.

class PcmEncoder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.framesPerBuffer = options.processorOptions.framesPerBuffer;
    this.reset();
  }

  reset() {
    this.mic = new Int16Array(this.framesPerBuffer);
    this.tab = new Int16Array(this.framesPerBuffer);
    this.frames = 0;
  }

  process(inputs) {
    const input = inputs[0] || [];
    const mic = input[0];
    const tab = input[1];
    const length = mic?.length || tab?.length || 0;
    for (let i = 0; i < length; i++) {
      this.mic[this.frames] = toInt16(mic ? mic[i] : 0);
      this.tab[this.frames] = toInt16(tab ? tab[i] : 0);
      this.frames++;
      if (this.frames === this.framesPerBuffer) {
        this.port.postMessage({ mic: this.mic.buffer, tab: this.tab.buffer }, [
          this.mic.buffer,
          this.tab.buffer,
        ]);
        this.reset();
      }
    }
    return true;
  }
}

function toInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

registerProcessor("pcm-encoder", PcmEncoder);

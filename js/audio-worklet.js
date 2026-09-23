class QuranCapture extends AudioWorkletProcessor {
  constructor() { super(); this.step = sampleRate / 16000; this.position = 0; this.previous = 0; this.output = []; }
  process(inputs) {
    const channels = inputs[0]; if (!channels?.length) return true;
    const input = channels[0];
    for (let i = 0; i < input.length; i++) {
      const value = input[i];
      while (this.position <= i) {
        const fraction = this.position - (i - 1);
        this.output.push(this.previous + (value - this.previous) * Math.max(0, Math.min(1, fraction)));
        this.position += this.step;
      }
      this.previous = value;
    }
    this.position -= input.length;
    if (this.output.length >= 2048) {
      const pcm = Float32Array.from(this.output); this.output.length = 0;
      this.port.postMessage({ pcm }, [pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('quran-capture', QuranCapture);

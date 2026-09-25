// Retains microphone PCM long enough to cut the exact word span emitted by
// the local ASR. Timings are wall-clock estimates; uncertain cuts stay uncertain.
export class WordAudioBuffer {
  constructor(sampleRate = 16000, keepMs = 12000) {
    this.sampleRate = sampleRate; this.keepMs = keepMs; this.frames = [];
  }
  clear() { this.frames = []; }
  push(pcm, endAt = Date.now()) {
    const duration = pcm.length / this.sampleRate * 1000;
    this.frames.push({pcm:pcm.slice(),startAt:endAt-duration,endAt});
    const oldest = endAt-this.keepMs;
    while (this.frames.length && this.frames[0].endAt < oldest) this.frames.shift();
  }
  slice(startAt, endAt, beforeMs = 20, afterMs = 120) {
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) return null;
    const from = startAt-beforeMs, to = endAt+afterMs;
    const selected = [];
    let length = 0;
    for (const frame of this.frames) {
      if (frame.endAt <= from || frame.startAt >= to) continue;
      const first = Math.max(0,Math.floor((from-frame.startAt)*this.sampleRate/1000));
      const last = Math.min(frame.pcm.length,Math.ceil((to-frame.startAt)*this.sampleRate/1000));
      if (last <= first) continue;
      const part = frame.pcm.subarray(first,last);
      selected.push(part);length += part.length;
    }
    if (length < this.sampleRate*.18 || length > this.sampleRate*4) return null;
    const result = new Float32Array(length);
    let at = 0;
    for (const part of selected) {result.set(part,at);at+=part.length;}
    return result;
  }
}

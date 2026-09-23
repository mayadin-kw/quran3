export async function requestMicrophone() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('يلزم فتح الموقع عبر اتصال آمن للسماح بالميكروفون');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, video: false });
  if (!stream.getAudioTracks().some(t => t.readyState === 'live' && t.enabled)) {
    stream.getTracks().forEach(t => t.stop()); throw Error('تعذر استقبال الصوت من الميكروفون');
  }
  return stream;
}
export class Microphone {
  constructor(stream, onSamples, onError) { this.stream = stream; this.onSamples = onSamples; this.onError = onError; }
  async start() {
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule('js/audio-worklet.js');
    this.source = this.context.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.context, 'quran-capture');
    this.silent = this.context.createGain(); this.silent.gain.value = 0;
    this.worklet.port.onmessage = event => this.onSamples(event.data.pcm);
    this.source.connect(this.worklet); this.worklet.connect(this.silent); this.silent.connect(this.context.destination);
    await this.context.resume();
    this.stream.getAudioTracks().forEach(track => track.onended = () => this.onError(Error('انقطع اتصال الميكروفون')));
    return this.context.sampleRate;
  }
  async stop() {
    this.source?.disconnect(); this.worklet?.disconnect(); this.silent?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop()); await this.context?.close();
  }
}

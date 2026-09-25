import {BrowserFastConformerProvider, BrowserStreamingProvider} from './asr-engine.js';

const average = values => values.length ? values.reduce((a,b) => a+b,0)/values.length : null;
const getHistory = () => {
  try { return JSON.parse(localStorage.getItem('quran-asr-latency-v1')) || {}; }
  catch { return {}; }
};
const saveHistory = history => {
  try { localStorage.setItem('quran-asr-latency-v1', JSON.stringify(history)); } catch {}
};

export function rankProviders({browserOnline, localInstalled, deviceMemory, cores, wordTimingRequired = false}, history = getHistory()) {
  const candidates = [];
  if (BrowserStreamingProvider.supported && browserOnline) {
    const prior = average(history.browser || []);
    candidates.push({kind:'browser', estimatedMs:prior ?? 650});
  }
  if (localInstalled) {
    const prior = average(history.local || []);
    candidates.push({kind:'local', estimatedMs:(prior ?? 850) +
      (deviceMemory && deviceMemory < 4 ? 300 : 0) + (cores && cores <= 2 ? 200 : 0)});
  }
  return candidates.sort((a,b) => wordTimingRequired && localInstalled ?
    (a.kind === 'local' ? -1 : 1) - (b.kind === 'local' ? -1 : 1) :
    a.estimatedMs-b.estimatedMs);
}

// One provider is active at a time. Runtime failover keeps the same microphone
// and Quran engine; an acoustic model is only changed after a fatal failure or
// repeated measured first-partial delay.
export class AutomaticASRProvider {
  constructor(onMessage, capabilities) {
    this.onMessage = onMessage;
    this.history = getHistory();
    this.wordTimingRequired=!!capabilities.wordTimingRequired;
    this.candidates = rankProviders(capabilities, this.history);
    this.index = -1; this.current = null; this.ready = false; this.running = false;
    this.settings = {}; this.samples = []; this.seenSegments = new Set();
    this.switching = null; this.calibrating = false;
    this.audioSpeechStartAt = null; this.quietAudioMs = 0;
  }
  get selected() { return this.candidates[this.index]?.kind || null; }
  setCalibrationMode(value) { this.calibrating = !!value; }
  getLatencyStats() { return {selected:this.selected, averageFirstPartialMs:average(this.samples), samples:this.samples.length}; }
  record(message) {
    if (message.type !== 'hypothesis' || message.phase !== 'partial' || !message.text?.trim()) return;
    if (this.seenSegments.has(message.segmentId)) return;
    this.seenSegments.add(message.segmentId);
    const nativeAudioDelay = this.audioSpeechStartAt == null ? null :
      message.partialHypothesisAt - this.audioSpeechStartAt;
    const sample = this.selected === 'browser' ?
      (this.calibrating && nativeAudioDelay > 0 && nativeAudioDelay < 6000
        ? nativeAudioDelay : message.durationMs) :
      message.partialHypothesisAt - message.startAt;
    if (!Number.isFinite(sample) || sample < 0) return;
    this.samples.push(sample); if (this.samples.length > 12) this.samples.shift();
    const kind = this.selected;
    this.history[kind] = [...(this.history[kind] || []),sample].slice(-12);
    saveHistory(this.history);
    const next = this.candidates[this.index+1];
    if (!this.wordTimingRequired && this.calibrating && next && sample > 950 && next.estimatedMs + 100 < sample) {
      this.failover(); return;
    }
    if (!this.wordTimingRequired && this.samples.length >= 3 && next && average(this.samples) > 1200 &&
        next.estimatedMs + 200 < average(this.samples)) this.failover();
  }
  async init() {
    if (!this.candidates.length) throw Error('تعذر تشغيل نظام الاستماع على هذا الجهاز');
    await this.activateNext(false);
  }
  async activateNext(restart) {
    this.current?.stop(); this.current = null; this.ready = false;
    while (!this.stopped && ++this.index < this.candidates.length) {
      const kind = this.selected;
      const candidate = kind === 'browser'
        ? new BrowserStreamingProvider(message => this.receive(candidate,message))
        : new BrowserFastConformerProvider(message => this.receive(candidate,message));
      try {
        await candidate.init();
        if (this.stopped) {candidate.stop(); return;}
        this.current = candidate; this.ready = true; this.samples = []; this.seenSegments.clear();
        candidate.configure(this.settings);
        if (restart) candidate.start();
        this.onMessage({type:'provider-selected',selected:kind,latencyStats:this.getLatencyStats()});
        return;
      } catch (error) {
        candidate.stop();
        if (this.stopped) return;
        this.onMessage({type:'provider-failed',selected:kind,reason:error.message});
      }
    }
    if (this.stopped) return;
    this.running = false;
    throw Error('تعذر تشغيل نظام الاستماع على هذا الجهاز');
  }
  receive(candidate,message) {
    if (candidate !== this.current) return;
    if (message.type === 'error') { this.failover(); return; }
    this.record(message); this.onMessage(message);
  }
  failover() {
    if (this.switching || this.stopped) return this.switching;
    this.onMessage({type:'provider-recovering'});
    this.switching = this.activateNext(this.running).catch(error => {
      if (!this.stopped) this.onMessage({type:'error',message:error.message});
    }).finally(() => {this.switching=null;});
    return this.switching;
  }
  start() {
    if (!this.ready || this.stopped) return;
    this.running = true;
    try { this.current.start(); } catch { this.failover(); }
  }
  configure(values) { Object.assign(this.settings,values); this.current?.configure(values); }
  reset() { this.current?.reset(); this.seenSegments.clear(); }
  push(pcm, timing) {
    if (!this.ready || this.switching) return;
    let power = 0; for (const value of pcm) power += value * value;
    const speaking = Math.sqrt(power/pcm.length) >= (this.settings.vadThreshold || .006);
    if (speaking) {
      if (this.quietAudioMs >= 400 || this.audioSpeechStartAt == null)
        this.audioSpeechStartAt = timing?.audioFrameReceivedAt ?? Date.now();
      this.quietAudioMs = 0;
    } else this.quietAudioMs += pcm.length/16000*1000;
    this.current?.push(pcm, timing);
  }
  stop() { this.stopped=true; this.running=false; this.ready=false; this.current?.stop(); this.current=null; }
}

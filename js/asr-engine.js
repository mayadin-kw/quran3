export class BrowserFastConformerProvider {
  constructor(onMessage) { this.onMessage = onMessage; this.worker = null; this.ready = false; }
  async init() {
    this.worker = new Worker('js/asr-worker.js');
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error = null) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); this.cancelInit = null;
        if (error) reject(error); else { this.ready = true; resolve(); }
      };
      const timeout = setTimeout(() => finish(Error('استغرق تجهيز نموذج الاستماع وقتًا طويلًا')), 240000);
      this.cancelInit = () => finish(new DOMException('أُلغي تجهيز النموذج', 'AbortError'));
      this.worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') finish();
        else if (message.type === 'error') { if (!settled) finish(Error(message.message)); else this.onMessage(message); }
        else this.onMessage(message);
      };
      this.worker.onerror = event => finish(Error(event.message || 'تعذر تشغيل نموذج الاستماع'));
      this.worker.postMessage({ type: 'init' });
    });
  }
  start() { this.worker?.postMessage({ type: 'start' }); }
  configure(values) { this.worker?.postMessage({type:'configure', ...values}); }
  reset() { this.worker?.postMessage({type:'reset'}); }
  push(pcm) { if (this.ready) this.worker?.postMessage({ type: 'pcm', pcm, audioChunkReceivedAt:Date.now() }, [pcm.buffer]); }
  stop() { this.cancelInit?.(); this.worker?.postMessage({ type: 'stop' }); this.worker?.terminate(); this.worker = null; this.ready = false; }
}


// Native interim recognition is the live provider. The browser owns audio capture
// and may use a remote service; the setup screen discloses this before start().
export class BrowserStreamingProvider {
  static get supported() { return !!(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition); }
  constructor(onMessage) {
    this.onMessage = onMessage; this.ready = false; this.running = false;
    this.cycle = 0; this.generation = 0; this.resultsLength = 0; this.ignoreBefore = 0;
    this.partialSegments = new Set(); this.started = new Map(); this.vadThreshold = .006;
  }
  async init() {
    const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
    if (!Recognition) throw Error('هذا المتصفح لا يدعم التعرف الصوتي الجزئي المباشر');
    const r = this.recognition = new Recognition();
    r.lang = 'ar-SA'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
    r.onresult = event => {
      if (!this.running) return;
      this.resultsLength = event.results.length;
      for (let i = Math.max(event.resultIndex, this.ignoreBefore); i < event.results.length; i++) {
        const result = event.results[i], now = Date.now();
        const id = `${this.generation}:${this.cycle}:${i}`;
        if (!this.started.has(id)) this.started.set(id, this.speechStartedAt || now);
        if (!result.isFinal) this.partialSegments.add(id);
        if (result.isFinal && !this.partialSegments.size) {
          this.running = false; r.abort();
          this.onMessage({type:'error', message:'خدمة المتصفح أعادت نتيجة نهائية فقط. لم يُتحقق البث المباشر؛ جرّب متصفحًا يدعم النتائج الجزئية.'});
          return;
        }
        const confidence = result[0].confidence;
        this.onMessage({type:'hypothesis', phase:result.isFinal ? 'final' : 'partial',
          text:result[0].transcript, segmentId:id,
          acousticScore:confidence > 0 ? confidence : null,
          startAt:this.started.get(id), endAt:now, durationMs:now-this.started.get(id),
          // Native recognition exposes no chunk-to-hypothesis or inference clock.
          audioChunkReceivedAt:null, asrInferenceStartedAt:null, partialHypothesisAt:now,
          encoderMode:'browser-interim', timingAvailable:false});
        if (result.isFinal) this.started.delete(id);
      }
    };
    r.onspeechstart = () => { this.speechStartedAt = Date.now(); };
    r.onerror = event => {
      if (!this.running || event.error === 'no-speech' || event.error === 'aborted') return;
      this.running = false;
      this.onMessage({type:'error', message:`تعذر الاستماع المباشر (${event.error})`});
    };
    r.onend = () => {
      if (!this.running) return;
      // Browser service interruptions only; never restart at a Quran/Ayah boundary.
      this.cycle++; this.resultsLength = 0; this.ignoreBefore = 0; this.started.clear();
      this.restartTimer = setTimeout(() => {
        if (!this.running) return;
        try { r.start(); } catch (error) { this.running=false; this.onMessage({type:'error',message:error.message}); }
      }, 100);
    };
    this.ready = true;
  }
  start() { if (!this.ready || this.running) return; this.running = true; this.recognition.start(); }
  configure(values) { if (Number.isFinite(values.vadThreshold)) this.vadThreshold = values.vadThreshold; }
  reset() { this.generation++; this.ignoreBefore = this.resultsLength; this.started.clear(); }
  push(pcm) {
    let power=0, peak=0;
    for (const value of pcm) { power+=value*value; peak=Math.max(peak,Math.abs(value)); }
    const rms=Math.sqrt(power/pcm.length);
    this.onMessage({type:'level',rms,peak,sampleRate:16000,vadState:rms>=this.vadThreshold?'speech':'silence'});
  }
  stop() { this.running=false;this.ready=false;clearTimeout(this.restartTimer);this.recognition?.abort(); }
}

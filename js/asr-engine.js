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
        else if (message.type === 'error') finish(Error(message.message));
        else this.onMessage(message);
      };
      this.worker.onerror = event => finish(Error(event.message || 'تعذر تشغيل نموذج الاستماع'));
      this.worker.postMessage({ type: 'init' });
    });
  }
  start() { this.worker?.postMessage({ type: 'start' }); }
  configure(values) { this.worker?.postMessage({type:'configure', ...values}); }
  reset() { this.worker?.postMessage({type:'reset'}); }
  push(pcm) { if (this.ready) this.worker?.postMessage({ type: 'pcm', pcm }, [pcm.buffer]); }
  stop() { this.cancelInit?.(); this.worker?.postMessage({ type: 'stop' }); this.worker?.terminate(); this.worker = null; this.ready = false; }
}

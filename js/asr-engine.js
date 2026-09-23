export class BrowserFastConformerProvider {
  constructor(onMessage) { this.onMessage = onMessage; this.worker = null; this.ready = false; }
  async init() {
    this.worker = new Worker('js/asr-worker.js');
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('استغرق تجهيز نموذج الاستماع وقتًا طويلًا')), 240000);
      this.worker.onmessage = event => {
        const message = event.data;
        if (message.type === 'ready') { this.ready = true; clearTimeout(timeout); resolve(); }
        else if (message.type === 'error') { clearTimeout(timeout); reject(Error(message.message)); }
        else this.onMessage(message);
      };
      this.worker.onerror = event => { clearTimeout(timeout); reject(Error(event.message || 'تعذر تشغيل نموذج الاستماع')); };
      this.worker.postMessage({ type: 'init' });
    });
  }
  start() { this.worker?.postMessage({ type: 'start' }); }
  push(pcm) { if (this.ready) this.worker?.postMessage({ type: 'pcm', pcm }, [pcm.buffer]); }
  stop() { this.worker?.postMessage({ type: 'stop' }); this.worker?.terminate(); this.worker = null; this.ready = false; }
}

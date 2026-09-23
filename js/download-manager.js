import {SHA256} from './sha256.js';

const CACHE_NAME = 'recitation-core';
const DB_NAME = 'quran-recitation-installation';
const STORE = 'metadata';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readMetadata() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readonly');
    const request = transaction.objectStore(STORE).get('recitation-core');
    request.onsuccess = () => { resolve(request.result || null); db.close(); };
    request.onerror = () => { reject(request.error); db.close(); };
  });
}
async function writeMetadata(value) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, 'recitation-core');
    transaction.oncomplete = () => { resolve(); db.close(); };
    transaction.onerror = () => { reject(transaction.error); db.close(); };
  });
}
export const formatBytes = bytes => `${new Intl.NumberFormat('ar', {maximumFractionDigits:1}).format(bytes / 1000000)} ميجابايت`;
export function formatEta(seconds) {
  if (!Number.isFinite(seconds)) return 'جارٍ التقدير';
  if (seconds < 60) return 'أقل من دقيقة';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes === 1) return 'حوالي دقيقة';
  if (minutes === 2) return 'حوالي دقيقتين';
  return `حوالي ${new Intl.NumberFormat('ar').format(minutes)} دقائق`;
}
export class DownloadManager {
  constructor() {
    this.state = 'checking'; this.listeners = new Set(); this.manifest = null;
    this.missing = []; this.missingBytes = 0; this.downloadedBytes = 0;
    this.speed = 0; this.eta = Infinity; this.startedAt = 0; this.samples = [];
    this.active = new Map(); this.completed = 0; this.running = null;
  }
  subscribe(listener) { this.listeners.add(listener); listener(this.snapshot()); return () => this.listeners.delete(listener); }
  snapshot() { return {state:this.state, manifest:this.manifest, missingBytes:this.missingBytes,
    downloadedBytes:this.downloadedBytes, speed:this.speed, eta:this.eta,
    percent:this.missingBytes ? Math.min(100, Math.floor(this.downloadedBytes / this.missingBytes * 100)) : 100,
    installedBytes:this.manifest ? this.manifest.totalBytes - this.missingBytes : 0,
    error:this.error || null}; }
  emit() { const value = this.snapshot(); for (const listener of this.listeners) listener(value); }
  setState(value, error = null) { this.state = value; this.error = error; this.emit(); }
  allFiles() { return this.manifest.groups.filter(g => g.required).flatMap(g => g.files); }
  async init() {
    this.setState('checking');
    try {
      const response = await fetch('data/recitation-assets-manifest.json', {cache:'no-store'});
      if (!response.ok) throw Error('تعذر تحميل بيان الملفات المطلوبة');
      const manifestText = await response.text();
      this.manifestHash = new SHA256().update(new TextEncoder().encode(manifestText)).digest();
      this.manifest = JSON.parse(manifestText);
      this.cache = await caches.open(CACHE_NAME);
      this.metadata = await readMetadata().catch(() => null);
      await this.check();
    } catch (error) { this.setState('error', error.message); }
  }
  async check() {
    const files = this.allFiles();
    this.missing = [];
    for (let start = 0; start < files.length; start += 24) {
      const batch = files.slice(start, start + 24);
      const found = await Promise.all(batch.map(async file => {
        const response = await this.cache.match(file.url);
        return response && response.headers.get('x-quran-bytes') === String(file.bytes)
          && response.headers.get('x-quran-sha256') === file.sha256;
      }));
      batch.forEach((file, i) => { if (!found[i]) this.missing.push(file); });
    }
    this.missingBytes = this.missing.reduce((sum, file) => sum + file.bytes, 0);
    this.eta = this.missingBytes / 1048576;
    if (this.missing.length) {
      this.setState(this.metadata?.verified && (this.metadata.version !== this.manifest.version || this.metadata.manifestHash !== this.manifestHash) ? 'update-required' : 'ready-to-download');
      return;
    }
    if (!this.metadata?.verified || this.metadata.version !== this.manifest.version || this.metadata.manifestHash !== this.manifestHash || this.metadata.totalBytes !== this.manifest.totalBytes) {
      await this.verify();
    } else this.setState('installed');
  }
  async storageCheck() {
    if (!navigator.storage?.estimate) return {enough:true, required:this.missingBytes, available:null};
    const {quota, usage} = await navigator.storage.estimate();
    const available = Number.isFinite(quota) && Number.isFinite(usage) ? Math.max(0, quota - usage) : null;
    return {enough: available === null || available >= this.missingBytes * 1.12,
      required:this.missingBytes, available};
  }
  async start() {
    if (this.running) return this.running;
    this.running = this.install().finally(() => { this.running = null; });
    return this.running;
  }
  async install() {
    if (!this.manifest) await this.init();
    await this.check();
    if (!this.missing.length) return;
    const capacity = await this.storageCheck();
    if (!capacity.enough) { this.setState('insufficient-storage'); return capacity; }
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    this.startedAt = Date.now(); this.completed = 0; this.active.clear(); this.samples = [];
    this.setState('downloading');
    const small = this.missing.filter(file => file.bytes < 10 * 1048576);
    const large = this.missing.filter(file => file.bytes >= 10 * 1048576);
    try {
      let cursor = 0, failed = false;
      const next = async () => {
        while (!failed && cursor < small.length) {
          try { await this.retry(small[cursor++]); }
          catch (error) { failed = true; throw error; }
        }
      };
      const results = await Promise.allSettled(Array.from({length:Math.min(4,small.length)}, next));
      const rejected = results.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      for (const file of large) await this.retry(file);
      await this.verify();
      return {enough:true};
    } catch (error) { this.setState('error', error.message || 'تعذر إكمال تحميل بعض الملفات'); throw error; }
  }
  async retry(file) {
    let failure;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.download(file); return; }
      catch (error) { failure = error; this.active.delete(file.url); this.emit(); if (attempt < 2) await sleep(attempt ? 2500 : 600); }
    }
    throw Error(`تعذر إكمال تحميل بعض الملفات: ${file.url} (${failure?.message || ''})`);
  }
  progress() {
    const now = Date.now();
    this.downloadedBytes = this.completed + Array.from(this.active.values()).reduce((sum,n) => sum+n,0);
    this.samples.push({time:now, bytes:this.downloadedBytes});
    this.samples = this.samples.filter(sample => now - sample.time <= 15000);
    if (this.samples.length > 1) {
      const first = this.samples[0], elapsed = (now-first.time)/1000;
      if (elapsed > 0.3) this.speed = Math.max(0, (this.downloadedBytes-first.bytes)/elapsed);
    }
    this.eta = this.speed > 0 ? (this.missingBytes-this.downloadedBytes)/this.speed : this.missingBytes/1048576;
    this.emit();
  }
  async download(file) {
    await this.cache.delete(file.url);
    const response = await fetch(file.url, {cache:'reload'});
    if (!response.ok || !response.body?.getReader) throw Error('تعذر استقبال الملف');
    const reader = response.body.getReader(), hash = new SHA256();
    let bytes = 0;
    const stream = new ReadableStream({
      pull: async controller => {
        try {
          const {done,value} = await reader.read();
          if (done) { controller.close(); return; }
          hash.update(value); bytes += value.length; this.active.set(file.url, bytes); this.progress(); controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel: reason => reader.cancel(reason)
    });
    const headers = new Headers({
      'content-type': this.mime(file.url),
      'x-quran-bytes': String(file.bytes), 'x-quran-sha256': file.sha256
    });
    await this.cache.put(file.url, new Response(stream, {status:200, headers}));
    if (bytes !== file.bytes || hash.digest() !== file.sha256) {
      await this.cache.delete(file.url);
      throw Error('فشل التحقق من سلامة الملف');
    }
    this.active.delete(file.url); this.completed += file.bytes; this.progress();
  }
  mime(path) {
    if (path.endsWith('.wasm')) return 'application/wasm';
    if (path.endsWith('.js') || path.endsWith('.mjs')) return 'application/javascript';
    if (path.endsWith('.svg')) return 'image/svg+xml';
    if (path.endsWith('.json')) return 'application/json';
    if (path.endsWith('.html')) return 'text/html';
    if (path.endsWith('.css')) return 'text/css';
    return 'application/octet-stream';
  }
  async verify() {
    this.setState('verifying');
    const files = this.allFiles();
    for (const file of files) {
      const response = await this.cache.match(file.url);
      if (!response || response.headers.get('x-quran-bytes') !== String(file.bytes) || response.headers.get('x-quran-sha256') !== file.sha256) {
        this.setState('ready-to-download'); throw Error('ملفات التسميع غير مكتملة');
      }
    }
    const index = await (await this.cache.match('data/quran-index.json')).json();
    const surahs = await (await this.cache.match('data/surahs.json')).json();
    if (index.totals.pages !== 604 || index.totals.verses !== 6236 || Object.keys(surahs).length !== 114) throw Error('بيانات المصحف غير صالحة');
    for (const page of ['001','604']) {
      const file = this.manifest.groups.find(group => group.id === 'mushaf-svg')?.files.find(entry => entry.url.endsWith(`/${page}.svg`));
      const response = file && await this.cache.match(file.url);
      const svg = response && await response.text();
      if (!svg?.includes('md-word-') || !svg.includes('md-aya-mark-')) throw Error('صفحات المصحف غير صالحة');
    }
    for (const name of ['encoder.int8.onnx','decoder.int8.onnx']) {
      const entry = files.find(file => file.url.includes(name));
      const response = await this.cache.match(entry.url);
      if (!response || !response.headers.get('x-quran-sha256')) throw Error('نموذج الاستماع غير صالح');
    }
    const valid = new Set(files.map(file => new URL(file.url, location.href).href));
    for (const request of await this.cache.keys()) if (!valid.has(request.url)) await this.cache.delete(request);
    this.metadata = {packageId:'recitation-core', version:this.manifest.version,
      installedAt:new Date().toISOString(), manifestHash:this.manifestHash,
      totalBytes:this.manifest.totalBytes, verified:true};
    await writeMetadata(this.metadata);
    this.missing=[]; this.missingBytes=0; this.downloadedBytes=this.manifest.totalBytes;
    this.setState('installed');
  }
}
export const downloadManager = new DownloadManager();

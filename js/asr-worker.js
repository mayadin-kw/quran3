/* Quran FastConformer RNNT inference. Audio stays in this browser. */
let encoder, decoder, vocabulary, running = false, busy = false;
let audio = new Float32Array(0), lastInferenceLength = 0, lastSoundAt = 0;
const RATE = 16000, HOP = 160, FFT_SIZE = 512, WINDOW = 400, BLANK = 1024;

function stage(label) { self.postMessage({ type: 'stage', label }); }
async function asset(name) {
  const url = name === 'encoder.int8.onnx'
    ? 'https://huggingface.co/voidwaveDev/fastconformer-quran/resolve/9dd2fd999fed6b38fbf251343cbd9a8f5253c810/encoder.int8.onnx?download=true'
    : new URL(`../assets/models/${name}`, self.location.href).href;
  const cache = await caches.open('recitation-core');
  let response = await cache.match(url);
  if (!response) throw Error(`بيانات الاستماع غير مكتملة: ${name}`);
  return response.arrayBuffer();
}
function melHz(hz) { return hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / Math.log(6.4) * 27; }
function hzMel(mel) { return mel < 15 ? mel * (200 / 3) : 1000 * Math.exp((mel - 15) * Math.log(6.4) / 27); }
const FILTERS = (() => {
  const edges = Array.from({length:82}, (_, i) => hzMel(melHz(0) + i * (melHz(8000) - melHz(0)) / 81));
  return Array.from({length:80}, (_, m) => {
    const result = new Float32Array(257), [left, mid, right] = edges.slice(m, m + 3);
    const scale = 2 / (right - left);
    for (let k = 0; k <= 256; k++) {
      const hz = k * RATE / FFT_SIZE;
      result[k] = Math.max(0, Math.min((hz - left) / (mid - left), (right - hz) / (right - mid))) * scale;
    }
    return result;
  });
})();
function fftPower(samples) {
  const real = new Float32Array(FFT_SIZE), imag = new Float32Array(FFT_SIZE);
  for (let i = 0; i < WINDOW; i++) real[i + 56] = samples[i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WINDOW - 1)));
  for (let i = 1, j = 0; i < FFT_SIZE; i++) {
    let bit = FFT_SIZE >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; }
  }
  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = -2 * Math.PI / length, wr = Math.cos(angle), wi = Math.sin(angle);
    for (let start = 0; start < FFT_SIZE; start += length) {
      let cr = 1, ci = 0;
      for (let k = 0; k < length / 2; k++) {
        const even = start + k, odd = even + length / 2;
        const tr = cr * real[odd] - ci * imag[odd], ti = cr * imag[odd] + ci * real[odd];
        real[odd] = real[even] - tr; imag[odd] = imag[even] - ti;
        real[even] += tr; imag[even] += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
  return Float32Array.from({length:257}, (_, k) => real[k] * real[k] + imag[k] * imag[k]);
}
function features(pcm) {
  const frames = Math.max(1, Math.floor(pcm.length / HOP) + 1);
  const result = new Float32Array(80 * frames);
  const frame = new Float32Array(WINDOW);
  for (let t = 0; t < frames; t++) {
    const center = t * HOP;
    for (let i = 0; i < WINDOW; i++) {
      let at = center + i - WINDOW / 2;
      if (at < 0) at = -at;
      if (at >= pcm.length) at = 2 * pcm.length - at - 2;
      frame[i] = pcm[Math.max(0, Math.min(pcm.length - 1, at))];
    }
    const power = fftPower(frame);
    for (let m = 0; m < 80; m++) {
      let value = 0; const filter = FILTERS[m];
      for (let k = 0; k < 257; k++) value += power[k] * filter[k];
      result[m * frames + t] = Math.log(value + Math.pow(2, -24));
    }
  }
  for (let m = 0; m < 80; m++) {
    let mean = 0, variance = 0;
    for (let t = 0; t < frames; t++) mean += result[m * frames + t];
    mean /= frames;
    for (let t = 0; t < frames; t++) variance += (result[m * frames + t] - mean) ** 2;
    const denominator = Math.sqrt(variance / frames + 1e-5);
    for (let t = 0; t < frames; t++) result[m * frames + t] = (result[m * frames + t] - mean) / denominator;
  }
  return { data: result, frames };
}
function tensor64(value) { return new ort.Tensor('int64', BigInt64Array.of(BigInt(value)), [1]); }
function tensor32(value, shape = [1]) { return new ort.Tensor('int32', Int32Array.of(value), shape); }
function decodeTokens(ids) {
  return ids.map(id => vocabulary[id] || '').join('').replace(/▁/g, ' ').replace(/<[^>]*>/g, '').trim();
}
async function infer(pcm) {
  const start = performance.now();
  const {data, frames} = features(pcm);
  const inputs = {};
  inputs[encoder.inputNames[0]] = new ort.Tensor('float32', data, [1, 80, frames]);
  inputs[encoder.inputNames[1]] = tensor64(frames);
  const encoded = await encoder.run(inputs);
  const signal = encoded[encoder.outputNames[0]];
  const count = Number(encoded[encoder.outputNames[1]].data[0]);
  const ids = [];
  let state1 = new ort.Tensor('float32', new Float32Array(640), [1, 1, 640]);
  let state2 = new ort.Tensor('float32', new Float32Array(640), [1, 1, 640]);
  let target = BLANK;
  for (let frame = 0; frame < count; frame++) {
    const vector = new Float32Array(512);
    for (let channel = 0; channel < 512; channel++) vector[channel] = signal.data[channel * count + frame];
    for (let attempt = 0; attempt < 5; attempt++) {
      const data = {};
      data[decoder.inputNames[0]] = new ort.Tensor('float32', vector, [1, 512, 1]);
      data[decoder.inputNames[1]] = tensor32(target, [1, 1]);
      data[decoder.inputNames[2]] = tensor32(1);
      data[decoder.inputNames[3]] = state1;
      data[decoder.inputNames[4]] = state2;
      const result = await decoder.run(data);
      const logits = result[decoder.outputNames[0]].data;
      let best = 0;
      for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
      if (best === BLANK) break;
      ids.push(best); target = best;
      state1 = result[decoder.outputNames[2]];
      state2 = result[decoder.outputNames[3]];
    }
  }
  self.postMessage({type:'hypothesis', text:decodeTokens(ids), latency:Math.round(performance.now() - start)});
}
async function pump() {
  if (busy || !running || audio.length < RATE * .75 || audio.length - lastInferenceLength < RATE * .35) return;
  busy = true; lastInferenceLength = audio.length;
  const excerpt = audio.slice(Math.max(0, audio.length - RATE * 3.2));
  try { await infer(excerpt); }
  catch (error) { self.postMessage({type:'recoverable', message:error.message}); }
  busy = false;
  if (audio.length > RATE * 5) { audio = audio.slice(-RATE * 4); lastInferenceLength = audio.length - RATE * .5; }
}
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') {
      stage('تحميل نموذج التعرّف');
      importScripts(new URL('../assets/vendor/ort.min.js', self.location.href).href);
      ort.env.wasm.wasmPaths = new URL('../assets/vendor/', self.location.href).href;
      ort.env.wasm.numThreads = 1;
      const [encoderBytes, decoderBytes, tokensBytes] = await Promise.all([
        asset('encoder.int8.onnx'), asset('decoder.int8.onnx'), asset('tokens.txt')]);
      vocabulary = [];
      for (const line of new TextDecoder().decode(tokensBytes).trim().split(/\r?\n/)) {
        const match = line.match(/^(.*)\s+(\d+)$/);
        if (match) vocabulary[Number(match[2])] = match[1];
      }
      stage('تهيئة نموذج الاستماع');
      encoder = await ort.InferenceSession.create(new Uint8Array(encoderBytes), {executionProviders:['wasm']});
      decoder = await ort.InferenceSession.create(new Uint8Array(decoderBytes), {executionProviders:['wasm']});
      self.postMessage({type:'ready'});
    } else if (data.type === 'start') { running = true; }
    else if (data.type === 'stop') { running = false; audio = new Float32Array(0); }
    else if (data.type === 'pcm' && running) {
      const pcm = data.pcm;
      const next = new Float32Array(audio.length + pcm.length); next.set(audio); next.set(pcm, audio.length); audio = next;
      let sum = 0; for (const v of pcm) sum += v * v;
      const rms = Math.sqrt(sum / pcm.length);
      if (rms > .008) lastSoundAt = Date.now();
      self.postMessage({type:'level', rms, sampleRate:RATE, silent:Date.now() - lastSoundAt > 7000});
      if (rms > .005 || Date.now() - lastSoundAt < 800) pump();
    }
  } catch (error) { self.postMessage({type:'error', message:error.message || String(error)}); }
};

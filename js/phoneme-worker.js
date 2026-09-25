/* Separate CTC pronunciation worker; lexical ASR remains on its own live path. */
let model, vocabulary, scorer;
const RATE = 16000;
async function cached(name) {
  const url = new URL(`../assets/models/${name}`, self.location.href);
  const response = await (await caches.open('recitation-core')).match(url.href);
  if (!response) throw Error(`بيانات فحص النطق غير مكتملة: ${name}`);
  return response.arrayBuffer();
}
async function initialize() {
  self.postMessage({type:'stage',stage:'runtime'});
  importScripts(new URL('../assets/vendor/ort.min.js', self.location.href).href);
  ort.env.wasm.wasmPaths = new URL('../assets/vendor/', self.location.href).href;
  ort.env.wasm.numThreads = 1;
  scorer = await import('./phoneme-scoring.js');
  self.postMessage({type:'stage',stage:'assets'});
  const [modelBytes, vocabBytes] = await Promise.all([
    cached('quran-phoneme.int8.onnx'), cached('quran-phoneme-vocab.json')]);
  vocabulary = JSON.parse(new TextDecoder().decode(vocabBytes));
  self.postMessage({type:'stage',stage:'model'});
  model = await ort.InferenceSession.create(new Uint8Array(modelBytes),
    {executionProviders:['wasm'],graphOptimizationLevel:'disabled'});
  self.postMessage({type:'ready'});
}
async function verify(message) {
  const startedAt = performance.now();
  const pcm = message.pcm;
  if (!(pcm instanceof Float32Array) || pcm.length < RATE*.18 || pcm.length > RATE*4)
    return {decision:'uncertain',reason:'word-audio-length',phonemeConfidence:0};
  let mean = 0, variance = 0;
  for (const sample of pcm) mean += sample;
  mean /= pcm.length;
  for (const sample of pcm) variance += (sample-mean)**2;
  const deviation = Math.sqrt(variance/pcm.length+1e-7);
  const normalized = Float32Array.from(pcm, sample => (sample-mean)/deviation);
  const input = new ort.Tensor('float32', normalized, [1,normalized.length]);
  const result = await model.run({input_values:input});
  const output = result.logits;
  const assessment = scorer.scorePronunciation(output.data, output.dims[1], vocabulary,
    message.expectedPhonemes, message.options);
  return {...assessment, focusPhonemes:message.focusPhonemes || message.expectedPhonemes,
    inferenceMs:Math.round(performance.now()-startedAt),
    audioDurationMs:Math.round(pcm.length/RATE*1000)};
}
self.onmessage = async ({data}) => {
  try {
    if (data.type === 'init') await initialize();
    if (data.type === 'verify') self.postMessage({type:'result', requestId:data.requestId,
      wordId:data.wordId, assessment:await verify(data)});
  } catch (error) {
    self.postMessage({type:'error', requestId:data.requestId, message:error.message || String(error)});
  }
};

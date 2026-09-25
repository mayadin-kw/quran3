// Optional real-model smoke test. FIXTURE_DIR contains encoder.int8.onnx and 112001.mp3.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=new URL('../',import.meta.url);
const server=createServer(async(req,res)=>{
 try {
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<p>ASR validation</p>');return;}
  const fixture=req.url.startsWith('/fixture/');
  const path=fixture?`${process.env.FIXTURE_DIR}/${req.url.slice(9)}`:fileURLToPath(new URL('.'+req.url,root));
  res.setHeader('Content-Type',req.url.endsWith('.js')||req.url.endsWith('.mjs')?'text/javascript':req.url.endsWith('.wasm')?'application/wasm':'application/octet-stream');
  res.end(await readFile(path));
 } catch(error){res.writeHead(404);res.end(error.message);}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
 const page=await browser.newPage();page.on('console',m=>console.log(m.text()));
 await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const cache=await caches.open('recitation-core');
  for(const name of ['decoder.int8.onnx','tokens.txt','quran-phoneme.int8.onnx','quran-phoneme-vocab.json'])
    await cache.put(`assets/models/${name}`,await fetch(`assets/models/${name}`));
  await cache.put('https://huggingface.co/voidwaveDev/fastconformer-quran/resolve/9dd2fd999fed6b38fbf251343cbd9a8f5253c810/encoder.int8.onnx?download=true',await fetch('/fixture/encoder.int8.onnx'));
  const [{BrowserFastConformerProvider},{TranscriptGate},{RecitationEngine},
    {PronunciationProvider},{pronunciationFor},
    {MushafRenderer,mushafPageUrl}]=await Promise.all([
      import('/js/asr-engine.js'),import('/js/transcript-gate.js'),
      import('/js/recitation-engine.js'),import('/js/pronunciation-provider.js'),
      import('/js/pronunciation.js'),import('/js/mushaf-renderer.js')]);
  const phonemeMap=(await(await fetch('/data/quran-pronunciation-map.json')).json()).words;
  const fixtureWords=['قُلْ','هُوَ','اللَّهُ','أَحَدٌ'].map((hafs,i)=>({
    key:`112:1:${i+1}`,hafs,imlaey:hafs,verseKey:'112:1',page:1,
    state:'hidden',revealed:false,attempts:0,errors:[],repeats:0}));
  for(const word of fixtureWords)word.pronunciation=pronunciationFor(word,phonemeMap[word.key]);
  const groups=fixtureWords.map((_,i)=>`<g id="md-word-${i}" data-type="text" data-surah="112" data-aya="1" data-word-index-in-ayah="${i+1}"><path d="M ${40+i*40} 100 h 20 v 15 h -20 Z"/></g>`).join('');
  await cache.put(mushafPageUrl(1),new Response(`<svg xmlns="http://www.w3.org/2000/svg"><g id="md-page"><g id="md-page-inner"><g id="md-line-1">${groups}</g></g></g></svg>`));
  const surface=document.createElement('div');surface.className='mushaf-page';document.body.append(surface);
  const renderer=new MushafRenderer(surface);await renderer.show(1,fixtureWords);
  const messages=[], visualEvents=[], seen=new Set();let currentMessage,lastHypothesis;
  const mark=(word,kind)=>{
    if(seen.has(word.key))return;seen.add(word.key);
    const at=Date.now(),m=currentMessage || lastHypothesis;
    visualEvents.push({wordId:word.key,kind,at,
      audioToPartialMs:m.audioFrameReceivedAt==null?null:(m.audioBufferingMs||0)+m.partialTranscriptReceivedAt-m.audioFrameReceivedAt,
      partialToHighlightMs:at-m.partialTranscriptReceivedAt,
      totalProxyMs:m.audioFrameReceivedAt==null?null:(m.audioBufferingMs||0)+at-m.audioFrameReceivedAt,
      audioBufferingMs:m.audioBufferingMs,featureExtractionMs:m.featureExtractionEndedAt-m.featureExtractionStartedAt,
      asrInferenceMs:m.asrInferenceEndedAt-m.asrInferenceStartedAt});
  };
  const engine=new RecitationEngine(fixtureWords,(word,active)=>{
    renderer.update(word,active);if(word.revealed&&lastHypothesis)mark(word,'commit');
  },()=>{},()=>{},()=>{},(word,visible)=>{
    if(visible){renderer.previewWord(word.key);mark(word,'preview');}
    else renderer.clearPreviewWord(word.key);
  });
  const pronunciation=new PronunciationProvider();const pronunciationDecisions=[];
  const lastWordTiming=new Map();
  const gate=new TranscriptGate(async(tokens,meta)=>{
    const expected=engine.expected;
    const positionBefore=engine.position;
    let evidence=null;
    if(expected && engine.matchingSpan(tokens[0])){
      const previous=lastWordTiming.get(meta.segmentId);
      const context=previous?.tokenOffset===meta.tokenOffset-1 &&
        previous?.position===positionBefore-1 ? previous : null;
      evidence=await pronunciation.verify(expected,meta,context);
      pronunciationDecisions.push({wordId:expected.key,phase:meta.phase,
        wordStartAt:meta.wordStartAt,wordEndAt:meta.wordEndAt,...evidence});
    }
    const consumed=engine.acceptCommitted(tokens,{...meta,pronunciationEvidence:evidence});
    if(engine.position>positionBefore&&Number.isFinite(meta.wordStartAt))
      lastWordTiming.set(meta.segmentId,{tokenOffset:meta.tokenOffset,
        position:engine.position-1,startAt:meta.wordStartAt,
        phonemes:expected?.pronunciation?.phonemeSequence});
    return consumed;
  },()=>{},
    tokens=>engine.previewPartial(tokens));
  const wrongWord={key:'1:1:1',hafs:'بِسْمِ',imlaey:'بسم',verseKey:'1:1',page:1,
    state:'hidden',revealed:false,attempts:0,errors:[],repeats:0};
  const wrongEngine=new RecitationEngine([wrongWord],()=>{},()=>{},()=>{});
  const wrongGate=new TranscriptGate((tokens,meta)=>wrongEngine.acceptCommitted(tokens,meta));
  const p=new BrowserFastConformerProvider(m=>{
    if(m.type!=='hypothesis'&&m.type!=='error')return;
    messages.push(m);
    if(m.type==='hypothesis'){
      currentMessage=m;lastHypothesis=m;m.partialTranscriptReceivedAt=Date.now();gate.push(m);wrongGate.push(m);currentMessage=null;
    }
  });
  await Promise.all([p.init(),pronunciation.init()]);p.start();
  const audio=new AudioContext({sampleRate:16000});
  const buf=await audio.decodeAudioData(await(await fetch('/fixture/112001.mp3')).arrayBuffer());
  const samples=buf.getChannelData(0);
  // Match microphone cadence; append silence only after the entire recording.
  for(let i=0;i<samples.length;i+=1024){const pcm=samples.slice(i,i+1024);
    pronunciation.push(pcm,Date.now());p.push(pcm);await new Promise(r=>setTimeout(r,64));}
  const speechFinishedAt=Date.now();
  for(let i=0;i<20;i++){const pcm=new Float32Array(1024);pronunciation.push(pcm,Date.now());p.push(pcm);await new Promise(r=>setTimeout(r,64));}
  await new Promise(r=>setTimeout(r,3000));p.stop();pronunciation.stop();await audio.close();
  return {duration:buf.duration,speechFinishedAt,messages,visualEvents,
    pronunciationDecisions,wordStates:fixtureWords.map(w=>({key:w.key,state:w.state})),
    wrongWord:{attempts:wrongWord.attempts,state:wrongWord.state,revealed:wrongWord.revealed,
      position:wrongEngine.position,events:wrongEngine.eventLog.filter(e=>e.type==='substitution')}};
 });
 const partials=result.messages.filter(m=>m.type==='hypothesis'&&m.phase==='partial'&&m.text);
 console.log('pronunciation stream',JSON.stringify({states:result.wordStates,
  decisions:result.pronunciationDecisions.map(({wordId,decision,reason,greedy,phonemeGap,
    inferenceMs,wordStartAt,wordEndAt})=>({wordId,decision,reason,greedy,phonemeGap,
      inferenceMs,wordStartAt,wordEndAt})),
  timings:result.messages.filter(m=>m.type==='hypothesis').slice(0,5).map(m=>m.wordTimes)}));
 assert.ok(partials.some(m=>m.partialHypothesisAt<result.speechFinishedAt),'No nonempty partial before recording ended');
 assert.ok(result.messages.some(m=>m.text?.includes('أَحَدٌ')),'Al-Ikhlas transcript not recognized');
 const mean=key=>{
  const values=result.visualEvents.map(e=>e[key]).filter(Number.isFinite);
  return values.length?Math.round(values.reduce((a,b)=>a+b,0)/values.length):null;
 };
 assert.ok(result.visualEvents.length>=3,'Word-level SVG feedback did not appear');
 assert.ok(result.visualEvents.every(event=>event.at<result.speechFinishedAt),
  'At least one word only appeared after the recording ended');
 assert.equal(result.wrongWord.attempts,1,'Recorded unrelated speech should count as one wrong attempt');
 assert.equal(result.wrongWord.position,0,'Wrong speech must stay on the required word');
 assert.equal(result.wrongWord.state,'incorrect-placeholder');
 console.log(JSON.stringify({duration:result.duration,visualEvents:result.visualEvents,
  pronunciationDecisions:result.pronunciationDecisions.map(({wordId,decision,reason,greedy,
    phonemeGap,inferenceMs,wordStartAt,wordEndAt})=>({wordId,decision,reason,greedy,phonemeGap,inferenceMs,wordStartAt,wordEndAt})),
  wordStates:result.wordStates,
  averagesMs:{audioToPartial:mean('audioToPartialMs'),partialToHighlight:mean('partialToHighlightMs'),
   totalWordDisplayProxy:mean('totalProxyMs'),audioBuffering:mean('audioBufferingMs'),
   featureExtraction:mean('featureExtractionMs'),asrInference:mean('asrInferenceMs')}}));
}finally{await browser.close();server.close();}

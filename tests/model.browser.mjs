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
  for(const name of ['decoder.int8.onnx','tokens.txt'])await cache.put(`assets/models/${name}`,await fetch(`assets/models/${name}`));
  await cache.put('https://huggingface.co/voidwaveDev/fastconformer-quran/resolve/9dd2fd999fed6b38fbf251343cbd9a8f5253c810/encoder.int8.onnx?download=true',await fetch('/fixture/encoder.int8.onnx'));
  const {BrowserFastConformerProvider}=await import('/js/asr-engine.js');
  const messages=[];const p=new BrowserFastConformerProvider(m=>{if(m.type==='hypothesis'||m.type==='error'){messages.push(m);console.log(JSON.stringify(m));}});
  await p.init();p.start();
  const audio=new AudioContext({sampleRate:16000});
  const buf=await audio.decodeAudioData(await(await fetch('/fixture/112001.mp3')).arrayBuffer());
  const samples=buf.getChannelData(0);
  // Match microphone cadence; append silence only after the entire recording.
  for(let i=0;i<samples.length;i+=2048){p.push(samples.slice(i,i+2048));await new Promise(r=>setTimeout(r,128));}
  const speechFinishedAt=Date.now();
  for(let i=0;i<10;i++){p.push(new Float32Array(2048));await new Promise(r=>setTimeout(r,128));}
  await new Promise(r=>setTimeout(r,3000));p.stop();await audio.close();
  return {duration:buf.duration,speechFinishedAt,messages};
 });
 const partials=result.messages.filter(m=>m.type==='hypothesis'&&m.phase==='partial'&&m.text);
 assert.ok(partials.some(m=>m.partialHypothesisAt<result.speechFinishedAt),'No nonempty partial before recording ended');
 assert.ok(result.messages.some(m=>m.text?.includes('أَحَدٌ')),'Al-Ikhlas transcript not recognized');
 console.log(JSON.stringify(result,null,2));
}finally{await browser.close();server.close();}

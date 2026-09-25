// Optional real-audio pronunciation test. Fixtures are Quran-MD word recordings
// downloaded outside the repository into PHONEME_FIXTURE_DIR.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root=new URL('../',import.meta.url);
const fixtureDir=process.env.PHONEME_FIXTURE_DIR;
if(!fixtureDir)throw Error('Set PHONEME_FIXTURE_DIR to downloaded Quran-MD word recordings');
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<p>Pronunciation validation</p>');return;}
    const path=req.url.startsWith('/fixture/')?`${fixtureDir}/${req.url.slice(9)}`:
      fileURLToPath(new URL('.'+req.url,root));
    res.setHeader('Content-Type',req.url.endsWith('.html')?'text/html':
      (req.url.endsWith('.js')||req.url.endsWith('.mjs'))?'text/javascript':
      req.url.endsWith('.wasm')?'application/wasm':'application/octet-stream');
    res.end(await readFile(path));
  }catch(error){res.writeHead(404);res.end(error.message);}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true});
try{
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const results=await page.evaluate(async()=>{
    const cache=await caches.open('recitation-core');
    for(const name of ['quran-phoneme.int8.onnx','quran-phoneme-vocab.json'])
      await cache.put(`assets/models/${name}`,await fetch(`assets/models/${name}`));
    const worker=new Worker('js/phoneme-worker.js');
    let next=0;const pending=new Map();
    worker.onmessage=({data})=>{
      if(data.type==='ready')pending.get('ready')?.resolve();
      else if(data.type==='result')pending.get(data.requestId)?.resolve(data.assessment);
      else if(data.type==='error')pending.get(data.requestId)?.reject(Error(data.message));
    };
    worker.onerror=error=>pending.get('ready')?.reject(Error(error.message));
    const ready=new Promise((resolve,reject)=>pending.set('ready',{resolve,reject}));
    worker.postMessage({type:'init'});
    await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('phoneme worker init timeout')),120000))]);
    const audio=new AudioContext({sampleRate:16000});
    const cases=[
      ['fatha-correct','106-3-2.mp3','rabba'],
      ['fatha-to-kasra','78-37-1.mp3','rabba'],
      ['kasra-to-damma','81-29-7.mp3','rabbi'],
      ['kasra-correct','78-37-1.mp3','rabbi'],
      ['shadda-correct','2-229-19.mp3','allā'],
      ['shadda-missing','2-12-1.mp3','allā'],
      ['sukoon-correct','2-4-8.mp3','min'],
      ['sukoon-missing','2-19-3.mp3','min']
    ];
    const outcomes=[];
    for(const [name,file,expectedPhonemes] of cases){
      const buffer=await audio.decodeAudioData(await(await fetch(`/fixture/${file}`)).arrayBuffer());
      const pcm=buffer.getChannelData(0).slice();
      if(buffer.numberOfChannels>1)for(let channel=1;channel<buffer.numberOfChannels;channel++){
        const other=buffer.getChannelData(channel);
        for(let index=0;index<pcm.length;index++)pcm[index]+=other[index];
      }
      if(buffer.numberOfChannels>1)for(let index=0;index<pcm.length;index++)pcm[index]/=buffer.numberOfChannels;
      const requestId=++next;
      const result=new Promise((resolve,reject)=>pending.set(requestId,{resolve,reject}));
      worker.postMessage({type:'verify',requestId,wordId:name,pcm,expectedPhonemes,
        options:{checkShadda:name.startsWith('shadda'),checkFinalSukoon:name.startsWith('sukoon')}},[pcm.buffer]);
      outcomes.push({name,...await result});
    }
    await audio.close();worker.terminate();return outcomes;
  });
  for(const result of results)console.log(result.name,result.decision,result.greedy,result.phonemeGap,
    result.vowels?.at(-1)?.margin,result.shadda?.at(-1)?.margin,
    result.sukoon?.at(-1)?.margin,result.inferenceMs);
  const expected={
    'fatha-correct':'correct','fatha-to-kasra':'incorrect',
    'kasra-to-damma':'incorrect','kasra-correct':'correct',
    'shadda-correct':'correct','shadda-missing':'incorrect',
    'sukoon-correct':'correct','sukoon-missing':'incorrect'};
  for(const result of results)assert.equal(result.decision,expected[result.name],result.name);
}finally{await browser.close();server.close();}

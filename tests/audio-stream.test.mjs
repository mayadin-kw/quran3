import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {BrowserStreamingProvider} from '../js/asr-engine.js';

test('local fallback requests partial inference during speech without waiting for silence',async()=>{
 const messages=[];
 const ctx=vm.createContext({Float32Array,Int32Array,BigInt64Array,Date,Math,performance,self:{postMessage:m=>messages.push(m)}});
 vm.runInContext(await readFile(new URL('../js/asr-worker.js',import.meta.url),'utf8'),ctx);
 vm.runInContext("infer=async()=>({text:'قل',acousticScore:.97});running=true",ctx);
 for(let i=0;i<12;i++){
  vm.runInContext('receivePcm(new Float32Array(2048).fill(.03))',ctx);
  await new Promise(resolve=>setImmediate(resolve));
 }
 const hypotheses=messages.filter(m=>m.type==='hypothesis');
 assert.ok(hypotheses.length>=2);assert.ok(hypotheses.every(m=>m.phase==='partial'));
 assert.ok(hypotheses.every(m=>m.encoderMode==='offline-windowed'));
});
class Recognition {
 start(){this.starts=(this.starts||0)+1;}
 abort(){this.aborted=true;}
 emit(text,isFinal=false,index=0){const result=[{transcript:text,confidence:.97}];result.isFinal=isFinal;
  const results=Array.from({length:index+1},()=>result);this.onresult({results,resultIndex:index});}
}
globalThis.SpeechRecognition=Recognition;
test('native provider forwards interim words immediately and keeps one recognition session',async()=>{
 const messages=[];const p=new BrowserStreamingProvider(m=>messages.push(m));await p.init();p.start();
 assert.equal(p.recognition.interimResults,true);assert.equal(p.recognition.continuous,true);
 p.recognition.onspeechstart();p.recognition.emit('قل');p.recognition.emit('قل هو');
 assert.equal(messages.length,2);assert.ok(messages.every(m=>m.phase==='partial'));
 assert.equal(messages[0].segmentId,messages[1].segmentId);assert.equal(p.recognition.starts,1);
 p.recognition.emit('قل هو الله احد',true);p.reset();
 p.recognition.emit('قل هو الله احد',true);assert.equal(messages.length,3);
 p.recognition.emit('الله',false,1);assert.equal(messages.length,4);
 assert.equal(p.recognition.starts,1);assert.equal(messages[3].asrInferenceStartedAt,null);
 p.stop();p.recognition.emit('متاخر');assert.equal(messages.length,4);
});
test('native provider rejects final-only service instead of pretending to be live',async()=>{
 const messages=[];const p=new BrowserStreamingProvider(m=>messages.push(m));await p.init();p.start();
 p.recognition.emit('قل هو الله احد',true);assert.equal(messages[0].type,'error');assert.equal(p.running,false);
});

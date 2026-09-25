import test from 'node:test';
import assert from 'node:assert/strict';
import {AutomaticASRProvider,rankProviders} from '../js/asr-selection.js';

class Recognition {
  start() {this.starts=(this.starts||0)+1;}
  abort() {this.aborted=true;}
}
globalThis.SpeechRecognition=Recognition;
test('ranking uses measured delay, browser support, network and local availability',()=>{
  assert.equal(rankProviders({browserOnline:true,localInstalled:true,deviceMemory:8},
    {browser:[1400],local:[500]})[0].kind,'local');
  assert.equal(rankProviders({browserOnline:true,localInstalled:true,deviceMemory:8},
    {browser:[350],local:[1100]})[0].kind,'browser');
  assert.equal(rankProviders({browserOnline:true,localInstalled:true,deviceMemory:8,wordTimingRequired:true},
    {browser:[350],local:[1100]})[0].kind,'local');
  assert.deepEqual(rankProviders({browserOnline:false,localInstalled:true,deviceMemory:8},{}).map(x=>x.kind),['local']);
  assert.deepEqual(rankProviders({browserOnline:false,localInstalled:false,deviceMemory:8},{}),[]);
});
test('automatic provider starts browser without exposing choice and keeps one session',async()=>{
 const messages=[];const auto=new AutomaticASRProvider(m=>messages.push(m),
  {browserOnline:true,localInstalled:true,deviceMemory:8});
 await auto.init();auto.start();assert.equal(auto.selected,'browser');
 assert.equal(auto.current.recognition.starts,1);
 auto.reset();auto.configure({vadThreshold:.01});
 assert.equal(auto.current.recognition.starts,1);
 assert.ok(messages.some(m=>m.type==='provider-selected'));
 auto.stop();assert.equal(auto.current,null);
});
test('fatal browser failure activates the compatible local provider automatically',async()=>{
 class WorkerStub {
   constructor() {this.messages=[];}
   postMessage(message) {
     this.messages.push(message.type);
     if (message.type==='init') queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));
   }
   terminate() {this.terminated=true;}
 }
 globalThis.Worker=WorkerStub;
 const messages=[];const auto=new AutomaticASRProvider(m=>messages.push(m),
   {browserOnline:true,localInstalled:true,deviceMemory:8});
 await auto.init();auto.start();
 auto.current.recognition.onerror({error:'network'});
 while(auto.switching) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(auto.selected,'local');assert.equal(auto.ready,true);
 assert.ok(auto.current.worker.messages.includes('start'));
 assert.ok(messages.some(m=>m.type==='provider-recovering'));
 assert.equal(messages.some(m=>m.type==='error'),false);
 auto.stop();
});
test('slow browser interim during calibration triggers one controlled fallback',async()=>{
 class WorkerStub {
   postMessage(message) {if(message.type==='init')queueMicrotask(()=>this.onmessage({data:{type:'ready'}}));}
   terminate(){}
 }
 globalThis.Worker=WorkerStub;
 const auto=new AutomaticASRProvider(()=>{},
   {browserOnline:true,localInstalled:true,deviceMemory:8});
 auto.setCalibrationMode(true);await auto.init();auto.start();
 auto.push(new Float32Array(1024).fill(.03),{audioFrameReceivedAt:Date.now()-1800});
 const result=[{transcript:'بسم',confidence:.95}];result.isFinal=false;
 auto.current.recognition.onresult({results:[result],resultIndex:0});
 while(auto.switching) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(auto.selected,'local');assert.equal(auto.ready,true);
 auto.stop();
});

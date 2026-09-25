import test from 'node:test';
import assert from 'node:assert/strict';
import {TranscriptGate} from '../js/transcript-gate.js';
import {RecitationEngine} from '../js/recitation-engine.js';
const verse = ['قل','هو','الله','احد','الله','الصمد'];
function session() {
  const words = verse.map((hafs,i) => ({hafs, key:`112:${i<4?1:2}:${i+1}`,verseKey:i<4?'112:1':'112:2',
    page:i<4?1:2, revealed:false,state:'hidden', attempts:0, errors:[], repeats:0}));
  const updates = [], pages = [];
  const engine = new RecitationEngine(words, (w,active) => updates.push([w.key,active]),p=>pages.push(p),()=>{});
  const gate = new TranscriptGate((tokens, meta) => engine.acceptCommitted(tokens, meta));
  const push = (text, extra={}) => gate.push({type:'hypothesis',phase:'partial',segmentId:1,
    acousticScore:.97,durationMs:900,text,...extra});
  return {words,engine,gate,push,updates,pages};
}
test('partial words reveal and blue cursor crosses Ayahs/pages without finals',()=>{
  const s=session();
  s.push('قل'); s.push('قل');
  assert.equal(s.engine.position,1); assert.equal(s.updates.at(-1)[1],true);
  s.push('قل هو'); s.push('قل هو'); assert.equal(s.engine.position,2);
  s.push('قل هو الله احد الله الصمد'); s.push('قل هو الله احد الله الصمد');
  assert.equal(s.engine.position,6); assert.ok(s.words.every(w=>w.revealed));
  assert.equal(s.pages.at(-1),2);
  s.push('قل هو الله احد الله الصمد',{phase:'final'}); assert.equal(s.engine.position,6);
});
test('repeated complete Ayah changes highlight, not permanent state or primary cursor',()=>{
  const s=session(); s.push('قل هو الله احد');s.push('قل هو الله احد');
  const before=s.words.map(({repeats,...w})=>structuredClone(w));
  for (const text of ['قل','قل هو','قل هو الله','قل هو الله احد']) {s.push(text,{segmentId:2});s.push(text,{segmentId:2});}
  assert.equal(s.engine.position,4);assert.equal(s.engine.highlightCursor,3);
  assert.deepEqual(s.words.map(({repeats,...w})=>w),before);
  s.push('الله الصمد',{segmentId:3});s.push('الله الصمد',{segmentId:3});assert.equal(s.engine.position,6);
});
test('confirmed skip locks required word, one haptic/attempt, correct retry clears red',()=>{
  const s=session();const vibrations=[];
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{vibrate:n=>vibrations.push(n)}});
  s.push('قل');s.push('قل');
  for(let i=0;i<4;i++)s.push('قل الله احد');
  assert.equal(s.engine.position,1);assert.equal(s.words[1].attempts,1);
  assert.equal(s.words[1].state,'incorrect-placeholder');assert.equal(vibrations.length,1);
  assert.equal(s.words[2].revealed,false);
  s.push('قل الله احد هو');s.push('قل الله احد هو');
  assert.equal(s.engine.position,2);assert.equal(s.words[1].state,'correct');
  assert.equal(s.engine.currentSpokenWordId,s.words[1].key);
});
test('unstable and low-confidence mismatches do not vibrate; retry can recover',()=>{
  const s=session();const vibrations=[];globalThis.navigator.vibrate=n=>vibrations.push(n);
  for(let i=0;i<4;i++)s.push('خطا',{acousticScore:.2});
  assert.equal(s.words[0].attempts,0);assert.equal(vibrations.length,0);
  s.push('خطا قل',{acousticScore:.2});s.push('خطا قل',{acousticScore:.2});
  assert.equal(s.engine.position,1);
});
test('three separate stable failed attempts reveal only required word',()=>{
  const s=session();
  for(let segmentId=1;segmentId<=3;segmentId++) for(let n=0;n<3;n++)s.push('خطا',{segmentId});
  assert.equal(s.words[0].attempts,3);assert.equal(s.words[0].state,'revealed-after-errors');
  assert.equal(s.engine.position,1);assert.equal(s.words[1].revealed,false);
});
test('committed prefix rewrites cannot duplicate or rollback progression',()=>{
  const s=session();s.push('قل');s.push('قل');
  s.push('غير هو الله');s.push('غير هو الله');assert.equal(s.engine.position,1);
  s.push('قل هو');s.push('قل هو');assert.equal(s.engine.position,2);
});

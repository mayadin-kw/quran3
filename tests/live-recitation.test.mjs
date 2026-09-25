import test from 'node:test';
import assert from 'node:assert/strict';
import {TranscriptGate} from '../js/transcript-gate.js';
import {RecitationEngine} from '../js/recitation-engine.js';
import {pronunciationFor, verifyPronunciation} from '../js/pronunciation.js';
import {selectedWords} from '../js/quran-data.js';
const verse = ['قل','هو','الله','احد','الله','الصمد'];
function session() {
  const words = verse.map((hafs,i) => ({hafs, key:`112:${i<4?1:2}:${i+1}`,verseKey:i<4?'112:1':'112:2',
    page:i<4?1:2, revealed:false,state:'hidden', attempts:0, errors:[], repeats:0}));
  const updates = [], pages = [];
  const engine = new RecitationEngine(words, (w,active) => updates.push([w.key,active]),p=>pages.push(p),()=>{});
  const gate = new TranscriptGate((tokens, meta) => engine.acceptCommitted(tokens, meta));
  const push = (text, extra={}) => gate.push({type:'hypothesis',phase:'partial',segmentId:1,
    acousticScore:.97,durationMs:900,speechMs:600,text,...extra});
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
test('first matching partial moves blue tracker before permanent commit; revision retracts preview',()=>{
  const s=session(), previews=[];
  const gate=new TranscriptGate((tokens,meta)=>s.engine.acceptCommitted(tokens,meta),()=>{},
    tokens=>s.engine.previewPartial(tokens));
  s.engine.onPreview=(word,visible)=>previews.push([word.key,visible]);
  const push=text=>gate.push({type:'hypothesis',segmentId:19,phase:'partial',text,
    acousticScore:.97,partialTranscriptReceivedAt:Date.now()});
  push('قل');
  assert.equal(s.engine.currentSpokenWordId,s.words[0].key);
  assert.equal(s.words[0].revealed,false);
  assert.deepEqual(previews.at(-1),[s.words[0].key,true]);
  push('خطا');
  assert.equal(s.engine.currentSpokenWordId,null);
  assert.equal(s.words[0].revealed,false);
  assert.equal(s.words[0].attempts,0);
  push('قل');push('قل');
  assert.equal(s.words[0].revealed,true);
  assert.equal(s.engine.position,1);
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
  assert.equal(s.engine.position,2);assert.equal(s.words[1].state,'lexical-only');
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
test('async acoustic check serializes committed words in transcript order',async()=>{
  const gateCalls=[];let resolveFirst;
  const gate=new TranscriptGate((tokens)=>{
    gateCalls.push(tokens[0]);
    if(tokens[0]==='قل')return new Promise(resolve=>{resolveFirst=resolve;});
    return true;
  });
  const push=()=>gate.push({type:'hypothesis',segmentId:91,phase:'partial',text:'قل هو'});
  push();push();
  assert.deepEqual(gateCalls,['قل']);
  resolveFirst(true);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(gateCalls,['قل','هو']);
  assert.deepEqual(gate.history.get(91).committed,['قل','هو']);
});
test('unrelated speech with no browser confidence produces one substitution, then recovers',()=>{
  const s=session();const vibrations=[];globalThis.navigator.vibrate=n=>vibrations.push(n);
  for(let n=0;n<4;n++)s.push('كتاب',{acousticScore:null});
  assert.equal(s.engine.position,0);assert.equal(s.words[0].attempts,1);
  assert.equal(s.words[0].state,'incorrect-placeholder');assert.deepEqual(vibrations,[70]);
  s.push('قل',{segmentId:2});s.push('قل',{segmentId:2});
  assert.equal(s.engine.position,1);assert.equal(s.words[0].state,'lexical-only');
});
test('recognized noise without sustained speech does not become an error',()=>{
  const s=session();
  for(let n=0;n<4;n++)s.push('كتاب',{speechMs:80});
  assert.equal(s.words[0].attempts,0);
});
test('all words use vocalized source; text-only lexical match remains unverified',()=>{
  const expected=pronunciationFor({key:'1:5:1',hafs:'إِيَّاكَ',imlaey:'إياك'});
  assert.equal(expected.lexicalNormalized,'اياك');
  assert.ok(expected.expectedVowels.some(unit=>unit.value==='fatha'));
  assert.equal(verifyPronunciation(expected,{source:'asr-text',text:'إِيَّاكَ'}).decision,'uncertain');
  const s=session();s.push('قل');s.push('قل');
  assert.equal(s.words[0].state,'lexical-only');
  assert.equal(s.engine.eventLog.at(-1).type,'pronunciation_uncertain');
});
test('split Mushaf clitics retain their shared Quran phoneme target and acoustic span',()=>{
  const index={verses:{'1:5':[
    {index:3,hafs:'وَ',imlaey:'و'}, {index:4,hafs:'إِيَّاكَ',imlaey:'إياك'}
  ]}};
  const map={'1:5:3':{phonemes:'wa-iyyāka',span:2},
    '1:5:4':{coveredBy:'1:5:3'}};
  const [prefix,word]=selectedWords(index,1,5,5,map);
  assert.equal(prefix.pronunciation.wordId,'1:5:3');
  assert.equal(word.pronunciation.wordId,'1:5:4');
  assert.equal(word.pronunciation.phonemeSequence,'wa-iyyāka');
  assert.equal(word.pronunciation.acousticSpan,2);
  assert.equal(word.pronunciation.coveredBy,'1:5:3');
});
test('validated alignment interface locks a vowel error and accepts a corrected retry (contract only)',()=>{
  const word={key:'1:5:1',hafs:'إِيَّاكَ',imlaey:'إياك',verseKey:'1:5',page:1,
    state:'hidden',revealed:false,attempts:0,errors:[],repeats:0};
  const engine=new RecitationEngine([word],()=>{},()=>{},()=>{});
  const target=pronunciationFor(word);word.pronunciation=target;
  const scores=(expected,alternative,alternativeName)=>target.expectedVowels.map((_,i)=>({
    expectedProbability:i===target.expectedVowels.length-1?expected:.98,
    alternativeProbability:i===target.expectedVowels.length-1?alternative:.01,
    alternative:alternativeName}));
  engine.acceptCommitted(['إِيَّاكِ'],{segmentId:1,eventId:'1:0',confirmed:true,
    pronunciationEvidence:{source:'validated-phoneme-alignment',vowels:scores(.1,.95,'kasra')}});
  assert.equal(word.attempts,1);assert.equal(word.state,'incorrect-placeholder');
  assert.equal(engine.eventLog.at(-1).type,'harakah');assert.equal(engine.position,0);
  engine.acceptCommitted(['إِيَّاكَ'],{segmentId:2,eventId:'2:0',confirmed:true,
    pronunciationEvidence:{source:'validated-phoneme-alignment',vowels:scores(.98,.01,'kasra')}});
  assert.equal(word.state,'correct');assert.equal(engine.position,1);
});

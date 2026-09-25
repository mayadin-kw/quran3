import {WordAudioBuffer} from './word-audio.js';

export class PronunciationProvider {
  constructor(onStatus = () => {}) {
    this.onStatus=onStatus;this.audio=new WordAudioBuffer();this.nextId=0;
    this.pending=new Map();this.ready=false;
  }
  async init() {
    this.worker=new Worker('js/phoneme-worker.js');
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(Error('استغرق تجهيز فحص النطق وقتًا طويلًا')),120000);
      this.worker.onmessage=({data})=>{
        if(data.type==='ready'){clearTimeout(timeout);this.ready=true;resolve();}
        else if(data.type==='stage')this.onStatus(data.stage);
        else if(data.type==='result'){
          this.pending.get(data.requestId)?.resolve(data.assessment);
          this.pending.delete(data.requestId);
        }else if(data.type==='error'){
          if(data.requestId){this.pending.get(data.requestId)?.reject(Error(data.message));this.pending.delete(data.requestId);}
          else {clearTimeout(timeout);reject(Error(data.message));}
        }
      };
      this.worker.onerror=error=>{clearTimeout(timeout);reject(Error(error.message));};
      this.worker.postMessage({type:'init'});
    });
  }
  push(pcm,endAt) {this.audio.push(pcm,endAt);}
  clear() {this.audio.clear();}
  async verify(word, meta, context = null) {
    const expectedPhonemes=word.pronunciation?.phonemeSequence;
    if (!this.ready || !expectedPhonemes || !Number.isFinite(meta.wordStartAt) ||
        !Number.isFinite(meta.wordEndAt))
      return {source:'quran-phoneme-ctc',decision:'uncertain',reason:'missing-word-audio-or-phonemes',
        expected:expectedPhonemes,phonemeConfidence:0};
    const prior = context?.phonemes && Number.isFinite(context.startAt) &&
      meta.wordEndAt-context.startAt <= 4000 ? context : null;
    const sequence=(prior?.phonemes || '')+expectedPhonemes;
    const pcm=this.audio.slice(prior?.startAt ?? meta.wordStartAt,meta.wordEndAt);
    if (!pcm)return {source:'quran-phoneme-ctc',decision:'uncertain',reason:'word-audio-not-available',
      expected:expectedPhonemes,phonemeConfidence:0};
    const requestId=++this.nextId;
    return new Promise((resolve,reject)=>{
      this.pending.set(requestId,{resolve,reject});
      this.worker.postMessage({type:'verify',requestId,wordId:word.key,
        pcm,expectedPhonemes:sequence,focusPhonemes:expectedPhonemes,options:{
          focusStart:(prior?.phonemes || '').length,focusEnd:sequence.length,
          checkShadda:word.pronunciation.units.some(unit=>unit.value==='shadda'),
          checkFinalSukoon:word.pronunciation.units.at(-1)?.value==='sukoon'
        }},[pcm.buffer]);
    });
  }
  stop() {
    this.worker?.terminate();this.worker=null;this.ready=false;this.clear();
    for(const {reject} of this.pending.values())reject(Error('أُلغي فحص النطق'));
    this.pending.clear();
  }
}

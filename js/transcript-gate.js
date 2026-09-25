import {normalizeWord} from './quran-data.js';
export const tokenizeArabic = text => (String(text || '').match(/[\u0621-\u06FF]+/g) || [])
  .map(normalizeWord).filter(Boolean);

// Commit an append-only lexical prefix. Revisions never undo Quran progress.
export class TranscriptGate {
  constructor(onCommitted, onStabilized = () => {}, onObserved = () => {}) {
    this.onCommitted = onCommitted; this.onStabilized = onStabilized;
    this.onObserved = onObserved; this.reset();
  }
  reset() { this.history = new Map(); this.finished = new Set(); this.rawPartialTranscript = ''; this.stabilizedPartialTranscript = ''; }
  push(message) {
    if (message.type !== 'hypothesis' || message.segmentId == null || this.finished.has(message.segmentId)) return;
    const tokens = tokenizeArabic(message.text), id = message.segmentId;
    const state = this.history.get(id) || {previous:[], counts:[], firstSeen:[], committed:[], version:0,pending:null};
    this.rawPartialTranscript = message.text;
    let common = 0;
    while (common < tokens.length && tokens[common] === state.previous[common]) common++;
    state.firstSeen = tokens.map((_, i) => i < common ? state.firstSeen[i] : {
      audioChunkReceivedAt:message.audioChunkReceivedAt,
      partialHypothesisAt:message.partialHypothesisAt,
      firstPartialTranscriptReceivedAt:message.partialTranscriptReceivedAt,
      asrInferenceStartedAt:message.asrInferenceStartedAt});
    state.counts = tokens.map((_, i) => i < common ? (state.counts[i] || 0) + 1 : 1);
    state.previous = tokens;
    state.latest = message;
    state.version++;
    this.history.set(id, state);
    this.process(id,state);
  }
  finish(id) {
    this.history.delete(id);this.finished.add(id);
    if (this.finished.size > 64) this.finished.delete(this.finished.values().next().value);
  }
  process(id,state) {
    const message=state.latest,tokens=state.previous;
    const compatible = state.committed.every((token, i) => token === tokens[i]);
    if (compatible && !state.pending) for (let i = state.committed.length; i < tokens.length; i++) {
      const stability = state.counts[i];
      const stable = stability >= 2 || i < tokens.length - 1 || message.phase === 'final';
      if (!stable) break;
      const meta = {...message, ...state.firstSeen[i], confirmed:true, stability, nextToken:tokens[i+1],
        confidence:message.acousticScore ?? null, eventId:`${id}:${i}`, tokenOffset:i,
        durationMs:message.durationMs ?? (message.endAt - message.startAt),
        wordStartAt:message.wordTimes?.[i] ? message.startAt+message.wordTimes[i].startMs : null,
        wordEndAt:message.wordTimes?.[i] ? message.startAt+message.wordTimes[i].endMs : null,
        wordStabilizedAt:Date.now()};
      const result=this.onCommitted([tokens[i]], meta);
      if (result && typeof result.then === 'function') {
        const pending={index:i,token:tokens[i],version:state.version};
        state.pending=pending;
        Promise.resolve(result).then(consumed=>{
          if (state.pending!==pending) return;
          state.pending=null;
          if (consumed!==false && state.previous[i]===pending.token)state.committed.push(pending.token);
          if (consumed!==false || state.version>pending.version)this.process(id,state);
          else if (state.latest.phase==='final')this.finish(id);
        }).catch(()=>{state.pending=null;if(state.latest.phase==='final')this.finish(id);});
        break;
      }
      if (result === false) break;
      state.committed.push(tokens[i]);
    }
    this.stabilizedPartialTranscript = state.committed.join(' ');
    this.onObserved(tokens.slice(state.committed.length), message, state.committed.length);
    this.onStabilized(state.committed, message);
    if (message.phase === 'final' && !state.pending) this.finish(id);
  }
}

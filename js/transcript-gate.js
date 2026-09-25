import {normalizeWord} from './quran-data.js';
export const tokenizeArabic = text => (String(text || '').match(/[\u0621-\u06FF]+/g) || [])
  .map(normalizeWord).filter(Boolean);

// Commit an append-only lexical prefix. Revisions never undo Quran progress.
export class TranscriptGate {
  constructor(onCommitted, onStabilized = () => {}) {
    this.onCommitted = onCommitted; this.onStabilized = onStabilized; this.reset();
  }
  reset() { this.history = new Map(); this.finished = new Set(); this.rawPartialTranscript = ''; this.stabilizedPartialTranscript = ''; }
  push(message) {
    if (message.type !== 'hypothesis' || message.segmentId == null || this.finished.has(message.segmentId)) return;
    const tokens = tokenizeArabic(message.text), id = message.segmentId;
    const state = this.history.get(id) || {previous:[], counts:[], firstSeen:[], committed:[]};
    this.rawPartialTranscript = message.text;
    let common = 0;
    while (common < tokens.length && tokens[common] === state.previous[common]) common++;
    state.firstSeen = tokens.map((_, i) => i < common ? state.firstSeen[i] : {
      audioChunkReceivedAt:message.audioChunkReceivedAt, partialHypothesisAt:message.partialHypothesisAt,
      asrInferenceStartedAt:message.asrInferenceStartedAt});
    state.counts = tokens.map((_, i) => i < common ? (state.counts[i] || 0) + 1 : 1);
    state.previous = tokens;
    this.history.set(id, state);
    const compatible = state.committed.every((token, i) => token === tokens[i]);
    if (compatible) for (let i = state.committed.length; i < tokens.length; i++) {
      const stability = state.counts[i];
      const stable = stability >= 2 || i < tokens.length - 1 || message.phase === 'final';
      if (!stable) break;
      const meta = {...message, ...state.firstSeen[i], confirmed:true, stability, nextToken:tokens[i+1],
        confidence:message.acousticScore ?? null, eventId:`${id}:${i}`, tokenOffset:i,
        durationMs:message.durationMs ?? (message.endAt - message.startAt),
        wordStabilizedAt:Date.now()};
      if (this.onCommitted([tokens[i]], meta) === false) break;
      state.committed.push(tokens[i]);
    }
    this.stabilizedPartialTranscript = state.committed.join(' ');
    this.onStabilized(state.committed, message);
    if (message.phase === 'final') {
      this.history.delete(id); this.finished.add(id);
      if (this.finished.size > 64) this.finished.delete(this.finished.values().next().value);
    }
  }
}

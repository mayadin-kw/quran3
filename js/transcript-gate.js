import {normalizeWord} from './quran-data.js';

export const tokenizeArabic = text => (String(text || '').match(/[\u0621-\u06FF]+/g) || [])
  .map(token => normalizeWord(token)).filter(Boolean);

// Raw hypotheses are observations. Only the final hypothesis of a bounded
// speech segment crosses the permanent-state boundary.
export class TranscriptGate {
  constructor(onCommitted, onStabilized = () => {}) {
    this.onCommitted = onCommitted; this.onStabilized = onStabilized; this.reset();
  }
  reset() { this.history = new Map(); this.finished = new Set(); }
  push(message) {
    if (message.type !== 'hypothesis' || message.segmentId == null) return;
    const id = message.segmentId;
    if (this.finished.has(id)) return;
    const tokens = tokenizeArabic(message.text);
    if (message.phase === 'partial') {
      const history = this.history.get(id) || [];
      history.push(tokens);
      if (history.length > 8) history.shift();
      this.history.set(id, history);
      if (history.length >= 2) {
        const previous = history[history.length-2];
        const stable = [];
        for (let i = 0; i < Math.min(previous.length, tokens.length); i++) {
          if (previous[i] !== tokens[i]) break;
          stable.push(tokens[i]);
        }
        if (stable.length) this.onStabilized(stable, message);
      }
      return;
    }
    if (message.phase !== 'final') return;
    this.finished.add(id);
    const history = this.history.get(id) || [];
    const lead = tokens[0];
    const stability = lead ? 1 + history.filter(partial => partial[0] === lead).length : 0;
    const tokenStabilities = tokens.map((token, at) =>
      1 + history.filter(partial => partial[at] === token).length);
    this.history.delete(id);
    this.onCommitted(tokens, {
      segmentId:id, confirmed:true, stability,
      tokenStabilities,
      confidence:message.acousticScore ?? null,
      durationMs:message.durationMs ?? 0,
      startAt:message.startAt ?? null, endAt:message.endAt ?? null
    });
  }
}

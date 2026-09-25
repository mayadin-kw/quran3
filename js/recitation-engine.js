import {normalizeWord} from './quran-data.js';

const wordText = word => normalizeWord(word.imlaey || word.hafs);
const resolved = word => word.state === 'correct' || word.state === 'revealed-after-errors';
function lexicalAlignment(a, b) {
  const row = Array.from({length:b.length+1}, (_, i) => i);
  for (let i=1;i<=a.length;i++) {
    let previous=row[0];row[0]=i;
    for (let j=1;j<=b.length;j++) {
      const old=row[j];
      row[j]=Math.min(row[j]+1,row[j-1]+1,previous+(a[i-1]===b[j-1]?0:1));
      previous=old;
    }
  }
  return 1-row[b.length]/Math.max(a.length,b.length,1);
}

export class RecitationEngine {
  constructor(words, onChange, onPage, onFinish, onUncertain = () => {}) {
    this.words = words; this.onChange = onChange; this.onPage = onPage; this.onFinish = onFinish;
    this.onUncertain = onUncertain;
    this.position = 0; this.currentAyah = words[0]?.verseKey || null;
    this.highlightCursor = null; this.repetitionCursor = null; this.errorEvents = new Set(); this.blockedAttempt = null; this.active = null; this.eventLog = []; this.committedQuranWords = new Set();
    this.longPauses = 0; this.lastSpeechAt = Date.now(); this.startedAt = Date.now();
  }
  get primaryCursor() { return this.position; }
  get currentSpokenWordId() { return this.active?.key || null; }
  get expected() { return this.words[this.position]; }
  get currentRequiredWordId() { return this.expected?.key || null; }
  get errorCount() { return this.eventLog.filter(event => event.type === 'substitution').length; }
  get complete() { return this.words.length > 0 && this.words.every(resolved); }
  heardSpeech(now = Date.now()) { this.lastSpeechAt = now; this.pauseCounted = false; }
  silence(now = Date.now()) {
    if (now - this.lastSpeechAt > 1000) this.clearActive();
    if (now - this.lastSpeechAt > 7000 && !this.pauseCounted) { this.longPauses++; this.pauseCounted = true; }
  }
  evidence(meta) {
    return {timestamp:Date.now(), confidence:meta.confidence ?? null,
      startAt:meta.startAt ?? null, endAt:meta.endAt ?? null,
      stability:meta.stability ?? 0, segmentId:meta.segmentId ?? null,
      alignmentScore:meta.alignmentScore ?? null};
  }
  record(type, word, meta, extra = {}) {
    this.eventLog.push({type, wordId:word?.key || null, expected:word?.imlaey || word?.hafs || null,
      ...this.evidence(meta), ...extra});
  }
  revealCorrect(meta) {
    const word = this.expected;
    if (!word) return;
    this.committedQuranWords.add(word.key);
    word.revealed = true; word.state = 'correct'; word.firstAttempt ||= Date.now();
    word.revealedAt = Date.now(); word.firstCorrectTimestamp ||= word.revealedAt;
    this.blockedAttempt = null; this.setActive(this.position);
    this.record('correct', word, meta);
    this.advance(word);
  }
  setActive(at) {
    if (this.active) this.onChange(this.active, false);
    this.highlightCursor = at; this.active = this.words[at];
    if (this.active) { this.onPage(this.active.page); this.onChange(this.active, true); }
  }
  clearActive() {
    if (this.active) this.onChange(this.active, false);
    this.active = null; this.highlightCursor = null;
  }
  advance(word) {
    this.position++;
    this.currentAyah = this.expected?.verseKey || null;
    // Page follows the spoken word, including repetitions; preloading is renderer-owned.
    if (this.position === this.words.length && this.complete) this.onFinish();
  }
  // Arabic clitics can share one ASR token while occupying separate Mushaf IDs.
  matchingSpan(token) {
    if (!this.expected) return 0;
    let joined = '';
    for (let count = 1; count <= 3 && this.position + count <= this.words.length; count++) {
      const word = this.words[this.position + count - 1];
      if (word.verseKey !== this.expected.verseKey) break;
      joined += wordText(word);
      if (joined === token) return count;
      if (!token.startsWith(joined)) break;
    }
    return 0;
  }
  isLookahead(token) {
    for (let at = this.position + 1; at < Math.min(this.position + 7, this.words.length); at++)
      if (wordText(this.words[at]) === token) return true;
    return false;
  }
  // Confidence is lexical evidence, not a Tajweed/pronunciation assessment.
  failedAttempt(token, meta) {
    const word = this.expected;
    if (!word) return;
    const evidence = {...meta, alignmentScore:lexicalAlignment(token, wordText(word))};
    const credible = meta.confirmed === true && (meta.confidence ?? 0) >= .9 &&
      (meta.stability ?? 0) >= 3 && (meta.durationMs ?? 0) >= 350;
    if (!credible) {
      this.record('recognition_uncertain', word, evidence, {recognized:token});
      this.onUncertain(word);
      return false;
    }
    const eventId = meta.eventId ?? `manual:${this.eventLog.length}`;
    if (this.errorEvents.has(eventId)) return true;
    this.errorEvents.add(eventId);
    this.clearActive(); this.onPage(word.page);
    try { globalThis.navigator?.vibrate?.(70); } catch {}
    word.firstAttempt ||= Date.now(); word.attempts++;
    const error = {type:'استبدال كلمة', spoken:token, at:Date.now(),
      confidence:meta.confidence, stability:meta.stability, startAt:meta.startAt, endAt:meta.endAt};
    word.errors.push(error);
    this.record('substitution', word, evidence, {recognized:token});
    if (word.attempts >= 3) {
      word.revealed = true; word.revealedByErrorLimit = true; word.revealedAt = Date.now();
      word.state = 'revealed-after-errors'; this.onChange(word, false);
      this.record('resolved-error', word, evidence);
      this.advance(word);
    } else { word.state = 'incorrect-placeholder'; this.onChange(word, false); }
    return true;
  }
  // Each call is a newly stabilized lexical event, never the cumulative transcript.
  acceptCommitted(spokenWords, meta = {}) {
    this.heardSpeech(meta.endAt || Date.now());
    for (const token of spokenWords.map(normalizeWord).filter(Boolean)) {
      if (this.repetitionCursor != null && this.repetitionCursor < this.position &&
          token === wordText(this.words[this.repetitionCursor])) {
        this.words[this.repetitionCursor].repeats++; this.setActive(this.repetitionCursor++);
        if (this.repetitionCursor >= this.position) this.repetitionCursor = null;
        continue;
      }
      this.repetitionCursor = null;
      const span = this.matchingSpan(token);
      if (span) {
        for (let n = 0; n < span; n++) this.revealCorrect({...meta, alignmentScore:1});
        continue;
      }
      // Prefer completed Ayah starts. The primary cursor and permanent word data stay intact.
      const at = this.words.findIndex((word, i) => i < this.position && resolved(word) &&
        (i === 0 || word.verseKey !== this.words[i-1].verseKey) && wordText(word) === token &&
        this.words.filter(w => w.verseKey === word.verseKey).every(resolved));
      if (at >= 0) {
        this.repetitionCursor = at + 1; this.words[at].repeats++; this.setActive(at);
        this.record('real-repetition', this.words[at], meta, {count:1});
        continue;
      }
      if (!this.expected) continue;
      const ahead = this.isLookahead(token);
      const blocked = this.blockedAttempt;
      if (blocked && blocked.segmentId === meta.segmentId &&
          (ahead || blocked.token !== token)) continue;
      const wordId = this.expected.key;
      if (!this.failedAttempt(token, meta)) {
        if (meta.nextToken === wordText(this.expected)) continue;
        return false;
      }
      // One skipped position/read-ahead run is one attempt. A repeated wrong token
      // at a new lexical offset, or a new acoustic segment, may be a new retry.
      this.blockedAttempt = {segmentId:meta.segmentId, token, wordId};
    }
    return true;
  }
  // Manual confirmed entry used by deterministic tests.
  accept(spoken, confidence = 1) {
    this.acceptCommitted([spoken], {confirmed:true, confidence, stability:3, durationMs:600});
  }
}

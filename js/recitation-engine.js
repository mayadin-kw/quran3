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
    this.active = null; this.eventLog = []; this.segments = new Set(); this.repeatedSegments = new Set();
    this.longPauses = 0; this.lastSpeechAt = Date.now(); this.startedAt = Date.now();
  }
  get expected() { return this.words[this.position]; }
  get currentRequiredWordId() { return this.expected?.key || null; }
  get errorCount() { return this.eventLog.filter(event => event.type === 'substitution').length; }
  get complete() { return this.words.length > 0 && this.words.every(resolved); }
  heardSpeech(now = Date.now()) { this.lastSpeechAt = now; this.pauseCounted = false; }
  silence(now = Date.now()) {
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
    if (this.active && this.active !== word) this.onChange(this.active, false);
    word.revealed = true; word.state = 'correct'; word.firstAttempt ||= Date.now();
    word.revealedAt = Date.now(); this.active = word; this.onChange(word, false);
    this.record('correct', word, meta);
    this.advance(word);
  }
  advance(word) {
    this.position++;
    this.currentAyah = this.expected?.verseKey || null;
    if (this.expected && this.expected.page !== word.page) this.onPage(this.expected.page);
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
  // Read-ahead is never a failed attempt.
  failedAttempt(token, meta) {
    const word = this.expected;
    if (!word) return;
    const evidence = {...meta, alignmentScore:lexicalAlignment(token, wordText(word))};
    const credible = meta.confirmed === true && (meta.confidence ?? 0) >= .82 &&
      (meta.stability ?? 0) >= 2 && (meta.durationMs ?? 0) >= 350;
    if (!credible) {
      this.record('recognition_uncertain', word, evidence, {recognized:token});
      this.onUncertain(word);
      return;
    }
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
  }
  // Only finalized, acoustically bounded speech segments enter permanent state.
  acceptCommitted(spokenWords, meta = {}) {
    if (this.complete) return;
    if (meta.segmentId != null) {
      if (this.segments.has(meta.segmentId)) return;
      this.segments.add(meta.segmentId);
    }
    const tokens = spokenWords.map(normalizeWord).filter(Boolean);
    if (!this.expected) return;
    if (!tokens.length) {
      this.record('recognition_uncertain', this.expected, meta, {reason:'empty-final'});
      this.onUncertain(this.expected);
      return;
    }
    this.heardSpeech(meta.endAt || Date.now());
    let offset = 0;
    // An overlapping final transcript may repeat already accepted words.
    for (let size = Math.min(4, this.position, tokens.length - 1); size >= 1; size--) {
      const prior = this.words.slice(this.position - size, this.position).map(wordText);
      if (prior.every((value, i) => value === tokens[i]) && tokens[size] === wordText(this.expected)) {
        offset = size; break;
      }
    }
    // Ignore a short lead-in when the required word appears immediately after it.
    if (!offset && tokens[0] !== wordText(this.expected)) {
      const at = tokens.findIndex((token, i) => i > 0 && i <= 2 && token === wordText(this.expected));
      if (at > 0) offset = at;
    }
    let progressed = false;
    for (let i = offset; i < tokens.length && this.expected; i++) {
      const span = this.matchingSpan(tokens[i]);
      if (span) {
        for (let n = 0; n < span; n++) this.revealCorrect({...meta, alignmentScore:1});
        progressed = true;
        continue;
      }
      if (this.isLookahead(tokens[i])) {
        this.record('recognition_uncertain', this.expected, meta, {recognized:tokens[i], reason:'read-ahead'});
        this.onUncertain(this.expected);
        break;
      }
      if (!progressed && i === offset && this.recordRepetition(tokens.slice(i), meta)) break;
      // One bounded speech segment can create at most one attempt at this word.
      this.failedAttempt(tokens[i], {...meta, stability:meta.tokenStabilities?.[i] ?? meta.stability});
      break;
    }
  }
  recordRepetition(tokens, meta) {
    if ((meta.durationMs ?? 0) < 700 || tokens.length < 3) return false;
    const last = Math.max(0, this.position - 24);
    for (let at = last; at < this.position - 1; at++) {
      if (this.words[at].verseKey !== this.words[at + 1].verseKey) continue;
      let count = 0;
      while (count < tokens.length && at + count < this.position &&
          tokens[count] === wordText(this.words[at + count])) count++;
      if (count < 3) continue;
      const key = `${meta.segmentId ?? meta.startAt}:${at}`;
      if (this.repeatedSegments.has(key)) return true;
      this.repeatedSegments.add(key);
      for (let i = 0; i < count; i++) {
        const word = this.words[at+i]; word.repeats++; this.onChange(word, true);
      }
      this.record('real-repetition', this.words[at], meta, {count});
      return true;
    }
    return false;
  }
  // Manual confirmed entry used by deterministic tests.
  accept(spoken, confidence = 1) {
    this.acceptCommitted([spoken], {confirmed:true, confidence, stability:2, durationMs:600});
  }
}

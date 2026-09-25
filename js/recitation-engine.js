import {normalizeWord} from './quran-data.js';
import {pronunciationFor, verifyPronunciation} from './pronunciation.js';

const wordText = word => normalizeWord(word.imlaey || word.hafs);
const resolved = word => ['correct','lexical-only','revealed-after-errors'].includes(word.state);
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
  constructor(words, onChange, onPage, onFinish, onUncertain = () => {}, onPreview = () => {}) {
    this.words = words; this.onChange = onChange; this.onPage = onPage; this.onFinish = onFinish;
    this.onUncertain = onUncertain; this.onPreview = onPreview;
    this.position = 0; this.currentAyah = words[0]?.verseKey || null;
    this.highlightCursor = null; this.repetitionCursor = null; this.previewIndex = null;
    this.errorEvents = new Set(); this.blockedAttempt = null; this.active = null; this.eventLog = []; this.committedQuranWords = new Set();
    this.pronunciationRetries = new Map();
    this.longPauses = 0; this.lastSpeechAt = Date.now(); this.startedAt = Date.now();
  }
  get primaryCursor() { return this.position; }
  get currentSpokenWordId() { return this.active?.key || null; }
  get expected() { return this.words[this.position]; }
  get currentRequiredWordId() { return this.expected?.key || null; }
  get errorCount() { return this.eventLog.filter(event => ['substitution','harakah','skipped'].includes(event.type)).length; }
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
  revealCorrect(meta, pronunciation) {
    const word = this.expected;
    if (!word) return;
    this.committedQuranWords.add(word.key);
    word.revealed = true; word.state = pronunciation.decision === 'correct' ? 'correct' : 'lexical-only';
    word.pronunciationDecision = pronunciation.decision; word.firstAttempt ||= Date.now();
    this.clearVisualPreview();
    word.revealedAt = Date.now(); word.firstCorrectTimestamp ||= word.revealedAt;
    this.blockedAttempt = null; this.setActive(this.position);
    this.pronunciationRetries.delete(word.key);
    this.record(pronunciation.decision === 'correct' ? 'correct' : 'pronunciation_uncertain', word, meta,
      {pronunciationReason:pronunciation.reason});
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
  clearVisualPreview() {
    if (this.previewIndex == null) return;
    const word = this.words[this.previewIndex];
    this.onPreview(word, false);
    if (this.active === word && !word.revealed) this.clearActive();
    this.previewIndex = null;
  }
  previewPartial(tokens, meta = {}) {
    const candidate = normalizeWord(tokens.at(-1));
    if (!candidate) { this.clearVisualPreview(); return null; }
    let at = null;
    // Acoustic verification may still be running for an earlier word. Follow
    // the lexical prefix visually without committing or advancing that word.
    let lookahead=this.position;
    for (const spoken of tokens.map(normalizeWord)) {
      let joined='';let match=0;
      for(let count=1;count<=3&&lookahead+count<=this.words.length;count++){
        const word=this.words[lookahead+count-1];
        if(word.verseKey!==this.words[lookahead]?.verseKey)break;
        joined+=wordText(word);
        if(joined===spoken){match=count;break;}
        if(!spoken.startsWith(joined))break;
      }
      if(!match)break;
      lookahead+=match;
    }
    if (lookahead>this.position) at=lookahead-1;
    const span = this.matchingSpan(candidate);
    if (at==null && span) at = this.position + span - 1;
    else if (at==null && this.repetitionCursor != null && this.repetitionCursor < this.position &&
        wordText(this.words[this.repetitionCursor]) === candidate) at = this.repetitionCursor;
    else if (at==null) {
      at = this.words.findIndex((word, i) => i < this.position && resolved(word) &&
        (i === 0 || word.verseKey !== this.words[i-1].verseKey) && wordText(word) === candidate &&
        this.words.filter(w => w.verseKey === word.verseKey).every(resolved));
      if (at < 0) at = null;
    }
    if (at == null) { this.clearVisualPreview(); return null; }
    if (this.previewIndex === at) return this.words[at];
    this.clearVisualPreview(); this.previewIndex = at;
    const word = this.words[at];
    this.onPreview(word, true, meta);
    this.setActive(at);
    return word;
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
  failedAttempt(token, meta, type = 'substitution', pronunciation = null) {
    const word = this.expected;
    if (!word) return;
    const evidence = {...meta, alignmentScore:lexicalAlignment(token, wordText(word))};
    const credible = type === 'harakah' || (meta.confirmed === true &&
      (meta.confidence == null || meta.confidence >= .75) &&
      ((meta.stability ?? 0) >= 2 || meta.phase === 'final' || !!meta.nextToken) &&
      (meta.speechMs ?? 0) >= 250 && (meta.durationMs ?? 0) >= 250);
    if (!credible) {
      this.record('recognition_uncertain', word, evidence, {recognized:token});
      this.onUncertain(word);
      return false;
    }
    word.lastAssessment={lexicalMatch:type==='harakah',
      pronunciationScore:pronunciation?.pronunciationScore ?? null,
      vowelDecision:type==='harakah'?'incorrect':null,
      phonemeConfidence:pronunciation?.phonemeConfidence ?? null,
      finalDecision:type};
    const eventId = meta.eventId ?? `manual:${this.eventLog.length}`;
    if (this.errorEvents.has(eventId)) return true;
    this.errorEvents.add(eventId);
    this.clearVisualPreview(); this.clearActive(); this.onPage(word.page);
    try { globalThis.navigator?.vibrate?.(70); } catch {}
    word.firstAttempt ||= Date.now(); word.attempts++;
    const error = {type, spoken:token, at:Date.now(),
      confidence:meta.confidence, stability:meta.stability, startAt:meta.startAt, endAt:meta.endAt};
    word.errors.push(error);
    this.record(type, word, evidence, {recognized:token,
      expectedUthmani:word.hafs, expectedHarakah:pronunciation?.expectedVowels ?? null,
      detectedHarakah:pronunciation?.detectedHarakah ?? null,
      harakahScore:pronunciation?.harakahScore ?? null});
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
        const expected = this.expected;
        const pronunciation = verifyPronunciation(expected.pronunciation || pronunciationFor(expected),
          (expected.pronunciation?.acousticSpan || 1) === span ? meta.pronunciationEvidence : null);
        const assessment={lexicalMatch:true,
          pronunciationScore:pronunciation.pronunciationScore ?? null,
          vowelDecision:pronunciation.decision,
          phonemeConfidence:pronunciation.phonemeConfidence ?? null,
          finalDecision:pronunciation.decision};
        for(let n=0;n<span;n++)this.words[this.position+n].lastAssessment=assessment;
        if (pronunciation.decision === 'incorrect') {
          this.failedAttempt(token, meta, 'harakah', pronunciation);
          this.blockedAttempt = {segmentId:meta.segmentId, token, wordId:expected.key};
          return true;
        }
        if (pronunciation.decision === 'uncertain' && meta.pronunciationEvidence?.source === 'quran-phoneme-ctc') {
          expected.pronunciationDecision='uncertain';
          this.onUncertain(expected);
          const retries=(this.pronunciationRetries.get(expected.key)||0)+1;
          this.pronunciationRetries.set(expected.key,retries);
          if (retries < 2 && meta.phase !== 'final') return false;
        }
        for (let n = 0; n < span; n++)
          this.revealCorrect({...meta, alignmentScore:1}, pronunciation);
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
      if (!this.failedAttempt(token, meta, ahead ? 'skipped' : 'substitution')) {
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
    this.acceptCommitted([spoken], {confirmed:true, confidence, stability:3, durationMs:600, speechMs:600});
  }
}

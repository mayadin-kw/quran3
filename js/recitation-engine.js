import { normalizeWord } from './quran-data.js';

export class RecitationEngine {
  constructor(words, onChange, onPage, onFinish) {
    this.words = words; this.onChange = onChange; this.onPage = onPage; this.onFinish = onFinish;
    this.position = 0; this.active = null; this.repeatAt = -1; this.errorCount = 0;
    this.longPauses = 0; this.lastSpeechAt = Date.now(); this.startedAt = Date.now();
  }
  get expected() { return this.words[this.position]; }
  silence(now = Date.now()) {
    if (now - this.lastSpeechAt > 7000 && !this.pauseCounted) { this.longPauses++; this.pauseCounted = true; }
  }
  accept(spoken, confidence = 1) {
    const token = normalizeWord(spoken); if (!token || confidence < .65) return;
    this.lastSpeechAt = Date.now(); this.pauseCounted = false;
    const expected = this.expected; if (!expected) return;
    const prior = this.active;
    const recentStart = Math.max(0, this.position - 16);
    if (this.repeatAt >= 0) {
      const nextRepeat = this.words[this.repeatAt];
      if (nextRepeat && normalizeWord(nextRepeat.imlaey || nextRepeat.hafs) === token) {
        this.active = nextRepeat; nextRepeat.repeats++; this.repeatAt++;
        if (prior && prior !== nextRepeat) this.onChange(prior, false);
        this.onChange(nextRepeat, true); return;
      }
      this.repeatAt = -1;
    }
    const expToken = normalizeWord(expected.imlaey || expected.hafs);
    if (token === expToken) {
      if (prior) this.onChange(prior, false);
      expected.revealed = true; expected.state = 'correct'; expected.revealedAt ||= Date.now();
      expected.firstAttempt ||= Date.now(); this.active = expected; this.onChange(expected, false);
      this.position++;
      if (this.expected?.page !== expected.page && this.expected) this.onPage(this.expected.page);
      if (this.position === this.words.length) this.onFinish();
      return;
    }
    const back = this.words.findIndex((w, i) => i >= recentStart && i < this.position && normalizeWord(w.imlaey || w.hafs) === token);
    if (back >= 0) {
      this.repeatAt = back + 1;
      const word = this.words[back]; word.repeats++; this.active = word;
      if (prior && prior !== word) this.onChange(prior, false);
      this.onChange(word, true); return;
    }
    // A short, context-supported forward jump may indicate an omitted word.
    for (let jump = 1; jump <= 2 && this.position + jump < this.words.length; jump++) {
      const candidate = this.words[this.position + jump];
      if (normalizeWord(candidate.imlaey || candidate.hafs) !== token) continue;
      for (let i = this.position; i < this.position + jump; i++) {
        this.words[i].state = 'skipped'; this.words[i].errors.push({ type: 'تجاوز كلمة', spoken: null, at: Date.now() });
        this.errorCount++; this.onChange(this.words[i], false);
      }
      this.position += jump;
      this.accept(spoken, confidence); return;
    }
    if (prior) this.onChange(prior, false);
    expected.firstAttempt ||= Date.now(); expected.attempts++; this.errorCount++;
    expected.errors.push({ type: 'استبدال كلمة', spoken, at: Date.now() });
    if (expected.attempts >= 3) {
      expected.revealed = true; expected.revealedByErrorLimit = true; expected.revealedAt = Date.now();
      expected.state = 'revealed-after-errors'; this.onChange(expected, false);
      this.position++;
      if (this.expected?.page !== expected.page && this.expected) this.onPage(this.expected.page);
      if (this.position === this.words.length) this.onFinish();
    } else { expected.state = 'incorrect-placeholder'; this.onChange(expected, false); }
  }
}

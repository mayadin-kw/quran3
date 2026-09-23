export function buildReport(session, engine) {
  const completedAt = Date.now();
  const words = engine.words;
  const verses = [];
  for (const word of words) {
    let verse = verses.find(v => v.verseKey === word.verseKey);
    if (!verse) { verse = { verseKey: word.verseKey, words: [] }; verses.push(verse); }
    verse.words.push({ index: word.index, hafs: word.hafs, attempts: word.attempts,
      repeats: word.repeats, revealedAfterThreeErrors: word.revealedByErrorLimit,
      state: word.state, errors: word.errors });
  }
  return { sessionId: session.id, surah: session.surah, fromAyah: session.fromAyah,
    toAyah: session.toAyah, startedAt: engine.startedAt, completedAt,
    durationMs: completedAt - engine.startedAt,
    totals: { words: words.length, correctWords: words.filter(w => w.revealed && !w.revealedByErrorLimit).length,
      correctFirstAttempt: words.filter(w => w.revealed && !w.attempts).length,
      requiredRepetition: words.filter(w => w.revealed && w.attempts && !w.revealedByErrorLimit).length,
      errors: engine.errorCount,
      substitutions: words.reduce((n,w) => n + w.errors.filter(e => e.type === 'استبدال كلمة').length,0),
      skipped: words.filter(w => w.state === 'skipped').length,
      revealedAfterThreeErrors: words.filter(w => w.revealedByErrorLimit).length,
      repetitions: words.reduce((n, w) => n + w.repeats, 0), longPauses: engine.longPauses,
      completion: Math.round(100 * words.filter(w => w.revealed || w.state === 'skipped').length / words.length) },
    verses };
}

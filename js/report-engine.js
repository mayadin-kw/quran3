export function buildReport(session, engine) {
  if (!engine.complete) throw Error('لا يمكن إصدار التقرير قبل حسم كل كلمات المقطع');
  const completedAt = Date.now();
  const words = engine.words;
  const events = engine.eventLog;
  const confirmedErrors = events.filter(event => event.type === 'substitution');
  const verses = [];
  for (const word of words) {
    let verse = verses.find(value => value.verseKey === word.verseKey);
    if (!verse) { verse = {verseKey:word.verseKey, words:[]}; verses.push(verse); }
    const errors = confirmedErrors.filter(event => event.wordId === word.key).map(event => ({
      type:'خطأ مؤكد', spoken:event.confidence >= .82 ? event.recognized : null,
      expected:event.expected, at:event.timestamp
    }));
    verse.words.push({index:word.index, hafs:word.hafs, attempts:errors.length,
      repeats:word.repeats, revealedAfterThreeErrors:word.revealedByErrorLimit,
      state:word.state, errors});
  }
  const resolved = words.filter(word => word.state === 'correct' || word.state === 'revealed-after-errors').length;
  return {
    sessionId:session.id, surah:session.surah, fromAyah:session.fromAyah,
    toAyah:session.toAyah, startedAt:engine.startedAt, completedAt,
    calibration:session.calibration || null,
    durationMs:completedAt-engine.startedAt,
    totals:{
      words:words.length,
      correctWords:words.filter(word => word.state === 'correct').length,
      correctFirstAttempt:words.filter(word => word.state === 'correct' && !confirmedErrors.some(event => event.wordId === word.key)).length,
      requiredRepetition:words.filter(word => word.state === 'correct' && confirmedErrors.some(event => event.wordId === word.key)).length,
      errors:confirmedErrors.length, substitutions:confirmedErrors.length, skipped:0,
      revealedAfterThreeErrors:words.filter(word => word.revealedByErrorLimit).length,
      repetitions:events.filter(event => event.type === 'real-repetition').length,
      longPauses:engine.longPauses,
      completion:words.length ? Math.round(100*resolved/words.length) : 0
    },
    verses,
    // Evidence is retained for ?debug=1 inspection; normal UI never renders it.
    debugErrors:confirmedErrors.map(event => ({
      expected:event.expected, recognized:event.recognized,
      confidence:event.confidence, alignmentScore:event.alignmentScore,
      startAt:event.startAt, endAt:event.endAt, stability:event.stability
    }))
  };
}

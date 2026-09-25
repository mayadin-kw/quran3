export function buildReport(session, engine) {
  if (!engine.complete) throw Error('لا يمكن إصدار التقرير قبل حسم كل كلمات المقطع');
  const completedAt = Date.now();
  const words = engine.words;
  const events = engine.eventLog;
  const confirmedErrors = events.filter(event => ['substitution','harakah','skipped','forgotten'].includes(event.type));
  const verses = [];
  for (const word of words) {
    let verse = verses.find(value => value.verseKey === word.verseKey);
    if (!verse) { verse = {verseKey:word.verseKey, words:[]}; verses.push(verse); }
    const errors = confirmedErrors.filter(event => event.wordId === word.key).map(event => ({
      type:({substitution:'خطأ في كلمة',harakah:'خطأ في الحركة',skipped:'تجاوز كلمة',
        forgotten:'نسيان كلمة'})[event.type],
      spoken:event.recognized || null, expected:event.expected,
      expectedUthmani:event.expectedUthmani || word.hafs,
      expectedHarakah:event.expectedHarakah || null,
      detectedHarakah:event.detectedHarakah || null,
      confidence:event.harakahScore ?? event.confidence ?? null, at:event.timestamp
    }));
    verse.words.push({index:word.index, hafs:word.hafs, attempts:errors.length,
      repeats:word.repeats, revealedAfterThreeErrors:word.revealedByErrorLimit,
      state:word.state, assessment:word.lastAssessment || null, errors});
  }
  const resolved = words.filter(word => ['correct','lexical-only','revealed-after-errors'].includes(word.state)).length;
  return {
    sessionId:session.id, surah:session.surah, fromAyah:session.fromAyah,
    toAyah:session.toAyah, startedAt:engine.startedAt, completedAt,
    calibration:session.calibration || null,
    durationMs:completedAt-engine.startedAt,
    totals:{
      words:words.length,
      correctWords:words.filter(word => word.state === 'correct').length,
      pronunciationUnverified:words.filter(word => word.state === 'lexical-only').length,
      correctFirstAttempt:words.filter(word => word.state === 'correct' && !confirmedErrors.some(event => event.wordId === word.key)).length,
      requiredRepetition:words.filter(word => word.state === 'correct' && confirmedErrors.some(event => event.wordId === word.key)).length,
      errors:confirmedErrors.length,
      substitutions:confirmedErrors.filter(event => event.type === 'substitution').length,
      harakahErrors:confirmedErrors.filter(event => event.type === 'harakah').length,
      skipped:confirmedErrors.filter(event => event.type === 'skipped').length,
      forgotten:confirmedErrors.filter(event => event.type === 'forgotten').length,
      revealedAfterThreeErrors:words.filter(word => word.revealedByErrorLimit).length,
      repetitions:events.filter(event => event.type === 'real-repetition').length,
      longPauses:engine.longPauses,
      completion:words.length ? Math.round(100*resolved/words.length) : 0
    },
    verses,
    // Evidence is retained for ?debug=1 inspection; normal UI never renders it.
    debugErrors:confirmedErrors.map(event => ({
      type:event.type, expected:event.expected, recognized:event.recognized,
      expectedHarakah:event.expectedHarakah, detectedHarakah:event.detectedHarakah,
      harakahScore:event.harakahScore,
      confidence:event.confidence, alignmentScore:event.alignmentScore,
      startAt:event.startAt, endAt:event.endAt, stability:event.stability
    }))
  };
}

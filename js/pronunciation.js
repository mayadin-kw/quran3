import {normalizeWord} from './quran-data.js';

const VOWELS = new Map([['\u064e','fatha'], ['\u0650','kasra'], ['\u064f','damma'],
  ['\u064b','tanwin-fath'], ['\u064d','tanwin-kasr'], ['\u064c','tanwin-damm']]);
const MARKS = new Map([['\u0651','shadda'], ['\u0652','sukoon'], ['\u06e1','sukoon'],
  ['\u0670','dagger-alif'], ['\u06e4','madd']]);

// Keep the Hafs source separate from the consonantal form used by ASR alignment.
// Uthmani signs are preserved even if the current acoustic model cannot score them.
export function pronunciationFor(word, aligned = null) {
  const displayUthmani = word.hafs || '';
  const units = [];
  for (const char of displayUthmani.normalize('NFC')) {
    if (VOWELS.has(char)) units.push({kind:'vowel', value:VOWELS.get(char)});
    else if (MARKS.has(char)) units.push({kind:'mark', value:MARKS.get(char)});
    else units.push({kind:'grapheme', value:char});
  }
  const expectedPhonemes = aligned?.phonemes || null;
  return {wordId:word.key, displayUthmani, uthmaniText:displayUthmani,
    lexicalNormalized:normalizeWord(word.imlaey || displayUthmani),
    pronunciationRepresentation:displayUthmani,
    phonemeSequence:expectedPhonemes, expectedPhonemes,
    vowelSequence:[...(expectedPhonemes || '')].filter(char => 'aiuāīū'.includes(char)),
    expectedVowels:units.filter(unit => unit.kind === 'vowel'), units,
    acousticSpan:aligned?.span || 1, coveredBy:aligned?.coveredBy || null,
    alignmentDistance:aligned?.alignmentDistance ?? null};
}

// A text hypothesis, including a diacritized ASR hypothesis, is not an acoustic
// vowel score. Until a validated audio aligner supplies per-vowel evidence, the
// only honest pronunciation decision is uncertain.
export function verifyPronunciation(expected, acousticEvidence) {
  if (acousticEvidence?.source === 'quran-phoneme-ctc') {
    if (!expected.phonemeSequence || acousticEvidence.focusPhonemes !== expected.phonemeSequence)
      return {decision:'uncertain',reason:'phoneme-target-mismatch',
        harakahScore:null,finalVowelScore:null,expectedVowels:expected.expectedVowels};
    return {decision:acousticEvidence.decision,reason:'ctc-forced-alignment',
      harakahScore:acousticEvidence.vowels?.length ?
        Math.min(...acousticEvidence.vowels.map(value=>value.expectedProbability)) : null,
      finalVowelScore:acousticEvidence.finalVowelScore,
      expectedVowels:expected.expectedVowels,
      detectedHarakah:acousticEvidence.decision === 'incorrect' ?
        acousticEvidence.vowels?.find(value=>value.margin<=-6)?.alternative || null : null,
      phonemeConfidence:acousticEvidence.phonemeConfidence,
      pronunciationScore:acousticEvidence.pronunciationScore};
  }
  if (!expected.expectedVowels.length)
    return {decision:'uncertain', reason:'no-explicit-vowel-target',
      harakahScore:null, finalVowelScore:null, expectedVowels:[]};
  if (!acousticEvidence || acousticEvidence.source !== 'validated-phoneme-alignment')
    return {decision:'uncertain', reason:'no-validated-acoustic-alignment',
      harakahScore:null, finalVowelScore:null, expectedVowels:expected.expectedVowels};
  const scores = acousticEvidence.vowels;
  if (!Array.isArray(scores) || scores.length !== expected.expectedVowels.length ||
      scores.some(item => !Number.isFinite(item.expectedProbability) ||
        !Number.isFinite(item.alternativeProbability) || item.expectedProbability < 0 ||
        item.expectedProbability > 1 || item.alternativeProbability < 0 ||
        item.alternativeProbability > 1))
    return {decision:'uncertain', reason:'incomplete-vowel-evidence',
      harakahScore:null, finalVowelScore:null, expectedVowels:expected.expectedVowels};
  const weakest = Math.min(...scores.map(item => item.expectedProbability));
  const final = scores.at(-1) || null;
  const wrong = scores.find(item => item.alternativeProbability >= .9 &&
    item.alternativeProbability - item.expectedProbability >= .35);
  const decision = wrong ? 'incorrect' : scores.every(item =>
    item.expectedProbability >= .9 && item.expectedProbability - item.alternativeProbability >= .35)
    ? 'correct' : 'uncertain';
  return {decision, reason:'validated-acoustic-alignment', harakahScore:weakest,
    finalVowelScore:final?.expectedProbability ?? null,
    expectedVowels:expected.expectedVowels, detectedHarakah:wrong?.alternative ?? null};
}

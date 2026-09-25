const SHORT_VOWELS = ['a', 'i', 'u'];
const ALL_VOWELS = new Set([...SHORT_VOWELS, 'ā', 'ī', 'ū', 'e', 'o']);
const logAdd = (a, b) => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const top = Math.max(a, b);
  return top + Math.log1p(Math.exp(Math.min(a, b) - top));
};

export function logProbabilities(logits, frames, vocabularySize) {
  const result = new Float32Array(logits.length);
  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * vocabularySize;
    let maximum = -Infinity;
    for (let token = 0; token < vocabularySize; token++)
      maximum = Math.max(maximum, logits[offset + token]);
    let sum = 0;
    for (let token = 0; token < vocabularySize; token++)
      sum += Math.exp(logits[offset + token] - maximum);
    const normalizer = maximum + Math.log(sum);
    for (let token = 0; token < vocabularySize; token++)
      result[offset + token] = logits[offset + token] - normalizer;
  }
  return result;
}

export function ctcLogLikelihood(logProb, frames, vocabularySize, sequence, vocabulary) {
  const blank = vocabulary['[PAD]'];
  const symbols = [...sequence].map(symbol => vocabulary[symbol]);
  if (symbols.some(symbol => symbol == null) || !symbols.length) return -Infinity;
  const path = [blank];
  for (const symbol of symbols) path.push(symbol, blank);
  let previous = new Float64Array(path.length).fill(-Infinity);
  previous[0] = logProb[blank];
  previous[1] = logProb[path[1]];
  for (let frame = 1; frame < frames; frame++) {
    const next = new Float64Array(path.length).fill(-Infinity);
    for (let state = 0; state < path.length; state++) {
      let score = previous[state];
      if (state) score = logAdd(score, previous[state - 1]);
      if (state > 1 && path[state] !== blank && path[state] !== path[state - 2])
        score = logAdd(score, previous[state - 2]);
      next[state] = score + logProb[frame * vocabularySize + path[state]];
    }
    previous = next;
  }
  return logAdd(previous[path.length - 1], previous[path.length - 2]);
}

export function greedyPhonemes(logits, frames, vocabularySize, vocabulary) {
  const reverse = Object.fromEntries(Object.entries(vocabulary).map(([symbol, id]) => [id, symbol]));
  const blank = vocabulary['[PAD]'];
  let previous = null, transcript = '';
  for (let frame = 0; frame < frames; frame++) {
    const offset = frame * vocabularySize;
    let best = 0;
    for (let token = 1; token < vocabularySize; token++)
      if (logits[offset + token] > logits[offset + best]) best = token;
    if (best !== previous && best !== blank) transcript += reverse[best] || '';
    previous = best;
  }
  return transcript;
}

export function scorePronunciation(logits, frames, vocabulary, expected, options = {}) {
  // The classifier has 40 logits while the published vocab names 38 IDs.
  // Use the actual tensor stride; the last two unnamed IDs are still present
  // in the acoustic normalization and must never shift subsequent frames.
  const vocabularySize = logits.length / frames;
  const logProb = logProbabilities(logits, frames, vocabularySize);
  const cache = new Map();
  const score = sequence => {
    if (!cache.has(sequence)) cache.set(sequence,
      ctcLogLikelihood(logProb, frames, vocabularySize, sequence, vocabulary));
    return cache.get(sequence);
  };
  const expectedScore = score(expected);
  const greedy = greedyPhonemes(logits, frames, vocabularySize, vocabulary);
  const greedyScore = score(greedy);
  const phonemeGap = expectedScore - greedyScore;
  const sequenceAgreement = Number.isFinite(phonemeGap) ?
    Math.min(1, Math.exp(Math.min(0, phonemeGap) / Math.max(expected.length, 1))) : 0;
  const vowels = [];
  const focusStart=options.focusStart ?? 0;
  const focusEnd=options.focusEnd ?? expected.length;
  for (let index = focusStart; index < focusEnd; index++) {
    const symbol = expected[index];
    if (!SHORT_VOWELS.includes(symbol)) continue;
    const alternatives = SHORT_VOWELS.filter(value => value !== symbol)
      .map(value => ({value, score:score(expected.slice(0,index) + value + expected.slice(index+1))}));
    const maximum = Math.max(expectedScore, ...alternatives.map(item => item.score));
    const weights = [expectedScore, ...alternatives.map(item => item.score)]
      .map(value => Math.exp(value - maximum));
    const denominator = weights.reduce((a,b) => a+b, 0);
    const best = alternatives.reduce((a,b) => b.score > a.score ? b : a);
    vowels.push({index, expected:symbol, alternative:best.value,
      expectedProbability:weights[0]/denominator,
      alternativeProbability:Math.max(...weights.slice(1))/denominator,
      margin:expectedScore-best.score, alternativeScore:best.score});
  }
  const shadda = [];
  if (options.checkShadda) for (let index = Math.max(1,focusStart); index < focusEnd; index++) {
    const symbol = expected[index];
    if (symbol !== expected[index-1] || ALL_VOWELS.has(symbol) || !/[a-zʿḥṣḍṭẓ]/u.test(symbol)) continue;
    const alternative = expected.slice(0,index) + expected.slice(index+1);
    const alternativeScore = score(alternative);
    shadda.push({index, margin:expectedScore-alternativeScore, alternativeScore});
  }
  const sukoon = [];
  if (options.checkFinalSukoon && focusEnd === expected.length && /[a-zʿḥṣḍṭẓ]$/u.test(expected)) {
    const best = SHORT_VOWELS.map(vowel => ({vowel, score:score(expected+vowel)}))
      .reduce((a,b) => b.score > a.score ? b : a);
    sukoon.push({index:expected.length-1, margin:expectedScore-best.score,
      alternativeScore:best.score,
      alternative:best.vowel});
  }
  const credible = Number.isFinite(expectedScore) && Number.isFinite(greedyScore);
  const contextual=focusStart>0;
  const threshold=contextual?8:6;
  const wrong = [...vowels,...shadda,...sukoon].find(item => item.margin <= -threshold &&
    (contextual || item.alternativeScore >= greedyScore - 8));
  const required = [...vowels,...shadda,...sukoon];
  const confidentCorrect = required.length > 0 && required.every(item => item.margin >= threshold) &&
    (contextual || phonemeGap >= -8);
  const decision = !credible ? 'uncertain' : wrong ? 'incorrect' :
    confidentCorrect ? 'correct' : 'uncertain';
  const phonemeConfidence = decision === 'uncertain' ? 0 : Math.min(...required.map(item =>
    1/(1+Math.exp(-Math.abs(item.margin)))));
  return {source:'quran-phoneme-ctc', decision, expected, greedy,
    pronunciationScore:Math.round(expectedScore*100)/100,
    phonemeConfidence, sequenceAgreement, phonemeGap:Math.round(phonemeGap*100)/100,
    vowelDecision:decision, vowels, shadda, sukoon,
    finalVowelScore:vowels.at(-1)?.expectedProbability ?? null};
}

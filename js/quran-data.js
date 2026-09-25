import {pronunciationFor} from './pronunciation.js';
let indexPromise;
export function loadQuran() {
  return indexPromise ||= caches.open('recitation-core').then(async cache => {
    const indexResponse = await cache.match('data/quran-index.json');
    const surahsResponse = await cache.match('data/surahs.json');
    const pronunciationResponse = await cache.match('data/quran-pronunciation-map.json');
    if (!indexResponse || !surahsResponse || !pronunciationResponse)
      throw Error('بيانات المصحف غير مكتملة');
    return {index: await indexResponse.json(), surahs: await surahsResponse.json(),
      pronunciationMap:(await pronunciationResponse.json()).words};
  });
}
export function selectedWords(index, surah, first, last, pronunciationMap = {}) {
  const words = [];
  for (let ayah = first; ayah <= last; ayah++) {
    const verseKey = `${surah}:${ayah}`;
    for (const word of index.verses[verseKey] || []) {
      // Pause ornaments are SVG positions, not spoken Quran words.
      if (!normalizeWord(word.imlaey || word.hafs)) continue;
      const selected = { ...word, verseKey, surah, ayah, key: `${verseKey}:${word.index}`,
        state: 'hidden', attempts: 0, revealed: false, revealedByErrorLimit: false,
        repeats: 0, errors: [], firstAttempt: null, revealedAt: null };
      const aligned = pronunciationMap[selected.key];
      const sharedTarget = aligned?.coveredBy ? pronunciationMap[aligned.coveredBy] : null;
      selected.pronunciation = pronunciationFor(selected, sharedTarget ? {
        ...sharedTarget, coveredBy:aligned.coveredBy
      } : aligned);
      words.push(selected);
    }
  }
  return words;
}
export function normalizeWord(value) {
  return (value || '').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\u0621-\u064A]/g, '');
}

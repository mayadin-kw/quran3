let indexPromise;
export function loadQuran() {
  return indexPromise ||= caches.open('recitation-core').then(async cache => {
    const indexResponse = await cache.match('data/quran-index.json');
    const surahsResponse = await cache.match('data/surahs.json');
    if (!indexResponse || !surahsResponse) throw Error('بيانات المصحف غير مكتملة');
    return {index: await indexResponse.json(), surahs: await surahsResponse.json()};
  });
}
export function selectedWords(index, surah, first, last) {
  const words = [];
  for (let ayah = first; ayah <= last; ayah++) {
    const verseKey = `${surah}:${ayah}`;
    for (const word of index.verses[verseKey] || []) {
      words.push({ ...word, verseKey, surah, ayah, key: `${verseKey}:${word.index}`,
        state: 'hidden', attempts: 0, revealed: false, revealedByErrorLimit: false,
        repeats: 0, errors: [], firstAttempt: null, revealedAt: null });
    }
  }
  return words;
}
export function normalizeWord(value) {
  return (value || '').normalize('NFKD').replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\u0621-\u064A]/g, '');
}

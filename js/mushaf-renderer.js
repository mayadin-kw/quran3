const SVG_NS = 'http://www.w3.org/2000/svg';
export const MUSHAF_CANONICAL_VIEWBOX = '0 0 382.68 547.09';
export const MUSHAF_FRAME = Object.freeze({x:7.5, y:7.5, width:367.68, height:532.09});
export const MUSHAF_SOURCE = 'https://cdn.jsdelivr.net/gh/mushafdatabase/MushafDatabase-Ligature-Based-SVG@ae5786ab08597f8123575dec4e774f1eca195e0f/SVG%20V1.01/';
export const mushafPageUrl = page => `${MUSHAF_SOURCE}${String(page).padStart(3, '0')}.svg`;
const element = (name, attributes = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
};

function decorate(svg, page) {
  const content = svg.querySelector('#md-page');
  if (!content) throw Error('صفحة المصحف لا تحتوي على النص');
  const inner = content.querySelector('#md-page-inner');
  if (!inner) throw Error('صفحة المصحف لا تحتوي على الأسطر');
  // All original Quran paths stay in one uniformly scaled group. Word geometry
  // and identifiers are unchanged, including the positions used by overlays.
  const opening = page <= 2;
  const scale = opening ? 1.5 : 1.055;
  if (opening) for (const line of inner.querySelectorAll('[id^="md-line-"]')) {
    if (Number(line.dataset.lineNumber) >= 7 && Number(line.dataset.lineNumber) <= 13)
      line.setAttribute('transform', 'translate(0 -140)');
  }
  inner.setAttribute('transform', `translate(${191.34 * (1 - scale)} ${273.545 * (1 - scale) + (opening ? 100 : 0)}) scale(${scale})`);
  for (const header of content.querySelectorAll('#md-non-quranic-header-surah-name, #md-non-quranic-header-juz-name'))
    header.setAttribute('transform', 'translate(0 15)');
  content.querySelector('#md-non-quranic-page-number')?.setAttribute('transform', 'translate(0 -24)');
  svg.insertBefore(element('rect', {x:0, y:0, width:382.68, height:547.09, fill:'#fffdf7'}), content);

  for (const title of inner.querySelectorAll('[data-type="surah-name"]')) {
    const box = title.getBBox();
    const mid = box.y + box.height / 2;
    const top = mid - Math.max(16, box.height / 2 + 6);
    const bottom = mid + Math.max(16, box.height / 2 + 6);
    const ornament = element('g', {'class':'surah-ornament', 'aria-hidden':'true'});
    const left = opening ? 75 : 35;
    const right = 382 - left;
    const plaqueLeft = opening ? 139 : 128;
    const plaqueRight = 382 - plaqueLeft;
    ornament.append(
      element('rect', {x:left, y:top, width:right-left, height:bottom-top, fill:'#fbf4dc', stroke:'#a28c5c', 'stroke-width':'.8'}),
      element('rect', {x:left+3, y:top+3, width:right-left-6, height:bottom-top-6, fill:'none', stroke:'#c7b67b', 'stroke-width':'.45'}),
      element('path', {d:`M ${left+5} ${mid-7} H ${plaqueLeft-10} L ${plaqueLeft-1} ${mid} L ${plaqueLeft-10} ${mid+7} H ${left+5} M ${right-5} ${mid-7} H ${plaqueRight+10} L ${plaqueRight+1} ${mid} L ${plaqueRight+10} ${mid+7} H ${right-5}`, fill:'none', stroke:'#b29a63', 'stroke-width':'.75'}),
      element('path', {d:`M ${left+4} ${top+5} H ${plaqueLeft-16} M ${plaqueRight+16} ${top+5} H ${right-4} M ${left+4} ${bottom-5} H ${plaqueLeft-16} M ${plaqueRight+16} ${bottom-5} H ${right-4}`, fill:'none', stroke:'#d6c99e', 'stroke-width':'.6'}),
      element('path', {d:`M ${plaqueLeft} ${mid} l 8 -11 H ${plaqueRight-8} l 8 11 -8 11 H ${plaqueLeft+8} Z`, fill:'#fffdf7', stroke:'#a28c5c', 'stroke-width':'.8'}),
      element('path', {d:`M ${left+7} ${mid} l 4 -4 4 4 -4 4 Z M ${right-7} ${mid} l -4 -4 -4 4 4 4 Z`, fill:'#b8a270'})
    );
    title.before(ornament);
  }

  const frame = element('g', {'class':'mushaf-frame', 'aria-hidden':'true', fill:'none'});
  frame.append(
    element('rect', {...MUSHAF_FRAME, rx:5, stroke:'#695c41', 'stroke-width':'1.5'}),
    element('rect', {x:12, y:12, width:358.68, height:523.09, rx:3, stroke:'#c3ad75', 'stroke-width':'.8'}),
    element('rect', {x:17, y:17, width:348.68, height:513.09, rx:1, stroke:'#8f7a4e', 'stroke-width':'.65'}),
    element('path', {d:'M 17 39 Q 17 17 39 17 M 344 17 Q 365 17 365 39 M 17 508 Q 17 530 39 530 M 344 530 Q 365 530 365 508', stroke:'#b79e69', 'stroke-width':'1.1'}),
    element('path', {d:'M 25 28 l 4 -4 4 4 -4 4 Z M 350 28 l 4 -4 4 4 -4 4 Z M 25 519 l 4 -4 4 4 -4 4 Z M 350 519 l 4 -4 4 4 -4 4 Z', fill:'#d1bc84', stroke:'#8f7a4e', 'stroke-width':'.5'})
  );
  svg.append(frame);
}

export class MushafRenderer {
  constructor(container, onPage) { this.container = container; this.onPage = onPage; this.cache = new Map(); this.page = null; this.nodes = new Map(); this.boxes = new Map(); this.overlays = new Map(); this.activeWordId = null; this.showVersion = 0; }
  async preload(page) {
    if (!page || page > 604 || this.cache.has(page)) return;
    const url = mushafPageUrl(page);
    const response = await (await caches.open('recitation-core')).match(url);
    if (!response?.ok) throw Error('تعذر تحميل صفحة المصحف');
    this.cache.set(page, await response.text());
    if (this.cache.size > 4) this.cache.delete(this.cache.keys().next().value);
  }
  async show(page, words) {
    const version = ++this.showVersion;
    if (this.page === page) return;
    await this.preload(page);
    if (version !== this.showVersion) return;
    const doc = new DOMParser().parseFromString(this.cache.get(page), 'image/svg+xml');
    if (doc.querySelector('parsererror')) throw Error('ملف المصحف غير صالح');
    const svg = document.importNode(doc.documentElement, true);
    svg.removeAttribute('width'); svg.removeAttribute('height');
    svg.setAttribute('viewBox', MUSHAF_CANONICAL_VIEWBOX);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    if (typeof location !== 'undefined' && !new URLSearchParams(location.search).has('debug'))
      svg.querySelector(':scope > title')?.remove();
    this.container.replaceChildren(svg);
    decorate(svg, page);
    this.nodes.clear(); this.boxes.clear(); this.overlays.clear(); this.page = page;
    const selected = new Map(words.filter(w => w.page === page).map(w => [w.key, w]));
    for (const group of svg.querySelectorAll('[id^="md-word-"][data-surah][data-aya][data-word-index-in-ayah]')) {
      if (group.getAttribute('data-type') !== 'text') continue;
      const key = `${Number(group.dataset.surah)}:${Number(group.dataset.aya)}:${Number(group.dataset.wordIndexInAyah)}`;
      const word = selected.get(key);
      if (!word) continue;
      this.nodes.set(key, group);
      this.boxes.set(group.id, group.getBBox());
      group.classList.toggle('is-hidden', !word.revealed);
      this.update(word, word.key === this.activeWordId);
    }
    this.onPage?.(page);
    this.preload(page + 1).catch(() => {});
  }
  overlay(group, kind) {
    const key = `${group.id}:${kind}`;
    if (this.overlays.has(key)) return;
    const box = this.boxes.get(group.id);
    const rect = element('rect', {x:box.x-1, y:box.y-1,
      width:Math.max(box.width+2,5), height:Math.max(box.height+2,5), rx:1.5,
      class:`word-overlay ${kind}`, 'aria-hidden':'true'});
    group.before(rect); this.overlays.set(key, rect);
  }
  removeOverlay(group, kind) {
    const key = `${group.id}:${kind}`;
    this.overlays.get(key)?.remove(); this.overlays.delete(key);
  }
  setActiveWord(wordId) {
    if (this.activeWordId && this.activeWordId !== wordId) this.clearActiveWord(this.activeWordId);
    this.activeWordId = wordId;
    const group = this.nodes.get(wordId);
    if (group && !group.classList.contains('is-hidden')) this.overlay(group, 'active');
  }
  clearActiveWord(wordId = this.activeWordId) {
    const group = this.nodes.get(wordId);
    if (group) this.removeOverlay(group, 'active');
    if (wordId === this.activeWordId) this.activeWordId = null;
  }
  revealWord(wordId) { this.nodes.get(wordId)?.classList.remove('is-hidden'); }
  showWordError(wordId) { const group = this.nodes.get(wordId); if (group) this.overlay(group, 'error'); }
  clearWordError(wordId) { const group = this.nodes.get(wordId); if (group) this.removeOverlay(group, 'error'); }
  revealWordAfterFailures(wordId) {
    this.revealWord(wordId); this.clearWordError(wordId);
    const group = this.nodes.get(wordId); if (group) this.overlay(group, 'revealed-error');
  }
  update(word, active = false) {
    // Remember off-page state while an asynchronous page load is in flight.
    if (active) this.setActiveWord(word.key);
    else if (this.activeWordId === word.key) this.clearActiveWord(word.key);
    const group = this.nodes.get(word.key); if (!group) return;
    if (word.revealed) this.revealWord(word.key);
    if (word.revealedByErrorLimit) this.revealWordAfterFailures(word.key);
    else if (word.state === 'incorrect-placeholder') this.showWordError(word.key);
    else this.clearWordError(word.key);
    if (active) this.setActiveWord(word.key);
  }
}

import {loadQuran, selectedWords, normalizeWord} from './quran-data.js';
import {MushafRenderer} from './mushaf-renderer.js';
import {requestMicrophone, Microphone} from './microphone.js';
import {BrowserFastConformerProvider} from './asr-engine.js';
import {RecitationEngine} from './recitation-engine.js';
import {buildReport} from './report-engine.js';
import {saveReport} from './firebase.js';
import {downloadManager, formatBytes, formatEta} from './download-manager.js';

const root = document.getElementById('app');
const debug = new URLSearchParams(location.search).has('debug');
let data, stream, microphone, provider, engine, renderer, session, report;
let homeUnsubscribe;
let modalUnsubscribe;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arabic = value => new Intl.NumberFormat('ar').format(value);
function debugInfo(values) { if (!debug) return; let node = document.querySelector('.debug'); if (!node) { node = document.createElement('pre'); node.className = 'debug'; document.body.append(node); } node.textContent = JSON.stringify(values, null, 2); }
function home() {
  homeUnsubscribe?.();
  root.innerHTML = `<section class="screen home"><div class="emblem" aria-hidden="true">۞</div><h1>القرآن الكريم</h1>
    <div class="home-download"><div class="home-action"><button class="primary" id="go-setup" aria-disabled="true">تسميع</button>
    <button class="download-icon" id="download-action" aria-label="تحميل بيانات التسميع">↓</button></div>
    <p id="download-status" class="download-status">جاري فحص بيانات التسميع…</p></div></section>`;
  document.getElementById('go-setup').onclick = () => downloadManager.state === 'installed' ? setup() : openDownloadModal();
  document.getElementById('download-action').onclick = openDownloadModal;
  homeUnsubscribe = downloadManager.subscribe(updateHomeDownload);
  if (sessionStorage.getItem('interrupted')) sessionStorage.removeItem('interrupted');
}
function updateHomeDownload(info) {
  const button = document.getElementById('go-setup'), icon = document.getElementById('download-action'), status = document.getElementById('download-status');
  if (!button || !icon || !status) return;
  const ready = info.state === 'installed';
  button.setAttribute('aria-disabled', String(!ready)); button.classList.toggle('locked', !ready);
  icon.hidden = ready;
  if (info.state === 'downloading') {
    icon.className = 'download-icon progress-ring'; icon.style.setProperty('--progress', `${info.percent}%`);
    icon.textContent = `${arabic(info.percent)}٪`;
    status.textContent = `الوقت المتبقي: ${formatEta(info.eta)} · ${formatBytes(info.downloadedBytes)} من ${formatBytes(info.missingBytes)}`;
  } else if (info.state === 'verifying') {
    icon.className = 'download-icon verifying-ring'; icon.textContent = '◌';
    status.textContent = 'جاري التحقق من الملفات…';
  } else {
    icon.className = 'download-icon'; icon.style.removeProperty('--progress'); icon.textContent = '↓';
    status.textContent = ({installed:'جاهز للتسميع',checking:'جاري فحص بيانات التسميع…',
      'update-required':'يتوفر تحديث لبيانات التسميع',error:'تعذر إكمال التحميل',
      'insufficient-storage':'لا توجد مساحة تخزين كافية'})[info.state] || 'يتطلب تحميل بيانات التسميع';
  }
}
function closeModal() { modalUnsubscribe?.(); modalUnsubscribe = null; document.getElementById('download-modal')?.remove(); }
function openDownloadModal() {
  closeModal();
  const info = downloadManager.snapshot();
  if (info.state === 'checking') {
    const waiting = document.createElement('div'); waiting.id = 'download-modal'; waiting.className = 'modal-backdrop';
    waiting.innerHTML = '<div class="download-modal" role="dialog" aria-modal="true"><div class="spinner modal-spinner"></div><h2>جاري فحص بيانات التسميع…</h2><button class="modal-later" id="modal-close">لاحقًا</button></div>';
    document.body.append(waiting); document.getElementById('modal-close').onclick = closeModal;
    modalUnsubscribe = downloadManager.subscribe(next => { if (next.state !== 'checking') openDownloadModal(); });
    return;
  }
  if (!info.manifest) {
    const unavailable = document.createElement('div'); unavailable.id = 'download-modal'; unavailable.className = 'modal-backdrop';
    unavailable.innerHTML = '<div class="download-modal" role="dialog" aria-modal="true"><h2>تعذر تحميل بيانات التسميع</h2><p>تعذر قراءة قائمة الملفات المطلوبة. تحقق من الاتصال ثم أعد المحاولة.</p><button class="primary" id="modal-retry">إعادة المحاولة</button><button class="modal-later" id="modal-close">لاحقًا</button></div>';
    document.body.append(unavailable); document.getElementById('modal-close').onclick = closeModal;
    document.getElementById('modal-retry').onclick = () => { closeModal(); downloadManager.init(); };
    return;
  }
  const isDownloading = info.state === 'downloading' || info.state === 'verifying';
  const startLabel = info.state === 'error' ? 'إعادة المحاولة' : info.state === 'update-required' ? 'تحديث البيانات' : info.installedBytes > 0 ? 'استكمال التحميل' : 'بدء التحميل';
  const modal = document.createElement('div'); modal.id = 'download-modal'; modal.className = 'modal-backdrop';
  modal.innerHTML = `<div class="download-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <div class="modal-icon" aria-hidden="true">↓</div><h2 id="modal-title">تحميل بيانات التسميع</h2>
    <p>${isDownloading ? 'يجري تجهيز الملفات المطلوبة للتسميع.' : 'يجب تحميل البيانات المطلوبة لقسم التسميع قبل البدء.'}</p>
    <div class="modal-facts"><div><span>حجم الملفات</span><strong>${formatBytes(info.missingBytes)}</strong></div>
    <div><span>${isDownloading ? 'الوقت المتبقي' : 'الوقت المتوقع للتحميل'}</span><strong>${formatEta(info.eta)}</strong></div></div>
    <p id="modal-error" class="message"></p>
    ${isDownloading ? '' : `<button class="primary" id="modal-start">${startLabel}</button>`}
    <button class="modal-later" id="modal-close">لاحقًا</button></div>`;
  document.body.append(modal);
  document.getElementById('modal-close').onclick = closeModal;
  modal.onclick = event => { if (event.target === modal) closeModal(); };
  document.getElementById('modal-start')?.addEventListener('click', async () => {
    const start = document.getElementById('modal-start'); start.disabled = true;
    try {
      const capacity = await downloadManager.storageCheck();
      if (!capacity.enough) {
        document.getElementById('modal-title').textContent = 'لا توجد مساحة تخزين كافية';
        document.getElementById('modal-error').textContent = `المساحة المطلوبة: ${formatBytes(capacity.required)} · المساحة المتاحة تقريبًا: ${formatBytes(capacity.available)}`;
        return;
      }
      closeModal();
      await downloadManager.start();
    } catch (error) {
      if (document.getElementById('download-modal')) document.getElementById('modal-error').textContent = error.message;
    }
  });
}
async function setup() {
  if (downloadManager.state !== 'installed') return home();
  homeUnsubscribe?.(); homeUnsubscribe = null;
  root.innerHTML = '<section class="screen loading"><div class="spinner"></div><h1>جاري تجهيز المصحف</h1></section>';
  try { data ||= await loadQuran(); } catch (error) { return errorScreen(error, setup); }
  const options = Object.entries(data.surahs).sort((a,b) => Number(a[0])-Number(b[0]))
    .map(([number, surah]) => `<option value="${number}">${escapeHTML(surah.name)}</option>`).join('');
  root.innerHTML = `<section class="screen setup"><button class="back" id="back-home">رجوع</button><h1>إعداد التسميع</h1>
    <label class="field">السورة<select id="surah">${options}</select></label>
    <div class="range"><label class="field">من آية<select id="from"></select></label><label class="field">إلى آية<select id="to"></select></label></div>
    <div class="spacer"></div><label class="mic-row"><span><strong>تفعيل الميكروفون</strong><small id="mic-note">مطلوب لبدء التسميع</small></span><input class="switch" type="checkbox" id="mic-switch" aria-label="تفعيل الميكروفون"></label>
    <div id="setup-error" class="message" role="alert"></div><button class="primary" id="start" disabled>بدء التسميع</button></section>`;
  const surah = document.getElementById('surah'), from = document.getElementById('from'), to = document.getElementById('to');
  function ayahOptions() {
    const count = data.surahs[surah.value].verses;
    from.innerHTML = Array.from({length: count}, (_,i) => `<option value="${i+1}">${arabic(i+1)}</option>`).join('');
    to.innerHTML = from.innerHTML; to.value = String(count);
  }
  surah.onchange = ayahOptions; ayahOptions();
  from.onchange = () => { if (+to.value < +from.value) to.value = from.value; };
  to.onchange = () => { if (+to.value < +from.value) to.value = from.value; };
  document.getElementById('back-home').onclick = async () => { stream?.getTracks().forEach(t => t.stop()); stream = null; home(); };
  const control = document.getElementById('mic-switch');
  control.onchange = async () => {
    const message = document.getElementById('setup-error'); message.textContent = '';
    if (!control.checked) { stream?.getTracks().forEach(t => t.stop()); stream = null; document.getElementById('start').disabled = true; document.getElementById('mic-note').textContent = 'مطلوب لبدء التسميع'; return; }
    try {
      stream = await requestMicrophone();
      document.getElementById('start').disabled = false;
      document.getElementById('mic-note').textContent = 'الميكروفون جاهز';
      stream.getAudioTracks()[0].onended = () => { document.getElementById('start').disabled = true; control.checked = false; message.textContent = 'انقطع اتصال الميكروفون'; };
    } catch(error) { control.checked = false; message.textContent = error.name === 'NotAllowedError' ? 'يرجى السماح باستخدام الميكروفون من إعدادات المتصفح' : error.message || 'تعذر الوصول إلى الميكروفون'; }
  };
  document.getElementById('start').onclick = () => begin(+surah.value, +from.value, +to.value);
}
function errorScreen(error, retry) {
  root.innerHTML = `<section class="screen loading"><h1>تعذر المتابعة</h1><p>${escapeHTML(error.message || error)}</p><button class="primary" id="retry">إعادة المحاولة</button></section>`;
  document.getElementById('retry').onclick = retry;
}
class Stabilizer {
  constructor(onWord) { this.previous = []; this.emitted = []; this.onWord = onWord; }
  push(text) {
    const current = (text.match(/[\u0621-\u06FF]+/g) || []).filter(word => normalizeWord(word));
    const a = this.previous.map(normalizeWord), b = current.map(normalizeWord);
    let best = {length:0, start:0};
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      let n = 0; while (a[i+n] && a[i+n] === b[j+n]) n++;
      if (n > best.length) best = {length:n, start:j};
    }
    const stable = current.slice(best.start, best.start + best.length);
    const emitted = this.emitted.map(normalizeWord);
    let overlap = 0;
    for (let n = Math.min(emitted.length, stable.length); n > 0; n--) {
      if (emitted.slice(-n).join('|') === stable.slice(0,n).map(normalizeWord).join('|')) { overlap = n; break; }
    }
    if (best.length) {
      for (const word of stable.slice(overlap)) { this.onWord(word); this.emitted.push(word); }
      this.emitted = this.emitted.slice(-24);
    }
    this.previous = current;
  }
}
async function begin(surah, fromAyah, toAyah) {
  if (downloadManager.state !== 'installed') return home();
  if (!stream?.getAudioTracks().some(t => t.readyState === 'live')) return;
  session = {id: crypto.randomUUID(), surah, fromAyah, toAyah};
  sessionStorage.setItem('interrupted', JSON.stringify(session));
  root.innerHTML = '<section class="screen loading"><div class="spinner"></div><h1>جاري تجهيز نظام الاستماع</h1><p id="stage">تحميل نموذج التعرّف</p></section>';
  const words = selectedWords(data.index, surah, fromAyah, toAyah);
  if (!words.length) return errorScreen(Error('لم تُعثر كلمات الآيات المختارة'), setup);
  try {
    const firstPage = words[0].page;
    renderer = new MushafRenderer(document.createElement('div'));
    await renderer.preload(firstPage);
    const stabilizer = new Stabilizer(word => engine?.accept(word));
    provider = new BrowserFastConformerProvider(message => {
      if (message.type === 'stage') { const stage = document.getElementById('stage'); if (stage) stage.textContent = message.label; }
      if (message.type === 'hypothesis') { stabilizer.push(message.text); debugInfo({partial:message.text, latency:message.latency, expected:engine?.expected?.hafs, page:renderer?.page, model:'ready'}); }
      if (message.type === 'level') { if (message.silent) engine?.silence(); if (debug) debugInfo({rms:message.rms, sampleRate:message.sampleRate, expected:engine?.expected?.hafs, page:renderer?.page}); }
      if (message.type === 'recoverable') { if (debug) console.warn(message.message); }
    });
    await provider.init();
    root.innerHTML = `<section class="screen recite"><div class="recite-header"><button id="exit" aria-label="إنهاء التسميع">خروج</button><span id="page-number"></span></div><div class="page-shell"><div id="mushaf" class="mushaf-page" aria-label="صفحة المصحف"></div></div><div class="live-bar"><span class="live-dot" aria-hidden="true"></span><span>الاستماع مباشر</span></div></section>`;
    renderer = new MushafRenderer(document.getElementById('mushaf'), page => document.getElementById('page-number').textContent = `صفحة ${arabic(page)}`);
    engine = new RecitationEngine(words, (word, active) => renderer.update(word, active), page => renderer.show(page, words).catch(error => errorScreen(error, () => renderer.show(page, words))), finish);
    await renderer.show(firstPage, words);
    document.getElementById('exit').onclick = async () => { await cleanup(); sessionStorage.removeItem('interrupted'); home(); };
    if (!stream.getAudioTracks().some(t => t.readyState === 'live')) throw Error('انقطع اتصال الميكروفون أثناء تجهيز النموذج');
    microphone = new Microphone(stream, pcm => provider.push(pcm), async error => { await cleanup(); errorScreen(error, setup); });
    const sampleRate = await microphone.start();
    provider.start();
    debugInfo({sampleRate, model:'ready', expected:engine.expected.hafs, page:firstPage});
  } catch(error) { await cleanup(); errorScreen(error, setup); }
}
async function cleanup() { provider?.stop(); provider = null; await microphone?.stop(); microphone = null; stream?.getTracks().forEach(t => t.stop()); stream = null; }
async function finish() {
  if (report) return;
  report = buildReport(session, engine);
  await cleanup(); sessionStorage.removeItem('interrupted');
  saveReport(report).catch(error => { if (debug) console.warn('تعذر حفظ التقرير في Firebase', error); });
  showReport();
}
function showReport() {
  if (!report) return home();
  const stats = [
    ['إجمالي الكلمات', report.totals.words],['الكلمات الصحيحة', report.totals.correctWords],
    ['الكلمات التي احتاجت إلى تكرار', report.totals.requiredRepetition],['عدد الأخطاء', report.totals.errors],
    ['الكلمات المتجاوزة', report.totals.skipped],
    ['كُشفت بعد ثلاث محاولات', report.totals.revealedAfterThreeErrors],['مرات التكرار', report.totals.repetitions],
    ['التوقف الطويل', report.totals.longPauses],['نسبة الإتمام', `${report.totals.completion}٪`]
  ];
  const verses = report.verses.map(verse => `<article class="verse-card"><h3>آية ${arabic(verse.verseKey.split(':')[1])}</h3>
    <div class="verse-text">${verse.words.map(w => escapeHTML(w.hafs)).join(' ')}</div>
    <div class="mistake-list">${verse.words.flatMap(w => w.errors.map(e => `${escapeHTML(w.hafs)}: ${escapeHTML(e.type)}${e.spoken ? `، سُمعت «${escapeHTML(e.spoken)}»` : ''}`)).join('<br>')}</div></article>`).join('');
  root.innerHTML = `<section class="screen report"><button class="back" id="report-home">الرئيسية</button><h1>تقرير التسميع</h1>
    <div class="summary"><div class="summary-title">${escapeHTML(data.surahs[session.surah].name)} · من آية ${arabic(session.fromAyah)} إلى ${arabic(session.toAyah)}</div>
    <div>مدة التسميع: ${arabic(Math.round(report.durationMs/1000))} ثانية</div><div class="stats">${stats.map(([label,value]) => `<div class="stat"><b>${escapeHTML(value)}</b><span>${label}</span></div>`).join('')}</div></div>
    <h2>تفصيل الآيات</h2>${verses}</section>`;
  document.getElementById('report-home').onclick = () => { report = null; home(); };
}
home();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
downloadManager.init();

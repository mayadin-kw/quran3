import {loadQuran, selectedWords} from './quran-data.js';
import {MushafRenderer} from './mushaf-renderer.js';
import {requestMicrophone, Microphone} from './microphone.js';
import {BrowserFastConformerProvider, BrowserStreamingProvider} from './asr-engine.js';
import {RecitationEngine} from './recitation-engine.js';
import {buildReport} from './report-engine.js';
import {saveReport} from './firebase.js';
import {downloadManager, formatBytes, formatEta} from './download-manager.js';
import {TranscriptGate} from './transcript-gate.js';
import {MicrophoneCalibration} from './calibration.js';

const root = document.getElementById('app');
const debug = new URLSearchParams(location.search).has('debug');
const debugState = {};
let data, stream, microphone, provider, engine, renderer, session, report;
let calibration, calibrationData, transcriptGate, mode = 'idle';
let configuredVad = null;
let providerChoice = 'browser';
let homeUnsubscribe;
let modalUnsubscribe;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arabic = value => new Intl.NumberFormat('ar').format(value);
function debugInfo(values) { if (!debug) return; Object.assign(debugState, values); let node = document.querySelector('.debug'); if (!node) { node = document.createElement('pre'); node.className = 'debug'; document.body.append(node); } node.textContent = JSON.stringify(debugState, null, 2); }
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
    <label class="field">طريقة الاستماع<select id="asr-provider">
      <option value="browser">مباشر عبر خدمة المتصفح</option>
      <option value="local">محلي — قد يتأخر ظهور الكلمات</option></select></label>
    <p id="asr-disclosure">الاستماع المباشر قد يرسل صوتك إلى خدمة التعرف التابعة للمتصفح ويتطلب اتصالًا بالإنترنت. بالمتابعة تختار استخدام هذه الخدمة.</p>
    <div class="spacer"></div><div id="setup-error" class="message" role="alert"></div><button class="primary" id="next">التالي</button></section>`;
  const providerSelect = document.getElementById('asr-provider');
  providerSelect.onchange = () => {
    document.getElementById('asr-disclosure').textContent = providerSelect.value === 'browser'
      ? 'الاستماع المباشر قد يرسل صوتك إلى خدمة التعرف التابعة للمتصفح ويتطلب اتصالًا بالإنترنت. بالمتابعة تختار استخدام هذه الخدمة.'
      : 'يبقى الصوت على جهازك. النموذج المحلي الحالي لا يضمن التتبع المباشر منخفض التأخير.';
  };
  const surah = document.getElementById('surah'), from = document.getElementById('from'), to = document.getElementById('to');
  function ayahOptions() {
    const count = data.surahs[surah.value].verses;
    from.innerHTML = Array.from({length: count}, (_,i) => `<option value="${i+1}">${arabic(i+1)}</option>`).join('');
    to.innerHTML = from.innerHTML; to.value = String(count);
  }
  surah.onchange = ayahOptions; ayahOptions();
  from.onchange = () => { if (+to.value < +from.value) to.value = from.value; };
  to.onchange = () => { if (+to.value < +from.value) to.value = from.value; };
  document.getElementById('back-home').onclick = home;
  document.getElementById('next').onclick = async () => {
    providerChoice = providerSelect.value;
    if (providerChoice === 'browser' && !BrowserStreamingProvider.supported) {
      document.getElementById('setup-error').textContent = 'هذا المتصفح لا يدعم خدمة الاستماع المباشر. استخدم متصفحًا متوافقًا أو اختر الاستماع المحلي.'; return;
    }
    const button = document.getElementById('next'); button.disabled = true;
    try { await openCalibration(+surah.value, +from.value, +to.value); }
    catch (error) {
      if (error.name === 'AbortError') return;
      await cleanup();
      errorScreen(error.name === 'NotAllowedError' ? Error('يرجى السماح باستخدام الميكروفون') : error, setup);
    }
  };
}
function errorScreen(error, retry) {
  root.innerHTML = `<section class="screen loading"><h1>تعذر المتابعة</h1><p>${escapeHTML(error.message || error)}</p><button class="primary" id="retry">إعادة المحاولة</button></section>`;
  document.getElementById('retry').onclick = retry;
}
function updateCalibrationUI(value) {
  const fill = document.getElementById('mic-meter-fill');
  const marker = document.getElementById('mic-meter-marker');
  const message = document.getElementById('calibration-message');
  const check = document.getElementById('calibration-check');
  const button = document.getElementById('calibration-start');
  if (!fill) return;
  fill.style.width = `${value.meterPercent}%`;
  marker.style.left = `${value.thresholdPercent}%`;
  document.getElementById('required-label').style.left = `${value.thresholdPercent}%`;
  document.querySelector('.mic-meter')?.setAttribute('aria-valuenow', String(Math.round(value.meterPercent)));
  if (message.textContent !== value.message) message.textContent = value.message;
  check.hidden = !value.passed;
  button.disabled = !value.passed;
  if (value.noiseReady && provider?.ready &&
      (configuredVad === null || Math.abs(value.recommendedVadThreshold-configuredVad)/configuredVad > .15)) {
    configuredVad = value.recommendedVadThreshold;
    provider.configure({vadThreshold:configuredVad});
  }
}
function handleAsrMessage(message) {
  if (message.type === 'stage') {
    const stage = document.getElementById('stage'); if (stage) stage.textContent = message.label;
  } else if (message.type === 'hypothesis') {
    if (mode === 'calibration' && message.phase === 'final') {
      updateCalibrationUI(calibration.hear(message.text, message));
    } else if (mode === 'recitation') {
      transcriptGate?.push(message);
    }
    debugInfo({asrPhase:message.phase, partial:message.text, latency:message.latency,
      acousticScore:message.acousticScore, expected:engine?.expected?.hafs,
      currentRequiredWordId:engine?.currentRequiredWordId, currentAyah:engine?.currentAyah});
  } else if (message.type === 'level') {
    if (mode === 'recitation' && message.vadState === 'speech') engine?.heardSpeech();
    if (mode === 'recitation' && message.vadState === 'silence') engine?.silence();
    debugInfo({rms:message.rms, vadState:message.vadState, sampleRate:message.sampleRate});
  } else if (message.type === 'error') {
    cleanup().then(() => errorScreen(Error(message.message), setup));
  } else if (message.type === 'recoverable' && debug) console.warn(message.message);
}
async function openCalibration(surah, fromAyah, toAyah) {
  mode = 'calibration'; calibrationData = null; configuredVad = null;
  root.innerHTML = `<section class="screen calibration">
    <button class="back" id="calibration-back">رجوع</button>
    <div class="calibration-content"><h1>اختبار الميكروفون</h1>
      <p>اقرأ العبارة التالية بصوتك الطبيعي</p>
      <div class="calibration-basmala">بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ</div>
      <div class="mic-meter" role="meter" aria-label="مستوى صوت الميكروفون" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
        <div class="mic-meter-track"><div id="mic-meter-fill" class="mic-meter-fill"></div>
          <div id="mic-meter-marker" class="mic-meter-marker"></div></div>
        <div class="mic-meter-labels"><span>منخفض</span><span id="required-label">الحد المطلوب</span><span>قوي</span></div>
      </div>
      <div id="calibration-check" class="calibration-check" hidden>✓</div>
      <p id="calibration-message" class="calibration-message" role="status">انتظر قليلًا لقياس هدوء المكان</p>
      <p id="stage" class="calibration-stage">جاري تجهيز التعرّف الصوتي…</p>
      <button class="primary" id="calibration-start" disabled>بدء التسميع</button>
    </div></section>`;
  document.getElementById('calibration-back').onclick = async () => { await cleanup(); setup(); };
  document.getElementById('calibration-start').onclick = () => begin(surah, fromAyah, toAyah);
  stream = await requestMicrophone();
  calibration = new MicrophoneCalibration();
  microphone = new Microphone(stream, pcm => {
    if (mode === 'calibration') updateCalibrationUI(calibration.observe(pcm));
    if (mode === 'calibration' || mode === 'recitation') provider?.push(pcm);
  }, async error => { await cleanup(); errorScreen(error, setup); });
  calibration.deviceSampleRate = await microphone.start();
  provider = providerChoice === 'browser' ? new BrowserStreamingProvider(handleAsrMessage) : new BrowserFastConformerProvider(handleAsrMessage);
  await provider.init();
  provider.configure({vadThreshold:calibration.recommendedVadThreshold});
  configuredVad = calibration.recommendedVadThreshold;
  provider.start();
  const stage = document.getElementById('stage'); if (stage) stage.textContent = 'استمع الآن إلى البسملة';
  updateCalibrationUI(calibration.snapshot());
}
function diagnoseCenter() {
  if (!debug) return;
  requestAnimationFrame(() => {
    const stage = document.querySelector('.page-shell');
    const frame = document.querySelector('.mushaf-frame rect');
    if (!stage || !frame) return;
    const viewportCenterX = stage.getBoundingClientRect().left + stage.getBoundingClientRect().width/2;
    const pageFrameCenterX = frame.getBoundingClientRect().left + frame.getBoundingClientRect().width/2;
    const offsetX = pageFrameCenterX-viewportCenterX;
    debugInfo({viewportCenterX, pageFrameCenterX, offsetX, page:renderer?.page});
    if (Math.abs(offsetX)>2) console.warn('Mushaf frame is off-center', offsetX);
  });
}
async function begin(surah, fromAyah, toAyah) {
  if (!calibration?.passed || !provider?.ready || !stream?.getAudioTracks().some(t => t.readyState === 'live')) return;
  calibrationData = calibration.snapshot();
  mode = 'preparing'; report = null;
  session = {id:crypto.randomUUID(), surah, fromAyah, toAyah, calibration:{
    noiseFloorDb:calibrationData.noiseFloorDb, normalSpeechRms:calibrationData.speechRms,
    peakSpeechRms:calibrationData.peakRms, recommendedVadThreshold:calibrationData.recommendedVadThreshold,
    deviceSampleRate:calibrationData.deviceSampleRate}};
  sessionStorage.setItem('interrupted', JSON.stringify(session));
  root.innerHTML = '<section class="screen loading"><div class="spinner"></div><h1>جاري تجهيز المصحف</h1></section>';
  const words = selectedWords(data.index, surah, fromAyah, toAyah);
  if (!words.length) return errorScreen(Error('لم تُعثر كلمات الآيات المختارة'), setup);
  try {
    const firstPage = words[0].page;
    renderer = new MushafRenderer(document.createElement('div'));
    await renderer.preload(firstPage);
    root.innerHTML = `<section class="screen recite"><div class="recite-header"><button id="exit" aria-label="إنهاء التسميع">خروج</button><button id="finish-recitation" hidden>النتيجة</button><span id="page-number"></span></div><div class="page-shell"><div id="mushaf" class="mushaf-page" aria-label="صفحة المصحف"></div></div><div class="live-bar"><span class="live-dot" aria-hidden="true"></span><span id="live-status">${providerChoice === 'browser' ? 'الاستماع مباشر' : 'الاستماع محلي — قد يتأخر التتبع'}</span></div></section>`;
    renderer = new MushafRenderer(document.getElementById('mushaf'), page => {
      const number = document.getElementById('page-number');
      if (number) number.textContent = `صفحة ${arabic(page)}`;
      diagnoseCenter();
    });
    engine = new RecitationEngine(words, (word, active) => {
      renderer.update(word, active);
      if (word.state === 'correct') { const status = document.getElementById('live-status'); if (status) status.textContent = (providerChoice === 'browser' ? 'الاستماع مباشر' : 'الاستماع محلي — قد يتأخر التتبع'); }
    }, page => renderer.show(page, words).catch(error => errorScreen(error, () => renderer.show(page, words))),
    () => { document.getElementById('finish-recitation').hidden = false; }, () => { const status = document.getElementById('live-status'); if (status) status.textContent = 'لم يتضح الصوت، أعد الكلمة الحالية'; });
    transcriptGate = new TranscriptGate((tokens, meta) => {
      const consumed = engine?.acceptCommitted(tokens, meta);
      const uiUpdatedAt = Date.now();
      debugInfo({audioChunkReceivedAt:meta.audioChunkReceivedAt,
        asrInferenceStartedAt:meta.asrInferenceStartedAt, partialHypothesisAt:meta.partialHypothesisAt,
        wordStabilizedAt:meta.wordStabilizedAt, uiUpdatedAt,
        audioToPartialMs:meta.audioChunkReceivedAt == null ? null : meta.partialHypothesisAt-meta.audioChunkReceivedAt,
        partialToUiMs:uiUpdatedAt-meta.partialHypothesisAt,
        totalPipelineMs:meta.audioChunkReceivedAt == null ? null : uiUpdatedAt-meta.audioChunkReceivedAt,
        currentSpokenWordId:engine?.currentSpokenWordId, primaryCursor:engine?.primaryCursor,
        highlightCursor:engine?.highlightCursor});
      return consumed;
    }, (stable, message) => {
      const history = [...(debugState.partialStream || []),
        {at:Date.now(), RAW:message.text, STABLE:stable.join(' '),
          EXPECTED:engine?.expected?.hafs, CURRENT_WORD:engine?.currentSpokenWordId}].slice(-20);
      debugInfo({rawPartialTranscript:message.text, stabilizedPartialTranscript:stable.join(' '),
        partialStream:history, backlogMs:message.backlogMs, encoderMode:message.encoderMode});
    });
    await renderer.show(firstPage, words);
    document.getElementById('finish-recitation').onclick = finish;
    document.getElementById('exit').onclick = async () => { await cleanup(); sessionStorage.removeItem('interrupted'); home(); };
    provider.reset(); provider.configure({vadThreshold:calibrationData.recommendedVadThreshold});
    calibration = null; mode = 'recitation';
    debugInfo({model:'ready', expected:engine.expected.hafs, page:firstPage,
      noiseFloorDb:calibrationData.noiseFloorDb, vadThreshold:calibrationData.recommendedVadThreshold});
  } catch(error) { await cleanup(); errorScreen(error, setup); }
}
async function cleanup() {
  mode = 'idle'; provider?.stop(); provider = null; transcriptGate = null;
  await microphone?.stop(); microphone = null;
  stream?.getTracks().forEach(track => track.stop()); stream = null;
  calibration = null;
}
async function finish() {
  if (report) return;
  report = buildReport(session, engine);
  debugInfo({reportErrors:report.debugErrors});
  await cleanup(); sessionStorage.removeItem('interrupted');
  saveReport(report).catch(error => { if (debug) console.warn('تعذر حفظ التقرير في Firebase', error); });
  showReport();
}
function showReport() {
  if (!report) return home();
  const stats = [
    ['إجمالي الكلمات', report.totals.words],['الكلمات الصحيحة', report.totals.correctWords],
    ['صحيحة من أول محاولة', report.totals.correctFirstAttempt],
    ['الكلمات التي احتاجت إلى تكرار', report.totals.requiredRepetition],['الأخطاء المؤكدة', report.totals.errors],
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

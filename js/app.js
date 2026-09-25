import {loadQuran, selectedWords} from './quran-data.js';
import {MushafRenderer} from './mushaf-renderer.js';
import {requestMicrophone, Microphone} from './microphone.js';
import {AutomaticASRProvider} from './asr-selection.js';
import {RecitationEngine} from './recitation-engine.js';
import {buildReport} from './report-engine.js';
import {saveReport} from './firebase.js';
import {downloadManager, formatBytes, formatEta} from './download-manager.js';
import {TranscriptGate} from './transcript-gate.js';
import {MicrophoneCalibration} from './calibration.js';
import {PronunciationProvider} from './pronunciation-provider.js';

const root = document.getElementById('app');
const debug = new URLSearchParams(location.search).has('debug');
const debugState = {};
const latencySamples = [];
let data, stream, microphone, provider, pronunciationProvider, engine, renderer, session, report;
let calibration, calibrationData, transcriptGate, mode = 'idle';
let configuredVad = null;
let homeUnsubscribe;
let modalUnsubscribe;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arabic = value => new Intl.NumberFormat('ar').format(value);
function debugInfo(values) { if (!debug) return; Object.assign(debugState, values); let node = document.querySelector('.debug'); if (!node) { node = document.createElement('pre'); node.className = 'debug'; document.body.append(node); } node.textContent = JSON.stringify(debugState, null, 2); }
function debugLatency(kind, values) {
  if (!debug) return;
  latencySamples.push({kind, ...values}); if (latencySamples.length > 40) latencySamples.shift();
  const mean = field => {
    const found = latencySamples.map(sample => sample[field]).filter(Number.isFinite);
    return found.length ? Math.round(found.reduce((a,b) => a+b,0)/found.length) : null;
  };
  debugInfo({latencyLatest:{kind,...values}, latencyAveragesMs:{
    audioToPartial:mean('audioToPartialMs'), partialToHighlight:mean('partialToHighlightMs'),
    totalWordDisplayProxy:mean('totalWordDisplayProxyMs'), audioBuffering:mean('audioBufferingMs'),
    featureExtraction:mean('featureExtractionMs'), asrInference:mean('asrInferenceMs'),
    stabilization:mean('stabilizationMs'), alignment:mean('alignmentMs'),
    svgRender:mean('svgRenderMs')}, latencySamples:latencySamples.length});
}
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
    <label class="mic-row" for="mic-enabled"><span><strong>تفعيل الميكروفون</strong><small id="mic-state">غير مفعّل</small></span>
      <input class="switch" id="mic-enabled" type="checkbox" role="switch" aria-label="تفعيل الميكروفون"></label>
    <div class="spacer"></div><div id="setup-error" class="message" role="alert"></div><button class="primary" id="next" disabled>التالي</button></section>`;
  const micSwitch = document.getElementById('mic-enabled'), next = document.getElementById('next');
  micSwitch.onchange = async () => {
    next.disabled = true;
    const state = document.getElementById('mic-state');
    const error = document.getElementById('setup-error'); error.textContent = '';
    if (!micSwitch.checked) {
      stream?.getTracks().forEach(track => track.stop()); stream = null;
      state.textContent = 'غير مفعّل'; return;
    }
    micSwitch.disabled = true; state.textContent = 'جاري التفعيل…';
    try {
      stream = await requestMicrophone();
      if (!micSwitch.isConnected || !micSwitch.checked) {
        stream.getTracks().forEach(track => track.stop()); stream = null; return;
      }
      const track = stream.getAudioTracks()[0];
      track.onended = () => {
        if (!micSwitch.isConnected) return;
        micSwitch.checked = false; next.disabled = true;
        state.textContent = 'غير مفعّل'; stream = null;
      };
      state.textContent = 'الميكروفون مفعّل'; next.disabled = false;
    } catch (reason) {
      micSwitch.checked = false; state.textContent = 'غير مفعّل';
      error.textContent = reason.name === 'NotAllowedError' ? 'يرجى السماح باستخدام الميكروفون' : reason.message;
    } finally { if (micSwitch.isConnected) micSwitch.disabled = false; }
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
  document.getElementById('back-home').onclick = () => {
    stream?.getTracks().forEach(track => track.stop()); stream = null; home();
  };
  document.getElementById('next').onclick = async () => {
    if (!micSwitch.checked || !stream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled)) return;
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
  button.disabled = !value.passed || !provider?.ready || !pronunciationProvider?.ready;
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
    message.partialTranscriptReceivedAt = Date.now();
    if (mode === 'calibration' && message.phase === 'final') {
      updateCalibrationUI(calibration.hear(message.text, message));
    } else if (mode === 'recitation') {
      transcriptGate?.push(message);
    }
    debugInfo({asrPhase:message.phase, partial:message.text, latency:message.latency,
      acousticScore:message.acousticScore, expected:engine?.expected?.hafs,
      currentRequiredWordId:engine?.currentRequiredWordId, currentAyah:engine?.currentAyah,
      providerLatencyStats:provider?.getLatencyStats?.()});
  } else if (message.type === 'level') {
    if (mode === 'recitation' && message.vadState === 'speech') engine?.heardSpeech();
    if (mode === 'recitation' && message.vadState === 'silence') engine?.silence();
    debugInfo({rms:message.rms, vadState:message.vadState, sampleRate:message.sampleRate});
  } else if (message.type === 'provider-selected') {
    debugInfo({selectedASRProvider:message.selected, providerLatencyStats:message.latencyStats});
    const stage = document.getElementById('stage');
    if (stage) stage.textContent = 'استمع الآن إلى البسملة';
    const status = document.getElementById('live-status');
    if (status) status.textContent = 'الاستماع مباشر';
  } else if (message.type === 'provider-recovering') {
    const stage = document.getElementById('stage');
    if (stage) stage.textContent = 'جاري تجهيز الاستماع…';
    const status = document.getElementById('live-status');
    if (status) status.textContent = 'جاري تجهيز الاستماع…';
  } else if (message.type === 'provider-failed') {
    debugInfo({failedASRProvider:message.selected, providerFailure:message.reason});
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
  if (!stream?.getAudioTracks().some(track => track.readyState === 'live' && track.enabled))
    throw Error('يرجى تفعيل الميكروفون أولًا');
  calibration = new MicrophoneCalibration();
  microphone = new Microphone(stream, (pcm, timing) => {
    if (mode === 'calibration') updateCalibrationUI(calibration.observe(pcm));
    if (mode === 'recitation') pronunciationProvider?.push(pcm,timing.audioFrameReceivedAt ?? Date.now());
    if (mode === 'calibration' || mode === 'recitation') provider?.push(pcm, timing);
  }, async error => { await cleanup(); errorScreen(error, setup); });
  calibration.deviceSampleRate = await microphone.start();
  provider = new AutomaticASRProvider(handleAsrMessage, {
    browserOnline:navigator.onLine !== false,
    localInstalled:downloadManager.state === 'installed',
    deviceMemory:navigator.deviceMemory || null,
    cores:navigator.hardwareConcurrency || null,
    wordTimingRequired:true
  });
  pronunciationProvider = new PronunciationProvider(stage =>
    debugInfo({pronunciationModelStage:stage}));
  provider.setCalibrationMode(true);
  await Promise.all([provider.init(),pronunciationProvider.init()]);
  if (mode !== 'calibration' || !provider?.ready) return;
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
  if (!calibration?.passed || !provider?.ready || !pronunciationProvider?.ready ||
      !stream?.getAudioTracks().some(t => t.readyState === 'live')) return;
  calibrationData = calibration.snapshot();
  latencySamples.length = 0;
  mode = 'preparing'; report = null;
  session = {id:crypto.randomUUID(), surah, fromAyah, toAyah, calibration:{
    noiseFloorDb:calibrationData.noiseFloorDb, normalSpeechRms:calibrationData.speechRms,
    peakSpeechRms:calibrationData.peakRms, recommendedVadThreshold:calibrationData.recommendedVadThreshold,
    deviceSampleRate:calibrationData.deviceSampleRate}};
  sessionStorage.setItem('interrupted', JSON.stringify(session));
  root.innerHTML = '<section class="screen loading"><div class="spinner"></div><h1>جاري تجهيز المصحف</h1></section>';
  const words = selectedWords(data.index, surah, fromAyah, toAyah, data.pronunciationMap);
  if (!words.length) return errorScreen(Error('لم تُعثر كلمات الآيات المختارة'), setup);
  try {
    const firstPage = words[0].page;
    renderer = new MushafRenderer(document.createElement('div'));
    await renderer.preload(firstPage);
    root.innerHTML = `<section class="screen recite"><div class="recite-header"><button id="exit" aria-label="إنهاء التسميع">خروج</button><button id="finish-recitation" hidden>النتيجة</button><span id="page-number"></span></div><div class="page-shell"><div id="mushaf" class="mushaf-page" aria-label="صفحة المصحف"></div></div><div class="live-bar"><span class="live-dot" aria-hidden="true"></span><span id="live-status">الاستماع مباشر</span></div></section>`;
    renderer = new MushafRenderer(document.getElementById('mushaf'), page => {
      const number = document.getElementById('page-number');
      if (number) number.textContent = `صفحة ${arabic(page)}`;
      diagnoseCenter();
    });
    let svgWordUpdatedAt = null, svgRenderMs = null;
    const visuallyShown = new Set();
    const lastWordTiming = new Map();
    engine = new RecitationEngine(words, (word, active) => {
      const renderStart = performance.now();
      renderer.update(word, active);
      svgRenderMs = performance.now() - renderStart; svgWordUpdatedAt = Date.now();
      if (word.state === 'correct' || word.state === 'lexical-only') {
        const status = document.getElementById('live-status');
        if (status) status.textContent = word.state === 'correct' ? 'الاستماع مباشر' : 'تمت مطابقة الكلمة؛ النطق غير متحقق منه';
      }
    }, page => renderer.show(page, words).catch(error => errorScreen(error, () => renderer.show(page, words))),
    () => { document.getElementById('finish-recitation').hidden = false; }, () => { const status = document.getElementById('live-status'); if (status) status.textContent = 'لم يتضح الصوت، أعد الكلمة الحالية'; },
    (word, visible) => {
      const renderStart = performance.now();
      if (visible) renderer.previewWord(word.key);
      else renderer.clearPreviewWord(word.key);
      svgRenderMs = performance.now() - renderStart; svgWordUpdatedAt = Date.now();
    });
    transcriptGate = new TranscriptGate(async (tokens, meta) => {
      const alignmentStartedAt = Date.now();
      const beforeIds = new Set(engine.committedQuranWords);
      const expectedBefore = engine.expected;
      const positionBefore = engine.position;
      let pronunciationEvidence = null;
      if (expectedBefore && engine.matchingSpan(tokens[0]) &&
          expectedBefore.pronunciation?.phonemeSequence &&
          expectedBefore.pronunciation.acousticSpan === engine.matchingSpan(tokens[0])) {
        const previous = lastWordTiming.get(meta.segmentId);
        const context = previous?.tokenOffset === meta.tokenOffset-1 &&
          previous?.position === positionBefore-1 ? previous : null;
        try { pronunciationEvidence = await pronunciationProvider.verify(expectedBefore,meta,context); }
        catch (error) { pronunciationEvidence={source:'quran-phoneme-ctc',
          expected:expectedBefore.pronunciation.phonemeSequence,decision:'uncertain',
          reason:error.message,phonemeConfidence:0}; }
      }
      const consumed = engine?.acceptCommitted(tokens, {...meta,pronunciationEvidence});
      if (engine.position > positionBefore && Number.isFinite(meta.wordStartAt))
        lastWordTiming.set(meta.segmentId,{tokenOffset:meta.tokenOffset,
          position:engine.position-1,startAt:meta.wordStartAt,
          phonemes:expectedBefore?.pronunciation?.phonemeSequence});
      if (debug) debugInfo({lexicalExpected:expectedBefore?.pronunciation?.lexicalNormalized,
        lexicalASR:tokens[0], lexicalMatch:tokens[0] === expectedBefore?.pronunciation?.lexicalNormalized,
        expectedPronunciation:expectedBefore?.pronunciation?.pronunciationRepresentation,
        harakahDecision:pronunciationEvidence?.decision || 'uncertain',
        harakahScore:pronunciationEvidence?.vowels?.at(-1)?.expectedProbability ?? null,
        finalVowelScore:pronunciationEvidence?.finalVowelScore ?? null,
        phonemeConfidence:pronunciationEvidence?.phonemeConfidence ?? null,
        pronunciationScore:pronunciationEvidence?.pronunciationScore ?? null});
      const quranAlignmentCompletedAt = Date.now();
      debugLatency('commit', {
        audioFrameReceivedAt:meta.audioFrameReceivedAt ?? null,
        audioChunkReadyAt:meta.audioChunkReadyAt ?? null,
        featureExtractionStartedAt:meta.featureExtractionStartedAt ?? null,
        featureExtractionEndedAt:meta.featureExtractionEndedAt ?? null,
        asrInferenceStartedAt:meta.asrInferenceStartedAt ?? null,
        asrInferenceEndedAt:meta.asrInferenceEndedAt ?? null,
        partialTranscriptReceivedAt:meta.partialTranscriptReceivedAt ?? null,
        quranAlignmentCompletedAt, svgWordUpdatedAt,
        audioBufferingMs:meta.audioBufferingMs ?? null,
        asrInferenceMs:meta.asrInferenceEndedAt == null ? null : meta.asrInferenceEndedAt-meta.asrInferenceStartedAt,
        stabilizationMs:meta.wordStabilizedAt-(meta.firstPartialTranscriptReceivedAt ?? meta.wordStabilizedAt),
        alignmentMs:quranAlignmentCompletedAt-alignmentStartedAt, svgRenderMs,
        currentSpokenWordId:engine?.currentSpokenWordId,
        primaryCursor:engine?.primaryCursor, highlightCursor:engine?.highlightCursor});
      for (const id of engine.committedQuranWords) {
        if (beforeIds.has(id) || visuallyShown.has(id)) continue;
        visuallyShown.add(id);
        debugLatency('highlight', {
          wordId:id, audioFrameReceivedAt:meta.audioFrameReceivedAt ?? null,
          audioChunkReadyAt:meta.audioChunkReadyAt ?? null,
          featureExtractionStartedAt:meta.featureExtractionStartedAt ?? null,
          featureExtractionEndedAt:meta.featureExtractionEndedAt ?? null,
          asrInferenceStartedAt:meta.asrInferenceStartedAt ?? null,
          asrInferenceEndedAt:meta.asrInferenceEndedAt ?? null,
          partialTranscriptReceivedAt:meta.partialTranscriptReceivedAt ?? null,
          quranAlignmentCompletedAt, svgWordUpdatedAt,
          audioBufferingMs:meta.audioBufferingMs ?? null,
          featureExtractionMs:meta.featureExtractionEndedAt == null ? null : meta.featureExtractionEndedAt-meta.featureExtractionStartedAt,
          asrInferenceMs:meta.asrInferenceEndedAt == null ? null : meta.asrInferenceEndedAt-meta.asrInferenceStartedAt,
          audioToPartialMs:meta.audioFrameReceivedAt == null ? null :
            (meta.audioBufferingMs || 0)+meta.partialTranscriptReceivedAt-meta.audioFrameReceivedAt,
          partialToHighlightMs:svgWordUpdatedAt-meta.partialTranscriptReceivedAt,
          alignmentMs:quranAlignmentCompletedAt-alignmentStartedAt, svgRenderMs,
          totalWordDisplayProxyMs:meta.audioFrameReceivedAt == null ? null :
            (meta.audioBufferingMs || 0)+svgWordUpdatedAt-meta.audioFrameReceivedAt,
          currentSpokenWordId:engine.currentSpokenWordId});
      }
      return consumed;
    }, (stable, message) => {
      const history = [...(debugState.partialStream || []),
        {at:Date.now(), RAW:message.text, STABLE:stable.join(' '),
          EXPECTED:engine?.expected?.hafs, CURRENT_WORD:engine?.currentSpokenWordId}].slice(-20);
      debugInfo({rawPartialTranscript:message.text, stabilizedPartialTranscript:stable.join(' '),
        partialStream:history, backlogMs:message.backlogMs, encoderMode:message.encoderMode});
    }, (tokens, message) => {
      if (!tokens.length) return;
      const before = engine?.previewIndex;
      const alignmentStartedAt = Date.now();
      const preview = engine?.previewPartial(tokens, message);
      const quranAlignmentCompletedAt = Date.now();
      if (!preview || before === engine.previewIndex || visuallyShown.has(preview.key)) return;
      visuallyShown.add(preview.key);
      debugLatency('highlight', {
        wordId:preview.key, audioFrameReceivedAt:message.audioFrameReceivedAt ?? null,
        audioChunkReadyAt:message.audioChunkReadyAt ?? null,
        featureExtractionStartedAt:message.featureExtractionStartedAt ?? null,
        featureExtractionEndedAt:message.featureExtractionEndedAt ?? null,
        asrInferenceStartedAt:message.asrInferenceStartedAt ?? null,
        asrInferenceEndedAt:message.asrInferenceEndedAt ?? null,
        partialTranscriptReceivedAt:message.partialTranscriptReceivedAt,
        quranAlignmentCompletedAt, svgWordUpdatedAt,
        audioBufferingMs:message.audioBufferingMs ?? null,
        featureExtractionMs:message.featureExtractionEndedAt == null ? null : message.featureExtractionEndedAt-message.featureExtractionStartedAt,
        asrInferenceMs:message.asrInferenceEndedAt == null ? null : message.asrInferenceEndedAt-message.asrInferenceStartedAt,
        audioToPartialMs:message.audioFrameReceivedAt == null ? null :
          (message.audioBufferingMs || 0)+message.partialTranscriptReceivedAt-message.audioFrameReceivedAt,
        partialToHighlightMs:svgWordUpdatedAt-message.partialTranscriptReceivedAt,
        alignmentMs:quranAlignmentCompletedAt-alignmentStartedAt, svgRenderMs,
        totalWordDisplayProxyMs:message.audioFrameReceivedAt == null ? null :
          (message.audioBufferingMs || 0)+svgWordUpdatedAt-message.audioFrameReceivedAt,
        currentSpokenWordId:engine.currentSpokenWordId});
    });
    await renderer.show(firstPage, words);
    document.getElementById('finish-recitation').onclick = finish;
    document.getElementById('exit').onclick = async () => { await cleanup(); sessionStorage.removeItem('interrupted'); home(); };
    provider.setCalibrationMode(false);
    provider.reset(); provider.configure({vadThreshold:calibrationData.recommendedVadThreshold});
    pronunciationProvider.clear();
    calibration = null; mode = 'recitation';
    debugInfo({model:'ready', expected:engine.expected.hafs, page:firstPage,
      noiseFloorDb:calibrationData.noiseFloorDb, vadThreshold:calibrationData.recommendedVadThreshold});
  } catch(error) { await cleanup(); errorScreen(error, setup); }
}
async function cleanup() {
  mode = 'idle'; provider?.stop(); provider = null;
  pronunciationProvider?.stop();pronunciationProvider=null;transcriptGate = null;
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
    ['إجمالي الكلمات', report.totals.words],['الكلمات الصحيحة بعد فحص النطق', report.totals.correctWords],
    ['مطابقة كلمة دون تحقق النطق', report.totals.pronunciationUnverified],
    ['صحيحة من أول محاولة', report.totals.correctFirstAttempt],
    ['الكلمات التي احتاجت إلى تكرار', report.totals.requiredRepetition],['الأخطاء المؤكدة', report.totals.errors],
    ['أخطاء الحركة', report.totals.harakahErrors],['الكلمات المتجاوزة', report.totals.skipped],
    ['كُشفت بعد ثلاث محاولات', report.totals.revealedAfterThreeErrors],['مرات التكرار', report.totals.repetitions],
    ['التوقف الطويل', report.totals.longPauses],['نسبة الإتمام', `${report.totals.completion}٪`]
  ];
  const verses = report.verses.map(verse => `<article class="verse-card"><h3>آية ${arabic(verse.verseKey.split(':')[1])}</h3>
    <div class="verse-text">${verse.words.map(w => escapeHTML(w.hafs)).join(' ')}</div>
    <div class="mistake-list">${verse.words.flatMap(w => w.errors.map(e => `${escapeHTML(w.hafs)}: ${escapeHTML(e.type)}${e.spoken ? `، سُمعت «${escapeHTML(e.spoken)}»` : ''}`)).join('<br>')}</div></article>`).join('');
  root.innerHTML = `<section class="screen report"><button class="back" id="report-home">الرئيسية</button><h1>تقرير التسميع</h1>
    <div class="summary"><div class="summary-title">${escapeHTML(data.surahs[session.surah].name)} · من آية ${arabic(session.fromAyah)} إلى ${arabic(session.toAyah)}</div>
    <div>مدة التسميع: ${arabic(Math.round(report.durationMs/1000))} ثانية</div>
    <p>اللون الذهبي يعني مطابقة الكلمة نصيًا دون تحقق صوتي من الحركات، ولا تُحتسب ضمن الكلمات الصحيحة بعد فحص النطق.</p>
    <div class="stats">${stats.map(([label,value]) => `<div class="stat"><b>${escapeHTML(value)}</b><span>${label}</span></div>`).join('')}</div></div>
    <h2>تفصيل الآيات</h2>${verses}</section>`;
  document.getElementById('report-home').onclick = () => { report = null; home(); };
}
home();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
downloadManager.init();

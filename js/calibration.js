import {normalizeWord} from './quran-data.js';

const TARGET = normalizeWord('بسماللهالرحمنالرحيم');
const db = rms => 20 * Math.log10(Math.max(rms, 1e-7));
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
function editDistance(a, b) {
  const row = Array.from({length:b.length+1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]; row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j];
      row[j] = Math.min(row[j]+1, row[j-1]+1, previous+(a[i-1] === b[j-1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length];
}
export function recognizesBasmala(text) {
  const normalized = normalizeWord(text);
  if (!normalized || normalized.length < TARGET.length-3) return false;
  if (normalized.includes(TARGET)) return true;
  // Permit a small orthographic ASR difference, not an unrelated loud sound.
  return editDistance(normalized, TARGET) <= 2;
}

export class MicrophoneCalibration {
  constructor(deviceSampleRate = 16000) {
    this.deviceSampleRate = deviceSampleRate;
    this.noiseSamples = []; this.noiseFloorRms = .001;
    this.smoothedRms = 0; this.peakRms = 0; this.peakSignal = 0;
    this.speechMs = 0; this.speechSum = 0; this.speechBlocks = 0;
    this.strongBlocks = [];
    this.recognized = false; this.lastTranscript = ''; this.beganAt = Date.now();
  }
  get noiseReady() { return this.noiseSamples.length >= 8; }
  get threshold() { return clamp(Math.max(.004, this.noiseFloorRms*3.5), .004, .04); }
  get levelOk() { return this.speechMs >= 320; }
  get clipped() { return Date.now()-(this.lastClippedAt || 0) < 3000; }
  get passed() { return this.noiseReady && this.levelOk && this.recognized && !this.clipped; }
  get meterPercent() { return clamp((db(this.smoothedRms)+60)/50*100, 0, 100); }
  get thresholdPercent() { return clamp((db(this.threshold)+60)/50*100, 0, 100); }
  get normalSpeechRms() { return this.calibratedSpeechRms || (this.speechBlocks ? this.speechSum/this.speechBlocks : 0); }
  get recommendedVadThreshold() {
    return clamp(Math.max(.003, this.noiseFloorRms*2.5, this.normalSpeechRms*.16), .003, .05);
  }
  observe(pcm) {
    let power = 0, peak = 0;
    for (const value of pcm) { power += value*value; peak = Math.max(peak, Math.abs(value)); }
    const rms = Math.sqrt(power/pcm.length);
    const duration = pcm.length/16000*1000;
    this.smoothedRms = this.smoothedRms*.7+rms*.3;
    this.peakRms = Math.max(this.peakRms, rms);
    this.peakSignal = Math.max(this.peakSignal, peak);
    if (peak >= .97) this.lastClippedAt = Date.now();
    if (!this.noiseReady) {
      this.noiseSamples.push(rms);
      const ordered = [...this.noiseSamples].sort((a,b) => a-b);
      this.noiseFloorRms = ordered[Math.floor(ordered.length*.25)] || .001;
    } else if (rms < this.noiseFloorRms) {
      this.noiseFloorRms = this.noiseFloorRms*.5 + rms*.5;
    } else if (rms >= this.threshold) {
      this.speechMs += duration; this.speechSum += rms; this.speechBlocks++;
      this.strongBlocks.push({at:Date.now(), duration, rms});
      this.strongBlocks = this.strongBlocks.filter(block => Date.now()-block.at < 30000);
    }
    return this.snapshot();
  }
  hear(text, segment = {}) {
    this.lastTranscript = text; this.attemptedPhrase = true;
    const phraseBlocks = this.strongBlocks.filter(block =>
      block.at >= (segment.startAt ?? 0) && block.at <= (segment.endAt ?? Infinity));
    const strongMs = phraseBlocks.reduce((sum, block) => sum+block.duration, 0);
    if (recognizesBasmala(text) && strongMs >= 320 && !this.clipped) {
      this.calibratedSpeechRms = phraseBlocks.reduce((sum, block) => sum+block.rms, 0)/phraseBlocks.length;
      this.recognized = true;
    }
    return this.snapshot();
  }
  snapshot() {
    return {noiseReady:this.noiseReady, noiseFloorDb:db(this.noiseFloorRms),
      rms:this.smoothedRms, speechRms:this.normalSpeechRms,
      peakRms:this.peakRms, deviceSampleRate:this.deviceSampleRate,
      threshold:this.threshold, recommendedVadThreshold:this.recommendedVadThreshold,
      meterPercent:this.meterPercent, thresholdPercent:this.thresholdPercent,
      levelOk:this.levelOk, clipped:this.clipped, recognized:this.recognized,
      passed:this.passed,
      message:!this.noiseReady ? 'انتظر قليلًا لقياس هدوء المكان' :
        this.clipped ? 'أبعد الهاتف قليلًا' :
        this.passed ? 'تم الاجتياز' :
        this.levelOk && this.attemptedPhrase ? 'أعد قراءة البسملة بوضوح' :
        this.levelOk ? 'جيد، أكمل قراءة البسملة' : 'ارفع صوتك قليلًا'};
  }
}

# Live recitation implementation and validation

The acceptance test on a physical phone remains **unverified**. Neither a 200–600 ms
word latency nor consistent Arabic interim delivery across browsers is claimed.

## Root cause

`TranscriptGate.push()` returned after partials; `onCommitted` ran only on finals.
`RecitationEngine` deduplicated an entire segment ID, making incremental callbacks
impossible, and correct reveals explicitly called the renderer with `active=false`.
Repetition required three words in a final segment, and completing the selection
immediately stopped the microphone.

Partials now commit only newly stable prefix tokens. Correct words reveal and activate
immediately. Uncertain mismatches remain pending and can be bypassed by a correct retry;
confirmed mismatches lock progression. Attempts and haptics share a lexical event ID.
A read-ahead run contributes at most one attempt at the locked position. Distinct
segments or repeated wrong lexical tokens can represent new attempts. Without acoustic
word boundaries, distinguishing arbitrary retries from continued read-ahead remains
conservative. This is lexical recognition, not pronunciation or Tajweed assessment.

Primary progress is independent of the temporary highlight cursor. Completed Ayah starts
can initiate repetition. First-correct timestamps, errors and revealed state stay intact.
After completion, the result button ends the session; the microphone remains available
for repetition until the user ends it.

## Providers and model audit

The shipped [model card](https://huggingface.co/voidwaveDev/fastconformer-quran/blob/main/README.md)
describes a stateless causal encoder, with two inputs and no exported encoder caches.
Its inherited metadata incorrectly called the browser integration `sherpa-onnx` and the
variant streaming. The runtime metadata now describes the actual integration.

An experiment retaining predictor state and consuming only new encoder frames with
320 ms hops produced empty transcripts on a known Al-Ikhlas recording. That experiment
was **removed**, rather than shipped as working streaming recognition.

* `BrowserStreamingProvider` uses `continuous=true` and `interimResults=true` in the
  browser SpeechRecognition API. It forwards partials immediately, never restarts at
  Ayah boundaries, and resumes only if the browser service ends the recognition session.
  A service producing finals without any interim evidence is rejected explicitly.
  The setup screen discloses that the browser service may transmit audio and require
  internet before the user chooses it. Nothing switches to a remote service silently.
  Browser support, Arabic model behavior, service-imposed endpoints and latency vary.
* `BrowserFastConformerProvider` remains an explicitly labeled local fallback. It
  recomputes growing bounded audio windows, attempts partial inference every 320 ms
  after 480 ms of audio, and does not wait for VAD silence. It is **not cache-aware
  streaming** and is not advertised as meeting the low-latency requirement. The 11.5 s
  acoustic window limit is independent of Quran boundaries. No duplicate suppression
  can guarantee perfect recognition at that window boundary without word timestamps.

See [SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)
and [interimResults](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/interimResults).

## Rendering and diagnostics

SVG nodes, word bounding boxes and overlays are cached in maps. Updates change only
individual words/overlays; permanent error decoration survives a blue tracking overlay.
Page requests carry a generation guard. Application shell v4 prevents stale core-cached
JavaScript from shadowing the updated matcher and provider.

`?debug=1` records RAW/STABLE/EXPECTED/current word history and timestamps. For local
inference the timings measure window scheduling/inference and UI mutation, not true
word-onset latency. The native provider exposes no audio-to-hypothesis mapping or
inference clock, so these fields are explicitly null. Partial-to-UI includes time spent
stabilizing. `uiUpdatedAt` is a DOM mutation timestamp, not a measured display paint.

## Verification

Run `node --test tests/*.test.mjs` for nine deterministic tests covering partial-only
progress, repetitions, skip locks, haptic debounce, uncertainty, three-error resolution,
revisions and the native provider lifecycle. These do not establish acoustic accuracy.

Run `PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/renderer.browser.mjs`
with Chrome installed for actual SVG DOM/visibility/overlay checks.

An optional real-model test is `tests/model.browser.mjs`; set `FIXTURE_DIR` to a folder
containing the pinned encoder and an EveryAyah Alafasy 128 kbps `112001.mp3` recording.
No recording or model is committed. The test supplies prerecorded audio to the **local**
provider only, never a user's live microphone or a remote speech service.

On desktop Chrome in this session, the 2.917 s recording produced these local partials
before the recording ended: `قُلْ هُوَ`, `قُلْ هُوَ اللَّهُ`, `قُلْ هُوَ اللَّهُ أَحَدٌ`.
The first nonempty result arrived about 1.02 s after the segment start, with 111 ms
inference; subsequent inference was 179–281 ms. This is evidence of pre-endpoint
recognition, **not** proof of the requested per-word latency or phone acceptance test.

Still required on a physical device: continuous Al-Ikhlas, immediate next Ayah,
repetition, intentional mismatch and correction, three distinct failures, supported
haptics, and measuring each word's latency. Check both the native provider and local
fallback, including unsupported-service behavior. Do not declare requirements 150–192
fully accepted until that test passes.

After changing deployable files, run `python3 scripts/update-manifest.py` to update local
asset sizes, SHA-256 hashes and total size. Hosting/deployment was not requested or done.

# Live recitation: implementation and measurement

The physical-phone acceptance test is still open. The browser recording below tests
one device and one recitation, not all phones or browser speech services.

## Corrections

The setup page now contains Surah, From Ayah, To Ayah, and the original iOS-style
`تفعيل الميكروفون` switch. It opens `getUserMedia`, verifies a live audio track,
shows the active state, and only then enables `التالي`. Switching it off stops the
track and disables the button. The next page is `اختبار الميكروفون`, then `بدء التسميع`.
There is no provider selector in normal UI.

`AutomaticASRProvider` ranks compatible providers using browser interim support,
network availability, installed local assets, device memory and recorded first-partial
latency. Recitation requests word timing for the acoustic pronunciation layer, so the
local provider is preferred when available; a fatal local failure can fall back to
browser recognition. The browser path preserves lexical progression, but lacks word
timings and therefore cannot acoustically verify the matched word. Selected provider,
measurements and failures appear under `?debug=1` only. The browser recognition service
may process speech remotely, depending on browser implementation.

The shipped [FastConformer model card](https://huggingface.co/voidwaveDev/fastconformer-quran/blob/main/README.md)
describes a causal encoder without exported cache inputs. The local implementation uses
bounded overlapping windows and cannot claim cache-aware streaming. An experiment to
decode only new encoder frames yielded empty transcripts and was removed. Native browser
recognition uses `continuous=true` and `interimResults=true`; a service that gives only
final results triggers automatic fallback.

On each raw partial, the Quran matcher may preview the exact expected word immediately
in blue. That visual state can be retracted if the ASR revises the word. A separate
stable-prefix path commits permanent correct words; mistakes and haptics require a
higher confidence and persistence threshold. The primary progress cursor remains
independent of the temporary blue reading cursor. Re-reading a completed Ayah changes
only repetition tracking and the blue cursor. SVG word nodes and boxes are cached;
updates touch only the affected word and overlays.

The local audio worklet delivers 1024 samples (64 ms at 16 kHz). The local model
can first infer after roughly 320 ms of speech and requests new partials after
roughly 160 ms of new audio. Model inference can take longer on a phone. The worker
runs while speech continues and does not need a VAD endpoint to produce partials.

## Measurement

`?debug=1` shows timestamps for frame receipt, chunk readiness, feature extraction,
inference, partial receipt, alignment completion, and SVG mutation. It also shows
buffering, inference, stabilization, alignment, SVG update and partial-to-highlight
durations with rolling averages. The native browser provider does not expose feature
or inference clocks, so these values are null for that provider. SVG mutation time
is not a measured screen paint time.

To measure the local path in a real Chrome browser, run
`FIXTURE_DIR=/path/to/fixtures PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/model.browser.mjs`.
The fixture directory contains the pinned encoder and EveryAyah Alafasy 128 kbps
`112001.mp3`. Neither is committed to the repository. The test feeds recorded audio
at microphone cadence through the actual ONNX model, transcript gate, matcher and
SVG renderer.

On this desktop Chrome run with a 2.917 s Al-Ikhlas recording, all four Quran words
appeared before the recording ended. Across their first visible updates, mean
**audio-buffer-to-partial proxy** was 353 ms, mean **partial-to-highlight** was 1 ms,
and mean **total pipeline proxy** was 353 ms. The 353 ms included about 192 ms of
audio accumulation and 160 ms of ASR processing, of which roughly 6 ms was feature extraction. These
proxies use the audio chunk that produced a hypothesis; they do not identify the
acoustic onset of each spoken word. They cannot establish the user's perceived word
latency or the 200–700 ms physical-phone target.

`node --test tests/*.test.mjs` verifies partial word preview and retraction,
permanent word progression, skip/error/haptic rules, repetition, provider ranking,
and fatal fallback. `tests/setup.browser.mjs` checks the actual microphone switch
and navigation in Chrome with a fake audio device. `tests/renderer.browser.mjs`
checks temporary and permanent word rendering in real SVG DOM.

A phone run remains required: recite Al-Ikhlas continuously, cross to the next Ayah,
repeat the completed Ayah, test a confirmed wrong word and correct retry, and inspect
`?debug=1` for first-word and per-word delay on that device. The local model and native
browser service should both be checked where available.

After editing deployable assets, run `python3 scripts/update-manifest.py` so hashes
and sizes match the current files. Hosting or deployment was not requested here.

## Acoustic pronunciation verification

Each selected Mushaf word retains its Uthmani form, normalized lexical form, phoneme
sequence and vowel sequence. `data/quran-pronunciation-map.json` aligns the pinned
Quran-MD word pronunciations to Mushaf word IDs, including fused clitics. A clitic
covered by a fused source recording shares that acoustic span; it cannot receive an
independent vowel decision from that recording. A few source alignment exceptions
remain without a phoneme target and are reported as uncertain.

The lexical recognizer still determines word identity and progression. For a matched
word with local ASR timestamps, the app cuts that word from its rolling microphone PCM
buffer and sends it to a separate, quantized Wav2Vec2 CTC model. The CTC scorer compares
the expected phoneme sequence with alternatives for short vowels, duplicated
consonants (shadda), and final vowel insertion (sukoon). It never infers pronunciation
from ASR spelling. Clear incorrect evidence produces one red Harakah error and one
vibration, and keeps progression on that word. Clear evidence for the expected sounds
marks the word correct. Weak evidence, missing timing, fused-word ambiguity, or a
phoneme-map gap is marked uncertain; uncertain words are tracked separately and do
not count as fully correct.

The model is [TBOGamer22/wav2vec2-quran-phonetics](https://huggingface.co/TBOGamer22/wav2vec2-quran-phonetics), trained on
[Quran-MD word recordings](https://huggingface.co/datasets/Buraaq/quran-md-words).
The browser loads a 91 MB quantized model and runs it in a dedicated worker. The blue
lexical preview continues while this worker scores the current word. A high-confidence
wrong decision is immediate; uncertain decisions get one additional stable hypothesis
before the engine moves on as lexical-only. Native browser ASR has no word timings, so
its lexical matches cannot be acoustically verified and remain uncertain.

### Audio validation and limits

Run the audio minimal-pair test with downloaded Quran-MD recordings:

```sh
PHONEME_FIXTURE_DIR=/path/to/quran-md-fixtures \
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
node tests/phoneme.browser.mjs
```

The fixture set currently exercises eight isolated recordings: Fatha versus Kasra,
Kasra versus Damma, present versus absent Shadda, and Sukoon versus an inserted final
vowel. All eight pass on the model's source dataset. This is a real-audio smoke test,
not an independent-speaker accuracy evaluation: the files come from the training
distribution. A continuous Al-Ikhlas recording also verifies the local ASR, rolling
word cuts and pronunciation worker together, but this unseen-reciter test often returns
uncertain for later words. It does not establish robust Harakah recognition during
continuous recitation, and there is not yet a human negative recording for the exact
`إِيَّاكَ` versus `إِيَّاكِ` acceptance pair. Do not interpret those results as a
validated Quran-wide pronunciation score.

The current desktop Chromium run measured roughly 0.5–1.2 s for individual
pronunciation inference, depending on the clip and context. That delay can lag blue
tracking and can occasionally consume part of the following word; the audio cut uses
ASR emission timing estimates rather than a validated word-level forced aligner.
Physical-phone latency and accuracy remain unmeasured. The app intentionally preserves
uncertain decisions in the report rather than converting them to red errors or fully
correct pronunciations. Completion percentage means passage progress; the separate
`correctWords` count includes only words with a confident acoustic pass.

`node --test tests/*.test.mjs` runs the local unit suite. The browser smoke tests are
`tests/phoneme.browser.mjs`, `tests/model.browser.mjs`, `tests/setup.browser.mjs`, and
`tests/renderer.browser.mjs`. After editing deployable assets, run
`python3 scripts/update-manifest.py` so hashes and sizes match the current files.
Hosting or deployment was not requested.

The quantized ONNX file is stored as four `.partN` files, each below GitHub's 25 MiB
browser upload limit. The pronunciation worker joins them from the verified app cache
before opening ONNX Runtime. To recreate them after exporting a new model, run
`python3 scripts/split-phoneme-model.py /path/to/quran-phoneme.int8.onnx`, copy the
four parts into `assets/models`, then remove the original large ONNX file and refresh
the manifest.

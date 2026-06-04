# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

This repo contains two sub-projects:

- `smpte-analyzer/` — a Vite + React app implementing an SMPTE LTC analyzer per ST 12-1:2014. Runs fully in the browser using the Web Audio API. **LTC only** — VITC (in video vertical interval) and ATC (embedded in SDI/HDMI ancillary data) are not decoded.
- `smpte-bridge/` — a Node.js WebSocket sidecar that ingests the timecode feed from the analyzer and fans it out to subscribers.

There is no top-level package.json. Each sub-project has its own.

## Running / Iterating

```bash
# Analyzer (dev server at http://localhost:5173)
cd smpte-analyzer && npm install && npm run dev

# Bridge sidecar (optional; listens on :8765)
cd smpte-bridge && npm install && npm start
```

Correctness checks are manual: open the browser, grant microphone access, feed real LTC into an audio input, and verify behavior against the SMPTE rules documented in the README.

## File Responsibilities

| File | Concern |
|---|---|
| `smpte-analyzer/src/App.jsx` | Root component: all React state, UI layout, audio capture setup, tick wiring, mode switching, file-drop analysis, session log, publisher integration |
| `smpte-analyzer/src/ltcDecoder.js` | DSP: `LtcDecoder` (biphase decode with rolling state; `pendingFrames` queue for continuity tracking; `recentDecodeTimes` carrying worklet-stamped wall-clock per frame for LSQ rate measurement and dropout rate), `MultiRateDecoder` (parallel-rate auto-detection, wall-clock LSQ carrier classifier with 5σ + 3-agreements commit rule, `carrierObservation()` rich state, `carrierRate()` (tri-state), `cadence()` (delegates to CadenceDetector), `carrierCadenceMismatch()` ({result, confidence, reason}), `driftPpmSourceVsHostQuartz()` + `driftPpmSourceVsAdc()` + `captureClockErrorPpm()`, `driftPpm()` deprecated alias, `dropoutPct()`, `medianFrameSpan()`, `detectedRateKey()` (combined view, returns null until commit)), `lastCarrierEvent` (MEASURING_COMMIT / RATE_CHANGE / DIVERGENCE edge events), `tcToFrameNumber()`, `tcString()`, `parseFrame`, rate key helpers |
| `smpte-analyzer/src/cadenceDetector.js` | `CadenceDetector` — observes the decoded FF sequence and minute-boundary behaviour to infer counting cadence and DF skip independently of carrier-rate timing. Owns continuity-break tracking (REPEAT/JUMP/REWIND) using the inferred cadence's frame-number math. |
| `smpte-analyzer/src/publisher.js` | Transport: reconnecting WebSocket `Publisher` class |
| `smpte-analyzer/src/tickWorker.js` | Tick source: Web Worker that fires `{type:"tick"}` at ~30 Hz, immune to tab-backgrounding throttle |
| `smpte-analyzer/public/ltc-worklet.js` | Audio thread: `LtcCapture` AudioWorklet that forwards every sample to the main thread (no drops) and stamps `performance.now()` at chunk start + chunk end so the decoder can recover true wall-clock arrival time per frame independent of ADC sample-clock drift |
| `smpte-bridge/src/index.js` | WS fan-out: `/ingest` (single publisher), `/subscribe` (multi-subscriber broadcast), `/status` HTTP snapshot |

## Architecture

### Audio pipeline

1. `getUserMedia` (with `echoCancellation`, `noiseSuppression`, `autoGainControl` all off) opens the selected device.
2. `getOrCreateAudioContext()` lazily constructs a single `AudioContext` for the app's lifetime, registers the worklet module once, and reuses it across device switches. `stopAudio()` suspends the context (does not close it). Reusing one context is critical on macOS: each `new AudioContext()` triggers a fresh Core Audio negotiation that can switch the system output device when an audio interface is selected as input.
3. The single `AudioContext` hosts two parallel graphs from the same source node (mic or file):
   - `AnalyserNode` (fftSize 2048, `minDecibels=-120`, `maxDecibels=0`, `smoothingTimeConstant=0`) — used for RMS, peak, and FFT-based spectral metrics. Measurement-grade settings (not VU-visualisation defaults).
   - `AudioWorkletNode` (`ltc-capture`, `numberOfOutputs:0`) — forwards Float32 sample chunks to the main thread without opening any system output stream. The `numberOfOutputs:0` matters on macOS: connecting a node to `ctx.destination` would cause Core Audio to switch the system output when an audio interface is the input.
4. Wiring of source → analyser + worklet is encapsulated in `wireSourceToDecoder(ctx, source)`, which is shared between the live-mic path (`startAudioCapture`) and the file-playback path (`startFilePlayback`). `teardownCurrentSource()` tears down whatever source is currently active before a new one is wired. **Audio setup must be StrictMode-/race-safe (load-bearing):** `startAudioCapture` is async (awaits `getUserMedia`), so it claims a `captureEpochRef` token at entry and bails after each await if superseded; the mount effect's cleanup tears down audio AND bumps the epoch; `teardownCurrentSource` nulls the worklet `port.onmessage` before disconnect. Without these, React StrictMode's dev double-mount wired two `ltc-capture` worklets that both incremented `sampleClockRef.n`, doubling the measured sample rate (read ~96k on a 48k context and falsely flagged RESAMPLED).
5. The worklet's `port.onmessage` feeds samples to `MultiRateDecoder.feed()`.
6. **Carrier rate vs. counting cadence are separate observations** (load-bearing). The integer-vs-fractional carrier classification (e.g. 30 vs 29.97) is **wall-clock-clocked, not sample-count-clocked**. The worklet stamps `performance.now()` at each chunk boundary; the decoder linearly interpolates per-frame wall-clock arrival times across the chunk. `MultiRateDecoder.carrierObservation()` runs LSQ regression of frame-index vs wall-clock-time over a 20 s stable window + 3 s detector window, classifies fractional vs integer by which side of the (1 + 1/1.001)/2 midpoint the measured fps ratio sits, and commits only when the estimate is ≥5σ from the midpoint AND has produced 3 consecutive same-side measurement updates ≥1 s apart. The detector window watches for source rate changes and triggers a DIVERGENCE event that invalidates the commit. While not yet committed, `carrierRate()` / `detectedRateKey()` return null — the UI shows "MEASURING…". On signal loss (>500 ms without a fresh frame), the committed classification is held for 5 s, then dropped. **The previous sample-count-based classifier (using mean frame span vs expected) is gone**: it was contaminated by the capture device's ADC clock running ±tens-of-ppm off nominal, which combined with measurement jitter on the 120-frame mean produced spurious RATE_CHANGE flips on clean 29.97 sources every 6–14 s. The wall-clock path is referenced to the host quartz, immune to ADC clock bias.

   A separate `CadenceDetector` watches the decoded FF sequence and minute-boundary behaviour to infer the counting cadence and drop-frame skip pattern, never consulting carrier timing. `carrierCadenceMismatch()` surfaces the case in issue #1 (e.g. a 30 fps carrier carrying a DF-skipping count, or a fractional carrier carrying a 24-cadence count) — it returns `{result, confidence, reason}` so the UI can only raise the NON-CONFORMANT banner at high confidence and stay quiet while either side is still MEASURING. The DF flag bit in the LTC frame is observed but not trusted: `dfFlagMatchesObservedCadence()` reports disagreement separately. Continuity break math uses the inferred cadence's max-FF, NOT the carrier's nominal fps — otherwise a stream whose carrier matches one rate but counts in a different cadence registers continuous spurious JUMPs.

   `MultiRateDecoder` runs five `LtcDecoder` instances (24/25/30/50/60 fps) in parallel. Each decoder maintains rolling biphase decode state across chunks. **Winner selection is windowed, not cumulative (load-bearing).** Score = `recentFramesDecoded(last 20 s) + recencyBonus(1000 if frame < 500 ms old)`. Cumulative scoring (`framesDecoded - bitErrors×0.1 + recencyBonus`) was reverted because when the input rate changed on the same device, the previous winner had thousands of accumulated frames while the new correct decoder had thousands of accumulated *bit errors* from running against the wrong rate the whole time — the cumulative score kept the old decoder ahead for ~60 s. A page refresh hid the bug because all counters started at 0. `recentDecodeTimes` is now time-pruned (≤45 s) rather than entry-count-capped so window semantics don't drift between 24 and 60 fps streams.
   - After picking the winner, `MultiRateDecoder.feed()` drains the winner's `pendingFrames` queue and calls `_checkFrameContinuity()` per frame. A single 2048-sample worklet chunk (~42 ms at 48 kHz) can contain more than one LTC frame at 30 fps; checking `lastFrame` per chunk would miss intermediate frames and produce spurious JUMP breaks. Non-winner queues are discarded.
   - `_checkFrameContinuity()` uses `tcToFrameNumber()` to compute an absolute frame count and compares it to the previous count. Any delta other than +1 increments `continuityBreaks` and updates `lastBreak {type, delta, from, to, t}`. If the gap between consecutive decoded frames exceeds 500 ms, continuity *tracking* state (`_prevFrameNumber`, `_prevFrameTc`) resets rather than reporting a spurious jump across the gap — but the break counter itself persists. If the gap exceeds 3 s, `continuityBreaks` and `lastBreak` are also cleared on the first resuming frame, on the basis that a long signal stop starts a new run. The break counter is **not** cleared by elapsed time alone while code is rolling — a past glitch stays in the count until the signal actually stops for 3 s.
   - `dropoutPct(windowSec=2)` counts decoded frames in `recentDecodeTimes` within the window and divides by expected count (`effectiveWindowSec × detected_actual_fps`). The window is **adaptive**: it uses the lesser of `windowSec` and the actual span of decode history available, with a 0.5 s floor. Without adaptation, just-acquired lock would report near-100% dropout because only the first few frames count against the full window. Returns null when (a) there's no winner, (b) the most recent decode is more than 500 ms old (no live signal — prevents the readout lighting up on a silent input like BlackHole), or (c) less than 0.5 s of decode history exists.
   - **Two drift readouts**, both measurement-grade. `driftPpmSourceVsHostQuartz()` is the primary number an engineer wants — derived from the wall-clock LSQ fit, it expresses how fast the LTC source clock runs vs the host machine's quartz. Positive = source faster than quartz. Note that the host quartz is itself undisciplined (typically ±50 ppm absolute on consumer hardware), so this is "drift relative to whatever crystal this laptop has," not an absolute number — for absolute, you'd discipline against an external reference. `driftPpmSourceVsAdc()` is the legacy sample-count-based number kept as a capture-chain diagnostic: it uses the mean of `recentFrameSpans` (sub-sample precision from natural jitter, same rationale as before). `captureClockErrorPpm()` = host − ADC drift with the LTC source as common reference, surfaced in the AUDIT panel; if it exceeds ±100 ppm the audit panel flags the row amber (suggests faulty interface or an SRC in the chain). The deprecated `driftPpm()` alias forwards to `driftPpmSourceVsHostQuartz()`.
7. On each tick (~33 ms via Web Worker), `App.jsx` reads `decoderRef.current.lastFrame`. If the frame is less than 200 ms old, it is treated as live and its HH:MM:SS:FF populates the display. Otherwise the display shows zeros and LOCK turns off.

### Tick architecture

`tickWorker.js` runs `setInterval` in a Web Worker at 33 ms. `setInterval` and `requestAnimationFrame` in inactive tabs are throttled to ~1 Hz by browsers; the Worker is not. This keeps downstream API subscribers from stuttering when the tab loses focus.

### Mode switching

Switching between live and simulation modes calls `setUseRealAudio()`, which triggers a `useEffect` that clears `analysis`, resets `peakHold` to −60, and resets `peakDecayRef`. This ensures the displayed detection state (confidence bar, rate label, lock indicator) visibly clears and re-acquires on switch rather than carrying stale values over.

### Spectral metrics in live mode

`computeLtcSpectralMetrics(analyser, sampleRate, nominalFps)` returns `{snr, noiseFloor, thd}` (or `null` on failure):

- **SNR**: total power in `[bitRate×0.4, bitRate×1.6]` divided by noise-floor power projected across the same band width. Noise floor is sampled at biphase spectral nulls — frequencies exactly halfway between consecutive LTC harmonics `(h+0.5)×f1` — where the biphase coding guarantees no signal energy. Median of those null bins is taken for robustness.
- **Noise floor**: `10×log₁₀(median null-bin linear power)` in dB.
- **THD**: classical `√(ΣP_h)/√(P_1)×100` across the 3rd/5th/7th odd harmonics of `f1 = bitRate/2`. Each harmonic peak is found within ±10% of its target frequency to tolerate clock drift.

All three are `null` when not locked. The `AnalyserNode` is configured with `smoothingTimeConstant=0` so the FFT reflects the actual current block rather than a temporally averaged spectrum.

Displayed values are EMA-smoothed via `smoothedMetricsRef` (alpha=0.025, ~0.5 Hz effective bandwidth, ~2 s settle). `driftPpm` is also EMA-smoothed. The refs reset to `null` on lock loss.

### Bootstrap state

A `bootstrapping` flag is `true` from mount until either live audio successfully starts or the user explicitly switches to simulation mode. While `bootstrapping` is true:
- The simulator tick is skipped entirely (no wall-clock-derived timecode flashes on refresh).
- `TimecodeDisplay` receives `dim={true}`, rendering digits in `#333` with no glow.
- The LOCK badge is forced inactive.
- The orange rate label is hidden.
- A grey "○ STARTING — requesting audio input…" banner appears above the timecode card.
- The left controls panel shows a "STARTING" placeholder instead of SIMULATION CONTROLS or LIVE INPUT STATUS.

`bootstrapping` is cleared to `false` in `startAudioCapture()` on both success and failure paths.

### Three input modes

- **Live mode (default):** app calls `startAudioCapture()` on mount. Timecode digits come from the biphase decoder. If the browser blocks `getUserMedia` before a user gesture, the app surfaces an error and falls back to simulation mode.
- **File analysis mode:** drop an audio file on the AUDIO INPUT panel or click **ANALYZE FILE…**. `startFilePlayback(file)` reads the file's `arrayBuffer`, calls `ctx.decodeAudioData` (which resamples to the context rate), creates a looping `AudioBufferSourceNode`, and passes it to `wireSourceToDecoder`. For WAV files, `readWavSampleRate(arrayBuffer)` parses the native sample rate from the RIFF header before decoding so the LIVE INPUT STATUS panel can display both the native and decoder rates. The source is **never connected to `ctx.destination`** — the file is silent on system output.
  - **Multi-channel LTC auto-detect (#32):** for files with >1 channel, `detectLtcChannel(audioBuffer, sampleRate)` (`src/channelDetect.js`) probes each channel through a throwaway `MultiRateDecoder` over a short window and selects the channel that decodes the most frames (real LTC decodes dozens-to-hundreds; program audio/silence decode ~0). The detected channel is set before wiring/feeding; if no channel clears the frame threshold it falls back to channel 0. The `CH` picker still lets the user override (which clears the green **AUTO** badge). A `ChannelSplitter` taps exactly one channel at unity — never Web Audio's default down-mix, which would sum program audio into the code and read 6 dB low for a single-channel signal.
- **Simulation mode:** accessed by clicking **SWITCH TO SIMULATED TIMECODE** (only shown in live mode when no file is playing). `generateSimulatedAnalysis()` produces fake timecode and level data. The timecode card shows a fuchsia outline and a blinking **SIMULATING CODE** indicator.

### Drop-frame rule (load-bearing)

DF math in `App.jsx` is split across two helpers:
- `dropPerMin(nomFps)` — returns 4 for 60-fps nominal, 2 otherwise. Single source for the per-minute skip count.
- `framesToTc(totalFrames, nomFps, dropFrame)` — canonical frame-count → HH:MM:SS:FF converter; applies `dropPerMin` internally.

`isValidDropFrame` and `generateSimulatedAnalysis` both consume these helpers. There is no `tcToFrames` function; it was removed as dead code.

The rule encoded:
- 29.97 DF: skip frames 00, 01 at the start of every minute except every 10th minute.
- 59.94 DF: skip frames 00, 01, 02, 03 with the same 10th-minute exception.

The same rule is applied in `ltcDecoder.js`'s `parseFrame`. Any change to drop-frame handling must be cross-checked across both files.

### LTC frame layout

The 80-bit LTC frame structure (BCD digits, flags, user bits, sync word `0011111111111101` at bits 64–79) is implemented in `parseFrame` in `ltcDecoder.js`. The simulation path in `App.jsx` does not decode frames — it generates timecode values directly via `framesToTc`. The README's "LTC Frame Structure" table is the reference if bit-field code needs to change.

**50/60 fps has two FF encodings (load-bearing, #34), selected by `parseFrame`'s `frameMode` arg:**
- **`wide`** (default, de-facto) — FF labels every frame; frame-tens is a 3-bit field reading **bit 58** as the MSB (FF up to 79); the field-mark flag is static. Used by Tentacle/Ambient/some Sound Devices.
- **`framepair`** (spec ST 12-1 §12) — FF labels frame *pairs* (2-bit tens, wraps at 24/29), **bit 58 is BGF1**, and the per-field LSB rides in the field-mark flag (bit 27 @ 60, bit 59 @ 50). `parseFrame` reconstructs the true frame as `FF_pair×2 + fieldMark`.

`MultiRateDecoder.feed()` picks the mode from `fieldMarkBehavior()` (the rolling field-mark toggle classifier: `TOGGLING`→framepair, `STATIC`→wide) and sets `_frameMode` on the 50/60 decoders. On the wide→framepair flip it resets the cadence detector and zeroes `continuityBreaks`, because the brief wide-mode acquisition transient (FF read as the pair value, repeated every other frame) would otherwise leave spurious REPEAT breaks. `ltcSynth.js` can generate both via the `convention` arg (`buildLtcAudioBuffer`/`encodeFrameBits`); round-trip coverage is in `test/framePair.test.js`. The FIELD-MARK row in the UI surfaces which convention is in use.

### API publisher

`publisher.js` exports a `Publisher` class. `App.jsx` creates one instance when `apiEnabled` is true. On each tick it calls `publisher.send({type:"tc",...})`. On each error-state transition it calls `publisher.send({type:"error",...})`. The publisher handles reconnection with exponential back-off (1 s → 10 s max). The bridge sends `{type:"status"}` messages back; the app reads `msg.subscribers` from these to display the subscriber count.

Wire payload shapes:
- `tc` tick: `{type:"tc", t, seq, hh, mm, ss, ff, rate, dropFrame, carrierRate, cadenceFps, cadenceDropFrame, carrierCadenceMismatch, fieldMarkBehavior, bgf, userBits, source, ltcLocked, frameValid, levelDbFS, peakDbFS, driftPpm, dropoutPct, snr, errors}` — `seq` is a publisher-monotonic counter appended by `Publisher.send()`. `rate` is the combined SMPTE rate key (e.g. `"29.97df"`); `carrierRate`/`cadenceFps`/`cadenceDropFrame` are the independent observations it's composed from; `fieldMarkBehavior` is `TOGGLING`/`STATIC`/null (50/60 frame-pair vs wide); `userBits` is an 8-char hex string. Uncommitted/absent fields are null. Full schema in `smpte-bridge/README.md`.
- `error` transition: `{type:"error", t, seq, tc, rate, errors}` — `tc` is a formatted string using `;` as the frame separator for drop-frame.
- `continuity` break: `{type:"continuity", t, seq, breakType, delta, from, to, rate}` — emitted per continuity break. `breakType` is `"REPEAT"` (delta = 0), `"JUMP"` (delta > 1), or `"REWIND"` (delta < 0). `from` and `to` are formatted timecode strings. Each break is also written to the session log with `errors: ["TC_REPEAT"|"TC_JUMP"|"TC_REWIND", "+Δ"]`.
- `log` snapshot: `{type:"log", t, seq, entries}` — the **full session log**, published whenever it changes so the phone viewer (`smpte-bridge/public/viewer.html`) renders a true mirror of the analyzer's log rather than keeping its own. `entries` is the whole `sessionLog` array oldest-first; each entry is `{id, t, tc, from?, rate, source, levelDbFS, snr, errors, count, note?}`. **It's a whole-array snapshot, not per-entry deltas** (load-bearing): idempotent, so a dropped message self-corrects on the next one and a late-joining subscriber just takes the bridge's cached copy. Published via a single stable 750 ms interval gated on a dirty flag (App.jsx), which coalesces the per-second count flushes during sustained errors into one send. The bridge caches the latest snapshot as `lastLog` and replays it in the `hello` to new subscribers; the viewer's mirror is read-only (notes are authored only in the analyzer — there is no subscriber→analyzer back-channel). Because continuity breaks already appear in the log as `TC_*` entries, the viewer no longer maintains a separate continuity-break list.

## Conventions

- Plain React function components with hooks (`useState`, `useEffect`, `useRef`, `useCallback`) — no class components, no state library, no TypeScript.
- Tailwind-style utility classes are used inline. Fonts (`Share Tech Mono`, `Orbitron`, `B612 Mono`) load via a runtime CSS `@import` from Google Fonts inside `App.jsx`. The timecode display is hardcoded to `B612 Mono` (designed for aircraft cockpit displays). There is no runtime font picker.
- `App.jsx` is organized in layers top-to-bottom: spec constants → drop-frame helpers → DSP functions (`computeRMS`, `computePeak`, `linearToDB`, `readWavSampleRate`, `computeLtcSpectralMetrics`) → simulation generator → formatting helpers → shared style tokens → UI sub-components → root component. Preserve this layout when adding code.
- `smpte-analyzer` has no external runtime dependencies beyond React. `smpte-bridge` depends only on the `ws` package.
- Spec constants (`SMPTE_RATES`, `LEVEL_SPEC`) encode the standard. Do not adjust them to make things work; they are authoritative.
- `_snrBins` is a module-level `Float32Array` cache reused by `computeLtcSpectralMetrics` across ticks to avoid per-tick allocation. `timeBufRef` is a component-level ref serving the same purpose for `getFloatTimeDomainData`. `PANEL` is a module-level const for the standard panel box style; `buttonStyle(color, opts?)` is a helper for consistent button styling.
- `smoothedMetricsRef` holds `{ snr, thd, noiseFloor, driftPpm, dropoutPct }` — the EMA state for the five displayed live metrics. Reset to `null` on lock loss.
- `TimecodeDisplay` accepts a `dim` prop: when true, digits render in `#333` with no glow (used during bootstrap).
- The live error tag list is derived strictly from real level measurements (`CLIP`, `HOT`, `LOW`, `DROPOUT`). `LOW` and `DROPOUT` both mean "a signal that's now weak or gone" — both are suppressed when the input is just idle (level below silent threshold AND no decoded frame within the last 2 s), so switching to a silent device like BlackHole doesn't immediately light up the tags. `NOISE` is not emitted in live mode; it appears only in the sim path from `generateSimulatedAnalysis`.
- **Confidence** is computed from `dropoutPct`, not cumulative `framesDecoded`/`bitErrors` counts. Formula: `100 - dropoutPct` (clamped 0–99.5), with a 25% fallback during the first 0.5 s before `dropoutPct` returns a value. Cumulative-ratio confidence was reverted for the same reason as cumulative winner scoring: stale bit errors from a previous rate kept the bar near 0% for ~60 s after a rate change.
- Rate label next to the timecode is color-coded: orange (`#ffaa00`) for drop-frame rates (matches the DF badge), blue (`#3b9cff`) for non-drop. Hidden during bootstrap and in live mode until lock is acquired.

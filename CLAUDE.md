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
| `smpte-analyzer/src/ltcDecoder.js` | DSP: `LtcDecoder` (biphase decode with rolling state; `pendingFrames` queue for continuity tracking; `recentDecodeTimes` for dropout rate), `MultiRateDecoder` (parallel-rate auto-detection, `driftPpm()`, `dropoutPct()`, `medianFrameSpan()`, `detectedRateKey()`, `_checkFrameContinuity()`), `tcToFrameNumber()`, `tcString()`, `parseFrame`, rate key helpers |
| `smpte-analyzer/src/publisher.js` | Transport: reconnecting WebSocket `Publisher` class |
| `smpte-analyzer/src/tickWorker.js` | Tick source: Web Worker that fires `{type:"tick"}` at ~30 Hz, immune to tab-backgrounding throttle |
| `smpte-analyzer/public/ltc-worklet.js` | Audio thread: `LtcCapture` AudioWorklet that forwards every sample to the main thread (no drops) |
| `smpte-bridge/src/index.js` | WS fan-out: `/ingest` (single publisher), `/subscribe` (multi-subscriber broadcast), `/status` HTTP snapshot |

## Architecture

### Audio pipeline

1. `getUserMedia` (with `echoCancellation`, `noiseSuppression`, `autoGainControl` all off) opens the selected device.
2. `getOrCreateAudioContext()` lazily constructs a single `AudioContext` for the app's lifetime, registers the worklet module once, and reuses it across device switches. `stopAudio()` suspends the context (does not close it). Reusing one context is critical on macOS: each `new AudioContext()` triggers a fresh Core Audio negotiation that can switch the system output device when an audio interface is selected as input.
3. The single `AudioContext` hosts two parallel graphs from the same source node (mic or file):
   - `AnalyserNode` (fftSize 2048, `minDecibels=-120`, `maxDecibels=0`, `smoothingTimeConstant=0`) — used for RMS, peak, and FFT-based spectral metrics. Measurement-grade settings (not VU-visualisation defaults).
   - `AudioWorkletNode` (`ltc-capture`, `numberOfOutputs:0`) — forwards Float32 sample chunks to the main thread without opening any system output stream. The `numberOfOutputs:0` matters on macOS: connecting a node to `ctx.destination` would cause Core Audio to switch the system output when an audio interface is the input.
4. Wiring of source → analyser + worklet is encapsulated in `wireSourceToDecoder(ctx, source)`, which is shared between the live-mic path (`startAudioCapture`) and the file-playback path (`startFilePlayback`). `teardownCurrentSource()` tears down whatever source is currently active before a new one is wired.
5. The worklet's `port.onmessage` feeds samples to `MultiRateDecoder.feed()`.
6. `MultiRateDecoder` runs five `LtcDecoder` instances (24/25/30/50/60 fps) in parallel. Each decoder maintains rolling biphase decode state across chunks. Winner selection: `framesDecoded - bitErrors×0.1 + recencyBonus(1000 if frame < 500 ms old)`. The winner's `detectedRateKey()` maps decoded fps + dropFrame flag + median frame span to a SMPTE rate key string, distinguishing fractional rates (29.97 NDF, 23.976, 59.94 NDF) from integer counterparts.
   - After picking the winner, `MultiRateDecoder.feed()` drains the winner's `pendingFrames` queue and calls `_checkFrameContinuity()` per frame. A single 2048-sample worklet chunk (~42 ms at 48 kHz) can contain more than one LTC frame at 30 fps; checking `lastFrame` per chunk would miss intermediate frames and produce spurious JUMP breaks. Non-winner queues are discarded.
   - `_checkFrameContinuity()` uses `tcToFrameNumber()` to compute an absolute frame count and compares it to the previous count. Any delta other than +1 increments `continuityBreaks` and updates `lastBreak {type, delta, from, to, t}`. If the gap between consecutive decoded frames exceeds 500 ms, continuity state resets rather than reporting a spurious jump.
   - `dropoutPct(windowSec=2)` counts decoded frames in `recentDecodeTimes` within the window and divides by expected count (`windowSec × detected_actual_fps`). Returns 0–100 or null if not yet established.
   - `driftPpm()` uses the **mean** (not median) of `recentFrameSpans` for sub-sample precision. Per-frame span is integer-resolution; the median snaps to the nearest sample and produces hundreds-of-ppm bias for fractional rates; the mean recovers sub-sample precision from the natural jitter. `recentFrameSpans` is capped at 120 frames (~4 s at 30 fps). Median is still used for fractional/integer rate classification in both `driftPpm()` and `detectedRateKey()` (median is more robust to outliers for classification).
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

The 80-bit frame structure (BCD digits, flags, user bits, sync word `0011111111111101` at bits 64–79) is defined by SMPTE ST 12-1 Table 2. It is implemented in `parseFrame` in `ltcDecoder.js`. The simulation path in `App.jsx` does not decode frames — it generates timecode values directly via `framesToTc`. The README's "LTC Frame Structure" table is the reference if bit-field code needs to change.

### API publisher

`publisher.js` exports a `Publisher` class. `App.jsx` creates one instance when `apiEnabled` is true. On each tick it calls `publisher.send({type:"tc",...})`. On each error-state transition it calls `publisher.send({type:"error",...})`. The publisher handles reconnection with exponential back-off (1 s → 10 s max). The bridge sends `{type:"status"}` messages back; the app reads `msg.subscribers` from these to display the subscriber count.

Wire payload shapes:
- `tc` tick: `{type:"tc", t, seq, hh, mm, ss, ff, rate, dropFrame, source, levelDbFS, errors}` — `seq` is a publisher-monotonic counter appended by `Publisher.send()`. `rate` is the SMPTE rate key string (e.g. `"29.97df"`); `dropFrame` is boolean. Both rate fields are always present; they are redundant but explicit.
- `error` transition: `{type:"error", t, seq, tc, rate, errors}` — `tc` is a formatted string using `;` as the frame separator for drop-frame.
- `continuity` break: `{type:"continuity", t, seq, breakType, delta, from, to, rate}` — emitted per continuity break. `breakType` is `"REPEAT"` (delta = 0), `"JUMP"` (delta > 1), or `"REWIND"` (delta < 0). `from` and `to` are formatted timecode strings. Each break is also written to the session log with `errors: ["TC_REPEAT"|"TC_JUMP"|"TC_REWIND", "+Δ"]`.

## Conventions

- Plain React function components with hooks (`useState`, `useEffect`, `useRef`, `useCallback`) — no class components, no state library, no TypeScript.
- Tailwind-style utility classes are used inline. Fonts (`Share Tech Mono`, `Orbitron`, `B612 Mono`) load via a runtime CSS `@import` from Google Fonts inside `App.jsx`. The timecode display is hardcoded to `B612 Mono` (designed for aircraft cockpit displays). There is no runtime font picker.
- `App.jsx` is organized in layers top-to-bottom: spec constants → drop-frame helpers → DSP functions (`computeRMS`, `computePeak`, `linearToDB`, `readWavSampleRate`, `computeLtcSpectralMetrics`) → simulation generator → formatting helpers → shared style tokens → UI sub-components → root component. Preserve this layout when adding code.
- `smpte-analyzer` has no external runtime dependencies beyond React. `smpte-bridge` depends only on the `ws` package.
- Spec constants (`SMPTE_RATES`, `LEVEL_SPEC`) encode the standard. Do not adjust them to make things work; they are authoritative.
- `_snrBins` is a module-level `Float32Array` cache reused by `computeLtcSpectralMetrics` across ticks to avoid per-tick allocation. `timeBufRef` is a component-level ref serving the same purpose for `getFloatTimeDomainData`. `PANEL` is a module-level const for the standard panel box style; `buttonStyle(color, opts?)` is a helper for consistent button styling.
- `smoothedMetricsRef` holds `{ snr, thd, noiseFloor, driftPpm, dropoutPct }` — the EMA state for the five displayed live metrics. Reset to `null` on lock loss.
- `TimecodeDisplay` accepts a `dim` prop: when true, digits render in `#333` with no glow (used during bootstrap).
- The live error tag list is derived strictly from real level measurements (`CLIP`, `HOT`, `LOW`, `DROPOUT`). `NOISE` is not emitted in live mode; it appears only in the sim path from `generateSimulatedAnalysis`.
- Rate label next to the timecode is color-coded: orange (`#ffaa00`) for drop-frame rates (matches the DF badge), blue (`#3b9cff`) for non-drop. Hidden during bootstrap and in live mode until lock is acquired.

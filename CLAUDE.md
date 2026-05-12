# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

This repo contains two sub-projects:

- `smpte-analyzer/` — a Vite + React app implementing an SMPTE LTC analyzer per ST 12-1:2014 and ST 12-2:2014. Runs fully in the browser using the Web Audio API.
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
| `smpte-analyzer/src/App.jsx` | Root component: all React state, UI layout, audio capture setup, tick wiring, mode switching, session log, publisher integration |
| `smpte-analyzer/src/ltcDecoder.js` | DSP: `LtcDecoder` (biphase decode with rolling state), `MultiRateDecoder` (parallel-rate auto-detection), `parseFrame`, rate key helpers |
| `smpte-analyzer/src/publisher.js` | Transport: reconnecting WebSocket `Publisher` class |
| `smpte-analyzer/src/tickWorker.js` | Tick source: Web Worker that fires `{type:"tick"}` at ~30 Hz, immune to tab-backgrounding throttle |
| `smpte-analyzer/public/ltc-worklet.js` | Audio thread: `LtcCapture` AudioWorklet that forwards every sample to the main thread (no drops) |
| `smpte-bridge/src/index.js` | WS fan-out: `/ingest` (single publisher), `/subscribe` (multi-subscriber broadcast), `/status` HTTP snapshot |

## Architecture

### Audio pipeline

1. `getUserMedia` (with `echoCancellation`, `noiseSuppression`, `autoGainControl` all off) opens the selected device.
2. `getOrCreateAudioContext()` lazily constructs a single `AudioContext` for the app's lifetime, registers the worklet module once, and reuses it across device switches. `stopAudio()` suspends the context (does not close it). Reusing one context is critical on macOS: each `new AudioContext()` triggers a fresh Core Audio negotiation that can switch the system output device when an audio interface is selected as input.
3. The single `AudioContext` hosts two parallel graphs from the same `MediaStreamSource`:
   - `AnalyserNode` (fftSize 2048) — used for RMS, peak, and FFT-based SNR.
   - `AudioWorkletNode` (`ltc-capture`, `numberOfOutputs:0`) — forwards Float32 sample chunks to the main thread without opening any system output stream. The `numberOfOutputs:0` matters on macOS: connecting a node to `ctx.destination` would cause Core Audio to switch the system output when an audio interface is the input.
4. The worklet's `port.onmessage` feeds samples to `MultiRateDecoder.feed()`.
5. `MultiRateDecoder` runs five `LtcDecoder` instances (24/25/30/50/60 fps) in parallel. Each decoder maintains rolling biphase decode state across chunks. Winner selection: `framesDecoded - bitErrors×0.1 + recencyBonus(1000 if frame < 500 ms old)`. The winner's `detectedRateKey()` maps decoded fps + dropFrame flag to a SMPTE rate key string.
6. On each tick (~33 ms via Web Worker), `App.jsx` reads `decoderRef.current.lastFrame`. If the frame is less than 200 ms old, it is treated as live and its HH:MM:SS:FF populates the display. Otherwise the display shows zeros and LOCK turns off.

### Tick architecture

`tickWorker.js` runs `setInterval` in a Web Worker at 33 ms. `setInterval` and `requestAnimationFrame` in inactive tabs are throttled to ~1 Hz by browsers; the Worker is not. This keeps downstream API subscribers from stuttering when the tab loses focus.

### Mode switching

Switching between live and simulation modes calls `setUseRealAudio()`, which triggers a `useEffect` that clears `analysis`, resets `peakHold` to −60, and resets `peakDecayRef`. This ensures the displayed detection state (confidence bar, rate label, lock indicator) visibly clears and re-acquires on switch rather than carrying stale values over.

### SNR computation in live mode

`computeLtcSnr(analyser, sampleRate, nominalFps)` sums FFT bin power in the band `[bitRate×0.4, bitRate×1.6]` (where `bitRate = nominalFps × 80`) and compares it to average power per bin outside that band. It returns `null` if the spectrum is silent, which causes the SNR Gauge to display `—`. SNR is only computed when `ltcLocked` is true; otherwise both `snr` and `thd` are set to `null`.

### Bootstrap state

A `bootstrapping` flag is `true` from mount until either live audio successfully starts or the user explicitly switches to simulation mode. While `bootstrapping` is true:
- The simulator tick is skipped entirely (no wall-clock-derived timecode flashes on refresh).
- `TimecodeDisplay` receives `dim={true}`, rendering digits in `#333` with no glow.
- The LOCK badge is forced inactive.
- The orange rate label is hidden.
- A grey "○ STARTING — requesting audio input…" banner appears above the timecode card.
- The left controls panel shows a "STARTING" placeholder instead of SIMULATION CONTROLS or LIVE INPUT STATUS.

`bootstrapping` is cleared to `false` in `startAudioCapture()` on both success and failure paths.

### Two input modes

- **Live mode (default):** app calls `startAudioCapture()` on mount. Timecode digits come from the biphase decoder. If the browser blocks `getUserMedia` before a user gesture, the app surfaces an error and falls back to simulation mode.
- **Simulation mode:** accessed by clicking **SWITCH TO SIMULATED TIMECODE** in the audio input panel. `generateSimulatedAnalysis()` produces fake timecode and level data. The timecode card shows a fuchsia outline and a blinking **SIMULATING CODE** indicator.

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

## Conventions

- Plain React function components with hooks (`useState`, `useEffect`, `useRef`, `useCallback`) — no class components, no state library, no TypeScript.
- Tailwind-style utility classes are used inline. Fonts (`Share Tech Mono`, `Orbitron`) load via a runtime CSS `@import` from Google Fonts inside `App.jsx`.
- `App.jsx` is organized in layers top-to-bottom: spec constants → drop-frame helpers → DSP functions → formatting helpers → shared style tokens → UI sub-components → root component. Preserve this layout when adding code.
- `smpte-analyzer` has no external runtime dependencies beyond React. `smpte-bridge` depends only on the `ws` package.
- Spec constants (`SMPTE_RATES`, `LEVEL_SPEC`) encode the standard. Do not adjust them to make things work; they are authoritative.
- `_snrBins` is a module-level `Float32Array` cache reused by `computeLtcSnr` across ticks to avoid per-tick allocation. `timeBufRef` is a component-level ref serving the same purpose for `getFloatTimeDomainData`. `PANEL` is a module-level const for the standard panel box style; `buttonStyle(color, opts?)` is a helper for consistent button styling.
- `TimecodeDisplay` accepts a `dim` prop: when true, digits render in `#333` with no glow (used during bootstrap).

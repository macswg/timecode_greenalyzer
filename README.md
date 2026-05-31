# SMPTE Timecode Analyzer

A browser-based Linear Timecode (LTC) analyzer built to the SMPTE ST 12-1:2014 specification. It decodes and displays timecode from a live audio input, detects frame rate and drop-frame mode automatically, measures signal level, and flags error conditions including clipping, low level, noise, and dropout.

This tool reads **LTC only**. VITC (vertical interval timecode) and ATC (ancillary timecode embedded in SDI/HDMI) carry timecode in video, not audio, and cannot be analyzed here.

For a full list of every on-screen indicator and where its value comes from, see [`INDICATORS.md`](INDICATORS.md).

> ## ⚠️ Not for show-cue triggering
>
> This tool is for **viewing and analyzing** incoming timecode. It is **not** a show-control timecode source.
>
> Even though the bridge sidecar can re-broadcast the decoded timecode to other devices over WebSocket (and eventually OSC / Art-Net / MTC), the feed is intended for monitoring, logging, and debugging — not for driving live cues. The signal path runs through a browser tab, a Web Worker tick, and a Node fan-out; jitter, occasional dropped frames, and tab/permission interruptions are tolerable for analysis but **not** acceptable for cueing lights, audio playback, or video roll. Use a dedicated hardware or software timecode source (a slate, a deck, a chase device, or a purpose-built sync engine) for any production trigger path.

---

## Project Structure

```
timecode_greenalyzer/
├── smpte-analyzer/     Vite + React app — the analyzer UI
│   ├── src/
│   │   ├── App.jsx              Root component, UI, audio glue
│   │   ├── ltcDecoder.js        Biphase decoder, MultiRateDecoder, wall-clock carrier classifier
│   │   ├── cadenceDetector.js   FF-sequence cadence inference, DF skip detection
│   │   ├── dropFrame.js         Drop-frame math (framesToTc, dropPerMin)
│   │   ├── ltcSynth.js          LTC synthesizer (independent carrier / cadence knobs; wide + frame-pair)
│   │   ├── channelDetect.js     Auto-detect the LTC channel in a multi-channel file
│   │   ├── publisher.js         Reconnecting WebSocket publisher
│   │   └── tickWorker.js        Web Worker tick source
│   ├── public/
│   │   └── ltc-worklet.js       AudioWorklet sample capture (wall-clock stamped)
│   └── test/
│       ├── *.test.js            Unit tests (Vitest) — decoder, cadence, frame-pair, channel detect
│       └── manual/              On-demand harnesses over the testing_timecode WAVs (npm run test:manual)
└── smpte-bridge/       Node WS sidecar — fan-out to subscribers
    └── src/index.js
```

---

## Running the Analyzer

**Prerequisites:** Node.js 18 or later

```bash
cd smpte-analyzer
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. The app immediately attempts to open your default audio input. Grant microphone permission when prompted.

To use a real LTC source: connect a timecode output to an audio interface, then select that interface in the device picker inside the app.

---

## Running the Bridge Sidecar (optional)

The bridge is only needed if you want to forward the timecode feed to other applications on the network.

```bash
cd smpte-bridge
npm install
npm start
```

Listens on `:8765` by default. Set the `PORT` environment variable to override. See `smpte-bridge/README.md` for endpoints and message types.

To connect the analyzer to the bridge, enter the WebSocket URL (`ws://localhost:8765/ingest`) in the API PUBLISHER section of the UI and click PUBLISH.

---

## Specifications Referenced

| Standard | Title |
|---|---|
| SMPTE ST 12-1:2014 | Time and Control Code — Part 1: Linear Timecode (LTC) |

---

## What It Does

### Timecode Display

The main readout shows timecode in the standard `HH:MM:SS:FF` format. The frame separator character distinguishes drop-frame from non-drop-frame mode:

- `:` (colon) — non-drop-frame
- `;` (semicolon) — drop-frame

The display turns **red** when any error condition is active that would cause the timecode to be unreliable.

Three status flags appear alongside the display:

- **LOCK** — the decoder has a valid sync word and is reading frames correctly
- **DF** — drop-frame mode is active (bit 10 of the LTC frame is set)
- **CF** — color frame flag is set (bit 11 of the LTC frame)

---

### Carrier Rate and Counting Cadence (separate observations)

The analyzer detects all frame rates defined in SMPTE ST 12-1:

| Rate Key | Label | fps (exact) | Drop Frame |
|---|---|---|---|
| 23.976 | 23.976 ND | 24000/1001 | No |
| 24 | 24 ND | 24 | No |
| 25 | 25 ND | 25 | No |
| 29.97df | 29.97 DF | 30000/1001 | Yes |
| 29.97 | 29.97 ND | 30000/1001 | No |
| 30 | 30 ND | 30 | No |
| 50 | 50 ND | 50 | No |
| 59.94df | 59.94 DF | 60000/1001 | Yes |
| 59.94 | 59.94 ND | 60000/1001 | No |
| 60 | 60 ND | 60 | No |

The analyzer treats **carrier rate** (how fast frames physically arrive: integer 30 vs the 1.001-divided 29.97) and **counting cadence** (how the FF field counts and whether it skips at minute boundaries: DF / NDF) as two independent observations. They are decided by different mechanisms and only combined at the UI, so an off-spec source — e.g. an integer-30 carrier carrying a DF count — is correctly identified instead of being silently re-labeled.

**Candidate selection.** Five `LtcDecoder` instances run in parallel at 24/25/30/50/60 fps. The winner is scored on a **windowed** basis: frames decoded in the last 20 s plus a recency bonus for a frame decoded within the last 500 ms. Cumulative scoring was reverted because stale bit errors from a previous rate could keep the wrong decoder ahead for ~60 s after a real rate change.

**Counting cadence.** `CadenceDetector` (`src/cadenceDetector.js`) watches the decoded FF sequence and minute-boundary behaviour to infer the counting cadence (24/25/30/50/60) and whether the count drops frames at minute boundaries, without consulting carrier timing. The DF flag bit in the LTC frame is observed but not trusted — `dfFlagMatchesObservedCadence()` reports disagreement separately.

**Carrier rate — measurement-grade, wall-clock-referenced.** Distinguishing integer rates (30, 60, 24) from their 1.001-divided NTSC siblings (29.97, 59.94, 23.976) requires resolving a 1000 ppm gap. The previous classifier used sample-count timing, which is contaminated by the capture device's ADC clock running ±tens of ppm off nominal — that produced spurious flips every 6–14 s on clean 29.97 sources. The current classifier instead measures wall-clock frame arrival times referenced to the host quartz:

- The audio worklet stamps `performance.now()` at each chunk boundary; the decoder interpolates per-frame arrival times across the chunk.
- A least-squares regression of frame-index vs wall-clock-time runs over a 20 s **stable window** + 3 s **detector window**.
- **Commit rule:** the stable estimate must sit ≥5σ off the integer/fractional midpoint **and** produce 3 consecutive same-side measurements ≥1 s apart. Until committed, the rate label reads **MEASURING**.
- **Divergence rule:** once committed, the detector window watches for source rate changes; the same 5σ + 3-agreements hysteresis applies before invalidating the commit (genuine rate change confirmed in ~3–5 s; single-shot noise blips suppressed).
- **Hold:** on signal loss (>500 ms without a fresh frame) the committed classification is held for 5 s, then dropped back to MEASURING.

**NON-CONFORMANT warning.** `carrierCadenceMismatch()` raises a high-confidence warning when the observed carrier rate and counting cadence are inconsistent (e.g. integer-30 carrier carrying a DF count, or a fractional carrier carrying a 24-cadence count). The warning is suppressed while either side is still MEASURING so operators are not alarmed by transient states.

**AUDIT panel.** Collapsed by default under the LIVE INPUT STATUS readouts, the AUDIT panel exposes the raw measurement numbers behind the classification: measured fps with ±ppm uncertainty, window size, commit-state agreement counter, three drift readouts (see below), and the measured `performance.now()` resolution on the current browser. Engineers can audit the analyzer's conclusions instead of taking them on faith.

**Two drift readouts.** Both are measurement-grade:

- **Source → host quartz** (primary, in the LIVE INPUT STATUS panel) — deviation of the source clock from the host machine's quartz, derived from the wall-clock LSQ. EMA-smoothed. Thresholds: `<5 ppm LOCKED` (green), `5–500 ppm OK TO CHASE` (cyan), `>500 ppm CHECK RATE` (amber). Drift is a steady frequency offset; it does **not** affect chase-ability — chasing is governed by dropout rate and continuity, not by ppm. The host quartz is itself undisciplined (typically ±50 ppm absolute on consumer hardware), so this is drift relative to your machine's crystal, not absolute.
- **Source → ADC** (in the AUDIT panel) — drift derived from the capture device's sample count rather than host time. Compares the source against whatever clock drives the audio interface's ADC.
- **Capture clock error** (= host − ADC, with the LTC source as common reference) — surfaced in the AUDIT panel and flagged amber if it exceeds ±100 ppm, indicating a faulty interface, an in-line sample rate converter, or a mislabeled file rate.

---

### Drop Frame Validation

Drop-frame timecode compensates for the difference between 30 fps nominal and 29.97002997... fps actual (30000/1001) — and equivalently between 60 and 59.94 fps. Without compensation, timecode would drift from wall-clock time by approximately 3.6 seconds per hour at 29.97.

The drop-frame rule:

- At the start of each minute (`SS=00`), frames `00` and `01` are skipped (not recorded or displayed)
- **Exception:** frames are not skipped at every 10th minute (`MM=00, 10, 20, 30, 40, 50`)
- For 59.94 DF, frames `00`, `01`, `02`, and `03` are skipped instead of two

The analyzer validates every incoming frame number against this rule and flags frames that violate it as errors.

**Frame-to-sample conversion** uses the SMPTE drop-frame formula:

```
droppedFrames = dropPerMin × (totalMinutes − floor(totalMinutes / 10))
totalFrames = (nomFps × 3600 × HH) + (nomFps × 60 × MM) + (nomFps × SS) + FF − droppedFrames
```

---

### LTC Frame Structure

Linear Timecode is encoded as a **biphase mark** (bi-phase mark coding, or BMC) audio signal. Each LTC frame consists of **80 bits** carrying timecode digits, user bits, status flags, and a sync word.

At a high level, the 80 bits carry HH/MM/SS/FF as BCD digits, a drop-frame flag, a color-frame flag, three binary-group flags, eight 4-bit user-bit groups interleaved between the timecode digits, and a 16-bit sync word at the end of the frame. The bit-exact field layout is defined by the standard — see the ST 12-1 document, or any of the widely-available secondary descriptions (e.g. the Wikipedia "Linear timecode" article), for the per-bit field assignments. The actual bit positions consumed by this analyzer are visible in `parseFrame` in `smpte-analyzer/src/ltcDecoder.js`.

**High-frame-rate (HFR) handling — two 50/60 conventions (§12).** The standard 2-bit frame-tens field only encodes FF values 0–39, which is enough for cadences up to 30. At 50/60 fps there are two encodings in the wild, and the analyzer **auto-detects which a source uses** by watching the **field-mark flag** (bit 27 at 60-frame, bit 59 at 50-frame):

- **Wide LTC (de-facto).** FF labels every frame; bit 58 is read as a third frame-tens bit so FF can reach 79. The field-mark flag stays static. Used by several sound-recorder vendors (Tentacle, Ambient, some Sound Devices firmwares).
- **Frame-pair (spec-conformant ST 12-1 §12).** FF labels frame *pairs* (wraps at 24 for 50, 29 for 60), bit 58 is BGF1, and the per-field LSB rides in the field-mark flag, which toggles every frame. The analyzer reconstructs the true frame number as `FF_pair × 2 + field-mark`.

`MultiRateDecoder` classifies the source from the field-mark toggle pattern (`fieldMarkBehavior()`: TOGGLING → frame-pair, STATIC → wide) and decodes accordingly — so a conformant frame-pair source reads its true count instead of repeating each FF and throwing a continuity break every other frame. The **FIELD-MARK** readout in the UI shows which convention is in use. Caveat: a generator that puts the extra frame-tens MSB on a *different* bit (some use bit 35) will still mis-decode at FF≥40 in wide mode.

**Sync word** (bits 64–79): `0011111111111101`  
This 16-bit pattern is unique — it cannot occur in valid BCD timecode data or in the biphase encoding of any other legal bit sequence, which allows the decoder to frame-align reliably.

#### Biphase Mark Encoding

In biphase mark coding:
- Every bit begins with a transition (polarity change)
- A **`1` bit** has an additional transition at the mid-point of the bit cell
- A **`0` bit** has no mid-point transition

The decoder measures the time between transitions and classifies each interval as **short** (≈ half bit-cell, `1`) or **long** (≈ full bit-cell, `0`) using a recovered bit-clock model rather than a fixed tolerance window. A running estimate of the actual bit period (`sbEst`) is updated on every long interval, and each new interval is assigned to whichever expected value — `sbEst` or `2·sbEst` — it is closer to. Intervals that the classifier cannot confidently bucket are flagged as bit errors. This mirrors how hardware LTC chips behave once locked: they track the recovered bit clock and decide bit slots by phase, not by independent interval measurement against a fixed nominal. A frame-span sanity check additionally rejects any 80-bit sequence whose total sample span deviates more than ±3% from the expected span for the candidate rate — this catches 24 vs 25 fps cross-locks that per-interval classification alone cannot separate.

---

### Signal Level Analysis

LTC must be kept within a specific level range to decode reliably. Too hot and the signal clips the input stage, distorting the zero-crossings the decoder relies on. Too quiet and the signal-to-noise ratio drops below the threshold for reliable bit detection.

Level thresholds used by the analyzer (digital, dBFS):

| Threshold | dBFS | Meaning |
|---|---|---|
| Clip | > −1 | Input stage overload; zero-crossings distorted; decode will fail |
| Hot | > −6 | Above SMPTE recommended maximum; decode errors likely |
| Nominal | −18 | SMPTE recommended operating level |
| Low | < −30 | Below minimum reliable level; decoder may lose lock |
| Dropout / Silent | < −60 | No signal; complete loss of timecode |

The analyzer measures and displays:

- **RMS level** — average signal energy, the primary level indicator for LTC
- **Peak level** — instantaneous peak with hold and decay
- **Noise floor** — median power at biphase spectral nulls (frequencies between LTC harmonics where the coding guarantees no signal energy), in dB; shown only when locked
- **SNR** (Signal-to-Noise Ratio) — total signal-band energy vs noise-floor power projected across the same band, in dB; shown only when locked. EMA-smoothed for readability.
- **THD** (Total Harmonic Distortion) — classical √(ΣP_h)/√(P_1)×100 across the 3rd/5th/7th odd harmonics of the bit-rate-half fundamental; shown only when locked. LTC's near-square wave has ideal THD ≈ 38%; values above that baseline indicate added distortion.

---

### Continuity Detection

The analyzer checks that every decoded frame advances the timecode by exactly one frame (applying drop-frame rules at minute boundaries). Any deviation is a continuity break:

| Type | Delta | Cause |
|---|---|---|
| REPEAT | 0 | Same frame decoded twice — freeze frame in source playback |
| JUMP | > 1 | TC advanced by more than one frame — edit splice, dropout, or skip |
| REWIND | < 0 | TC went backwards — player rewind, freewheel reset, or non-monotonic generator |

The LIVE INPUT STATUS panel shows the break count over a **rolling 60-second window** (`CONTINUITY · 60s`), along with the most recent break detail when that break itself is still within the window. Older breaks scroll off the live count but remain in the session log. Gaps of 500 ms or more between decoded frames reset continuity tracking rather than producing a spurious JUMP across the gap; gaps of 3 s or more additionally clear the break counter on the resuming frame, treating a long signal stop as the start of a new run. Each break is also written to the session log and published over the API as a `{type:"continuity"}` message.

---

### Dropout Rate

A rolling 2-second window counts how many LTC frames were successfully decoded versus how many were expected at the detected rate. The percentage of missed frames is displayed in the LIVE INPUT STATUS panel.

| Status | Dropout % | Typical cause |
|---|---|---|
| CLEAN | < 1% | Every frame decoded; clean signal |
| OCCASIONAL | 1–10% | Minor head wear, marginal level |
| FREQUENT | 10–50% | Signal degraded but locked |
| SEVERE | > 50% | Near loss-of-lock |

---

### Error Detection

Five error conditions are monitored and displayed as illuminated badges:

| Badge | Color | Live condition | Sim condition |
|---|---|---|---|
| CLIP | Red | Signal > −1 dBFS | Level slider above −1 dBFS |
| HOT | Orange | Signal > −6 dBFS (and not CLIP) | Level slider above −6 dBFS |
| LOW | Amber | Signal < −30 dBFS | Level slider below −30 dBFS |
| DROPOUT | Pink | Signal < −60 dBFS | Level slider below −60 dBFS or random dropout roll |
| NOISE | Purple | Not emitted in live mode | Noise slider above 15% |
| DF_INVALID | Amber | A fresh frame asserts the DF flag but its FF lands where a DF count would have skipped (non-tenth-minute boundary) — the bit-10 flag is inconsistent with the count | Not emitted |
| AUDIO_GAP | Cyan | The capture worklet reported audio-thread starvation (a `process()` gap > 2.5× the quantum) within the last 2 s — a capture-side glitch, distinct from low signal | Not emitted |

In live mode the CLIP/HOT/LOW/DROPOUT tags come exclusively from real level measurements; DF_INVALID and AUDIO_GAP come from the decoded frame and the worklet respectively. NOISE is only active in simulation mode; in live mode signal quality is indicated by the SNR and THD gauges and the BIT ERRORS counter. When any error badge is active, the main timecode display turns red.

---

### Frame Integrity Map

A 20-column grid of 80 cells visualizes the bits of the most recently decoded LTC frame. Data bits (0–63) render in green; the sync word (bits 64–79) renders in cyan. Bit 10 (the DF flag) is marked with a `D` glyph so its state is readable at a glance. The cumulative bit-error count is shown below the grid.

---

### Frame Counter

The total number of frames analyzed and the cumulative error count are shown in the top-right corner. This allows assessment of error rate over time (e.g., intermittent dropout vs. sustained level problem).

---

### Session Log

The app maintains an in-session log that captures each distinct error-state transition, lock acquisition, continuity break, and carrier-rate event (MEASURING_COMMIT, RATE_CHANGE, DIVERGENCE) with timestamp (24-hour), timecode, rate, source (`live` / `file` / `sim`), level, and SNR. The log can be exported as CSV or JSON. Clearing the log also resets the error counter.

---

## Audio Input Modes

### Live Audio Mode (default)

On startup the app calls `getUserMedia` immediately and attempts to open the default audio input. If the browser blocks this before a user gesture (common in some browsers) or the user denies access, the app surfaces the error and falls back to simulation mode until the user clicks **CONNECT AUDIO INPUT**.

When live audio is active:
- A device picker (`enumerateDevices`) lets you select among all available audio inputs. Switching reopens the stream with the selected `deviceId`. The app listens for `devicechange` events and updates the list automatically. For multi-channel inputs, a channel picker selects which channel is tapped for LTC.
- An `AudioWorklet` (`ltc-worklet.js`) runs on the audio thread, forwards every sample to the main thread without drops, and stamps `performance.now()` at each chunk's start and end so the decoder can recover true wall-clock arrival time per frame independent of ADC sample-clock drift. The `MultiRateDecoder` (`ltcDecoder.js`) receives these samples and runs five `LtcDecoder` instances in parallel at 24/25/30/50/60 fps; the winner is scored on a 20 s rolling window of decoded frames plus a recency bonus for a frame within the last 500 ms.
- The timecode digits (HH:MM:SS:FF) shown in the display come directly from the decoded LTC frame. If no valid frame has been decoded within ~200 ms, the display shows `00:00:00:00` and LOCK turns off.
- SNR, THD, and noise floor are computed from the FFT (`computeLtcSpectralMetrics`) and only populated when locked; otherwise they show `—`. All three are EMA-smoothed (~0.5 Hz bandwidth, ~2 s settle) to reduce per-tick jitter.
- The CARRIER RATE line shows the committed classification (e.g. `29.97` or `30`), or **MEASURING** while the wall-clock classifier is still accumulating evidence; cadence (`DF` / `ND` / `ND?`) is displayed independently and turns red if it disagrees with the carrier (NON-CONFORMANT).
- The CLOCK DRIFT readout (source → host quartz) replaces the previous integer-rate-based drift number. See [Carrier Rate and Counting Cadence](#carrier-rate-and-counting-cadence-separate-observations) for the three drift readouts and thresholds.

To use with real LTC: connect a timecode source to an audio interface input and select that interface in the device picker.

### File Analysis Mode

The AUDIO INPUT panel accepts audio files via drag-and-drop anywhere on the panel, or by clicking **ANALYZE FILE…** / **REPLACE FILE**. The file is decoded by the Web Audio API and routed through the biphase decoder. The file loops continuously.

Key properties:
- The file is **never connected to `ctx.destination`** — it is silent on the system output (ANALYSIS ONLY · NO OUTPUT).
- For WAV files, the native sample rate from the file header is displayed alongside the context's resampled rate (Web Audio always resamples to the context's rate on decode).
- **Multi-channel files: the LTC channel is auto-detected on load.** Production files often carry LTC on one channel and program audio (dialog/music) on the others. The analyzer probes each channel through the decoder (`detectLtcChannel`) and selects the one that actually decodes LTC, instead of letting Web Audio down-mix them together. The auto-selected channel is marked with a green **AUTO** badge; the **CH** picker still lets you override.
- The decoder is fed by a deterministic, software-paced sample feeder (`startPacedDecoderFeed`) rather than the worklet path used for live input. Headless audio graphs deliver buffer-source samples in deferred bursts, which would otherwise contaminate the wall-clock LSQ classifier's per-frame timing.
- Session log entries from file analysis are tagged `file` (distinct from `live` and `sim`).
- The status label reads `FILE filename · Xs · LOOPED · ANALYSIS ONLY · NO OUTPUT` while a file is playing.
- Click **STOP FILE** to tear down file playback and return to live audio input.

### Simulation Mode

Click **SWITCH TO SIMULATED TIMECODE** (visible at the bottom of the audio input panel when in live mode with no file playing), or **CONNECT AUDIO INPUT** to enter live mode. The app defaults to LIVE mode, but simulation mode is available to explore behavior under controlled conditions.

In simulation mode:
- An internal LTC generator produces valid timecode at the selected frame rate.
- Three sliders inject conditions: **Signal Level** (−70 to 0 dBFS), **Noise / Distortion** (0–100%), and **Dropout Probability** (0–50% per frame).
- SNR and THD are synthetic estimates based on the noise slider. NOISE error tag is active when the noise slider exceeds 15%.

The timecode card gets a fuchsia outline and a blinking **SIMULATING CODE** indicator while in this mode.

---

## API Publisher

The app can publish timecode frames to the `smpte-bridge` sidecar over WebSocket. Enter the bridge URL in the **API PUBLISHER** section and click **PUBLISH**. The publisher reconnects automatically with exponential back-off if the bridge is not running.

Every tick emits a `{type:"tc"}` message. Each error-state transition emits a `{type:"error"}` message. Each continuity break emits a `{type:"continuity"}` message. See `smpte-bridge/README.md` for the full schema.

---

## License

Released under the [MIT License](LICENSE) © 2026 Sean Green. You are free to use, modify, and redistribute the code, including in commercial and proprietary work, provided the copyright notice and license text are retained in copies or substantial portions of the software.

---

## Revision History

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-05-12 | Initial release — LTC display, rate detection, level analysis, error flagging, simulation mode, live audio level measurement |
| 1.1 | 2026-05-12 | Live biphase decode wired (MultiRateDecoder + AudioWorklet); auto rate detection; device picker; API publisher; session log; Web Worker tick |
| 1.2 | 2026-05-12 | File-drop analysis path; `wireSourceToDecoder()` shared between mic and file paths; WAV native rate display; real SNR/THD/noise-floor via `computeLtcSpectralMetrics()`; EMA smoothing on gauges; clock drift/chase indicator; fractional rate detection (29.97 NDF / 23.976 / 59.94 NDF); frame-span sanity check; biphase tolerance tightened ±25% → ±15%; rate label color-coded (DF orange / NDF blue); B612 Mono timecode font; mobile responsive CSS; NOISE error tag removed from live mode |
| 1.3 | 2026-05-12 | Continuity detection (REPEAT / JUMP / REWIND break types, per-frame queue drain, 500 ms gap reset); dropout rate (2-second rolling window, CLEAN / OCCASIONAL / FREQUENT / SEVERE); drift uses mean of recentFrameSpans (not median) for sub-sample precision; recentFrameSpans cap raised 30 → 120 frames; lock indicator and LOCKED banner changed from cyan to green (`#00ff88`); 47.95 and 48 fps removed from SMPTE_RATES; ST 12-2 references removed; app header updated to `ST 12-1:2014 COMPLIANT · LTC`; file status label changed to `ANALYSIS ONLY · NO OUTPUT`; `{type:"continuity"}` API publisher message |
| 1.4 | 2026-05-25 | Carrier rate and counting cadence split into independent observations (`CadenceDetector` in its own module); measurement-grade wall-clock LSQ carrier classifier (worklet stamps `performance.now()` at chunk boundaries; LSQ regression over 20 s stable + 3 s detector windows; 5σ + 3-agreements commit and divergence rules; MEASURING state in UI); HFR frame layout support (FF up to 79 via bit 58 as frame-tens MSB, wide-LTC convention); `carrierCadenceMismatch()` raises high-confidence NON-CONFORMANT warning for off-spec sources (e.g. integer-30 carrier with DF count); AUDIT panel exposes raw measurement numbers; two drift readouts (source → host quartz primary, source → ADC diagnostic, CAPTURE CLOCK ERROR cross-check); LOCK_ACQUIRED log entries (5 s sustained requirement); file analysis uses deterministic software-paced decoder feeder; session log SRC column distinguishes `file` from `live`; session log timestamps in 24-hour; FRAME INTEGRITY grid marks DF flag (bit 10) with a `D` glyph; SMPTE SPEC REFERENCE panel documents every reported quantity; `ltcSynth.js` with independent carrier and cadence knobs; Vitest unit-test suite (55 tests) covering the new classifier. Closes #1 (30 DF detection) and #29 (measurement-grade carrier classification) |
| 1.5 | 2026-05-30 | Count-only error-reset button (zeroes the error tally without clearing the session log); headless `test/manual/` tc-test harness that verifies the TESTING.md test files through the real decoder; audio-clock → host offset tracking with periodic `getOutputTimestamp()` resample + EMA, so a one-shot offset taken while the main thread was busy can no longer push `lf.t` past the 200 ms freshness gate (#56) |
| 1.6 | 2026-05-31 | Spec-conformant ST 12-1 §12 **frame-pair decode** at 50/60 (field-mark flag carries the per-field LSB; true frame reconstructed as `FF_pair×2 + field-mark`; convention auto-selected from the field-mark toggle pattern; `ltcSynth` can generate both conventions) — closes #34; **auto-detect the LTC channel** on multi-channel file load (`detectLtcChannel`, with a manual CH override and AUTO badge) — closes #32; carrier classification **survives tab backgrounding** (signal-loss hold keys off frame delivery recency, not stamped time, so a backgrounding burst no longer drops the rate to MEASURING) — #51; **sample-rate readout no longer double-counts** (StrictMode-/race-safe audio setup stops a duplicate dev-mode capture worklet that read ~2× and falsely flagged RESAMPLED) |

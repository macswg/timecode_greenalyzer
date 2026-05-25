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
│   │   ├── App.jsx         Root component, UI, audio glue
│   │   ├── ltcDecoder.js   Biphase decoder, MultiRateDecoder
│   │   ├── publisher.js    Reconnecting WebSocket publisher
│   │   └── tickWorker.js   Web Worker tick source
│   └── public/
│       └── ltc-worklet.js  AudioWorklet sample capture
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

### Frame Rate Detection

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

In live audio mode, rate detection is fully automatic: five `LtcDecoder` instances run in parallel at 24/25/30/50/60 fps candidates and the winner is chosen by frames-decoded score. NDF vs DF is resolved from the drop-frame flag in the parsed frame. Fractional rates (29.97 NDF, 23.976, 59.94 NDF) are distinguished from their integer counterparts by comparing the median measured frame span against the integer-rate expected span at a 1.0005× threshold. A confidence bar shows the current lock strength.

---

### Drop Frame Validation

Drop-frame timecode compensates for the difference between 30 fps nominal and 29.97002997... fps actual (30000/1001) — and equivalently between 60 and 59.94 fps. Without compensation, timecode would drift from wall-clock time by approximately 3.6 seconds per hour at 29.97.

The drop-frame rule per **SMPTE ST 12-1 §7**:

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

Per **SMPTE ST 12-1 Table 2**, the 80-bit frame layout is:

| Bits | Field |
|---|---|
| 0–3 | Frame units (BCD) |
| 4–7 | User bits group 1 |
| 8–9 | Frame tens (BCD) |
| 10 | Drop frame flag |
| 11 | Color frame flag |
| 12–15 | User bits group 2 |
| 16–19 | Seconds units (BCD) |
| 20–23 | User bits group 3 |
| 24–26 | Seconds tens (BCD) |
| 27 | Biphase mark phase correction bit |
| 28–31 | User bits group 4 |
| 32–35 | Minutes units (BCD) |
| 36–39 | User bits group 5 |
| 40–42 | Minutes tens (BCD) |
| 43 | Binary group flag BGF0 |
| 44–47 | User bits group 6 |
| 48–51 | Hours units (BCD) |
| 52–55 | User bits group 7 |
| 56–57 | Hours tens (BCD) |
| 58 | Binary group flag BGF1 — **or** frame-tens MSB in the HFR variant (see below) |
| 59 | Binary group flag BGF2 |
| 60–63 | User bits group 8 |
| 64–79 | Sync word: `0011111111111101` |

**High-frame-rate (HFR) variant.** The standard 2-bit frame-tens field only encodes FF values 0–39, which is enough for cadences up to 30. SMPTE ST 12-1:2014 §6.6 defines an HFR variant for 50/60-fps systems that repurposes bit 58 (formerly BGF1) as a third frame-tens bit, expanding the field to 3 bits so FF can reach 79.

This analyzer always reads bit 58 as part of frame tens, in every decoded frame, regardless of detected rate. Caveats to be aware of:

- A strictly-spec-conformant generator at a ≤30 cadence that uses binary group flags will mis-decode FF whenever BGF1 happens to be set. The analyzer does not surface binary group flag data anywhere, so the practical impact is limited, but it's a real departure from the standard variant.
- Real-world HFR generators are not unanimous about which bit becomes the extra frame-tens MSB. Some vendors use bit 35 or bit 59 instead of bit 58. We follow ST 12-1:2014 (bit 58). A generator that uses a different bit will mis-decode at FF≥40; that's a per-vendor compatibility issue, not an analyzer bug.

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

In live mode the CLIP/HOT/LOW/DROPOUT tags come exclusively from real level measurements. NOISE is only active in simulation mode; in live mode signal quality is indicated by the SNR and THD gauges and the BIT ERRORS counter. When any error badge is active, the main timecode display turns red.

---

### Bit Integrity Map

An 8×8 grid of 64 cells visualizes the bit-error distribution across recent frames. Each cell represents a decoded bit region; red cells indicate a detected error (short transition, long gap, or sync word mismatch). The total error count is shown below the grid.

---

### Frame Counter

The total number of frames analyzed and the cumulative error count are shown in the top-right corner. This allows assessment of error rate over time (e.g., intermittent dropout vs. sustained level problem).

---

### Session Log

The app maintains an in-session error log that captures each distinct error-state transition with timestamp, timecode, rate, source (live or sim), and level. The log can be exported as CSV or JSON. Clearing the log also resets the error counter.

---

## Audio Input Modes

### Live Audio Mode (default)

On startup the app calls `getUserMedia` immediately and attempts to open the default audio input. If the browser blocks this before a user gesture (common in some browsers) or the user denies access, the app surfaces the error and falls back to simulation mode until the user clicks **CONNECT AUDIO INPUT**.

When live audio is active:
- A device picker (`enumerateDevices`) lets you select among all available audio inputs. Switching reopens the stream with the selected `deviceId`. The app listens for `devicechange` events and updates the list automatically.
- An `AudioWorklet` (`ltc-worklet.js`) runs on the audio thread and forwards every sample to the main thread without dropping any between reads. The `MultiRateDecoder` (`ltcDecoder.js`) receives these samples and runs five `LtcDecoder` instances in parallel at 24/25/30/50/60 fps. The winner is selected by score (frames decoded minus a weighted bit-error penalty, with a recency bonus for frames decoded within the last 500 ms).
- The timecode digits (HH:MM:SS:FF) shown in the display come directly from the decoded LTC frame. If no valid frame has been decoded within ~200 ms, the display shows `00:00:00:00` and LOCK turns off.
- SNR, THD, and noise floor are computed from the FFT (`computeLtcSpectralMetrics`) and only populated when locked; otherwise they show `—`. All three are EMA-smoothed (~0.5 Hz bandwidth, ~2 s settle) to reduce per-tick jitter.
- A **Clock Drift** indicator in the LIVE INPUT STATUS panel shows deviation of the measured frame period from the exact expected SMPTE rate in parts-per-million. States: `SOLID` (<5 ppm, green), `DRIFTING` (5–50 ppm, orange), `OFF-RATE` (>50 ppm, red).

To use with real LTC: connect a timecode source to an audio interface input and select that interface in the device picker.

### File Analysis Mode

The AUDIO INPUT panel accepts audio files via drag-and-drop anywhere on the panel, or by clicking **ANALYZE FILE…** / **REPLACE FILE**. The file is decoded by the Web Audio API and routed through the same biphase decoder as a live input. The file loops continuously.

Key properties:
- The file is **never connected to `ctx.destination`** — it is silent on the system output (ANALYSIS ONLY · NO OUTPUT).
- For WAV files, the native sample rate from the file header is displayed alongside the context's resampled rate (Web Audio always resamples to the context's rate on decode).
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

## Revision History

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-05-12 | Initial release — LTC display, rate detection, level analysis, error flagging, simulation mode, live audio level measurement |
| 1.1 | 2026-05-12 | Live biphase decode wired (MultiRateDecoder + AudioWorklet); auto rate detection; device picker; API publisher; session log; Web Worker tick |
| 1.2 | 2026-05-12 | File-drop analysis path; `wireSourceToDecoder()` shared between mic and file paths; WAV native rate display; real SNR/THD/noise-floor via `computeLtcSpectralMetrics()`; EMA smoothing on gauges; clock drift/chase indicator; fractional rate detection (29.97 NDF / 23.976 / 59.94 NDF); frame-span sanity check; biphase tolerance tightened ±25% → ±15%; rate label color-coded (DF orange / NDF blue); B612 Mono timecode font; mobile responsive CSS; NOISE error tag removed from live mode |
| 1.3 | 2026-05-12 | Continuity detection (REPEAT / JUMP / REWIND break types, per-frame queue drain, 500 ms gap reset); dropout rate (2-second rolling window, CLEAN / OCCASIONAL / FREQUENT / SEVERE); drift uses mean of recentFrameSpans (not median) for sub-sample precision; recentFrameSpans cap raised 30 → 120 frames; lock indicator and LOCKED banner changed from cyan to green (`#00ff88`); 47.95 and 48 fps removed from SMPTE_RATES; ST 12-2 references removed; app header updated to `ST 12-1:2014 COMPLIANT · LTC`; file status label changed to `ANALYSIS ONLY · NO OUTPUT`; `{type:"continuity"}` API publisher message |

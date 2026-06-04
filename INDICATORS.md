# Indicator Reference

Every indicator in the SMPTE Timecode Analyzer is sourced from a real
measurement of the incoming signal. When a metric is undefined for the current state (e.g. SNR with no LTC
locked), the indicator shows `—` rather than a fake number.

This document lists every indicator, where its value comes from, and what
it means.

## Mode conventions

Three modes drive the analyzer:

- **Live mode (default):** audio flows from the selected mic input through the
  `AudioWorklet` to `MultiRateDecoder`. Indicators are computed from the
  decoded LTC frames and from the FFT/time-domain analysis of the live
  buffer.
- **File analysis mode:** an audio file dropped or picked via the AUDIO INPUT
  panel is decoded once via `decodeAudioData`, then fed to the biphase
  decoder by a deterministic software-paced feeder (`startPacedDecoderFeed`)
  rather than the worklet — headless audio graphs deliver buffer-source
  samples in deferred bursts, which would otherwise contaminate the
  wall-clock carrier classifier's per-frame timing. All real-signal
  indicators work the same as in live mode. The file loops continuously and
  is silent on system output (never connected to `ctx.destination`).
  Session log entries from this mode are tagged `file`.
- **Simulation mode:** the user has clicked **SWITCH TO SIMULATED
  TIMECODE**. The internal generator (`generateSimulatedAnalysis`) drives
  the display. Indicators that depend on real LTC decode (bit map, rate
  candidate bars, bit clock, SNR, noise floor, THD) show `—` or empty
  states — there is no real signal to measure.

A `—` means "no defined value" for the current state. Indicators do not
hide; they show their dim state so the layout stays stable.

---

## Timecode display

| Indicator | Live source | Sim source |
|---|---|---|
| `HH:MM:SS:FF` digits | Most recent decoded LTC frame (`lastFrame.hh/mm/ss/ff`) | Wall-clock-derived simulated TC |
| Frame separator (`:` vs `;`) | Decoded `dropFrame` flag from bit 10 of the frame | Picked rate's `dropFrame` |
| Digit color | Green only when `frameValid === true` (fresh frame within 200 ms **and** no real error tags); red otherwise; `#333` dim during bootstrap | Same |
| **LOCK** status badge | Active only when `frameValid === true` — requires positive evidence of a valid frame, not just absence of "false" | Always inactive |
| **DF** status badge | Decoded `dropFrame` flag bit (bit 10 of the LTC frame) | Picked rate's drop-frame flag |
| **CF** status badge | Decoded `colorFrame` flag bit (bit 11 of the LTC frame) | Hardcoded false |
| Carrier rate label | `MultiRateDecoder.carrierRate()` — committed integer-vs-fractional classification from the wall-clock LSQ classifier. Returns `null` until 5σ + 3-agreements have committed; while uncommitted a **MEASURING…** tag is shown next to the label. Color: orange (`#ffaa00`) when cadence is DF, blue (`#3b9cff`) otherwise. Hidden during bootstrap. | Picked rate from dropdown. Same color rule. |
| Cadence label (`DF` / `ND` / `ND?`) | `CadenceDetector` (`cadence().dropFrame` plus `dropFrameKnown`) — observed independently from carrier timing by watching the FF sequence and minute-boundary behaviour. Renders red when `carrierCadenceMismatch().result === true` at high confidence. | Picked rate's drop-frame flag |
| `MEASURING…` / `DETECTED` / `DETECTING…` tag | `MEASURING…` (orange) while locked but the carrier classifier hasn't committed; `DETECTED` (cyan) when locked and committed; `DETECTING…` when no lock yet | Hidden |
| `⚠ NON-CONFORMANT` line | `carrierCadenceMismatch()` with `result === true` and `confidence === "high"`. Shown only at high confidence so MEASURING states don't fire false alarms. Text contains the specific reason (e.g. `integer 30 fps carrier carrying DF count`). | Hidden |
| `⚠ DF FLAG BIT DISAGREES WITH COUNT BEHAVIOUR` line | `cadence().dfFlagMatches === false` — the parsed bit-10 DF flag from the LTC frame contradicts the cadence inferred from FF behaviour. The bit itself is observed but not trusted as ground truth. | Hidden |

---

## Banners above the timecode card

- `○ STARTING — requesting audio input…` — shown during the bootstrap
  window between page load and the first resolved `getUserMedia` result.
- `● LTC LOCKED · N FRAMES DECODED` — live, locked. Green (`#00ff88`). `N`
  is the cumulative frame count from the winning decoder.
- `○ NO LTC SIGNAL — feed valid LTC into the selected input` — live, no
  fresh decode. Either no signal or wrong rate / level.
- `▲ SIMULATING CODE` — simulation mode (fuchsia, blinking, with matching
  outline on the timecode card).

---

## SIGNAL LEVEL panel

| Indicator | Live source | Notes |
|---|---|---|
| **RMS** meter | `20·log₁₀(computeRMS(buf))` on the live time-domain buffer | dBFS |
| **PEAK** meter | `20·log₁₀(computePeak(buf))` on the live time-domain buffer | dBFS. Peak-hold marker latches only on a strictly higher peak, holds for 10 s, then decays toward current at ~20 dB/s. Equal-or-lower peaks do **not** reset the timer (otherwise LTC's stable per-edge transients would pin the marker forever) |
| **SNR** gauge | `computeLtcSpectralMetrics()` — total signal-band power [0.4–1.6×bitRate] vs noise-floor power projected across that same band. Noise floor sampled at biphase spectral nulls `(h+0.5)×f1`. | In dB. **Computed only when locked.** `—` otherwise. EMA-smoothed (~0.5 Hz). Gauge thresholds: ≥15 green, 10–15 orange, <10 red. (Numbers are lower than classical audio SNR because Blackman-window leakage limits the measurable floor.) |
| **THD** gauge | `computeLtcSpectralMetrics()` — `√(P3+P5+P7)/√(P1)×100` for 3rd/5th/7th odd harmonics of `bitRate/2` fundamental. | In %. **Computed only when locked.** `—` otherwise. EMA-smoothed. LTC ideal ≈38%; above that indicates added distortion. Gauge thresholds: ≤50% green, 50–70% orange, >70% red. |
| **NOISE FLOOR** readout | `10·log₁₀(median null-bin linear power)` — median of bins at biphase spectral nulls `(h+0.5)×f1` | In dB. **Computed only when locked.** `—` otherwise. EMA-smoothed. |

Threshold colors (from `LEVEL_SPEC` in `App.jsx`):
clip ≥ −1 dBFS · hot ≥ −6 · nominal −18 · low < −30 · dropout < −60.

---

## RATE DETECTION panel

The `MultiRateDecoder` runs five `LtcDecoder` instances in parallel at
candidate fps 24, 25, 30, 50, 60. The winner is the one with the highest
**windowed** score:

```
score = framesDecodedInLast20s + (recencyBonus 1000 if frame < 500 ms old)
```

The window matters: cumulative scoring kept the previous winner in front
for ~60 s after the input rate changed on the same device, because the
old decoder had thousands of accumulated frames while the new correct
decoder had thousands of accumulated *bit errors* from running against
the wrong rate. A windowed count decays naturally across the change.

The integer-vs-fractional decision (e.g. 30 vs 29.97) is **not** made by
the winner score; it is made by the separate wall-clock LSQ classifier
(see below). Until that classifier commits, `detectedRateKey()` returns
`null` and the UI shows MEASURING.

| Indicator | Source |
|---|---|
| **DETECTED RATE** bar | Single bar showing the current winning candidate. Fill = `min(100, framesDecodedInLast20s × 100/60)` — reaches 100% after ~60 clean frames within the rolling window |
| Rate label next to bar | `SMPTE_RATES[detectedRateKey()].label`, or `—` while MEASURING |
| Active dot (green ●) | Present once the winner exists |
| **CONFIDENCE** bar (TIMECODE card) | `100 − dropoutPct(2 s window)`, clamped 0–99.5 (falls back to 25 for the first ~0.5 s before the window has data). Tracks **recent** decode quality so it self-clears within a couple of seconds after a rate change, rather than waiting ~60 s for cumulative bit-error counts to wash out |

In sim mode the picked rate's bar shows scaled by the sim's confidence proxy.

---

## FRAME INTEGRITY panel

### LAST FRAME · 80 BITS

Renders the most recent successfully decoded LTC frame as a 20×4 grid of
cells of the 80-bit LTC frame:

- **Bits 0–63** — user / timecode payload bits. Green-filled = 1, dim = 0.
- **Bits 64–79** — the fixed 16-bit sync word `0011111111111101`. Cyan-filled
  = 1, dim cyan = 0. A successful decode requires this pattern, so when
  locked these bits always match.
- **Bit 10 (DF flag)** — overlaid with a `D` glyph. The glyph is black on
  the green fill when the flag is set, orange on the dim background when
  it is cleared, so the DF bit's state is readable at a glance.
- **No frame yet** — all cells dim grey.

Tooltips show bit index, sync-word / DF-flag membership, and decoded value.

| Below-grid readout | Source |
|---|---|
| `N cumulative bit errors` | `MultiRateDecoder.bitErrors` — total intervals from the winner decoder that the recovered bit-clock classifier could not assign to either a short (half-bit-cell) or long (full-bit-cell) slot |
| `no frame decoded yet` | Shown when `lastFrameBits` is null |

### Sub-readouts

| Field | Live source |
|---|---|
| **SYNC WORD** | `VALID` iff `ltcLocked`. The decoder's `parseFrame` only returns non-null when the 16-bit sync word at positions 64–79 exactly matches `0011111111111101`, so a lock implies a valid sync |
| **BIT ERRORS** | Cumulative count from the winning decoder. Non-zero turns the number amber |
| **BIT CLOCK** | `LOCKED` iff `ltcLocked`, else `UNLOCKED` |
| **FRAMES DECODED** | `MultiRateDecoder.framesDecoded` since the decoder was instantiated (i.e. since this audio session started) |

In sim mode every field shows `—` — frame integrity is meaningless without
a real biphase decode pass.

---

## Error tag row

In live mode, each tag is derived from a measured condition, never from
randomness or sim slider defaults:

| Tag | Live condition | Sim condition |
|---|---|---|
| **CLIP** | `lvl > −1 dBFS` | Level slider > −1 dBFS |
| **HOT** | `lvl > −6 dBFS` (and not CLIP) | Level slider > −6 dBFS |
| **LOW** | `lvl < −30 dBFS` | Level slider < −30 dBFS |
| **DROPOUT** | `lvl < −60 dBFS` | Level slider < −60 dBFS or random dropout roll |
| **NOISE** | **Not emitted in live mode** | Noise slider > 15% |
| **DF_INVALID** | Fresh frame asserts the DF flag but its FF fails `isValidDropFrame()` (lands where a DF count would have skipped, at a non-tenth-minute boundary) — bit-10 flag inconsistent with the count | Not emitted |
| **AUDIO_GAP** | Worklet reported a `process()` gap > 2.5× the quantum within the last 2 s (audio-thread starvation) — a capture-side glitch, distinct from low signal | Not emitted |

In live mode NOISE is intentionally absent. Signal quality in live mode is
reported by the SNR and THD gauges and the BIT ERRORS counter — a boolean
NOISE tag based on a crest-factor proxy or SNR threshold would be misleading.

In sim mode the tags are driven by the sim error model, since that is the
sim's purpose.

---

## LIVE INPUT STATUS panel

| Row | Source |
|---|---|
| **LOCK STATE** | `● LOCKED` (green `#00ff88`) / `○ NO SIGNAL` from `ltcLocked` |
| **FRAMES DECODED** | `MultiRateDecoder.framesDecoded` |
| **BIT ERRORS** | `MultiRateDecoder.bitErrors` |
| **INPUT LEVEL** | Shows `—` — `analysis.rmsDbFS` is not populated in the live path; the meters in SIGNAL LEVEL are the source of truth |
| **SAMPLE RATE** | Live mic: `{measured} Hz measured · {nominal} Hz nominal · RESAMPLED`. `measured` is the true sample-delivery rate counted from the capture worklet over wall-clock (ground truth — what's actually reaching the decoder); `nominal` is the device's declared rate (`getSettings().sampleRate`) and the `RESAMPLED` flag are shown only when the two diverge by more than 1% of nominal — i.e. an actual sample-rate converter in the chain (the OS resampling the input; the closest standard-rate pair, 44.1 k↔48 k, is already 3900 Hz ≈ 8% apart), not the few-Hz ADC-vs-host-quartz clock offset that's normal on any interface (that's surfaced in ppm as **CAPTURE CLOCK ERROR**). The flag is sticky with hysteresis (on >1%, off <0.5%) so it can't flicker at the boundary. When a file is playing: `{fileNativeRate} Hz file · {ctx.sampleRate} Hz decoded` — native parsed from the WAV RIFF header by `readWavSampleRate()`; non-WAV files show only the decoded rate |
| **CLOCK DRIFT** | `MultiRateDecoder.driftPpmSourceVsHostQuartz()`, EMA-smoothed. Deviation of the source LTC clock from the host machine's quartz (derived from the wall-clock LSQ that drives carrier classification — immune to capture-device ADC bias). `—` until the classifier has committed. States: `<5 ppm LOCKED` (green) · `5–500 ppm OK TO CHASE` (cyan) · `>500 ppm CHECK RATE` (amber — large enough to imply a mis-detected rate). The host quartz is itself undisciplined (typically ±50 ppm absolute on consumer hardware), so this is drift relative to the host crystal, not absolute. A second drift readout (source → ADC) and the difference (CAPTURE CLOCK ERROR) live in the AUDIT panel. |
| **DROPOUT RATE** | `MultiRateDecoder.dropoutPct(2)`, EMA-smoothed. Percentage of expected frames not decoded over a rolling 2-second window: `100 × (1 − decoded / (window_sec × detected_fps))`. `—` until the winner is established. States: `CLEAN` (<1%, green) · `OCCASIONAL` (1–10%, orange) · `FREQUENT` (10–50%, amber) · `SEVERE` (>50%, red) |
| **CONTINUITY · 60s** | Count of frames in a **rolling 60-second window** where `HH:MM:SS:FF` did not advance by exactly one frame (drop-frame rules applied). Green `● CONTINUOUS · 0 BREAKS` when clean. Amber `N BREAKS · last: TYPE ±Δ @ HH:MM:SS:FF` when at least one break is in-window (the `last: …` detail is shown only when `lastBreak` itself is within the 60 s window). Break types — `REPEAT` (delta = 0, freeze frame), `JUMP` (delta > 1, edit splice / dropout), `REWIND` (delta < 0, rewind / freewheel reset). The full break history is still in the session log. Gaps ≥ 500 ms between decoded frames reset continuity *tracking* (not the counter) to avoid a spurious JUMP across the gap; gaps ≥ 3 s also clear the break counter on the resuming frame, on the basis that a long signal stop starts a new run. |

---

## AUDIT panel

Collapsed by default under the LIVE INPUT STATUS readouts. Exposes the
raw measurement numbers behind the carrier classification so an engineer
can audit the analyzer's conclusions instead of taking them on faith.

| Row | Source |
|---|---|
| **MEASURED FPS** | `carrierObservation().stable.fps`, with its 1σ uncertainty expressed in ppm of the nominal rate (`stable.sigmaFps`). σ is floored by the `performance.now()` quantization to prevent over-confidence when residuals happen to be tiny |
| **WINDOW** | `stable.n` frames over `stable.spanSec` seconds — the stable LSQ window. Fills toward the 20 s target as code rolls |
| **CLASS** | `fractional / integer` plus `classConfidence`, or `MEASURING (k/3)` while the agreement counter is accumulating toward the 3-agreements commit threshold |
| **SOURCE → HOST QUARTZ** | Same value as the LIVE INPUT STATUS CLOCK DRIFT row; shown again here for context next to the other drifts. Positive = source faster than host crystal |
| **SOURCE → ADC** | `driftPpmSourceVsAdc()` — drift derived from the capture device's sample count instead of host time. Compares the source against whatever clock drives the audio interface's ADC |
| **CAPTURE CLOCK ERROR** | `captureClockErrorPpm()` = host − ADC drift with the LTC source as the common reference. Row turns amber if magnitude exceeds 100 ppm — a healthy capture chain should agree within tens of ppm, so a large value suggests a faulty interface, an in-line sample rate converter, or a mislabeled file rate |
| **FIELD-MARK** | `fieldMarkBehavior()` at 50/60 fps — `TOGGLING · frame-pair LTC` (green) when the field-mark flag (bit 27 @ 60, bit 59 @ 50) toggles every frame (spec ST 12-1 §12; the decoder reconstructs the true frame as `FF_pair×2 + field-mark`), `STATIC · wide LTC (de-facto)` (amber) when it doesn't (FF labels every frame, bit 58 as frame-tens MSB), or `—` outside 50/60 / while still gathering samples. The decoder follows this to pick its FF interpretation (#34) |
| **USER BITS** | The eight 4-bit user-bit groups (UB1..UB8) of the last frame, as hex. `—` with no live frame. Raw bits only — semantic decoding (e.g. ST 309 date/time) is left to downstream consumers |
| **BGF 0/1/2** | The three binary-group flag bits, whose positions are rate-dependent. BGF1 is `null` at 50/60 in wide mode (bit 58 is the frame-tens MSB there) but a real value in frame-pair mode |
| **perf.now() RES** | Probed quantization of `performance.now()` on this browser / cross-origin-isolation context. Bounds the σ floor for the carrier classifier; 100 µs is typical, 1 ms means the browser is coarse-clamping clocks for Spectre mitigation |

---

## AUDIO INPUT panel

The panel accepts drag-and-drop of audio files anywhere on its surface (cyan dashed outline on dragover).

**When in live mic mode:**
- **DEVICE** dropdown — populated by `navigator.mediaDevices.enumerateDevices()`, filtered to `audioinput`. Selecting a different device tears down the previous stream and rebuilds the source + worklet on the same `AudioContext` (so the system output is not re-negotiated). Only shown in live mic mode (hidden while a file is playing).
- **CH** dropdown — shown only for multi-channel inputs (and multi-channel files). Selects which channel is tapped for LTC; a `ChannelSplitter` taps that one channel at unity, avoiding Web Audio's default down-mix (which would sum program audio into the code and read ~6 dB low). For files the LTC channel is **auto-detected on load** (`detectLtcChannel` probes each channel through the decoder) and marked with a green **AUTO** badge; picking a different channel clears the badge (#32).
- **● LIVE** indicator — active when a real mic stream is open.
- **↻** button — refreshes the device list manually; the analyzer also listens for `devicechange` events.

**File row (always visible):**
- **FILE** label + **⇧ ANALYZE FILE…** / **⇧ REPLACE FILE** button — opens a file picker. Routes the file through `startFilePlayback()` → `wireSourceToDecoder()`.
- **■ STOP FILE** button — visible only while a file is playing; returns to live mic input.
- When a file is playing: header row shows `FILE {name} · {Xs} · LOOPED · ANALYSIS ONLY · NO OUTPUT`. The file is never connected to `ctx.destination`.
- "drop a file on this panel" hint always visible as a reminder.

**▲ SWITCH TO SIMULATED TIMECODE** — only shown in live mode when no file is playing.

---

## API PUBLISHER panel

- **URL field** — destination WebSocket for `/ingest` on the bridge sidecar.
- **▶ PUBLISH / ■ STOP** — toggles the `Publisher` instance.
- **Connection state** — `● CONNECTED · N SUBS` / `◐ CONNECTING…` /
  `○ RECONNECTING…` / `○ OFFLINE`. The subscriber count comes from
  `{"type":"status"}` heartbeats the bridge sends back over the same
  socket.

The published wire format is documented in
[`smpte-bridge/README.md`](smpte-bridge/README.md).

---

## SESSION LOG panel

- **Entry count** — total logged events since session start.
- **ERROR EVENTS** — count of error-set transitions; cumulative since
  session start / CLEAR.
- **FRAMES** — total tick count (≈30 Hz) since the session started.
- **CSV / JSON export buttons** — download a file containing every logged
  event with ISO timestamp, decoded TC, rate, source (`live` / `file` /
  `sim`), level in dBFS, SNR, and the event/error tag list.
- **CLEAR button** — empties the log and resets the error counter and
  session start time.

Logged event types include error-set transitions (deduped — 30 ticks/s
of CLIP doesn't produce 30 rows), `LOCK_ACQUIRED` (after 5 s sustained
lock), `MEASURING_COMMIT` / `RATE_CHANGE` / `DIVERGENCE` from the carrier
classifier, periodic `CARRIER_SNAPSHOT` heartbeats (every 30 s with the
current measurement and drift numbers), and continuity breaks
(`TC_REPEAT` / `TC_JUMP` / `TC_REWIND`). On-screen timestamps render in
24-hour format.

---

## What we deliberately don't show

- **A free-running synthetic "bit clock" indicator.** The old version had a
  `BIT CLOCK: LOCKED` line that was always green regardless of state.
  Removed — the real lock state is in `BIT CLOCK: LOCKED/UNLOCKED` derived
  from `ltcLocked`.
- **`LTC TYPE: LINEAR` static label.** This analyzer only decodes linear
  timecode; the label was informational but not measured. Removed.
- **Randomly jittered peak level in live mode.** Previously the sim's
  `Math.random() × 3 − 1.5` jitter was applied even when live audio was
  flowing. The peak meter now reflects the actual time-domain peak from
  `computePeak()`.
- **Random per-cell error blocks in the bit map.** Replaced with the actual
  80 decoded bits.
- **Random inactive-rate bar widths in Rate Detection.** Replaced with
  real candidate-decoder frame counts.
- **`DROPOUT` / `NOISE` error tags driven by sim-slider state.** In live
  mode these now come from real `lvl` and real SNR.

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
  panel is decoded and routed through the same `wireSourceToDecoder` path as
  live audio. The decoder and all real-signal indicators work identically. The
  file loops continuously and is silent on system output (never connected to
  `ctx.destination`).
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
| Detected rate label | `MultiRateDecoder.detectedRateKey()` — fps from winning candidate + DF flag. **Color: orange (`#ffaa00`) for drop-frame rates, blue (`#3b9cff`) for non-drop.** Hidden during bootstrap; in live mode hidden until lock acquired. | Picked rate from dropdown. Same color rule applies. |
| `DETECTED` / `DETECTING…` tag | Cyan when locked, grey otherwise | Hidden |

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
| **PEAK** meter | `20·log₁₀(computePeak(buf))` on the live time-domain buffer | dBFS. Peak-hold bar decays at 0.3 dB/tick |
| **SNR** gauge | `computeLtcSpectralMetrics()` — total signal-band power [0.4–1.6×bitRate] vs noise-floor power projected across that same band. Noise floor sampled at biphase spectral nulls `(h+0.5)×f1`. | In dB. **Computed only when locked.** `—` otherwise. EMA-smoothed (~0.5 Hz). Gauge thresholds: ≥15 green, 10–15 orange, <10 red. (Numbers are lower than classical audio SNR because Blackman-window leakage limits the measurable floor.) |
| **THD** gauge | `computeLtcSpectralMetrics()` — `√(P3+P5+P7)/√(P1)×100` for 3rd/5th/7th odd harmonics of `bitRate/2` fundamental. | In %. **Computed only when locked.** `—` otherwise. EMA-smoothed. LTC ideal ≈38%; above that indicates added distortion. Gauge thresholds: ≤50% green, 50–70% orange, >70% red. |
| **NOISE FLOOR** readout | `10·log₁₀(median null-bin linear power)` — median of bins at biphase spectral nulls `(h+0.5)×f1` | In dB. **Computed only when locked.** `—` otherwise. EMA-smoothed. |

Threshold colors (from `LEVEL_SPEC` in `App.jsx`, per SMPTE ST 12-1 §6):
clip ≥ −1 dBFS · hot ≥ −6 · nominal −18 · low < −30 · dropout < −60.

---

## RATE DETECTION panel

The `MultiRateDecoder` runs five `LtcDecoder` instances in parallel at
candidate fps 24, 25, 30, 50, 60. The winner is the one with the highest
recent score:

```
score = framesDecoded - bitErrors × 0.1 + (recencyBonus 1000 if frame < 500 ms old)
```

| Indicator | Source |
|---|---|
| Per-rate bar (each row) | Real `framesDecoded` of that candidate decoder. Reaches 100% width at ≈60 clean frames (~2 s) |
| Active rate dot (green ●) | The winner's mapped rate key (`detectedRateKey()`), including DF/NDF resolved from the parsed `dropFrame` flag |
| **CONFIDENCE** bar | `100 × framesDecoded / (framesDecoded + bitErrors + 1)`, capped at 99.5% |

In sim mode there are no real candidate scores; only the picked rate's bar
shows, scaled by the sim's confidence proxy.

---

## FRAME INTEGRITY panel

### LAST FRAME · 80 BITS

Renders the most recent successfully decoded LTC frame as a 20×4 grid of
cells per SMPTE ST 12-1 Table 2:

- **Bits 0–63** — user / timecode payload bits. Green-filled = 1, dim = 0.
- **Bits 64–79** — the fixed 16-bit sync word `0011111111111101`. Cyan-filled
  = 1, dim cyan = 0. A successful decode requires this pattern, so when
  locked these bits always match.
- **No frame yet** — all cells dim grey.

Tooltips show bit index, sync-word membership, and decoded value.

| Below-grid readout | Source |
|---|---|
| `N cumulative bit errors` | `MultiRateDecoder.bitErrors` — total intervals from the winner decoder that fell outside the biphase tolerance window |
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

In live mode NOISE is intentionally absent. Signal quality in live mode is
reported by the SNR and THD gauges and the BIT ERRORS counter — a boolean
NOISE tag based on a crest-factor proxy or SNR threshold would be misleading.

In sim mode the tags are driven by the sim error model, since that is the
sim's purpose.

---

## LIVE INPUT STATUS panel

| Row | Source |
|---|---|
| **DETECTED RATE** | `MultiRateDecoder.detectedRateKey()`, formatted via `SMPTE_RATES[key].label` |
| **LOCK STATE** | `● LOCKED` (green `#00ff88`) / `○ NO SIGNAL` from `ltcLocked` |
| **FRAMES DECODED** | `MultiRateDecoder.framesDecoded` |
| **BIT ERRORS** | `MultiRateDecoder.bitErrors` |
| **INPUT LEVEL** | Shows `—` — `analysis.rmsDbFS` is not populated in the live path; the meters in SIGNAL LEVEL are the source of truth |
| **SAMPLE RATE** | `audioContext.sampleRate` (Hz) for live mic input. When a file is playing: `{fileNativeRate} Hz file · {ctx.sampleRate} Hz decoded` — the native rate is parsed from the WAV RIFF header by `readWavSampleRate()`; non-WAV files show only the decoded rate |
| **CLOCK DRIFT** | `MultiRateDecoder.driftPpm()`, EMA-smoothed. Deviation of measured frame period from exact expected SMPTE rate, in ppm. `—` until 10 decoded frames. States: `SOLID` (<5 ppm, green) · `DRIFTING` (5–50 ppm, orange) · `OFF-RATE` (>50 ppm, red) |
| **DROPOUT RATE** | `MultiRateDecoder.dropoutPct(2)`, EMA-smoothed. Percentage of expected frames not decoded over a rolling 2-second window: `100 × (1 − decoded / (window_sec × detected_fps))`. `—` until the winner is established. States: `CLEAN` (<1%, green) · `OCCASIONAL` (1–10%, orange) · `FREQUENT` (10–50%, amber) · `SEVERE` (>50%, red) |
| **CONTINUITY** | Count of frames where `HH:MM:SS:FF` did not advance by exactly one frame (drop-frame rules applied). `—` when not locked. Green `● CONTINUOUS · 0 BREAKS` when clean. Amber `N BREAKS · last: TYPE ±Δ @ HH:MM:SS:FF` otherwise. Break types — `REPEAT` (delta = 0, freeze frame), `JUMP` (delta > 1, edit splice / dropout), `REWIND` (delta < 0, rewind / freewheel reset). Gaps ≥ 500 ms between decoded frames reset continuity tracking rather than producing a spurious JUMP. |

---

## AUDIO INPUT panel

The panel accepts drag-and-drop of audio files anywhere on its surface (cyan dashed outline on dragover).

**When in live mic mode:**
- **DEVICE** dropdown — populated by `navigator.mediaDevices.enumerateDevices()`, filtered to `audioinput`. Selecting a different device tears down the previous stream and rebuilds the source + worklet on the same `AudioContext` (so the system output is not re-negotiated). Only shown in live mic mode (hidden while a file is playing).
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

- **Entry count** — number of error events (deduped per error-set
  transition) since the session started.
- **ERROR EVENTS** — same as above; cumulative since session start /
  CLEAR.
- **FRAMES** — total tick count (≈30 Hz) since the session started.
- **CSV / JSON export buttons** — download a file containing every logged
  error event with ISO timestamp, decoded TC, rate, source (`live` / `sim`),
  level in dBFS, and the error tag list.
- **CLEAR button** — empties the log and resets the error counter and
  session start time.

The log captures one entry per error-set transition (not per tick), so
30 ticks/s of CLIP doesn't produce 30 rows.

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

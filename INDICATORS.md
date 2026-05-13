# Indicator Reference

Every indicator in the SMPTE Timecode Analyzer is sourced from a real
measurement of the incoming signal. When a metric is undefined for the current state (e.g. SNR with no LTC
locked), the indicator shows `—` rather than a fake number.

This document lists every indicator, where its value comes from, and what
it means.

## Mode conventions

Two modes drive the analyzer:

- **Live mode (default):** audio flows from the selected input through the
  `AudioWorklet` to `MultiRateDecoder`. Indicators are computed from the
  decoded LTC frames and from the FFT/time-domain analysis of the live
  buffer.
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
| Detected rate label (orange) | `MultiRateDecoder.detectedRateKey()` — fps from winning candidate + DF flag | Picked rate from dropdown |
| `DETECTED` / `DETECTING…` tag | Cyan when locked, grey otherwise | Hidden |

---

## Banners above the timecode card

- `○ STARTING — requesting audio input…` — shown during the bootstrap
  window between page load and the first resolved `getUserMedia` result.
- `● LTC LOCKED · N FRAMES DECODED` — live, locked. `N` is the cumulative
  frame count from the winning decoder.
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
| **SNR** gauge | `computeLtcSpectralMetrics()` — power ratio of LTC-band FFT bins to out-of-band bins | In dB. **Computed only when locked.** `—` otherwise — SNR is undefined without a signal. Rough guide: 20 dB = 10× noise, 40 dB clean, 60 dB broadcast-clean |
| **THD** gauge | Not yet measured | `—` in live mode |
| **NOISE FLOOR** readout | `10·log₁₀(mean out-of-band FFT bin power)` | In dB. Same lock condition as SNR — `—` otherwise |

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

| Tag | Live condition |
|---|---|
| **CLIP** | `lvl > −1 dBFS` |
| **HOT** | `lvl > −6 dBFS` (and not CLIP) |
| **LOW** | `lvl < −30 dBFS` |
| **DROPOUT** | `lvl < −60 dBFS` |
| **NOISE** | Real `snr < 20 dB` (only flagged when locked) |

In sim mode the tags are driven by the sim error model, since that is the
sim's purpose.

---

## LIVE INPUT STATUS panel

| Row | Source |
|---|---|
| **DETECTED RATE** | `MultiRateDecoder.detectedRateKey()`, formatted via `SMPTE_RATES[key].label` |
| **LOCK STATE** | `● LOCKED` / `○ NO SIGNAL` from `ltcLocked` |
| **FRAMES DECODED** | `MultiRateDecoder.framesDecoded` |
| **BIT ERRORS** | `MultiRateDecoder.bitErrors` |
| **INPUT LEVEL** | Currently shows `—` — the panel's RMS field is wired through `analysis.rmsDbFS` which isn't populated; the meters in SIGNAL LEVEL are the source of truth here |
| **SAMPLE RATE** | `audioContext.sampleRate` (Hz) at the time the worklet was attached |

---

## AUDIO INPUT panel

- **DEVICE** dropdown — populated by `navigator.mediaDevices.enumerateDevices()`,
  filtered to `audioinput`. Selecting a different device tears down the
  previous stream and rebuilds the source + worklet on the same
  `AudioContext` (so the system output is not re-negotiated).
- **● LIVE** indicator — active when a real stream is open.
- **↻** button — refreshes the device list manually; the analyzer also
  listens for `devicechange` events.
- **▲ SWITCH TO SIMULATED TIMECODE** — only shown in live mode.

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

# Test plan: LTC capture & cadence

End-to-end manual tests for the SMPTE analyzer's capture chain and cadence
detection. Each file is run in two modes: dropped directly into the analyzer
(paced-feed path), and played from another machine through Dante Virtual
Soundcard into the analyzer (live-capture / worklet path). Both modes should
produce the same rate label, no `NON-CONFORMANT` banner on conformant
sources, and a clean `DF flag matches observed cadence`.

## Test files to generate

All files: **48 kHz / 16-bit mono WAV** to match Dante's native rate and
avoid any SRC in the chain. Length ≥ 90 s so the cadence detector observes
at least one real minute boundary inside the body, not just at the loop wrap.

### Required

| # | File | Rate | Start TC | Length | Why |
|---|------|------|----------|--------|-----|
| F1 | `LTC_2997DF_01043000_90s_48k.wav` | 29.97 DF | `01:04:30:00` | 90 s | Contains a real `01:04→01:05` minute boundary inside the body; loop wraps back to `01:04:30:00` (mm unchanged). Primary regression test for the loop-wrap cadence fix. |
| F2 | `LTC_2997ND_01043000_90s_48k.wav` | 29.97 NDF | `01:04:30:00` | 90 s | Negative control. Same TC range, ND counting + DF flag bit clear. Confirms we didn't bias toward DF. |
| F3 | `LTC_5994DF_01043000_90s_48k.wav` | 59.94 DF | `01:04:30:00` | 90 s | Exercises 60-cadence boundary range (`dfMin=4, dfMax=6`) and the 4-frame skip. |
| F4 | `LTC_23976ND_01043000_90s_48k.wav` | 23.976 NDF | `01:04:30:00` | 90 s | Tests carrier classifier at the 23.976/24 fractional boundary. |
| F5 | `LTC_25ND_01043000_90s_48k.wav` | 25 NDF (PAL) | `01:04:30:00` | 90 s | Integer non-fractional, no DF concept. Sanity check that nothing misclassifies as 24 or 30. |
| F6 | `LTC_30ND_01043000_90s_48k.wav` | 30 NDF (integer) | `01:04:30:00` | 90 s | Pure integer 30. Should NOT raise the `integer 30 fps carrier carrying DF count` warning. |

### Optional

| # | File | Rate | Start TC | Length | Why |
|---|------|------|----------|--------|-----|
| F7 | `LTC_2997DF_23590000_90s_48k.wav` | 29.97 DF | `23:59:00:00` | 90 s | Exercises the day rollover (`23:59:59 → 00:00:00`) plus a normal minute boundary at the next minute. |
| F8 | `LTC_2997DF_01043000_3min_48k.wav` | 29.97 DF | `01:04:30:00` | 3 min | Spans a 10th-minute boundary (`01:09→01:10`) which the cadence detector deliberately ignores. Verifies that exclusion still works. |

## Test matrix

Completed tests are ~~struck through~~ and prefixed ✅; open tests stand out
in normal weight. Full evidence for the passed tests is collapsed under
**Results** below.

| # | Test | Files | What to verify |
|---|------|-------|----------------|
| ✅ ~~1~~ | ~~**Real minute boundary**~~ | ~~F1 file-drop, F1 via Dante~~ | ~~Rate label = `29.97 DF`. After the first loop wrap and again after the second, `dfFlagMatchesObservedCadence` stays true. No `DF flag bit disagrees` warning.~~ |
| ✅ ~~2~~ | ~~**NDF negative control**~~ | ~~F2 file-drop, F2 via Dante~~ | ~~Rate label = `29.97 ND`. Stays ND across multiple loop wraps. No spurious DF inference.~~ |
| ✅ ~~3~~ | ~~**59.94 DF cadence**~~ | ~~F3 file-drop, F3 via Dante~~ | ~~Rate label = `59.94 DF`. 4-frame skip recognized at each real minute boundary.~~ |
| ✅ ~~4~~ | ~~**23.976 carrier classification**~~ | ~~F4 file-drop, F4 via Dante~~ | ~~`CLASS: fractional · high`, label = `23.976 ND`. Should never flip to `24 ND`.~~ |
| ✅ ~~5~~ | ~~**25 / 30 integer rates**~~ | ~~F5, F6 via Dante~~ | ~~Correct labels, `CLASS: integer · high`. No `NON-CONFORMANT` banner.~~ |
| ✅ ~~6~~ | ~~**Day rollover** (optional)~~ | ~~F7 via Dante~~ | ~~Normal lock through `23:59→00:00`. No phantom continuity break at the hour roll.~~ |
| ✅ ~~7~~ | ~~**10th-minute exclusion** (optional)~~ | ~~F8 via Dante~~ | ~~The `01:09→01:10` crossing is correctly skipped from the boundary histogram (it can't disambiguate DF vs ND). DF inference comes from `01:04→01:05`, `01:05→01:06`, etc.~~ |
| 8 | **Device hot-swap** | F1 via Dante, then switch input to built-in mic, then back to DVS | Each switch re-locks within a few seconds. `audioClockOffsetMsRef` re-samples cleanly. No persistent NO SIGNAL. |
| 9 | **Signal cut/resume** | F1 via Dante; stop the Dante sender ~5 s, resume | Re-locks without a phantom continuity break (the >3 s gap reset should clear `lastBreak`). |
| 10 | **Tab backgrounding** | F1 via Dante; switch to another tab for 30+ s; switch back | TC current on return, dropout rate doesn't spike, lock retained, rate label stays committed (no flip to `MEASURING`). Decode-path behavior is guarded headlessly by `test/manual/tab_background.test.js` (simulates the burst drain); the browser-only audio-clock offset still needs a live run. |
| 11 | **Long-run stability** | F1 via Dante; leave running ≥1 hour | No spurious continuity breaks, no growing dropout, lock holds. Note: multi-day stability is eventually limited by the constant-offset assumption drifting at ~ppm/hour — known limitation, not a test failure. |
| ✅ ~~12~~ | ~~**Rate change mid-stream**~~ | ~~F1 then F4 from the same source without restarting the analyzer~~ | ~~Carrier classifier should `DIVERGENCE` on the rate change, unlock, then re-`MEASURING_COMMIT` on 23.976 within ~20 s. Cadence detector should follow without leaking 29.97-era hits into the 23.976 inference.~~ |

### Optional thoroughness

For broader coverage, run tests 1–5 from a third machine through a different
Dante DSP path (e.g. with a sample-rate converter in the chain) to confirm
the analyzer still locks even when SRC is present upstream.

## Results

Each completed test is verified by feeding the test WAV through the real
`MultiRateDecoder` + `CadenceDetector` headlessly (`npm run test:manual` in
`smpte-analyzer/`) and independently cross-checking with two from-scratch LTC
decoders (no repo code). ✅ = passed the real-decoder harness **and** both
independent decoders.

**Headless tests 1–7, 12 — ✅ all PASS (2026-05-29).** Evidence collapsed:

<details>
<summary>Show evidence for passed tests</summary>

| # | Test | Status | Verified | Evidence |
|---|------|--------|----------|----------|
| 1 | Real minute boundary (F1) | ✅ PASS | 2026-05-29 | `29.97 DF`, `detectedRateKey 29.97df`; `dfFlagMatches` true across all loop wraps (no "DF flag disagrees"); `dfHits 6 / ndfHits 0`; carrier 29.97 fractional (~1601.6 samples/frame); triple-confirmed. Harness: `test/manual/f1_groundtruth.test.js`. |
| 2 | NDF negative control | ✅ PASS | 2026-05-29 | `29.97 ND`; never inferred DF (`dfHits 0`); triple-confirmed. Harness: `test/manual/f2_groundtruth.test.js`. |
| 3 | 59.94 DF cadence | ✅ PASS | 2026-05-29 | `59.94 DF`; 4-frame skip → `ff=4` at each minute boundary; triple-confirmed. F3 regenerated — old `BAD_F3` was a 60 fps carrier carrying a 30-cadence count. Harness: `test/manual/gen_f3.test.js`. |
| 4 | 23.976 carrier classification | ✅ PASS | 2026-05-29 | `23.976 ND`, `CLASS: fractional · high`; ~2002.0 samples/frame, never flips to `24` (`sawTwentyFour=0`); quadruple-confirmed. Harness: `test/manual/f4_groundtruth.test.js`. |
| 5 | 25 / 30 integer rates | ✅ PASS | 2026-05-29 | F5 `25` and F6 `30`, both `CLASS: integer · high`, no NON-CONFORMANT banner. F5 never misframed as 24/30; F6 is integer 30 (1600.0 samples/frame), not 29.97 (1601.6), and raises no DF warning; triple-confirmed per file. Harness: `test/manual/f5_groundtruth.test.js`. |
| 6 | Day rollover (F7) | ✅ PASS (after fix) | 2026-05-29 | Locks `29.97 DF` through `23:59:59;29 → 00:00:00;00`. **Fixed** a phantom day-roll REWIND: continuity now uses a cyclic (mod `framesPerDay`) delta so the midnight wrap reads as +1, not a full-day backward jump. Harness: `test/manual/f7_dayroll.test.js`; CI unit test: `test/cadenceDetector.test.js`. |
| 7 | 10th-minute exclusion (F8) | ✅ PASS | 2026-05-29 | `29.97 DF` across `01:07:30 → 01:10:30`. `01:08:00` & `01:09:00` skip to `ff=2` (DF); the tenth-minute `01:10:00` lands on `ff=0` and is correctly **excluded** from the DF/NDF histogram (`dfHits 2 / ndfHits 0`); triple-confirmed. Harness: `test/manual/f8_tenthmin.test.js`. |
| 12 | Rate change mid-stream (F1→F4) | ✅ PASS | 2026-05-29 | `29.97 DF` → `23.976 ND` re-locks in ~2.6 s; cadence follows to 24 ND with no 29.97-era leak (relies on the cadence-reset fix). Re-lock event is `RATE_CHANGE` — for a nominal-fps change the winner decoder switches; `DIVERGENCE` is only for same-nominal fractional↔integer flips, so TESTING.md's "should DIVERGENCE" wording above is imprecise for this transition. Harness: `test/manual/rate_change.test.js`. |

</details>

Tests 8–11 (device hot-swap, signal cut/resume, tab backgrounding, long-run
stability) are live-hardware / browser behaviors that the file-decode harness
cannot cover — they require the live DVS + browser setup. See the operator
checklist below.

## Operator checklist — live tests (#8–#11)

These exercise live capture-chain behaviors that can't be reproduced headlessly,
so they're run by hand against the live Dante + browser. Record PASS/FAIL and a
note for each.

**Before you start**
- [ ] Analyzer open at `http://localhost:5173`, **Live** mode (not simulation, no file loaded).
- [ ] AUDIO INPUT device = **Dante Virtual Soundcard**; microphone permission granted.
- [ ] F1 (`F1_LTC_01043000_2mins_29_97_DF_FPS_48000x16.wav`) looping from the sender.
- [ ] Baseline locked: badge **● LOCKED**, rate **`29.97 DF`**, `CLASS: fractional · high`, DROPOUT ≈ 0 %, **no** NON-CONFORMANT banner.

### #8 — Device hot-swap
1. [ ] With F1 locked via DVS, change the AUDIO INPUT dropdown to the **built-in mic**.
2. [ ] Wait ~5 s — built-in mic carries no LTC, so **○ NO SIGNAL** here is expected.
3. [ ] Switch the dropdown **back to Dante Virtual Soundcard**.
4. [ ] Repeat the DVS → mic → DVS swap 2–3 times.
- **PASS:** every return to DVS re-locks within a few seconds — badge back to **● LOCKED**, rate back to `29.97 DF`; **no *persistent* ○ NO SIGNAL** after returning to DVS.
- **FAIL:** stays NO SIGNAL on DVS after a swap; the macOS system *output* device changes; rate won't re-commit.
- *Why it should pass:* one `AudioContext` is reused across switches (a fresh one would renegotiate Core Audio and can flip the system output); the worklet's audio-clock offset re-samples on each new stream.

### #9 — Signal cut / resume
1. [ ] With F1 locked via DVS, **stop the Dante sender** for ~5 s (badge should drop to **○ NO SIGNAL**).
2. [ ] **Resume** the sender.
- **PASS:** re-locks on resume, and **no continuity break is logged for the gap** — the session log shows no JUMP/REWIND at the resume point and the CONTINUITY count does not tick up from the cut.
- **FAIL:** a REWIND/JUMP continuity entry appears at resume; lock doesn't recover.
- *Note:* keep the cut **≥ 5 s** — a gap longer than 3 s clears the pending continuity state, which is what makes the resume clean. A sub-3 s blip may legitimately register a small break.

### #10 — Tab backgrounding
1. [ ] With F1 locked via DVS, switch to **another browser tab or app for 30+ s**.
2. [ ] Switch back to the analyzer tab.
- **PASS:** TC is **current** on return (advancing in step with the sender, not frozen or lagging); DROPOUT did **not** spike; **● LOCKED** retained throughout.
- **FAIL:** TC frozen/behind on return; DROPOUT jumps; lock lost.
- *Why it should pass:* the tick source runs in a Web Worker (~33 ms), which browsers do **not** throttle in background tabs (unlike `setInterval`/`requestAnimationFrame`).

### #11 — Long-run stability
1. [ ] With F1 locked via DVS, **leave it running ≥ 1 hour** (longer is better).
2. [ ] Periodically note: badge, CONTINUITY count, DROPOUT %, and the drift readout.
- **PASS:** lock holds the whole time; **no spurious continuity breaks** accumulate; DROPOUT stays ≈ 0 %; drift readout stays roughly steady.
- **FAIL:** lock drops with no signal interruption; CONTINUITY count climbs; DROPOUT grows over time.
- *Known limitation (not a failure):* the host-vs-source clock offset drifts at ~ppm/hour (the constant-offset assumption), so multi-day runs may show slow drift — expected, not a regression. 

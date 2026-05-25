import { CadenceDetector } from "./cadenceDetector";

// LTC biphase-mark decoder with rolling state across sample chunks.
// Per SMPTE ST 12-1: 80 bits/frame, sync word 0011111111111101 at bits 64-79.
//
// Biphase-mark rules:
//   - every bit boundary has a transition
//   - a "1" adds a mid-bit transition (so two short intervals per "1")
//   - a "0" has no mid-bit transition (one long interval per "0")
// We pair consecutive short intervals into a single "1" bit.
//
// Hardware-style bit-clock recovery: rather than testing each transition
// interval against a fixed ±tolerance window around the nominal bit period,
// we maintain a running estimate of the actual bit period (`sbEst`) and
// classify each interval as "short" or "long" by whichever expected value is
// closest. This mirrors what hardware LTC chips do once locked — they track
// the recovered bit clock and decide bit slots by phase, not by independent
// interval measurement. A fixed-window decoder rejects intervals that land
// mid-way (e.g. ~1.2× the half-bit period from edge-timing jitter), counts
// them as errors, and breaks the pendingShort pairing — wrecking the frame.
// Hardware doesn't see those as errors at all; it just bins them.

const SYNC = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1];

export class LtcDecoder {
  constructor() {
    this.bitBuf = [];
    this.bitSampleIdx = [];         // sample index at which each bit in bitBuf was emitted
    this.lastTransitionSample = 0;
    this.sampleIndex = 0;
    this.lastSign = 0;
    this.pendingShort = false;
    this.lastFrame = null;          // { hh, mm, ss, ff, dropFrame, colorFrame, t }
    this.lastFrameBits = null;      // Uint8Array(80) — the actual bits of the most recent decoded frame
    this.framesDecoded = 0;
    this.bitErrors = 0;
    this.samplesPerBit = 0;         // set on first feed()
    this._cachedSampleRate = 0;     // memoisation key for samplesPerBit
    this.recentFrameSpans = [];     // rolling window of actual sample spans for the last decoded frames
    this.recentDecodeTimes = [];    // wall-clock timestamps of recent successful decodes (for dropout rate)
    this.pendingFrames = [];        // frames decoded since the consumer last drained — needed for continuity tracking when a single audio chunk produces more than one frame
    this.sbEst = 0;                 // running estimate of the actual samples-per-bit period; seeded from nominal, then tracked via EMA on observed long intervals
    this.locked = false;            // true after the first successful frame decode; tightens the absurdity bounds used to reject true glitches
  }

  feed(samples, sampleRate, nominalFps) {
    // samplesPerBit only depends on (sampleRate, nominalFps); nominalFps is
    // fixed per decoder instance and sampleRate only changes on device switch.
    if (sampleRate !== this._cachedSampleRate) {
      this.samplesPerBit = sampleRate / (nominalFps * 80);
      this._cachedSampleRate = sampleRate;
    }
    this.nominalFps = nominalFps;
    if (this.sbEst === 0) this.sbEst = this.samplesPerBit;
    // If we haven't decoded a frame in over a minute the accumulated state is
    // stale: bit-error counts were racked up against noise while no LTC was
    // present, and the running frame count outlives the session it described.
    // Reset both symmetrically so any cumulative ratio derived from them stays
    // honest, and drop the lock flag so the absurdity bounds widen for
    // re-acquisition.
    if (this.lastFrame && performance.now() - this.lastFrame.t > 60000) {
      this.bitErrors = 0;
      this.framesDecoded = 0;
      this.locked = false;
      this.sbEst = this.samplesPerBit;
    }

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      // Treat exact zero as previous sign to avoid spurious crossings.
      const sign = s > 0 ? 1 : (s < 0 ? -1 : this.lastSign);
      if (this.lastSign !== 0 && sign !== this.lastSign) {
        this._handleInterval(this.sampleIndex - this.lastTransitionSample);
        this.lastTransitionSample = this.sampleIndex;
      }
      if (sign !== 0) this.lastSign = sign;
      this.sampleIndex++;
    }
  }

  _handleInterval(interval) {
    const sb = this.sbEst;
    const half = sb / 2;
    // Absurdity bounds: pre-lock loose so acquisition isn't picky; post-lock
    // tighter so true glitches still get rejected. Wrong-rate cross-locks are
    // prevented downstream by the 80-bit frame-span check (±3%), which is
    // much stricter than any per-interval window could be.
    const absMin = this.locked ? half * 0.5 : half * 0.3;
    const absMax = this.locked ? sb   * 1.5 : sb   * 1.7;
    if (interval < absMin || interval > absMax) {
      this.bitErrors++;
      this.pendingShort = false;
      return;
    }
    // Snap to nearest expected value. Decision boundary is the midpoint
    // between half-bit and full-bit (0.75 × sb).
    const isShort = interval < (half + sb) / 2;
    if (isShort) {
      if (this.pendingShort) {
        this._pushBit(1);
        this.pendingShort = false;
      } else {
        this.pendingShort = true;
      }
    } else {
      if (this.pendingShort) {
        // Unpaired short followed by a long — drop the orphan, count as error.
        this.bitErrors++;
        this.pendingShort = false;
      }
      this._pushBit(0);
      // Long intervals directly measure one bit period — update the bit-clock
      // estimate via slow EMA. Genuine drift tracks; transient outliers (which
      // we accepted due to wider snap-to-nearest binning) don't pull it much.
      this.sbEst = this.sbEst * 0.99 + interval * 0.01;
    }
  }

  _pushBit(b) {
    this.bitBuf.push(b);
    this.bitSampleIdx.push(this.sampleIndex);
    // Cap at ~1.2 frames (96 bits). Sync detection only ever looks at the
    // last 80 bits and the span check spans 80 bits, so older bits serve no
    // purpose — keeping a larger window just delays resync after a noise burst
    // by holding garbage in the buffer for ~2 extra frame durations.
    if (this.bitBuf.length > 96) {
      const drop = this.bitBuf.length - 96;
      this.bitBuf.splice(0, drop);
      this.bitSampleIdx.splice(0, drop);
    }
    this._tryDecode();
  }

  _tryDecode() {
    const buf = this.bitBuf;
    const idx = this.bitSampleIdx;
    const n = buf.length;
    if (n < 80) return;
    // The sync word occupies the LAST 16 bits of each frame. If the tail
    // matches, the previous 64 bits + sync = a complete 80-bit frame.
    for (let i = 0; i < 16; i++) {
      if (buf[n - 16 + i] !== SYNC[i]) return;
    }
    // Frame-span sanity check: the 80 bits must have arrived in roughly the
    // expected number of samples. This separates 24 vs 25 fps cross-locks
    // (≈4% apart) that per-interval tolerance alone can't catch. ±3% allows
    // for real-world LTC clock drift while rejecting wrong-rate decodes.
    // Note: idx[i] records the sample where bit i was *emitted* (i.e., its
    // closing transition), so the distance from idx[n-80] to idx[n-1] spans
    // 79 bit durations, not 80.
    const frameSamples = idx[n - 1] - idx[n - 80];
    const expectedFrameSamples = 79 * this.samplesPerBit;
    const spanError = Math.abs(frameSamples - expectedFrameSamples) / expectedFrameSamples;
    if (spanError > 0.03) return;
    // Read the 80 frame bits in place via a start index; avoids the per-frame
    // 80-element allocation that buf.slice(n-80) would otherwise produce on
    // every successful sync match.
    const frameStart = n - 80;
    const parsed = parseFrame(buf, this.nominalFps, frameStart);
    // FF must fit the candidate's cadence: an LTC frame at 24-cadence wraps
    // at FF=24, at 30-cadence FF=30, etc. parseFrame's own bound is just the
    // 6-bit field width (FF≤79); without this cadence check a single-bit
    // noise flip in the frame-tens nibble can yield e.g. FF=43 in a 30-cadence
    // stream and be accepted as a valid frame.
    if (parsed && parsed.ff >= this.nominalFps) {
      this.bitErrors++;
      this.bitBuf = buf.slice(n - 16);
      this.bitSampleIdx = idx.slice(n - 16);
      return;
    }
    if (parsed) {
      const now = performance.now();
      const frame = { ...parsed, t: now };
      this.lastFrame = frame;
      this.pendingFrames.push(frame);
      const fbits = new Uint8Array(80);
      for (let k = 0; k < 80; k++) fbits[k] = buf[frameStart + k];
      this.lastFrameBits = fbits;
      this.framesDecoded++;
      this.locked = true;
      this.recentFrameSpans.push(frameSamples);
      // Larger window than strictly needed for median (used for rate
      // classification, ≥10 entries is enough) so that the mean over the
      // whole buffer has enough samples to recover sub-sample precision for
      // the drift readout. 120 frames ≈ 4 s at 30 fps.
      if (this.recentFrameSpans.length > 120) this.recentFrameSpans.shift();
      this.recentDecodeTimes.push(now);
      // Cap at 1500 entries (~25 s at 60 fps); time-based pruning is done by
      // the consumer when computing the dropout rate or the winner score.
      if (this.recentDecodeTimes.length > 1500) this.recentDecodeTimes.shift();
      // Keep just the sync word so we don't re-decode the same frame; the
      // next frame's bits will accumulate after it.
      this.bitBuf = buf.slice(n - 16);
      this.bitSampleIdx = idx.slice(n - 16);
    }
  }

  // Returns ms since the last successfully decoded frame, or Infinity if never.
  ageMs() {
    if (!this.lastFrame) return Infinity;
    return performance.now() - this.lastFrame.t;
  }
}

export function parseFrame(b, nominalFps, start = 0) {
  const o = start;
  const frUnits  = b[o+0]  | (b[o+1]<<1) | (b[o+2]<<2) | (b[o+3]<<3);
  // Frame-tens field: standard LTC uses 2 bits (max FF=39, enough for ≤30
  // fps). SMPTE ST 12-1:2014 §6.6 (HFR) repurposes bit 58 (BGF0 in legacy
  // LTC) as a third frame-tens bit, expanding the field to 3 bits
  // (max FF=79). We only consult bit 58 when the candidate rate is 50/60 —
  // otherwise a spec-conformant ≤30 fps generator that sets BGF0=1
  // (binary group data present) would be miscoded as FF+40.
  const useHfrTens = nominalFps != null && nominalFps >= 50;
  const frTens   = b[o+8] | (b[o+9]<<1) | (useHfrTens ? (b[o+58]<<2) : 0);
  const dropFrame = b[o+10] === 1;
  const colorFrame = b[o+11] === 1;
  const secUnits = b[o+16] | (b[o+17]<<1) | (b[o+18]<<2) | (b[o+19]<<3);
  const secTens  = b[o+24] | (b[o+25]<<1) | (b[o+26]<<2);
  const minUnits = b[o+32] | (b[o+33]<<1) | (b[o+34]<<2) | (b[o+35]<<3);
  const minTens  = b[o+40] | (b[o+41]<<1) | (b[o+42]<<2);
  const hrUnits  = b[o+48] | (b[o+49]<<1) | (b[o+50]<<2) | (b[o+51]<<3);
  const hrTens   = b[o+56] | (b[o+57]<<1);
  const ff = frTens * 10 + frUnits;
  const ss = secTens * 10 + secUnits;
  const mm = minTens * 10 + minUnits;
  const hh = hrTens * 10 + hrUnits;
  if (ff > 79 || ss > 59 || mm > 59 || hh > 23) return null;
  return { hh, mm, ss, ff, dropFrame, colorFrame };
}

export function tcString(lf) {
  const p = n => String(n).padStart(2, "0");
  return `${p(lf.hh)}:${p(lf.mm)}:${p(lf.ss)}${lf.dropFrame ? ";" : ":"}${p(lf.ff)}`;
}

// Run several LtcDecoders at candidate fps in parallel and pick the winner
// by recent score (frames decoded - bit errors). This is how we auto-detect
// the incoming *carrier rate* — i.e. the bit-clock timing — without asking
// the user. The carrier rate is one of two independent properties of an
// LTC stream; the other is the counting cadence (how the FF field wraps),
// which is observed separately by CadenceDetector from the decoded numbers.
const CANDIDATE_FPS = [24, 25, 30, 50, 60];

export class MultiRateDecoder {
  constructor() {
    this.decoders = CANDIDATE_FPS.map(fps => ({ fps, dec: new LtcDecoder() }));
    this.winnerIdx = -1;
    // Counting-cadence and continuity tracking. Driven by the decoded
    // HH:MM:SS:FF sequence, NOT by the carrier-rate winner. See cadenceDetector.js.
    this.cadenceDetector = new CadenceDetector();
    // Carrier observation cached across getter calls; invalidated whenever
    // new samples arrive (a new feed() can shift winner / medianSpan).
    this._carrierObs = null;
  }

  feed(samples, sampleRate) {
    this._carrierObs = null;
    for (const { fps, dec } of this.decoders) dec.feed(samples, sampleRate, fps);
    this._pickWinner();
    // Drain the winning decoder's pending frames into the cadence detector.
    // A single audio chunk can contain more than one LTC frame; checking only
    // `lastFrame` per chunk would miss intermediate frames.
    const winner = this.winner;
    if (winner) {
      for (const frame of winner.dec.pendingFrames) {
        this.cadenceDetector.feed(frame);
      }
    }
    // Clear all candidates' queues — non-winners' decodes are discarded.
    for (const { dec } of this.decoders) dec.pendingFrames = [];
  }

  // Last continuity break observed by the cadence detector, surfaced for
  // event-driven logging (App.jsx watches lb.t for change). The cadence
  // detector also keeps a lifetime breaks counter for tests and diagnostics;
  // it has no UI surface — the visible CONTINUITY readout uses a separate
  // rolling-60s window kept in App.jsx.
  get lastBreak() { return this.cadenceDetector.lastBreak; }

  _pickWinner() {
    // Score on a 20-second window of successful decodes, not cumulative
    // counts. With cumulative scoring, a long-running winner amasses
    // framesDecoded into the thousands while every other candidate
    // accumulates bit errors from running against the wrong rate. When the
    // input rate then changes, the *new* correct decoder starts at near-zero
    // recent frames but inherits all of those stale wrong-rate bit errors —
    // the cumulative score keeps the old decoder ahead for ~60 s until the
    // new one's framesDecoded catches up. A page refresh hid the bug because
    // all counters started at 0. Windowed counts decay naturally.
    //
    // Selection is two-stage:
    //   1. If any decoder has a frame fresher than 500 ms, restrict the field
    //      to those decoders. A stalled candidate with a huge windowed count
    //      should never beat a candidate that's actually still decoding.
    //   2. Among the eligible set, pick the highest windowed frame count.
    //      Ties (and they happen briefly on wrong-rate signals where a higher-
    //      fps decoder catches spurious sync words) are broken by frame-span
    //      proximity to that candidate's nominal period — the decoder whose
    //      measured span matches its expected period is the better fit.
    const now = performance.now();
    const cutoff = now - 20000;
    const scores = this.decoders.map(({ dec }) => {
      let recentFrames = 0;
      const times = dec.recentDecodeTimes;
      for (let j = times.length - 1; j >= 0; j--) {
        if (times[j] >= cutoff) recentFrames++;
        else break;
      }
      const fresh = dec.lastFrame && now - dec.lastFrame.t < 500;
      let spanError = Infinity;
      const spans = dec.recentFrameSpans;
      if (spans && spans.length > 0 && dec.samplesPerBit > 0) {
        let sum = 0;
        for (let k = 0; k < spans.length; k++) sum += spans[k];
        const meanSpan = sum / spans.length;
        const expected = 79 * dec.samplesPerBit;
        spanError = Math.abs(meanSpan - expected) / expected;
      }
      return { recentFrames, fresh, spanError, hasFrame: !!dec.lastFrame };
    });
    const anyFresh = scores.some(s => s.fresh);
    let bestIdx = -1;
    let bestRecent = -1, bestSpanError = Infinity;
    for (let i = 0; i < scores.length; i++) {
      const s = scores[i];
      if (!s.hasFrame) continue;
      if (anyFresh && !s.fresh) continue;
      if (s.recentFrames > bestRecent
          || (s.recentFrames === bestRecent && s.spanError < bestSpanError)) {
        bestIdx = i;
        bestRecent = s.recentFrames;
        bestSpanError = s.spanError;
      }
    }
    this.winnerIdx = bestIdx;
  }

  get winner() { return this.winnerIdx >= 0 ? this.decoders[this.winnerIdx] : null; }

  get lastFrame() { return this.winner?.dec.lastFrame ?? null; }
  get lastFrameBits() { return this.winner?.dec.lastFrameBits ?? null; }
  get framesDecoded() { return this.winner?.dec.framesDecoded ?? 0; }
  get bitErrors() { return this.winner?.dec.bitErrors ?? 0; }
  get nominalFps() { return this.winner?.fps ?? null; }

  // Per-candidate status, for the rate-detection UI. Returns one entry per
  // candidate fps with real counters from that decoder instance.
  candidateStatus() {
    const now = performance.now();
    return this.decoders.map(({ fps, dec }) => ({
      fps,
      framesDecoded: dec.framesDecoded,
      bitErrors: dec.bitErrors,
      ageMs: dec.lastFrame ? now - dec.lastFrame.t : Infinity,
      locked: dec.lastFrame && (now - dec.lastFrame.t < 500),
    }));
  }

  // Median observed frame span (in samples) for the winning decoder. Used to
  // distinguish 1.001-divided fractional rates (29.97 NDF, 23.976, 59.94 NDF)
  // from their integer counterparts (30, 24, 60). At least 10 decoded frames
  // are needed before this returns a value to filter out per-frame jitter.
  medianFrameSpan() {
    return this.carrierObservation().medianSpan;
  }

  // Whether the carrier is at a 1.001-divided NTSC rate vs the integer rate.
  // Decided ONLY by measured frame span — never by the LTC DF flag bit or by
  // the counting cadence. This is the load-bearing primitive that separates
  // carrier-rate detection from counting-cadence detection. Uses the mean of
  // recentFrameSpans for sub-sample precision (see carrierObservation).
  _carrierIsFractional() {
    return this.carrierObservation().fractional;
  }

  // Carrier-rate key, purely from frame-span timing. No DF, no flag bits, no
  // count-pattern inference. Returns one of:
  //   "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60"
  // or null if not yet locked / not enough span samples.
  carrierRate() {
    return this.carrierObservation().carrierRate;
  }

  // One-shot observation of the carrier, computed lazily and cached until the
  // next feed() invalidates it. Bundles the fields that the four public
  // getters (carrierRate / cadence / carrierCadenceMismatch / detectedRateKey)
  // would otherwise each compute independently per tick.
  carrierObservation() {
    if (this._carrierObs) return this._carrierObs;
    const fps = this.nominalFps;
    const winner = this.winner;
    let medianSpan = null;
    let meanSpan = null;
    if (winner) {
      const spans = winner.dec.recentFrameSpans;
      if (spans && spans.length >= 10) {
        const sorted = [...spans].sort((a, b) => a - b);
        medianSpan = sorted[Math.floor(sorted.length / 2)];
        let sum = 0;
        for (let k = 0; k < spans.length; k++) sum += spans[k];
        meanSpan = sum / spans.length;
      }
    }
    // Fractional classification uses the MEAN, not the median. The threshold
    // sits exactly halfway between integer and 1.001-divided rates, and the
    // per-frame span is integer-sample-resolution — the median snaps to a
    // sample boundary and can flip across the threshold under normal jitter,
    // even for a clean 29.97 carrier. The mean recovers sub-sample precision
    // by averaging across the natural integer jitter (same reasoning as
    // driftPpm). Median is still used for general reporting / debugging.
    let fractional = null;
    if (fps === 25 || fps === 50) {
      fractional = false;
    } else if ((fps === 24 || fps === 30 || fps === 60) && winner && meanSpan != null) {
      const expected = 79 * winner.dec.samplesPerBit;
      fractional = (meanSpan / expected) >= 1.0005;
    }
    let carrierRate = null;
    if (fps === 25) carrierRate = "25";
    else if (fps === 50) carrierRate = "50";
    else if (fractional != null) {
      if (fps === 24) carrierRate = fractional ? "23.976" : "24";
      else if (fps === 30) carrierRate = fractional ? "29.97" : "30";
      else if (fps === 60) carrierRate = fractional ? "59.94" : "60";
    }
    this._carrierObs = { nominalFps: fps, fractional, medianSpan, carrierRate };
    return this._carrierObs;
  }

  // Counting-cadence readout from the FF-sequence observer. Returns
  // { fps, dropFrame, framesSeen, dfFlagMatches } or null until enough
  // frames have been seen to be confident.
  cadence() {
    const cd = this.cadenceDetector;
    const fps = cd.cadenceFps();
    if (fps == null) return null;
    const dropFrame = cd.isDropFrame();
    return {
      fps,
      dropFrame: dropFrame ?? false,
      dropFrameKnown: dropFrame != null,
      framesSeen: cd.framesSeen,
      dfFlagMatches: cd.dfFlagMatchesObservedCadence(),
    };
  }

  // Combined SMPTE rate key blending carrier timing with the observed
  // cadence's DF behaviour. Retained for callers (UI / publisher) that still
  // want a single string. Prefer carrierRate() + cadence() going forward.
  detectedRateKey() {
    const carrier = this.carrierRate();
    if (carrier == null) return null;
    const cad = this.cadence();
    const isDf = cad?.dropFrame === true;
    if (isDf && carrier === "29.97") return "29.97df";
    if (isDf && carrier === "59.94") return "59.94df";
    // A DF cadence with a non-fractional carrier (e.g. integer 30 + DF count,
    // the case in issue #1) has no canonical SMPTE rate key. Return the
    // carrier rate; the cadence mismatch is surfaced separately.
    return carrier;
  }

  // True if the carrier rate and counting cadence disagree in a way that
  // wouldn't occur in spec-conformant material. e.g. carrier=30 with DF
  // count, or carrier=29.97 (fractional) with 24-cadence count. Returns
  // null until both detections are confident.
  carrierCadenceMismatch() {
    const carrier = this.carrierRate();
    const cad = this.cadence();
    if (carrier == null || cad == null) return null;
    // Compare cadence fps to carrier's nominal integer fps.
    const carrierNominalFps = rateKeyToNominalFps(carrier);
    if (cad.fps !== carrierNominalFps) return true;
    // DF only meaningful at 30 and 60 cadence; for DF to be in-spec the
    // carrier must be the fractional 1.001-divided variant.
    if (cad.dropFrame) {
      const fractional = this._carrierIsFractional();
      if (fractional === false) return true;  // integer 30/60 carrier + DF count
    }
    return false;
  }

  // Dropout rate over a rolling window: percentage of expected frames that
  // weren't successfully decoded. Useful for distinguishing occasional
  // dropouts (low %) from serious signal-integrity problems (high %).
  //   0%      → every expected frame decoded; clean signal
  //   1–10%   → occasional dropouts (analog tape head wear, low-level noise)
  //   10–50%  → frequent dropouts; signal degraded but still locked
  //   >50%    → severe / barely decoding; near loss-of-lock
  //   100%    → no decodes in window (no signal or wrong rate)
  // Returns null until we have an actualFps estimate and some decode history.
  dropoutPct(windowSec = 2) {
    const winner = this.winner;
    if (!winner) return null;
    const dec = winner.dec;
    const times = dec.recentDecodeTimes;
    if (!times || times.length === 0) return null;
    const now = performance.now();
    // No live signal: most recent decode is stale. Without this guard, the
    // metric would report ~100% any time code stops rolling (silence after
    // a take, signal disconnected, etc.) instead of surfacing "no signal".
    if (now - times[times.length - 1] > 500) return null;
    // Adapt the window to however much history we actually have, down to a
    // floor of 0.5 s. This avoids two failure modes:
    //   • Full windowSec required → just-acquired lock reports near-100%
    //     dropout because only the first few frames count against the full
    //     expected count.
    //   • No floor → a single recent decode looks like 100% lock over a
    //     micro-window, which over-reports confidence at the very first frame.
    const historyMs = now - times[0];
    if (historyMs < 500) return null;
    const effectiveWindowSec = Math.min(windowSec, historyMs / 1000);
    const fps = winner.fps;
    // Fractional-ness is a CARRIER property — decided by frame-span timing,
    // not by the DF flag bit or the counting cadence. A "30 DF" stream
    // (integer carrier with DF count) must report against 30 fps expected,
    // not 29.97.
    const isFractional = this._carrierIsFractional() === true;
    const actualFps = fps / (isFractional ? 1.001 : 1);
    const cutoff = now - effectiveWindowSec * 1000;
    let count = 0;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] >= cutoff) count++;
      else break; // recentDecodeTimes is appended in chronological order
    }
    const expected = effectiveWindowSec * actualFps;
    if (expected <= 0) return null;
    return Math.max(0, Math.min(100, 100 * (1 - count / expected)));
  }

  // Clock drift in parts-per-million between the measured frame period and
  // the exact expected period for the detected SMPTE rate (integer or
  // 1.001-divided NTSC). Useful as a "chase" / sync indicator:
  //   • ~0 ppm  → source is solid-lock to the detected nominal rate
  //   • ±tens   → analog tape transport drift / minor varispeed
  //   • hundreds+ → source not matching either standard rate; likely
  //                 freewheeling or a non-standard generator
  //
  // The measured period uses the MEAN of recentFrameSpans, not the median.
  // Per-frame span is measured at integer sample resolution, but real LTC
  // frame periods are usually non-integer in samples (e.g. 29.97 fps at 48k
  // is 1581.58 samples per 79-bit span). The median snaps to the nearest
  // integer sample, producing several-hundred-ppm bias; the mean recovers
  // sub-sample precision by averaging across the natural integer jitter.
  //
  // Note: switching to the bit-clock recovery estimate (`sbEst`) was tried
  // and reverted — it's updated per long interval (one bit period) and so
  // integer-sample quantization on individual long intervals dominates,
  // giving ~3× more peak-to-peak noise than the frame-span mean. Each
  // frame-span measurement averages 79 bit periods, so √79 ≈ 9× of integer
  // noise washes out before the cross-frame averaging even starts.
  driftPpm() {
    const winner = this.winner;
    if (!winner) return null;
    const dec = winner.dec;
    const spans = dec.recentFrameSpans;
    if (!spans || spans.length < 10) return null;
    // Fractional-ness is a CARRIER property — derived from frame-span timing,
    // not the DF flag bit. Same primitive as carrierRate() / dropoutPct().
    const isFractional = this._carrierIsFractional() === true;
    let sum = 0;
    for (let i = 0; i < spans.length; i++) sum += spans[i];
    const meanSpan = sum / spans.length;
    const expected = 79 * dec.samplesPerBit * (isFractional ? 1.001 : 1.0);
    return (meanSpan - expected) / expected * 1e6;
  }
}

export function rateKeyToNominalFps(rateKey) {
  if (rateKey === "59.94df" || rateKey === "59.94" || rateKey === "60") return 60;
  if (rateKey === "50") return 50;
  if (rateKey === "29.97df" || rateKey === "29.97" || rateKey === "30") return 30;
  if (rateKey === "25") return 25;
  return 24; // 23.976, 24
}

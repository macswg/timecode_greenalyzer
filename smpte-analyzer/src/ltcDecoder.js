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
    this.lastBitTime = 0;
    this.samplesPerBit = 0;         // set on first feed()
    this.recentFrameSpans = [];     // rolling window of actual sample spans for the last decoded frames
    this.recentDecodeTimes = [];    // wall-clock timestamps of recent successful decodes (for dropout rate)
    this.pendingFrames = [];        // frames decoded since the consumer last drained — needed for continuity tracking when a single audio chunk produces more than one frame
    this.sbEst = 0;                 // running estimate of the actual samples-per-bit period; seeded from nominal, then tracked via EMA on observed long intervals
    this.locked = false;            // true after the first successful frame decode; tightens the absurdity bounds used to reject true glitches
  }

  feed(samples, sampleRate, nominalFps) {
    this.samplesPerBit = sampleRate / (nominalFps * 80);
    if (this.sbEst === 0) this.sbEst = this.samplesPerBit;
    // If we haven't decoded a frame in over a minute, the accumulated
    // bit-error count is stale — it was racked up against noise transitions
    // while no LTC was present. Clear it so a returning signal isn't
    // unfairly penalised in the FRAME INTEGRITY readout. Also drop the
    // lock flag so the absurdity bounds widen back out for re-acquisition.
    if (this.bitErrors > 0 && this.lastFrame && performance.now() - this.lastFrame.t > 60000) {
      this.bitErrors = 0;
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
    this.lastBitTime = performance.now();
    if (this.bitBuf.length > 200) {
      const drop = this.bitBuf.length - 200;
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
    const f = buf.slice(n - 80);
    const parsed = parseFrame(f);
    if (parsed) {
      const now = performance.now();
      const frame = { ...parsed, t: now };
      this.lastFrame = frame;
      this.pendingFrames.push(frame);
      this.lastFrameBits = Uint8Array.from(f);
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

export function parseFrame(b) {
  const frUnits  = b[0]  | (b[1]<<1) | (b[2]<<2) | (b[3]<<3);
  // Frame-tens field: standard LTC uses 2 bits (max FF=39, enough for ≤30
  // fps). The high-frame-rate variant in SMPTE ST 12-1:2014 §6.6 repurposes
  // bit 58 (formerly BGF) as a third frame-tens bit, expanding the field to
  // 3 bits (max FF=79). We always read bit 58 as part of frame tens — at
  // ≤30 cadences bit 58 stays 0 in any HFR-aware generator, and the
  // analyzer doesn't surface binary group flags anyway, so there's no
  // downside to always honouring it.
  const frTens   = b[8]  | (b[9]<<1) | (b[58]<<2);
  const dropFrame = b[10] === 1;
  const colorFrame = b[11] === 1;
  const secUnits = b[16] | (b[17]<<1) | (b[18]<<2) | (b[19]<<3);
  const secTens  = b[24] | (b[25]<<1) | (b[26]<<2);
  const minUnits = b[32] | (b[33]<<1) | (b[34]<<2) | (b[35]<<3);
  const minTens  = b[40] | (b[41]<<1) | (b[42]<<2);
  const hrUnits  = b[48] | (b[49]<<1) | (b[50]<<2) | (b[51]<<3);
  const hrTens   = b[56] | (b[57]<<1);
  const ff = frTens * 10 + frUnits;
  const ss = secTens * 10 + secUnits;
  const mm = minTens * 10 + minUnits;
  const hh = hrTens * 10 + hrUnits;
  if (ff > 79 || ss > 59 || mm > 59 || hh > 23) return null;
  return { hh, mm, ss, ff, dropFrame, colorFrame };
}

// Absolute frame number for a HH:MM:SS:FF timecode. Used by continuity
// detection — consecutive in-order LTC frames must differ by exactly 1.
// `fps` here is the NOMINAL integer rate (24, 25, 30, 50, 60); both NTSC
// fractional variants (29.97 / 23.976 / 59.94) use the same integer for
// frame-count math because they just slow the clock, not the count.
export function tcToFrameNumber(hh, mm, ss, ff, fps, dropFrame) {
  if (!dropFrame) {
    return ((hh * 60 + mm) * 60 + ss) * fps + ff;
  }
  const dropPerMin = fps === 60 ? 4 : 2;
  const totalMins = hh * 60 + mm;
  const dropped = dropPerMin * (totalMins - Math.floor(totalMins / 10));
  return ((hh * 60 + mm) * 60 + ss) * fps + ff - dropped;
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
  }

  feed(samples, sampleRate) {
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

  // Continuity tracking lives in the cadence detector now — these getters
  // preserve the previous surface for callers.
  get continuityBreaks() { return this.cadenceDetector.continuityBreaks; }
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
    const now = performance.now();
    const cutoff = now - 20000;
    let bestScore = -Infinity, bestIdx = -1;
    for (let i = 0; i < this.decoders.length; i++) {
      const d = this.decoders[i].dec;
      // recentDecodeTimes is appended chronologically; count entries inside
      // the window by walking from the tail.
      let recentFrames = 0;
      const times = d.recentDecodeTimes;
      for (let j = times.length - 1; j >= 0; j--) {
        if (times[j] >= cutoff) recentFrames++;
        else break;
      }
      const recencyBonus = (d.lastFrame && now - d.lastFrame.t < 500) ? 1000 : 0;
      const score = recentFrames + recencyBonus;
      if (score > bestScore && d.lastFrame) { bestScore = score; bestIdx = i; }
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
    const spans = this.winner?.dec.recentFrameSpans;
    if (!spans || spans.length < 10) return null;
    const sorted = [...spans].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  // Whether the carrier is at a 1.001-divided NTSC rate vs the integer rate.
  // Decided ONLY by measured frame span — never by the LTC DF flag bit or by
  // the counting cadence. This is the load-bearing primitive that separates
  // carrier-rate detection from counting-cadence detection.
  _carrierIsFractional() {
    const fps = this.nominalFps;
    if (fps === 25 || fps === 50) return false;
    if (fps !== 24 && fps !== 30 && fps !== 60) return null;
    const winner = this.winner;
    if (!winner) return null;
    const expected = 79 * winner.dec.samplesPerBit;
    const measured = this.medianFrameSpan();
    if (measured == null) return null;
    return (measured / expected) >= 1.0005;
  }

  // Carrier-rate key, purely from frame-span timing. No DF, no flag bits, no
  // count-pattern inference. Returns one of:
  //   "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60"
  // or null if not yet locked / not enough span samples.
  carrierRate() {
    const fps = this.nominalFps;
    if (fps == null) return null;
    if (fps === 25) return "25";
    if (fps === 50) return "50";
    const frac = this._carrierIsFractional();
    if (frac == null) return null;
    if (fps === 24) return frac ? "23.976" : "24";
    if (fps === 30) return frac ? "29.97" : "30";
    if (fps === 60) return frac ? "59.94" : "60";
    return null;
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
    const cutoff = now - windowSec * 1000;
    let count = 0;
    for (let i = times.length - 1; i >= 0; i--) {
      if (times[i] >= cutoff) count++;
      else break; // recentDecodeTimes is appended in chronological order
    }
    const expected = windowSec * actualFps;
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

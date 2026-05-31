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
    // Chunk wall-clock window for the most recent feed() call. Used by
    // _tryDecode to interpolate a frame's wall-clock time independent of ADC
    // sample-clock drift. See feed() for the rationale.
    this._chunkWallStart = 0;
    this._chunkWallEnd = 0;
    this._chunkStartSampleIdx = 0;
    this._chunkLen = 0;
    this._wallClockMode = "synthetic"; // "stamped" if worklet supplied timestamps
    // 50/60 fps FF interpretation: "wide" (FF labels every frame, bit 58 is a
    // frame-tens MSB) or "framepair" (spec ST 12-1 §12: FF labels frame pairs,
    // field-mark flag is the field LSB). MultiRateDecoder sets this on the
    // 50/60 decoders from fieldMarkBehavior(). No effect at ≤30 fps. See #34.
    this._frameMode = "wide";
  }

  feed(samples, sampleRate, nominalFps, chunkWallStart, chunkWallEnd) {
    // samplesPerBit only depends on (sampleRate, nominalFps); nominalFps is
    // fixed per decoder instance and sampleRate only changes on device switch.
    if (sampleRate !== this._cachedSampleRate) {
      this.samplesPerBit = sampleRate / (nominalFps * 80);
      this._cachedSampleRate = sampleRate;
    }
    this.nominalFps = nominalFps;
    if (this.sbEst === 0) this.sbEst = this.samplesPerBit;
    // Chunk wall-clock bookkeeping. If the caller (worklet on the audio thread,
    // or a test) supplied [chunkWallStart, chunkWallEnd], decoded frames inside
    // this chunk get their wall-clock time by linear interpolation across the
    // chunk: the chunk's wall-clock SPAN is host-quartz-measured, the
    // sample-index within the chunk only locates the frame within that span.
    // This recovers true wall-clock arrival time independent of ADC sample-
    // clock drift — the bias that the legacy sample-count-based classifier
    // suffered from. When timestamps are omitted (file analysis fallback), we
    // fall back to stamping at feed-call time and assume ADC == wall-clock; in
    // that mode the wall-clock classifier degrades to the same accuracy as
    // the sample-count path. Consumers can detect this via wallClockMode.
    const callT = performance.now();
    this._chunkStartSampleIdx = this.sampleIndex;
    this._chunkLen = samples.length;
    if (chunkWallStart != null && chunkWallEnd != null) {
      this._chunkWallStart = chunkWallStart;
      this._chunkWallEnd = chunkWallEnd;
      this._wallClockMode = "stamped";
    } else {
      this._chunkWallStart = callT;
      this._chunkWallEnd = callT + (samples.length / sampleRate) * 1000;
      this._wallClockMode = "synthetic";
    }
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
    const parsed = parseFrame(buf, this.nominalFps, frameStart, this._frameMode);
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
      // Frame wall-clock = chunk_t0 + (frame_end_sample_in_chunk / chunk_len) ×
      // (chunk_t1 - chunk_t0). idx[n-1] is the absolute (stream-wide) sample
      // index where the last bit transition was emitted; subtracting the chunk-
      // start sample index gives the position within the current chunk. If the
      // frame straddled the previous chunk boundary (last bit closed on this
      // chunk but the rest came earlier), the position can be slightly negative
      // — clamp to [0, chunkLen-1] so we stay in the interpolation window.
      const offsetInChunk = Math.max(0, Math.min(this._chunkLen - 1,
        idx[n - 1] - this._chunkStartSampleIdx));
      const frac = this._chunkLen > 0 ? offsetInChunk / this._chunkLen : 0;
      const now = this._chunkWallStart + frac * (this._chunkWallEnd - this._chunkWallStart);
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
      // Time-based pruning: keep the last 45 s of decode timestamps. This is
      // longer than the stable measurement window (20 s) + signal-loss hold
      // (5 s) + headroom, and is independent of frame rate (entry-count caps
      // had different window semantics at 24 vs 60 fps).
      const cutoff = now - 45000;
      while (this.recentDecodeTimes.length > 0 && this.recentDecodeTimes[0] < cutoff) {
        this.recentDecodeTimes.shift();
      }
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

export function parseFrame(b, nominalFps, start = 0, frameMode = "wide") {
  const o = start;
  const frUnits  = b[o+0]  | (b[o+1]<<1) | (b[o+2]<<2) | (b[o+3]<<3);
  // 50/60 fps has two encodings (issue #34), selected by `frameMode`:
  //
  //   "wide" (default) — de-facto convention (Tentacle, Ambient, some Sound
  //     Devices firmwares). FF labels every frame; frame-tens is extended to
  //     3 bits by reading bit 58 as the MSB (max FF=79). One word per frame.
  //
  //   "framepair" — spec-conformant ST 12-1 §12. FF labels frame *pairs*
  //     (2-bit tens, wraps at 24/29), bit 58 is BGF1, and the per-field LSB
  //     rides in the field-mark flag (bit 27 at 60, bit 59 at 50). The true
  //     frame number is reconstructed below as FF_pair*2 + field-mark.
  //
  // MultiRateDecoder picks the mode from fieldMarkBehavior() (a TOGGLING flag
  // ⇒ framepair, STATIC ⇒ wide) and sets it on the 50/60 decoders. We only
  // consult bit 58 as a frame-tens MSB in wide mode at 50/60 — at ≤30 fps it
  // is BGF1, and in framepair mode it is BGF1 too.
  const framePair = frameMode === "framepair" && (nominalFps === 50 || nominalFps === 60);
  const useHfrTens = !framePair && nominalFps != null && nominalFps >= 50;
  const frTens   = b[o+8] | (b[o+9]<<1) | (useHfrTens ? (b[o+58]<<2) : 0);
  // Drop-frame flag (bit 10) is meaningful only at 30/60-frame counting;
  // color-frame flag (bit 11) is unused at 24-frame. Suppress both outside
  // their valid cadences so a malformed source can't propagate a spurious
  // flag into downstream consumers (publisher payloads, UI, cadence
  // detector).
  const dfBitValid = nominalFps === 30 || nominalFps === 60;
  const cfBitValid = nominalFps === 25 || nominalFps === 30 ||
                     nominalFps === 50 || nominalFps === 60;
  const dropFrame = dfBitValid && b[o+10] === 1;
  const colorFrame = cfBitValid && b[o+11] === 1;
  const secUnits = b[o+16] | (b[o+17]<<1) | (b[o+18]<<2) | (b[o+19]<<3);
  const secTens  = b[o+24] | (b[o+25]<<1) | (b[o+26]<<2);
  const minUnits = b[o+32] | (b[o+33]<<1) | (b[o+34]<<2) | (b[o+35]<<3);
  const minTens  = b[o+40] | (b[o+41]<<1) | (b[o+42]<<2);
  const hrUnits  = b[o+48] | (b[o+49]<<1) | (b[o+50]<<2) | (b[o+51]<<3);
  const hrTens   = b[o+56] | (b[o+57]<<1);
  // Per-nibble BCD validity: each units field is a BCD digit 0–9; tens
  // fields are constrained by their bit-width and valid value range.
  // Catches single-bit flips that would otherwise produce
  // a value that passes the final bounds check (e.g. secUnits=0b1010 with
  // secTens=0 → ss=10 looks legal but is invalid BCD).
  if (frUnits > 9 || secUnits > 9 || minUnits > 9 || hrUnits > 9) return null;
  if (secTens > 5 || minTens > 5 || hrTens > 2) return null;
  // Field-mark flag at 50/60 fps. A spec-conformant frame-pair source toggles
  // this bit every frame; a wide-LTC source (#34) leaves it static.
  // MultiRateDecoder.fieldMarkBehavior() derives the source's convention from
  // the toggle pattern. See #40 for the bit-27/59 dual semantics at lower
  // cadences. Computed before FF because framepair reconstruction needs it.
  let fieldMark = null;
  if (nominalFps === 60) fieldMark = b[o+27] === 1;
  else if (nominalFps === 50) fieldMark = b[o+59] === 1;
  // FF: in framepair mode frTens*10+frUnits is the pair number; the true
  // frame is pair*2 + field-mark LSB. In wide mode FF is read directly.
  const ff = framePair
    ? (frTens * 10 + frUnits) * 2 + (fieldMark ? 1 : 0)
    : frTens * 10 + frUnits;
  const ss = secTens * 10 + secUnits;
  const mm = minTens * 10 + minUnits;
  const hh = hrTens * 10 + hrUnits;
  if (ff > 79 || ss > 59 || mm > 59 || hh > 23) return null;
  // Binary-group flag bits (BGF0/1/2). Positions are rate-dependent; the
  // combination identifies the user-bit encoding (e.g. ST 309 date/timezone).
  // At 50/60 fps in wide mode (#34) bit 58 is repurposed as the frame-tens
  // MSB, so BGF1 is reported as null there — when FF<40 it would coincidentally
  // read 0, but we cannot disambiguate "BGF1=0" from "frame-tens MSB=0". In
  // framepair mode bit 58 is a genuine BGF1 and is reported.
  let bgf0 = null, bgf1 = null, bgf2 = null;
  if (nominalFps === 25 || nominalFps === 50) {
    bgf0 = b[o+27] === 1;
    bgf2 = b[o+43] === 1;
    if (nominalFps === 25 || framePair) bgf1 = b[o+58] === 1;
  } else if (nominalFps === 24 || nominalFps === 30 || nominalFps === 60) {
    bgf0 = b[o+43] === 1;
    bgf2 = b[o+59] === 1;
    if (nominalFps === 24 || nominalFps === 30 || framePair) bgf1 = b[o+58] === 1;
  }
  // User bits: eight 4-bit groups, each read LSB-first within the group,
  // returned in transmission order (UB1 first). The semantic interpretation
  // is selected by the BGF triplet — see bgf0/1/2 above. Downstream code
  // decides how to render.
  const ub = new Uint8Array(8);
  const ubStarts = [4, 12, 20, 28, 36, 44, 52, 60];
  for (let g = 0; g < 8; g++) {
    const s = ubStarts[g];
    ub[g] = b[o+s] | (b[o+s+1]<<1) | (b[o+s+2]<<2) | (b[o+s+3]<<3);
  }
  return { hh, mm, ss, ff, dropFrame, colorFrame, fieldMark, bgf0, bgf1, bgf2, userBits: ub };
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
// **48 and 47.95 fps are intentionally absent from this candidate set.** A
// spec-compliant 48p source emits LTC at a 24-cadence count with the
// per-field LSB carried in a field-mark flag — already covered by the 24
// candidate; `fieldMarkBehavior()` (#37) will report TOGGLING on such a
// source. A non-spec "wide LTC" 48 fps stream (analogous to the 50/60
// deviation in #34) is the case this set does NOT cover; if such sources
// need to be detected, add 48 here. See issue #41.
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
    // Measurement-grade fractional/integer classification state.
    // _committedFractional is the last classification we are confident enough
    // to report on the UI; _committedNominalFps is the integer fps it applies
    // to. Both are null while MEASURING or after signal loss > 5 s.
    this._committedFractional = null;       // null | true | false
    this._committedNominalFps = null;       // 24 | 30 | 60 | null
    // Agreement-counter state for the 5σ + 3 consecutive agreements commit
    // rule. We require three successive measurement updates, each ≥1 s apart,
    // to agree on the same side before we commit. _pendingFractional is the
    // current candidate side under accumulation; _agreementCount counts how
    // many times we've observed it consecutively; _lastAgreementT throttles
    // the counter so it can't be advanced by sub-second update bursts.
    this._pendingFractional = null;
    this._pendingNominalFps = null;
    this._agreementCount = 0;
    this._lastAgreementT = 0;
    // Divergence-hysteresis state — mirror of the commit agreement counter,
    // applied to the 3 s detector window's signal that the committed side is
    // wrong. The 3 s window's noise floor (σ ~60+ ppm) is high enough that a
    // single 5σ excursion can fire on a stable borderline source whose true
    // rate sits within ~1000 ppm of the midpoint. Requiring N consecutive
    // same-side detector measurements ≥1 s apart (same shape as the commit
    // rule) suppresses one-shot noise blips while still catching a real
    // source rate change within ~3–5 s. _divergenceSide is the candidate
    // wrong-side under accumulation; _divergenceCount is how many times
    // we've seen it consecutively; _lastDivergenceT throttles the counter.
    this._divergenceSide = null;
    this._divergenceCount = 0;
    this._lastDivergenceT = 0;
    // Signal-loss hold. _lastFreshT is the *stamped* wall-clock time of the most
    // recent decoded frame (winner), used by drift/stamp-domain consumers.
    this._lastFreshT = 0;
    // _lastDeliveryT is performance.now() at the moment a NEW winner frame was
    // last observed — i.e. when the decoder was actually *handed* a frame. The
    // hold keys off this, not _lastFreshT, so that a tab-backgrounding burst
    // (frames delivered late but continuously, stamped up to 30 s ago) does not
    // look stale and wrongly expire the commit. Genuine signal loss stops
    // deliveries, so _lastDeliveryT freezes and the hold expires as before (#51).
    this._lastDeliveryT = 0;
    this._lastSeenFrame = null;             // identity of the last winner frame observed
    this._holdStartT = 0;                   // 0 when not in hold; set on first stale tick
    // performance.now() resolution probe (clamped lower bound on measurement
    // uncertainty). Some deployment contexts (cross-origin isolation off on
    // some browsers) quantize performance.now() to 1 ms; we must widen our
    // commit threshold accordingly. Probed lazily on the first feed() call.
    this._clockResolutionMs = null;
    // Event log for App.jsx to consume (MEASURING_COMMIT, DIVERGENCE,
    // RATE_CHANGE). Same pattern as cadenceDetector.lastBreak: App.jsx
    // watches .t for change and writes a session-log entry.
    this._lastEvent = null;
    // Field-mark history. When the winner is the 50 or 60 fps decoder, each
    // decoded frame's parseFrame extracts a fieldMark bit. A frame-pair
    // source toggles it every frame; a wide-LTC source (#34) leaves it
    // static. fieldMarkBehavior() classifies the recent toggle pattern.
    this._recentFieldMarks = [];            // { t, v }
    // Cadence-reset triggers (see feed()): the winning decoder's last nominal
    // fps and the timestamp of the last carrier event we acted on, so a source
    // rate/flavor change flushes the cadence detector's cumulative inference.
    this._lastWinnerFps = null;
    this._lastHandledCarrierEventT = 0;
  }

  // Probe performance.now() resolution by sampling deltas. Repeated calls in
  // a tight loop yield either 0 (same tick) or one resolution unit (next
  // tick). The minimum nonzero delta over N samples is a good estimate of the
  // quantization granularity.
  _probeClockResolution() {
    let minDelta = Infinity;
    let prev = performance.now();
    for (let i = 0; i < 1000; i++) {
      const t = performance.now();
      const d = t - prev;
      if (d > 0 && d < minDelta) minDelta = d;
      prev = t;
    }
    // If performance.now() never advanced over 1000 reads we're either on a
    // fixed-tick clock (rare on real hardware) or under a test mock that
    // returns a constant. Either way the loop-based probe isn't informative
    // — assume effectively-continuous precision so the σ floor doesn't choke
    // off legitimate commits. Real browsers always advance within 1000 reads.
    return Number.isFinite(minDelta) ? minDelta : 0.001;
  }

  feed(samples, sampleRate, chunkWallStart, chunkWallEnd) {
    this._carrierObs = null;
    for (const { fps, dec } of this.decoders) dec.feed(samples, sampleRate, fps, chunkWallStart, chunkWallEnd);
    this._pickWinner();
    // Drive the carrier measurement state machine once per feed. The state
    // machine advances the 5σ + 3-agreements commit, divergence detection,
    // and signal-loss hold — none of which should be gated on whether
    // anything happens to call carrierObservation() during this tick.
    this.carrierObservation();
    // Flush the cadence detector's cumulative inference when the carrier
    // indicates a source rate/flavor change, so the NON-CONFORMANT mismatch and
    // cadence readout stop reporting the previous stream's evidence. Two
    // complementary triggers: a change in the winning decoder's nominal fps
    // (nominal-rate changes, e.g. 59.94<->29.97, where the winner switches) and
    // a carrier DIVERGENCE / RATE_CHANGE event (fractional<->integer at the
    // same nominal, e.g. 29.97<->30, where the winner fps does not change).
    // After the reset, isDropFrame() falls back to the rolling DF-flag window,
    // so DF recovers within seconds instead of waiting a full minute boundary.
    const winnerFps = this.nominalFps;
    const ev = this._lastEvent;
    const newCarrierEvent = !!ev && ev.t !== this._lastHandledCarrierEventT &&
      (ev.type === "DIVERGENCE" || ev.type === "RATE_CHANGE");
    const winnerFpsChanged = winnerFps != null && this._lastWinnerFps != null &&
      winnerFps !== this._lastWinnerFps;
    if (winnerFpsChanged || newCarrierEvent) this.cadenceDetector.reset();
    if (winnerFps != null) this._lastWinnerFps = winnerFps;
    if (ev) this._lastHandledCarrierEventT = ev.t;
    // Drain the winning decoder's pending frames into the cadence detector.
    // A single audio chunk can contain more than one LTC frame; checking only
    // `lastFrame` per chunk would miss intermediate frames.
    const winner = this.winner;
    if (winner) {
      for (const frame of winner.dec.pendingFrames) {
        this.cadenceDetector.feed(frame);
        if (frame.fieldMark != null) {
          this._recentFieldMarks.push({ t: frame.t, v: frame.fieldMark });
        }
      }
      // Time-prune to the last 3 s. At 60 fps that's ~180 samples — enough
      // for a stable toggle/static classification; at 50 fps ~150.
      const cutoff = performance.now() - 3000;
      while (this._recentFieldMarks.length > 0 &&
             this._recentFieldMarks[0].t < cutoff) {
        this._recentFieldMarks.shift();
      }
    } else {
      this._recentFieldMarks = [];
    }
    // 50/60 fps frame-mode selection (#34). A TOGGLING field-mark flag means
    // the source is spec-conformant frame-pair LTC (FF labels pairs, flag is
    // the field LSB); STATIC means de-facto wide LTC (FF labels every frame).
    // Switch the 50/60 decoders' FF interpretation so a frame-pair source
    // decodes to the true frame count instead of reading each pair twice and
    // throwing a REPEAT continuity break every other frame.
    if (winner && (winner.fps === 50 || winner.fps === 60)) {
      const fmb = this.fieldMarkBehavior();
      const mode = fmb === "TOGGLING" ? "framepair" : fmb === "STATIC" ? "wide" : null;
      if (mode) {
        for (const { fps, dec } of this.decoders) {
          if ((fps === 50 || fps === 60) && dec._frameMode !== mode) {
            dec._frameMode = mode;
            // FF semantics just changed — frames decoded before the flip were
            // a misinterpretation. Clear cadence inference and the continuity
            // counter so the brief wide-mode acquisition transient doesn't
            // leave spurious REPEATs once we know the source is frame-pair.
            this.cadenceDetector.reset();
            this.cadenceDetector.continuityBreaks = 0;
            this.cadenceDetector.lastBreak = null;
          }
        }
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
  // Tri-state: true | false | null. Null while MEASURING, when the host-quartz
  // estimate has not yet committed at 5σ + 3 agreements. This is the load-
  // bearing primitive that separates carrier-rate detection from counting-
  // cadence detection — and a measurement-grade analyzer reports "still
  // measuring" rather than guessing.
  _carrierIsFractional() {
    return this.carrierObservation().fractional;
  }

  // Carrier-rate key, from wall-clock-based fps measurement. Returns one of:
  //   "23.976" | "24" | "25" | "29.97" | "30" | "50" | "59.94" | "60"
  // or null until the host-quartz-based classifier has committed.
  carrierRate() {
    return this.carrierObservation().carrierRate;
  }

  // Least-squares slope of frame-index vs wall-clock time across the supplied
  // window. Returns { fps, sigmaFps, n, spanSec, ratio, sigmaRatio } or null.
  // - fps is the measured frame rate from the slope (frames/ms × 1000)
  // - sigmaFps is the standard error of the slope, floored by the
  //   performance.now() quantization noise contribution
  // - ratio is fps / nominalIntegerFps, used directly for fractional/integer
  //   classification. The decision midpoint is (1 + 1/1.001) / 2.
  // Centered-time form for numerical stability — performance.now() can be
  // 10^9+ ms at runtime, and uncentered Σt² loses precision in float64.
  _lsqFps(times, fromT, toT, nominalFps) {
    if (!times || times.length === 0) return null;
    // Inclusive both ends; binary-searchable but linear is fine for ≤2k entries.
    let i0 = 0;
    while (i0 < times.length && times[i0] < fromT) i0++;
    const n = times.length - i0;
    if (n < 10) return null;
    const spanMs = times[times.length - 1] - times[i0];
    if (spanMs < 500) return null;
    let tSum = 0;
    for (let i = i0; i < times.length; i++) tSum += times[i];
    const tMean = tSum / n;
    const yMean = (n - 1) / 2;
    let Sxx = 0, Sxy = 0;
    for (let i = i0; i < times.length; i++) {
      const dt = times[i] - tMean;
      const dy = (i - i0) - yMean;
      Sxx += dt * dt;
      Sxy += dt * dy;
    }
    if (Sxx <= 0) return null;
    const slope = Sxy / Sxx;     // frames per ms
    // Residual sum of squares for stderr.
    let SSres = 0;
    for (let i = i0; i < times.length; i++) {
      const yHat = slope * (times[i] - tMean) + yMean;
      const r = (i - i0) - yHat;
      SSres += r * r;
    }
    const dof = n - 2;
    if (dof <= 0) return null;
    let sigmaSlope = Math.sqrt(SSres / dof) / Math.sqrt(Sxx);
    // Floor sigma by the contribution from performance.now() quantization.
    // Endpoint timestamp uncertainty propagates roughly as
    // σ_q / (span × √(n/12)); ignoring the constant, σ_q/span is a
    // conservative floor that prevents over-confidence when the residuals
    // happen to be tiny by chance.
    const clockRes = this._clockResolutionMs ?? 0.1;
    const qFloor = (clockRes / spanMs) * (1 / 1000);  // slope-domain floor
    if (sigmaSlope < qFloor) sigmaSlope = qFloor;
    const fps = slope * 1000;
    const sigmaFps = sigmaSlope * 1000;
    const ratio = fps / nominalFps;
    const sigmaRatio = sigmaFps / nominalFps;
    return { fps, sigmaFps, n, spanSec: spanMs / 1000, ratio, sigmaRatio };
  }

  // One-shot observation of the carrier, computed lazily and cached until the
  // next feed() invalidates it. Bundles every field the UI / publisher / log
  // would want. See class header for the measurement architecture.
  carrierObservation() {
    if (this._carrierObs) return this._carrierObs;
    const fps = this.nominalFps;
    const winner = this.winner;
    const now = performance.now();
    if (this._clockResolutionMs == null) {
      this._clockResolutionMs = this._probeClockResolution();
    }
    // medianSpan / meanSpan are retained for ADC-clock-based drift reporting
    // and legacy callers, but no longer drive the fractional classification.
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
    // Stable (20 s) and detector (3 s) wall-clock LSQ windows on the winning
    // decoder's frame timestamps. The two windows serve different roles:
    // stable drives the committed classification; detector watches for source
    // changes and triggers invalidation before stable would catch up.
    let stable = null;
    let detector = null;
    if (winner && fps && (fps === 24 || fps === 30 || fps === 60 ||
                           fps === 25 || fps === 50)) {
      const times = winner.dec.recentDecodeTimes;
      stable   = this._lsqFps(times, now - 20000, now, fps);
      detector = this._lsqFps(times, now -  3000, now, fps);
      if (winner.dec.lastFrame) {
        this._lastFreshT = winner.dec.lastFrame.t;
        // A new frame object means the decoder was just handed a frame. Stamp
        // delivery in the performance.now() domain so the hold measures "how
        // long since we were fed a frame", independent of the frame's own
        // (possibly stale) wall-time. See _lastDeliveryT comment in reset().
        if (winner.dec.lastFrame !== this._lastSeenFrame) {
          this._lastSeenFrame = winner.dec.lastFrame;
          this._lastDeliveryT = now;
        }
      }
    }
    // Side computation: which half of the integer/fractional decision space
    // does the stable estimate sit in, with 5σ confidence?
    //   integer rate:    ratio ≈ 1.000
    //   1.001-divided:   ratio ≈ 1/1.001 ≈ 0.999001
    //   midpoint:        (1 + 1/1.001) / 2 ≈ 0.9995002
    const MIDPOINT = (1 + 1 / 1.001) / 2;
    const SIGMA_GATE = 5;
    const AGREEMENTS_REQUIRED = 3;
    const AGREEMENT_MIN_INTERVAL_MS = 1000;
    let candidateSide = null;   // true (fractional) | false (integer) | null
    const fpsSupportsFractional = (fps === 24 || fps === 30 || fps === 60);
    if (fps === 25 || fps === 50) {
      // 25 / 50 have no NTSC counterpart; fractional is definitionally false.
      candidateSide = false;
    } else if (fpsSupportsFractional && stable) {
      const distFromMid = stable.ratio - MIDPOINT;
      if (Math.abs(distFromMid) >= SIGMA_GATE * stable.sigmaRatio) {
        candidateSide = distFromMid < 0;  // below midpoint → fractional
      }
    }
    // Agreement counter. Sub-1 s update bursts do not advance the counter;
    // genuine consecutive agreements over time do. A change of side or a
    // change of winner fps resets the counter to 1 against the new candidate.
    if (candidateSide == null || fps !== this._pendingNominalFps) {
      if (candidateSide == null) {
        this._pendingFractional = null;
        this._pendingNominalFps = null;
        this._agreementCount = 0;
      } else {
        // New fps came into play (e.g. winner switched).
        this._pendingFractional = candidateSide;
        this._pendingNominalFps = fps;
        this._agreementCount = 1;
        this._lastAgreementT = now;
      }
    } else if (candidateSide !== this._pendingFractional) {
      this._pendingFractional = candidateSide;
      this._agreementCount = 1;
      this._lastAgreementT = now;
    } else if (now - this._lastAgreementT >= AGREEMENT_MIN_INTERVAL_MS) {
      this._agreementCount++;
      this._lastAgreementT = now;
    }
    // Commit when we've reached the agreement target.
    const readyToCommit = (this._pendingFractional != null &&
                          this._agreementCount >= AGREEMENTS_REQUIRED);
    if (readyToCommit) {
      const prevFractional = this._committedFractional;
      const prevFps = this._committedNominalFps;
      const changed = (prevFractional !== this._pendingFractional ||
                       prevFps !== this._pendingNominalFps);
      if (changed) {
        const eventType = (prevFractional == null) ? "MEASURING_COMMIT" : "RATE_CHANGE";
        this._lastEvent = {
          type: eventType, t: now,
          fps: this._pendingNominalFps,
          fractional: this._pendingFractional,
          measuredFps: stable?.fps,
          sigmaFps: stable?.sigmaFps,
          windowFrames: stable?.n,
          windowSeconds: stable?.spanSec,
          previousFractional: prevFractional,
          previousNominalFps: prevFps,
        };
      }
      this._committedFractional = this._pendingFractional;
      this._committedNominalFps = this._pendingNominalFps;
      this._holdStartT = 0;
      // Fresh commit resets the divergence counter — any prior wrong-side
      // detector hits accumulated against the previous commit no longer apply.
      this._divergenceSide = null;
      this._divergenceCount = 0;
      this._lastDivergenceT = 0;
    }
    // Divergence: if we have a commit AND the 3 s detector window has, with
    // ≥5σ confidence and on N consecutive ≥1 s-apart measurements, reported
    // the OTHER side of the midpoint — drop the commit and re-measure. The
    // N-agreement requirement mirrors the commit rule and suppresses single-
    // sample noise blips from the short window's higher σ floor, which would
    // otherwise fire spuriously on borderline sources (true rate within ~1000
    // ppm of midpoint). The trade-off: a genuine source rate change takes
    // ~3–5 s to be confirmed instead of being acted on immediately. Disabled
    // while signal is stale (handled by hold logic below).
    if (this._committedFractional != null && detector && fps === this._committedNominalFps) {
      const distFromMid = detector.ratio - MIDPOINT;
      const detectorSide = (Math.abs(distFromMid) >= SIGMA_GATE * detector.sigmaRatio)
        ? (distFromMid < 0) : null;
      const wrongSide = (detectorSide != null && detectorSide !== this._committedFractional);
      if (!wrongSide) {
        // Detector agrees with commit (or is uncertain) — reset hysteresis.
        this._divergenceSide = null;
        this._divergenceCount = 0;
      } else if (detectorSide !== this._divergenceSide) {
        // First wrong-side hit, or the wrong side changed (e.g. detector
        // flapped). Start a fresh agreement run.
        this._divergenceSide = detectorSide;
        this._divergenceCount = 1;
        this._lastDivergenceT = now;
      } else if (now - this._lastDivergenceT >= AGREEMENT_MIN_INTERVAL_MS) {
        this._divergenceCount++;
        this._lastDivergenceT = now;
      }
      if (this._divergenceCount >= AGREEMENTS_REQUIRED) {
        this._lastEvent = {
          type: "DIVERGENCE", t: now,
          fps: this._committedNominalFps,
          committedFractional: this._committedFractional,
          detectorFractional: this._divergenceSide,
          detectorFps: detector.fps,
          detectorSigmaFps: detector.sigmaFps,
        };
        this._committedFractional = null;
        this._committedNominalFps = null;
        this._pendingFractional = this._divergenceSide;
        this._pendingNominalFps = fps;
        this._agreementCount = 1;
        this._lastAgreementT = now;
        this._divergenceSide = null;
        this._divergenceCount = 0;
      }
    } else {
      // No commit (or fps changed) — clear divergence counter so it doesn't
      // straddle commit cycles.
      this._divergenceSide = null;
      this._divergenceCount = 0;
    }
    // Signal-loss hold. Stale = we haven't been *delivered* a frame in 500 ms
    // of real time (_lastDeliveryT, not the frame's stamped time). Keying off
    // delivery is what makes a tab-backgrounding burst survive: on tab-return
    // the queued chunks drain continuously, so deliveries are current even
    // though each frame's stamp is up to 30 s old — the commit must not expire
    // (#51). True signal loss freezes deliveries, so this still trips at 500 ms
    // and clears the commit 5 s later, as before.
    const stale = !winner || (now - this._lastDeliveryT > 500);
    if (stale && this._committedFractional != null) {
      if (this._holdStartT === 0) this._holdStartT = this._lastDeliveryT;
      if (now - this._holdStartT > 5000) {
        this._committedFractional = null;
        this._committedNominalFps = null;
        this._pendingFractional = null;
        this._pendingNominalFps = null;
        this._agreementCount = 0;
        this._holdStartT = 0;
        this._divergenceSide = null;
        this._divergenceCount = 0;
      }
    } else if (!stale) {
      this._holdStartT = 0;
    }
    // Report. fractional reflects committed state; classConfidence is "high"
    // once committed, null otherwise. (Two-level so far; the field exists so
    // App.jsx / publisher don't need to evolve when we add intermediate
    // confidence levels.)
    const fractional = this._committedFractional;
    const classConfidence = fractional != null ? "high" : null;
    let carrierRate = null;
    if (fps === 25) carrierRate = "25";
    else if (fps === 50) carrierRate = "50";
    else if (fractional != null && fps === this._committedNominalFps) {
      if (fps === 24) carrierRate = fractional ? "23.976" : "24";
      else if (fps === 30) carrierRate = fractional ? "29.97" : "30";
      else if (fps === 60) carrierRate = fractional ? "59.94" : "60";
    }
    this._carrierObs = {
      nominalFps: fps,
      fractional,
      carrierRate,
      classConfidence,
      medianSpan,
      meanSpan,
      stable,
      detector,
      pendingFractional: this._pendingFractional,
      agreementCount: this._agreementCount,
      agreementsRequired: AGREEMENTS_REQUIRED,
      heldDuringSignalLoss: stale && fractional != null,
      clockResolutionMs: this._clockResolutionMs,
      measurementMethod: "walltime-lsq",
    };
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

  // Carrier-vs-cadence anomaly. Returns
  //   { result: true | false, confidence: "high" | null, reason: string | null }
  // or null if either detection isn't ready. confidence is "high" only when
  // both the carrier classifier has committed (5σ + 3 agreements) AND the
  // cadence detector reports its own readiness. Lower-confidence mismatches
  // (one side still MEASURING) are reported as result=false rather than
  // raised — we don't alarm operators on unsettled measurements.
  carrierCadenceMismatch() {
    const obs = this.carrierObservation();
    const cad = this.cadence();
    if (obs.fractional == null || obs.nominalFps == null || cad == null) return null;
    const carrier = obs.carrierRate;
    if (carrier == null) return null;
    const carrierNominalFps = rateKeyToNominalFps(carrier);
    if (cad.fps !== carrierNominalFps) {
      return { result: true, confidence: "high",
        reason: `carrier ${carrierNominalFps} fps but cadence counts at ${cad.fps} fps` };
    }
    if (cad.dropFrame && obs.fractional === false) {
      return { result: true, confidence: "high",
        reason: `integer ${carrierNominalFps} fps carrier carrying DF count` };
    }
    return { result: false, confidence: "high", reason: null };
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

  // Source-LTC-clock drift relative to the HOST QUARTZ, in parts-per-million.
  // This is the wall-clock-domain drift derived from the LSQ measurement —
  // independent of the capture device's sample clock. For an LTC source that
  // is itself disciplined to house sync, ±0 ppm here means the source is
  // synced to the host's quartz; ±tens of ppm typically indicates host-quartz
  // drift rather than source drift (commodity quartz is ±10–50 ppm). For an
  // absolute drift number you would discipline the host clock against an
  // external reference.
  driftPpmSourceVsHostQuartz() {
    const obs = this.carrierObservation();
    if (!obs.stable || obs.fractional == null || obs.nominalFps == null) return null;
    const expected = obs.nominalFps / (obs.fractional ? 1.001 : 1.0);
    return (obs.stable.fps - expected) / expected * 1e6;
  }

  // Source-LTC-clock drift relative to the ADC sample clock, in parts-per-
  // million. Convention: positive means source is FASTER than the ADC clock
  // (matches the convention used by driftPpmSourceVsHostQuartz). Computed
  // from sample-count-based frame-span timing; diagnostic of the capture
  // chain (a high value here together with a low host-quartz value means
  // the ADC clock is off, not the LTC source).
  //
  // Note on sign: if the ADC clock runs fast, each source-frame's span in
  // ADC samples is LARGER than nominal (more ADC ticks elapse during the
  // same wall-clock interval). meanSpan > expected → source-slower-than-
  // ADC → negative drift. Hence (expected − meanSpan) / expected, not
  // (meanSpan − expected).
  driftPpmSourceVsAdc() {
    const winner = this.winner;
    if (!winner) return null;
    const dec = winner.dec;
    const spans = dec.recentFrameSpans;
    if (!spans || spans.length < 10) return null;
    const obs = this.carrierObservation();
    if (obs.fractional == null) return null;
    let sum = 0;
    for (let i = 0; i < spans.length; i++) sum += spans[i];
    const meanSpan = sum / spans.length;
    const expected = 79 * dec.samplesPerBit * (obs.fractional ? 1.001 : 1.0);
    return (expected - meanSpan) / expected * 1e6;
  }

  // Capture-clock error: difference between source-vs-host and source-vs-ADC
  // drift. With the source as common reference, this is how far the ADC clock
  // is from the host quartz. A capture device feeding a sample-rate-converter
  // can land at hundreds of ppm here.
  captureClockErrorPpm() {
    const host = this.driftPpmSourceVsHostQuartz();
    const adc = this.driftPpmSourceVsAdc();
    if (host == null || adc == null) return null;
    return host - adc;
  }

  // Deprecated alias. New code should choose explicitly between the two
  // drift numbers depending on what the engineer wants to know.
  driftPpm() { return this.driftPpmSourceVsHostQuartz(); }

  // Event log accessor for App.jsx (mirrors cadenceDetector.lastBreak pattern).
  // Fires on MEASURING_COMMIT, RATE_CHANGE, and DIVERGENCE transitions.
  get lastCarrierEvent() { return this._lastEvent; }

  // Field-mark inference at 50/60 fps. Returns one of:
  //   "TOGGLING"   — flag toggles ≥80% of consecutive samples ⇒ source is
  //                  frame-pair LTC (FF labels frame pairs, flag carries
  //                  per-field LSB).
  //   "STATIC"     — flag toggles ≤20% of consecutive samples ⇒ source is
  //                  de-facto wide LTC (FF labels every frame directly).
  //   null         — winner is not 50/60, insufficient samples (<10), or
  //                  toggle rate is in the ambiguous middle.
  // Operators reading the AUDIT panel can use this to decide whether the
  // current cadence label is the source's actual semantic rate ("wide LTC at
  // 60") or half of it ("frame-pair LTC labelling 60p").
  fieldMarkBehavior() {
    const n = this._recentFieldMarks.length;
    if (n < 10) return null;
    let toggles = 0;
    for (let i = 1; i < n; i++) {
      if (this._recentFieldMarks[i].v !== this._recentFieldMarks[i-1].v) toggles++;
    }
    const rate = toggles / (n - 1);
    if (rate >= 0.8) return "TOGGLING";
    if (rate <= 0.2) return "STATIC";
    return null;
  }
}

export function rateKeyToNominalFps(rateKey) {
  if (rateKey === "59.94df" || rateKey === "59.94" || rateKey === "60") return 60;
  if (rateKey === "50") return 50;
  if (rateKey === "29.97df" || rateKey === "29.97" || rateKey === "30") return 30;
  if (rateKey === "25") return 25;
  return 24; // 23.976, 24
}

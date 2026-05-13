// LTC biphase-mark decoder with rolling state across sample chunks.
// Per SMPTE ST 12-1: 80 bits/frame, sync word 0011111111111101 at bits 64-79.
//
// Biphase-mark rules:
//   - every bit boundary has a transition
//   - a "1" adds a mid-bit transition (so two short intervals per "1")
//   - a "0" has no mid-bit transition (one long interval per "0")
// We pair consecutive short intervals into a single "1" bit.

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
  }

  feed(samples, sampleRate, nominalFps) {
    this.samplesPerBit = sampleRate / (nominalFps * 80);
    const samplesPerBit = this.samplesPerBit;
    const halfBit = samplesPerBit / 2;
    // ±15% per-interval tolerance prevents 24/25 fps decoders from accepting
    // 30 fps intervals (which differ by ~25%), but is still loose enough for
    // the typical 1-2% clock drift of real LTC sources. 24 vs 25 fps cross-
    // locks (only 4% apart) are caught downstream by the frame-span check.
    const shortMin = halfBit * 0.85;
    const shortMax = halfBit * 1.15;
    const longMin  = samplesPerBit * 0.85;
    const longMax  = samplesPerBit * 1.15;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      // Treat exact zero as previous sign to avoid spurious crossings.
      const sign = s > 0 ? 1 : (s < 0 ? -1 : this.lastSign);
      if (this.lastSign !== 0 && sign !== this.lastSign) {
        const interval = this.sampleIndex - this.lastTransitionSample;
        if (interval >= shortMin && interval <= shortMax) {
          if (this.pendingShort) {
            this._pushBit(1);
            this.pendingShort = false;
          } else {
            this.pendingShort = true;
          }
        } else if (interval >= longMin && interval <= longMax) {
          if (this.pendingShort) {
            // Unpaired short followed by a long — drop the orphan, count as error.
            this.bitErrors++;
            this.pendingShort = false;
          }
          this._pushBit(0);
        } else {
          // Out of range — glitch or wrong rate.
          this.bitErrors++;
          this.pendingShort = false;
        }
        this.lastTransitionSample = this.sampleIndex;
      }
      if (sign !== 0) this.lastSign = sign;
      this.sampleIndex++;
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
      this.lastFrame = { ...parsed, t: performance.now() };
      this.lastFrameBits = Uint8Array.from(f);
      this.framesDecoded++;
      this.recentFrameSpans.push(frameSamples);
      if (this.recentFrameSpans.length > 30) this.recentFrameSpans.shift();
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

function parseFrame(b) {
  const frUnits  = b[0]  | (b[1]<<1) | (b[2]<<2) | (b[3]<<3);
  const frTens   = b[8]  | (b[9]<<1);
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
  if (ff > 59 || ss > 59 || mm > 59 || hh > 23) return null;
  return { hh, mm, ss, ff, dropFrame, colorFrame };
}

// Run several LtcDecoders at candidate fps in parallel and pick the winner
// by recent score (frames decoded - bit errors). This is how we auto-detect
// incoming rate without asking the user.
const CANDIDATE_FPS = [24, 25, 30, 50, 60];

export class MultiRateDecoder {
  constructor() {
    this.decoders = CANDIDATE_FPS.map(fps => ({ fps, dec: new LtcDecoder() }));
    this.winnerIdx = -1;
  }

  feed(samples, sampleRate) {
    for (const { fps, dec } of this.decoders) dec.feed(samples, sampleRate, fps);
    this._pickWinner();
  }

  _pickWinner() {
    let bestScore = -Infinity, bestIdx = -1;
    for (let i = 0; i < this.decoders.length; i++) {
      const d = this.decoders[i].dec;
      // Score: rewards recent locks, penalises sustained bit errors.
      const recencyBonus = (d.lastFrame && performance.now() - d.lastFrame.t < 500) ? 1000 : 0;
      const score = d.framesDecoded - d.bitErrors * 0.1 + recencyBonus;
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

  // Map decoded fps + dropFrame flag + measured frame span to a SMPTE rate
  // key. The dropFrame flag distinguishes the DF variants outright. For NDF
  // signals we measure whether the actual frame span is closer to the
  // integer rate or to the 1.001-divided fractional rate (NTSC family).
  detectedRateKey() {
    const lf = this.lastFrame;
    if (!lf) return null;
    const fps = this.nominalFps;
    if (lf.dropFrame) {
      if (fps === 30) return "29.97df";
      if (fps === 60) return "59.94df";
    }
    // NDF: decide integer vs fractional by frame-span ratio. The 30-fps
    // decoder expects 80 × samplesPerBit samples per frame; an actual 29.97
    // signal arrives 0.1% longer (×1.001). Threshold at the midpoint
    // (×1.0005) so even a 1-sample drift over 30+ samples leans correctly.
    if (fps === 24 || fps === 30 || fps === 60) {
      const winner = this.winner;
      // 79 bit durations between idx[n-80] and idx[n-1] — see _tryDecode.
      const expected = 79 * winner.dec.samplesPerBit;
      const measured = this.medianFrameSpan();
      const isFractional = measured != null && (measured / expected) >= 1.0005;
      if (fps === 24) return isFractional ? "23.976" : "24";
      if (fps === 30) return isFractional ? "29.97" : "30";
      if (fps === 60) return isFractional ? "59.94" : "60";
    }
    if (fps === 25) return "25";
    if (fps === 50) return "50";
    return null;
  }
}

export function rateKeyToNominalFps(rateKey) {
  if (rateKey === "59.94df" || rateKey === "59.94" || rateKey === "60") return 60;
  if (rateKey === "50") return 50;
  if (rateKey === "47.95" || rateKey === "48") return 48;
  if (rateKey === "29.97df" || rateKey === "29.97" || rateKey === "30") return 30;
  if (rateKey === "25") return 25;
  return 24; // 23.976, 24
}

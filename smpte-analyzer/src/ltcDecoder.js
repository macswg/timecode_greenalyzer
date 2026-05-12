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
    this.lastTransitionSample = 0;
    this.sampleIndex = 0;
    this.lastSign = 0;
    this.pendingShort = false;
    this.lastFrame = null;          // { hh, mm, ss, ff, dropFrame, colorFrame, t }
    this.framesDecoded = 0;
    this.bitErrors = 0;
    this.lastBitTime = 0;
  }

  feed(samples, sampleRate, nominalFps) {
    const samplesPerBit = sampleRate / (nominalFps * 80);
    const halfBit = samplesPerBit / 2;
    // Tight bounds (~±25%) keep wrong-rate decoders from cross-locking on a
    // correct-rate signal — they pick up bit errors instead.
    const shortMin = halfBit * 0.75;
    const shortMax = halfBit * 1.25;
    const longMin  = samplesPerBit * 0.75;
    const longMax  = samplesPerBit * 1.25;

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
    this.lastBitTime = performance.now();
    if (this.bitBuf.length > 200) {
      this.bitBuf.splice(0, this.bitBuf.length - 200);
    }
    this._tryDecode();
  }

  _tryDecode() {
    const buf = this.bitBuf;
    const n = buf.length;
    if (n < 80) return;
    // The sync word occupies the LAST 16 bits of each frame. If the tail
    // matches, the previous 64 bits + sync = a complete 80-bit frame.
    for (let i = 0; i < 16; i++) {
      if (buf[n - 16 + i] !== SYNC[i]) return;
    }
    const f = buf.slice(n - 80);
    const parsed = parseFrame(f);
    if (parsed) {
      this.lastFrame = { ...parsed, t: performance.now() };
      this.framesDecoded++;
      // Keep just the sync word so we don't re-decode the same frame; the
      // next frame's bits will accumulate after it.
      this.bitBuf = buf.slice(n - 16);
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
  get framesDecoded() { return this.winner?.dec.framesDecoded ?? 0; }
  get bitErrors() { return this.decoders.reduce((s, d) => s + d.dec.bitErrors, 0); }
  get nominalFps() { return this.winner?.fps ?? null; }

  // Map decoded fps + dropFrame flag to the closest standard SMPTE rate key.
  // We can't distinguish 23.976 from 24 or 29.97-NDF from 30 from a few
  // frames alone, so the dropFrame flag is our only NDF/DF disambiguator.
  detectedRateKey() {
    const lf = this.lastFrame;
    if (!lf) return null;
    const fps = this.nominalFps;
    if (fps === 24) return "24";
    if (fps === 25) return "25";
    if (fps === 30) return lf.dropFrame ? "29.97df" : "30";
    if (fps === 50) return "50";
    if (fps === 60) return lf.dropFrame ? "59.94df" : "60";
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

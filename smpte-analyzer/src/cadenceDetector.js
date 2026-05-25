// Counting-cadence detection — independent of the carrier rate.
//
// Carrier rate (samples-per-frame timing) and counting cadence (how the FF
// field counts) are *separate* properties of an LTC stream and should be
// diagnosed independently. The carrier can be fast or slow with no relation
// to whether the count wraps at 24, 25, 30, 50, 60, or follows DF skipping.
// This module looks ONLY at the decoded HH:MM:SS:FF numbers; it never reads
// frame timing.
//
// What it reports:
//   • cadenceFps(): inferred wrap-at value (24/25/30/50/60) from the FF
//     sequence. Strongest signal is "the FF that most often precedes FF=0"
//     (the rollover boundary); falls back to maxFF+1 until a rollover is seen.
//   • isDropFrame(): inferred from minute-boundary behaviour. At ss=0 in any
//     minute where mm%10 != 0, an NDF count lands on FF=0, a DF count lands
//     on FF≥dropPerMin. The LTC frame's drop-frame *flag bit* is observed
//     separately and reported via dfFlagMatchesObservedCadence() so a
//     mismatched flag (e.g. DF bit asserted but the count never skips) can
//     be surfaced.
//   • continuityBreaks / lastBreak: per-frame +1 monotonicity check, using
//     the inferred cadence — NOT the carrier. This is the critical piece:
//     a stream whose carrier matches one rate but whose count uses a
//     different cadence used to register continuous spurious JUMPs.

import { tcToFrameNumber, tcString } from "./ltcDecoder";

const STANDARD_CADENCES = [24, 25, 30, 50, 60];

function nearestStandardCadence(n) {
  let best = STANDARD_CADENCES[0];
  let bestDiff = Math.abs(n - best);
  for (const c of STANDARD_CADENCES) {
    const d = Math.abs(n - c);
    if (d < bestDiff) { best = c; bestDiff = d; }
  }
  return best;
}

export class CadenceDetector {
  constructor() {
    this.framesSeen = 0;
    this.maxFFObserved = 0;
    // FF value immediately before a FF=0 frame, histogrammed. The mode is
    // the cadence's wrap-at value.
    this.rolloverHist = new Map();
    this._prevFrame = null;
    // DF inference from minute boundaries.
    this.minuteBoundaryDfHits = 0;
    this.minuteBoundaryNdfHits = 0;
    // DF flag bit observation (independent of count behaviour).
    this.dfFlagAsserted = 0;
    this.dfFlagCleared = 0;
    // Continuity.
    this.continuityBreaks = 0;
    this.lastBreak = null;
    this._prevFrameNumber = null;
    this._prevTc = null;
    this._prevT = null;
  }

  feed(frame) {
    this.framesSeen++;
    if (frame.ff > this.maxFFObserved) this.maxFFObserved = frame.ff;
    if (frame.dropFrame) this.dfFlagAsserted++; else this.dfFlagCleared++;

    if (this._prevFrame && frame.ff === 0 && this._prevFrame.ff > 0) {
      const v = this._prevFrame.ff;
      this.rolloverHist.set(v, (this.rolloverHist.get(v) ?? 0) + 1);
    }

    // Minute boundary: ss=0 in a minute that's NOT a multiple of 10.
    if (this._prevFrame
        && frame.ss === 0
        && this._prevFrame.ss === 59
        && frame.mm % 10 !== 0) {
      if (frame.ff === 0) {
        this.minuteBoundaryNdfHits++;
      } else if (frame.ff >= 1 && frame.ff <= 5) {
        // DF skip lands on FF=dropPerMin (2 for 30-cadence, 4 for 60-cadence).
        // Allow a small range in case we missed the literal first frame.
        this.minuteBoundaryDfHits++;
      }
    }

    const cadence = this.cadenceFps();
    const df = this.isDropFrame();
    if (cadence != null && df != null) {
      if (this._prevT != null && (frame.t - this._prevT) > 500) {
        this._prevFrameNumber = null;
        this._prevTc = null;
      }
      if (this._prevT != null && (frame.t - this._prevT) > 3000) {
        this.continuityBreaks = 0;
        this.lastBreak = null;
      }
      const current = tcToFrameNumber(frame.hh, frame.mm, frame.ss, frame.ff, cadence, df);
      if (this._prevFrameNumber != null) {
        const delta = current - this._prevFrameNumber;
        if (delta !== 1) {
          this.continuityBreaks++;
          this.lastBreak = {
            type: delta === 0 ? "REPEAT" : delta > 1 ? "JUMP" : "REWIND",
            delta,
            from: this._prevTc,
            to: tcString(frame),
            t: frame.t,
          };
        }
      }
      this._prevFrameNumber = current;
      this._prevTc = tcString(frame);
    }
    this._prevT = frame.t;
    this._prevFrame = frame;
  }

  // Returns the inferred wrap-at cadence (24/25/30/50/60), or null until we've
  // seen enough frames. Mode of the rollover histogram is the canonical
  // answer; maxFF+1 is a faster but weaker fallback.
  cadenceFps() {
    if (this.framesSeen < 30) return null;
    let modal = null, modalCount = 0;
    for (const [v, n] of this.rolloverHist) {
      if (n > modalCount) { modal = v; modalCount = n; }
    }
    const raw = modal != null ? modal + 1 : this.maxFFObserved + 1;
    return nearestStandardCadence(raw);
  }

  // Drop-frame inferred from count behaviour at minute boundaries. Returns
  // null until at least one boundary observation. Before any boundary, falls
  // back to the LTC DF flag bit so the continuity check can engage early.
  isDropFrame() {
    const boundaryObs = this.minuteBoundaryDfHits + this.minuteBoundaryNdfHits;
    if (boundaryObs === 0) {
      if (this.dfFlagAsserted + this.dfFlagCleared === 0) return null;
      return this.dfFlagAsserted > this.dfFlagCleared;
    }
    return this.minuteBoundaryDfHits > this.minuteBoundaryNdfHits;
  }

  // Whether the DF flag bit in the LTC frames agrees with the observed
  // counting behaviour. Returns null until both are known. A `false` here is
  // a real conformance fault: someone asserted DF in the frame but isn't
  // actually skipping frames at minute boundaries (or vice versa).
  dfFlagMatchesObservedCadence() {
    if (this.minuteBoundaryDfHits + this.minuteBoundaryNdfHits === 0) return null;
    if (this.dfFlagAsserted + this.dfFlagCleared === 0) return null;
    const observedDf = this.minuteBoundaryDfHits > this.minuteBoundaryNdfHits;
    const flagDf = this.dfFlagAsserted > this.dfFlagCleared;
    return observedDf === flagDf;
  }
}

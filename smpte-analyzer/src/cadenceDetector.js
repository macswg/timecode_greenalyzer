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

import { tcString } from "./ltcDecoder";
import { tcToFrameNumber, minuteBoundaryDfRange, framesPerDay } from "./dropFrame";

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
    // DF flag bit observation (independent of count behaviour). Rolling
    // window of recent frames' dropFrame bits — not a lifetime tally — so a
    // mid-session source change from DF to NDF (re-jam, source switch) is
    // reflected within ~10 s rather than after enough flips to outweigh the
    // entire prior session.
    this._dfFlagWindow = [];
    this._DF_FLAG_WINDOW_SIZE = 300;
    // Continuity.
    this.continuityBreaks = 0;
    this.lastBreak = null;
    this._prevFrameNumber = null;
    this._prevTc = null;
    this._prevT = null;
  }

  // Flush cadence/DF inference and per-frame tracking for a fresh start.
  // Called by MultiRateDecoder when the carrier classifier signals a source
  // rate/flavor change, so cumulative evidence from the previous stream
  // (rollover histogram, minute-boundary DF tallies, DF-flag window) stops
  // driving cadenceFps()/isDropFrame() — and hence the NON-CONFORMANT
  // mismatch — long after the input has changed. After this, isDropFrame()
  // has zero boundary observations and falls back to the rolling DF-flag
  // window, so DF re-acquires within seconds rather than at the next minute
  // boundary. The lifetime continuityBreaks counter and lastBreak are left
  // alone (they have their own signal-gap lifecycle); only the per-frame
  // tracking refs are cleared so the first frame of the new stream doesn't
  // register a spurious continuity break across the transition.
  reset() {
    this.framesSeen = 0;
    this.maxFFObserved = 0;
    this.rolloverHist = new Map();
    this._prevFrame = null;
    this.minuteBoundaryDfHits = 0;
    this.minuteBoundaryNdfHits = 0;
    this._dfFlagWindow = [];
    this._prevFrameNumber = null;
    this._prevTc = null;
    this._prevT = null;
  }

  feed(frame) {
    this.framesSeen++;
    if (frame.ff > this.maxFFObserved) this.maxFFObserved = frame.ff;
    this._dfFlagWindow.push(frame.dropFrame ? 1 : 0);
    if (this._dfFlagWindow.length > this._DF_FLAG_WINDOW_SIZE) this._dfFlagWindow.shift();

    if (this._prevFrame && frame.ff === 0 && this._prevFrame.ff > 0) {
      const v = this._prevFrame.ff;
      this.rolloverHist.set(v, (this.rolloverHist.get(v) ?? 0) + 1);
    }

    // Minute boundary: ss=0 in a minute that's NOT a multiple of 10. The NDF
    // range is widened to ff<=1 so a single missed first-frame after the
    // boundary doesn't bias the histogram against NDF; DF is tightened to
    // [dropPerMin, dropPerMin+2] so the two windows don't overlap. The DF
    // classification needs to know the cadence (drop=2 for 30, 4 for 60),
    // so we defer until cadenceFps() returns a value.
    //
    // A true ss=59→ss=0 crossing must also advance the minute (or wrap the
    // hour). A looping playback source (e.g. a 1-minute file that wraps back
    // to its own start TC) produces a pseudo-crossing where mm/hh stay
    // constant — that's a rewind, not a minute boundary, and counting it
    // as one biases the DF inference toward NDF since the loop start almost
    // always lands on ff=0.
    const minuteAdvanced = this._prevFrame
      && (frame.mm !== this._prevFrame.mm || frame.hh !== this._prevFrame.hh);
    if (this._prevFrame
        && frame.ss === 0
        && this._prevFrame.ss === 59
        && minuteAdvanced
        && frame.mm % 10 !== 0) {
      const cadence = this.cadenceFps();
      if (cadence != null) {
        const { ndfMax, dfMin, dfMax } = minuteBoundaryDfRange(cadence);
        if (frame.ff <= ndfMax) {
          this.minuteBoundaryNdfHits++;
        } else if (frame.ff >= dfMin && frame.ff <= dfMax) {
          this.minuteBoundaryDfHits++;
        }
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
        // Timecode is a 24h cyclic counter; tcToFrameNumber wraps to 0 at
        // midnight. Compute the minimal cyclic delta so a +1 step across the
        // day rollover (23:59:59:FF -> 00:00:00:00) reads as +1 rather than a
        // full-day REWIND, while small jumps/rewinds keep their true sign and
        // magnitude. Only an (unusual) intentional skip of more than 12h across
        // midnight would be taken the short way around.
        const fpd = framesPerDay(cadence, df);
        let delta = (((current - this._prevFrameNumber) % fpd) + fpd) % fpd;
        if (delta > fpd / 2) delta -= fpd;
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
      const flag = this._dfFlagMajority();
      return flag;
    }
    return this.minuteBoundaryDfHits > this.minuteBoundaryNdfHits;
  }

  // Whether the DF flag bit in the LTC frames agrees with the observed
  // counting behaviour. Returns null until both are known. A `false` here is
  // a real conformance fault: someone asserted DF in the frame but isn't
  // actually skipping frames at minute boundaries (or vice versa).
  dfFlagMatchesObservedCadence() {
    if (this.minuteBoundaryDfHits + this.minuteBoundaryNdfHits === 0) return null;
    const flagDf = this._dfFlagMajority();
    if (flagDf == null) return null;
    const observedDf = this.minuteBoundaryDfHits > this.minuteBoundaryNdfHits;
    return observedDf === flagDf;
  }

  // Majority DF flag across the rolling window, or null if empty.
  _dfFlagMajority() {
    const w = this._dfFlagWindow;
    if (w.length === 0) return null;
    let asserted = 0;
    for (let i = 0; i < w.length; i++) asserted += w[i];
    return asserted * 2 > w.length;
  }
}

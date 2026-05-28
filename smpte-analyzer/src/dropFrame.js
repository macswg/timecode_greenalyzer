// Drop-frame (and frame-count ↔ HH:MM:SS:FF) math.
//
// Single source of truth for the DF skip rule:
//   29.97 DF → 30 fps nominal → skip 2 frames per non-tenth minute
//   59.94 DF → 60 fps nominal → skip 4 frames per non-tenth minute
//
// The rule: at the start of each minute that is NOT a multiple of 10, the
// first `dropPerMin` frame numbers (00..dropPerMin-1) are skipped. The first
// frame of such a minute is therefore ff = dropPerMin; an in-spec NDF count
// lands on ff = 0 at the same point.

export function dropPerMin(nomFps) { return nomFps === 60 ? 4 : 2; }

// frames → HH:MM:SS:FF for a given nominal cadence and DF mode. Inverse of
// tcToFrameNumber below; the two must round-trip exactly (the round-trip
// test in test/ltcDecoder.test.js enforces it).
//
// DF layout per ten-minute block: the tenth-minute (mm % 10 === 0) holds a
// full fps*60 frames with ff starting at 0; each of the nine following
// minutes holds fps*60 - dropPerMin frames with ss=0 starting at
// ff = dropPerMin (frames 0..dropPerMin-1 are skipped).
export function framesToTc(totalFrames, nomFps, dropFrame) {
  if (!dropFrame) {
    const ff = totalFrames % nomFps;
    const totalSec = Math.floor(totalFrames / nomFps);
    return {
      hh: Math.floor(totalSec / 3600) % 24,
      mm: Math.floor(totalSec / 60) % 60,
      ss: totalSec % 60,
      ff,
    };
  }
  const drop = dropPerMin(nomFps);
  const framesPerTenthMin = nomFps * 60;
  const framesPerMin = framesPerTenthMin - drop;
  const framesPerTenMin = framesPerTenthMin + 9 * framesPerMin;
  const tenMins = Math.floor(totalFrames / framesPerTenMin);
  let rem = totalFrames % framesPerTenMin;
  let mins, ss, ff;
  if (rem < framesPerTenthMin) {
    // Inside the tenth-minute: linear mapping, no drop offset.
    mins = tenMins * 10;
    ss = Math.floor(rem / nomFps);
    ff = rem % nomFps;
  } else {
    rem -= framesPerTenthMin;
    const minsInChunk = 1 + Math.floor(rem / framesPerMin);
    mins = tenMins * 10 + minsInChunk;
    let pos = rem % framesPerMin;
    // Non-tenth-minute: ss=0 occupies (fps - drop) frames with ff in
    // [drop, fps); ss>=1 is normal.
    if (pos < nomFps - drop) {
      ss = 0;
      ff = pos + drop;
    } else {
      pos -= (nomFps - drop);
      ss = 1 + Math.floor(pos / nomFps);
      ff = pos % nomFps;
    }
  }
  return {
    hh: Math.floor(mins / 60) % 24,
    mm: mins % 60,
    ss, ff,
  };
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
  const totalMins = hh * 60 + mm;
  const dropped = dropPerMin(fps) * (totalMins - Math.floor(totalMins / 10));
  return ((hh * 60 + mm) * 60 + ss) * fps + ff - dropped;
}

// Conformance check: at a non-tenth-minute boundary (ss=0, mm%10!=0), a DF
// count is required to skip frames 00..dropPerMin-1, so any ff < dropPerMin
// at that position is a spec violation. Also bounds-checks the fields.
export function isValidDropFrame(hh, mm, ss, ff, nominalFps) {
  const maxFrame = nominalFps - 1;
  if (hh > 23 || mm > 59 || ss > 59 || ff > maxFrame) return false;
  if (ss === 0 && mm % 10 !== 0 && ff < dropPerMin(nominalFps)) return false;
  return true;
}

// Minute-boundary ff ranges used by the cadence detector to classify the
// first frame seen after a non-tenth-minute crossover. NDF acceptance is
// widened to ff<=1 so a dropped first frame doesn't bias the histogram
// against NDF; DF acceptance starts at the expected skip value rather than 1
// so the two ranges don't overlap.
export function minuteBoundaryDfRange(cadenceFps) {
  const drop = dropPerMin(cadenceFps);
  return {
    ndfMax: 1,
    dfMin: drop,
    dfMax: drop + 2,
  };
}

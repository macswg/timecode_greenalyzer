import { describe, it, expect } from "vitest";
import { CadenceDetector } from "../src/cadenceDetector.js";
import { framesPerDay, tcToFrameNumber } from "../src/dropFrame.js";
import { nextTc } from "../src/ltcSynth.js";

// Feed a contiguous run of `count` frames starting at `start` into a
// CadenceDetector, wall-clock spaced one frame period apart. Returns the last
// fed frame so tests can append a deliberate discontinuity.
function feedRun(cd, start, count, cadenceFps, dropFrame, t0 = 1000) {
  let { hh, mm, ss, ff } = start;
  let t = t0;
  const dt = 1000 / cadenceFps;
  let last = null, lastT = t0;
  for (let i = 0; i < count; i++) {
    cd.feed({ hh, mm, ss, ff, dropFrame, t });
    last = { hh, mm, ss, ff }; lastT = t;
    const n = nextTc(hh, mm, ss, ff, cadenceFps, dropFrame);
    hh = n.hh; mm = n.mm; ss = n.ss; ff = n.ff;
    t += dt;
  }
  return { last, lastT };
}

describe("framesPerDay", () => {
  it("counts a full day per cadence", () => {
    expect(framesPerDay(30, false)).toBe(24 * 60 * 60 * 30); // 2,592,000
    expect(framesPerDay(24, false)).toBe(24 * 60 * 60 * 24); // 2,073,600
    expect(framesPerDay(25, false)).toBe(24 * 60 * 60 * 25); // 2,160,000
    expect(framesPerDay(30, true)).toBe(2589408);            // 29.97 DF: 2,592,000 - 2*1296
    expect(framesPerDay(60, true)).toBe(5178816);            // 59.94 DF: 5,184,000 - 4*1296
  });
  it("is exactly one past the last frame of the day (tcToFrameNumber rollover)", () => {
    expect(tcToFrameNumber(23, 59, 59, 29, 30, false) + 1).toBe(framesPerDay(30, false));
    expect(tcToFrameNumber(23, 59, 59, 29, 30, true) + 1).toBe(framesPerDay(30, true));
  });
});

describe("CadenceDetector continuity across the 24h rollover (test #6)", () => {
  it("logs no phantom break at NDF midnight (23:59:59 -> 00:00:00)", () => {
    const cd = new CadenceDetector();
    feedRun(cd, { hh: 23, mm: 59, ss: 56, ff: 0 }, 150, 30, false); // ~5s spanning midnight
    expect(cd.cadenceFps()).toBe(30);
    expect(cd.isDropFrame()).toBe(false);
    expect(cd.continuityBreaks).toBe(0);
  });

  it("logs no phantom break at DF midnight", () => {
    const cd = new CadenceDetector();
    feedRun(cd, { hh: 23, mm: 59, ss: 56, ff: 0 }, 150, 30, true);
    expect(cd.cadenceFps()).toBe(30);
    expect(cd.isDropFrame()).toBe(true);
    expect(cd.continuityBreaks).toBe(0);
  });

  it("still flags a genuine small REWIND (cyclic delta preserves small deltas)", () => {
    const cd = new CadenceDetector();
    const { last, lastT } = feedRun(cd, { hh: 23, mm: 59, ss: 56, ff: 0 }, 150, 30, false);
    expect(last.ff).toBeGreaterThanOrEqual(3); // 150th frame lands at 00:00:00:29
    const before = cd.continuityBreaks;
    cd.feed({ hh: last.hh, mm: last.mm, ss: last.ss, ff: last.ff - 3, dropFrame: false, t: lastT + 33 });
    expect(cd.continuityBreaks).toBe(before + 1);
    expect(cd.lastBreak.type).toBe("REWIND");
    expect(cd.lastBreak.delta).toBe(-3);
  });
});

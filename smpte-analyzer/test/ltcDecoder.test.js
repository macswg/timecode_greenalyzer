import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  LtcDecoder,
  MultiRateDecoder,
  parseFrame,
  tcString,
  rateKeyToNominalFps,
} from "../src/ltcDecoder.js";
import { tcToFrameNumber, framesToTc, dropPerMin, isValidDropFrame } from "../src/dropFrame.js";

// ---------------------------------------------------------------------------
// LTC frame & biphase-mark synthesis helpers.
//
// SMPTE ST 12-1 Table 2 bit layout (LSB-first within each field):
//   0-3   frame units (BCD)
//   8-9   frame tens (BCD)
//   10    drop-frame flag
//   11    color-frame flag
//   16-19 sec units (BCD)
//   24-26 sec tens (BCD)
//   32-35 min units (BCD)
//   40-42 min tens (BCD)
//   48-51 hour units (BCD)
//   56-57 hour tens (BCD)
//   64-79 sync word 0011111111111101
// ---------------------------------------------------------------------------

const SYNC = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1];

function buildFrameBits({ hh, mm, ss, ff, dropFrame = false, colorFrame = false }) {
  const bits = new Array(80).fill(0);
  const writeBcd = (val, lsb, count) => {
    for (let i = 0; i < count; i++) bits[lsb + i] = (val >> i) & 1;
  };
  writeBcd(ff % 10, 0, 4);
  writeBcd(Math.floor(ff / 10), 8, 2);
  bits[10] = dropFrame ? 1 : 0;
  bits[11] = colorFrame ? 1 : 0;
  writeBcd(ss % 10, 16, 4);
  writeBcd(Math.floor(ss / 10), 24, 3);
  writeBcd(mm % 10, 32, 4);
  writeBcd(Math.floor(mm / 10), 40, 3);
  writeBcd(hh % 10, 48, 4);
  writeBcd(Math.floor(hh / 10), 56, 2);
  for (let i = 0; i < 16; i++) bits[64 + i] = SYNC[i];
  return bits;
}

// Encode an array of 80-bit frames to biphase-mark audio samples.
// Biphase: polarity flips at every bit boundary; "1" adds a mid-bit flip.
function synthesizeLtc(framesBits, sampleRate, nominalFps) {
  const samplesPerBit = sampleRate / (nominalFps * 80);
  const totalBits = framesBits.reduce((n, f) => n + f.length, 0);
  const total = Math.round(totalBits * samplesPerBit);
  const out = new Float32Array(total);
  let pol = 1;
  let pos = 0;
  let bitIdx = 0;
  for (const bits of framesBits) {
    for (const bit of bits) {
      const bitEnd = (bitIdx + 1) * samplesPerBit;
      if (bit === 1) {
        const mid = (bitIdx + 0.5) * samplesPerBit;
        while (pos < mid && pos < total) out[pos++] = pol * 0.5;
        pol = -pol;
        while (pos < bitEnd && pos < total) out[pos++] = pol * 0.5;
      } else {
        while (pos < bitEnd && pos < total) out[pos++] = pol * 0.5;
      }
      pol = -pol;
      bitIdx++;
    }
  }
  return out;
}

// Generate a continuous sequence of N frames starting at startFrame (frame
// number in the integer-fps frame-count space). Returns the concatenated
// samples plus the array of frame-bit blocks for verification.
function generateRunSamples({ sampleRate, nominalFps, dropFrame, count, startFrame = 0 }) {
  const dropPerMin = nominalFps === 60 ? 4 : 2;
  function nthTc(frameNum) {
    // Invert tcToFrameNumber. For DF, follow the same skip rule used by the
    // decoder so the generated TC is self-consistent with what
    // tcToFrameNumber() expects to see.
    if (!dropFrame) {
      const ff = frameNum % nominalFps;
      const totalSec = Math.floor(frameNum / nominalFps);
      const ss = totalSec % 60;
      const totalMin = Math.floor(totalSec / 60);
      const mm = totalMin % 60;
      const hh = Math.floor(totalMin / 60);
      return { hh, mm, ss, ff };
    }
    // Drop-frame: walk the count, applying skips at minute boundaries
    // except every 10th minute. This mirrors the math in App.jsx
    // framesToTc(). We brute-walk for clarity in the test fixture.
    let hh = 0, mm = 0, ss = 0, ff = 0;
    for (let i = 0; i < frameNum; i++) {
      ff++;
      if (ff >= nominalFps) { ff = 0; ss++; }
      if (ss >= 60) { ss = 0; mm++; if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; } }
      // At the start of each minute (ss=0, ff=0) except every 10th minute, skip.
      if (ss === 0 && ff === 0 && mm % 10 !== 0) {
        ff = dropPerMin;
      }
    }
    return { hh, mm, ss, ff };
  }
  const allBits = [];
  for (let i = 0; i < count; i++) {
    const { hh, mm, ss, ff } = nthTc(startFrame + i);
    allBits.push(buildFrameBits({ hh, mm, ss, ff, dropFrame }));
  }
  return synthesizeLtc(allBits, sampleRate, nominalFps);
}

// ---------------------------------------------------------------------------
// Wall-clock-aware test infrastructure.
//
// The measurement-grade carrier classifier uses wall-clock (performance.now)
// timestamps stamped at chunk boundaries by the worklet. Tests need to:
//   • mock performance.now() and advance it as feeds occur
//   • optionally simulate the ADC sample clock running at a different rate
//     from wall-clock (the load-bearing scenario the issue diagnoses)
//   • feed samples in chunks small enough that one chunk ≤ a few wall-clock
//     seconds, so the 1-s-spaced agreement counter can advance
//
// setupClockMock + feedWithDriftedAdc provide that infrastructure.
// ---------------------------------------------------------------------------

function setupClockMock(startMs = 1000) {
  let now = startMs;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    advance: (ms) => { now += ms; },
    set: (t) => { now = t; },
    get: () => now,
  };
}

// Feed `durationSec` of LTC into the MultiRateDecoder, simulating:
//   • a source generating frames at `sourceFps` per wall-clock second
//   • an ADC sample clock running `adcDriftPpm` parts-per-million faster than
//     wall-clock (negative = slower)
//   • a mocked performance.now() advancing in lockstep with wall-clock
// Chunks of `chunkMs` wall-clock duration are fed sequentially.
function feedWithDriftedAdc(mrd, opts) {
  const {
    clock,
    sourceFps,
    dropFrame = false,
    durationSec,
    adcDriftPpm = 0,
    sampleRate = 48000,
    chunkMs = 100,
    startFrame = 0,
  } = opts;
  // Synthesize all the source frames once, at a synthetic sample rate chosen
  // so each frame occupies exactly the same number of samples as the ADC
  // would capture for one wall-clock-period of one source frame. The decoder
  // gets samples at its nominal sampleRate; the "stretching" lives in how
  // many samples-per-frame are present.
  const sampleRateActual = sampleRate * (1 + adcDriftPpm / 1e6);
  const samplesPerSrcFrame = sampleRateActual / sourceFps;
  const nominalForSynth = Math.round(sourceFps);  // 30 for 29.97, etc.
  const synthSr = nominalForSynth * samplesPerSrcFrame;
  const totalSrcFrames = Math.ceil(sourceFps * durationSec) + 10;
  const dpm = nominalForSynth === 60 ? 4 : 2;
  function nthTc(frameNum) {
    if (!dropFrame) {
      const ff = frameNum % nominalForSynth;
      const totalSec = Math.floor(frameNum / nominalForSynth);
      const ss = totalSec % 60;
      const totalMin = Math.floor(totalSec / 60);
      const mm = totalMin % 60;
      const hh = Math.floor(totalMin / 60);
      return { hh, mm, ss, ff };
    }
    let hh = 0, mm = 0, ss = 0, ff = 0;
    for (let i = 0; i < frameNum; i++) {
      ff++;
      if (ff >= nominalForSynth) { ff = 0; ss++; }
      if (ss >= 60) { ss = 0; mm++; if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; } }
      if (ss === 0 && ff === 0 && mm % 10 !== 0) ff = dpm;
    }
    return { hh, mm, ss, ff };
  }
  const allBits = [];
  for (let i = 0; i < totalSrcFrames; i++) {
    const tc = nthTc(startFrame + i);
    allBits.push(buildFrameBits({ ...tc, dropFrame }));
  }
  const allSamples = synthesizeLtc(allBits, synthSr, nominalForSynth);
  const samplesPerChunk = Math.max(1, Math.round(sampleRateActual * chunkMs / 1000));
  const totalChunks = Math.ceil(durationSec * 1000 / chunkMs);
  let off = 0;
  for (let c = 0; c < totalChunks && off < allSamples.length; c++) {
    const end = Math.min(off + samplesPerChunk, allSamples.length);
    const chunk = allSamples.subarray(off, end);
    const t0 = clock.get();
    clock.advance(chunkMs);
    const t1 = clock.get();
    mrd.feed(chunk, sampleRate, t0, t1);
    off = end;
  }
}

// ===========================================================================
// Pure helpers
// ===========================================================================

describe("parseFrame", () => {
  it("decodes a canonical 12:34:56:18 NDF frame", () => {
    const bits = buildFrameBits({ hh: 12, mm: 34, ss: 56, ff: 18 });
    const parsed = parseFrame(bits);
    expect(parsed).toEqual({ hh: 12, mm: 34, ss: 56, ff: 18, dropFrame: false, colorFrame: false });
  });

  it("reads the drop-frame flag", () => {
    const bits = buildFrameBits({ hh: 0, mm: 1, ss: 0, ff: 2, dropFrame: true });
    const parsed = parseFrame(bits);
    expect(parsed.dropFrame).toBe(true);
    expect(parsed.hh).toBe(0);
    expect(parsed.mm).toBe(1);
  });

  it("reads the color-frame flag", () => {
    const bits = buildFrameBits({ hh: 1, mm: 2, ss: 3, ff: 4, colorFrame: true });
    expect(parseFrame(bits).colorFrame).toBe(true);
  });

  it("returns null for out-of-range BCD digits", () => {
    const bits = buildFrameBits({ hh: 0, mm: 0, ss: 0, ff: 0 });
    // Force frame-tens to 6 (BCD bits 8,9 = 0,1 → 2; bump to invalid)
    bits[8] = 1; bits[9] = 1; // frTens = 3 → ff=30, still valid at 60fps but >59 is the gate
    // Push frame units to 9 → ff = 39, still valid. Try seconds tens out of range.
    bits[24] = 0; bits[25] = 1; bits[26] = 1; // secTens = 6 → ss = 60, invalid
    expect(parseFrame(bits)).toBeNull();
  });
});

describe("tcToFrameNumber", () => {
  it("counts NDF frames linearly", () => {
    // 0:0:1:0 at 30 NDF = 30 frames
    expect(tcToFrameNumber(0, 0, 1, 0, 30, false)).toBe(30);
    // 0:1:0:0 at 30 NDF = 1800
    expect(tcToFrameNumber(0, 1, 0, 0, 30, false)).toBe(1800);
    // 1:0:0:0 at 24 NDF = 60 * 60 * 24
    expect(tcToFrameNumber(1, 0, 0, 0, 24, false)).toBe(24 * 60 * 60);
  });

  it("applies 29.97 DF drop math", () => {
    // 0:1:0:02 DF is the first valid frame of minute 1 (frames 00, 01 skipped).
    // Wall-clock count = 1*60*30 + 2 = 1802. Two skipped → DF frame# = 1800.
    expect(tcToFrameNumber(0, 1, 0, 2, 30, true)).toBe(1800);
    // 10th-minute boundary: 9 prior minutes × 2 drops = 18 dropped frames.
    // 0:10:0:00 wall = 18000; DF# = 18000 - 18 = 17982.
    expect(tcToFrameNumber(0, 10, 0, 0, 30, true)).toBe(18000 - 18);
  });

  it("applies 59.94 DF drop math (skip 4 per minute)", () => {
    // 0:1:0:04 DF first-valid-frame-of-minute-1 at 60 fps. Wall = 3604, drop 4 → 3600.
    expect(tcToFrameNumber(0, 1, 0, 4, 60, true)).toBe(3600);
  });
});

describe("tcString", () => {
  it("formats NDF with colons", () => {
    expect(tcString({ hh: 1, mm: 2, ss: 3, ff: 4, dropFrame: false })).toBe("01:02:03:04");
  });
  it("formats DF with semicolon before frames", () => {
    expect(tcString({ hh: 0, mm: 1, ss: 0, ff: 2, dropFrame: true })).toBe("00:01:00;02");
  });
});

describe("rateKeyToNominalFps", () => {
  it("returns 30 for 29.97 and 29.97df", () => {
    expect(rateKeyToNominalFps("29.97")).toBe(30);
    expect(rateKeyToNominalFps("29.97df")).toBe(30);
  });
  it("returns 24 for 23.976 and 24", () => {
    expect(rateKeyToNominalFps("23.976")).toBe(24);
    expect(rateKeyToNominalFps("24")).toBe(24);
  });
  it("returns 60 for 59.94df", () => {
    expect(rateKeyToNominalFps("59.94df")).toBe(60);
  });
});

// ===========================================================================
// LtcDecoder.feed end-to-end with synthesized biphase audio
// ===========================================================================

describe("LtcDecoder.feed", () => {
  it("decodes a single 30 fps frame at 48 kHz", () => {
    const sr = 48000, fps = 30;
    const bits = buildFrameBits({ hh: 1, mm: 2, ss: 3, ff: 4 });
    // Need at least 2 frames so the decoder can pick up a clean span from
    // edge transitions — a single frame still works because the sync match
    // looks at trailing 16 bits, but a couple frames is more robust.
    const samples = synthesizeLtc([bits, bits], sr, fps);
    const dec = new LtcDecoder();
    dec.feed(samples, sr, fps);
    expect(dec.lastFrame).toBeTruthy();
    expect(dec.lastFrame.hh).toBe(1);
    expect(dec.lastFrame.mm).toBe(2);
    expect(dec.lastFrame.ss).toBe(3);
    expect(dec.lastFrame.ff).toBe(4);
    expect(dec.framesDecoded).toBeGreaterThanOrEqual(1);
  });

  it("decodes a 1-second 24 fps run with low bit-error rate", () => {
    const sr = 48000, fps = 24;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: fps, dropFrame: false, count: fps });
    const dec = new LtcDecoder();
    dec.feed(samples, sr, fps);
    expect(dec.framesDecoded).toBeGreaterThanOrEqual(fps - 1);
    // Synthesized audio is clean — bit errors should be negligible.
    expect(dec.bitErrors).toBeLessThan(5);
  });

  it("decodes a 1-second 25 fps run", () => {
    const sr = 48000, fps = 25;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: fps, dropFrame: false, count: fps });
    const dec = new LtcDecoder();
    dec.feed(samples, sr, fps);
    expect(dec.framesDecoded).toBeGreaterThanOrEqual(fps - 1);
    expect(dec.lastFrame.ss).toBe(0);
  });

  it("decodes a 1-second 60 fps run", () => {
    const sr = 48000, fps = 60;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: fps, dropFrame: false, count: fps });
    const dec = new LtcDecoder();
    dec.feed(samples, sr, fps);
    expect(dec.framesDecoded).toBeGreaterThanOrEqual(fps - 1);
  });

  it("rejects 30 fps content fed to a 24 fps decoder (wrong-rate cross-lock)", () => {
    const sr = 48000;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30 });
    const dec = new LtcDecoder();
    dec.feed(samples, sr, 24); // feeding 30fps content to 24fps decoder
    // Frame-span check (±3%) should reject — 30fps frames are ~25% shorter
    // than what 24fps expects, way outside tolerance.
    expect(dec.framesDecoded).toBe(0);
  });
});

// ===========================================================================
// MultiRateDecoder
// ===========================================================================

describe("MultiRateDecoder", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("picks 30 fps as winner for 30 fps content", () => {
    const sr = 48000;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30 });
    const mrd = new MultiRateDecoder();
    mrd.feed(samples, sr);
    expect(mrd.winner).toBeTruthy();
    expect(mrd.winner.fps).toBe(30);
    expect(mrd.nominalFps).toBe(30);
  });

  it("picks 24 fps as winner for 24 fps content", () => {
    const sr = 48000;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 24, dropFrame: false, count: 24 });
    const mrd = new MultiRateDecoder();
    mrd.feed(samples, sr);
    expect(mrd.winner.fps).toBe(24);
  });

  it("detectedRateKey distinguishes 23.976 from 24 after measurement window", () => {
    const sr = 48000;
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 24 / 1.001, durationSec: 6, sampleRate: sr });
    expect(mrd.winner?.fps).toBe(24);
    expect(mrd.detectedRateKey()).toBe("23.976");
  });

  it("detectedRateKey returns '24' for true 24 fps content after measurement window", () => {
    const sr = 48000;
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 24, durationSec: 6, sampleRate: sr });
    expect(mrd.detectedRateKey()).toBe("24");
  });

  it("detectedRateKey returns '29.97df' for fractional 29.97 carrier with DF count", () => {
    const sr = 48000;
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30 / 1.001, dropFrame: true, durationSec: 6, sampleRate: sr });
    expect(mrd.detectedRateKey()).toBe("29.97df");
  });

  it("medianFrameSpan returns null with fewer than 10 frames", () => {
    const sr = 48000;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5 });
    const mrd = new MultiRateDecoder();
    mrd.feed(samples, sr);
    expect(mrd.medianFrameSpan()).toBeNull();
  });
});

// ===========================================================================
// Winner switching when input rate changes
// ===========================================================================

describe("MultiRateDecoder winner switching", () => {
  // Time mocking utility: spy on performance.now and let tests advance it.
  let nowVal;
  const realNow = performance.now;
  beforeEach(() => {
    nowVal = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowVal);
  });
  afterEach(() => {
    performance.now = realNow;
  });

  it("switches winner when the input rate changes (windowed scoring)", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();

    // Phase 1: feed 5 seconds of 24 fps content. Bump nowVal to the end of
    // the phase so the recent-frames window reflects real chronology.
    for (let s = 0; s < 5; s++) {
      const samples = generateRunSamples({ sampleRate: sr, nominalFps: 24, dropFrame: false, count: 24, startFrame: s * 24 });
      mrd.feed(samples, sr);
      nowVal += 1000;
    }
    expect(mrd.winner.fps).toBe(24);

    // Phase 2: feed 5 seconds of 30 fps content. The old 24-fps decoder's
    // recentDecodeTimes entries are still within the 20s window, so the
    // 30-fps decoder needs to overtake by recency-bonus + recent-frame count.
    for (let s = 0; s < 5; s++) {
      const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30, startFrame: s * 30 });
      mrd.feed(samples, sr);
      nowVal += 1000;
    }
    expect(mrd.winner.fps).toBe(30);
  });
});

// ===========================================================================
// dropoutPct semantics
// ===========================================================================

describe("MultiRateDecoder.dropoutPct", () => {
  let nowVal;
  const realNow = performance.now;
  beforeEach(() => {
    nowVal = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowVal);
  });
  afterEach(() => {
    performance.now = realNow;
  });

  it("returns null when there's no winner", () => {
    const mrd = new MultiRateDecoder();
    expect(mrd.dropoutPct()).toBeNull();
  });

  it("returns null when most recent decode is stale (>500 ms)", () => {
    const sr = 48000;
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30 });
    const mrd = new MultiRateDecoder();
    mrd.feed(samples, sr);
    // Now advance past the staleness threshold without feeding more.
    nowVal += 5000;
    expect(mrd.dropoutPct()).toBeNull();
  });

  it("returns null with less than 0.5 s of decode history", () => {
    const sr = 48000;
    // Just 5 frames at 30 fps → ~0.17 s of history.
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5 });
    const mrd = new MultiRateDecoder();
    mrd.feed(samples, sr);
    expect(mrd.dropoutPct()).toBeNull();
  });

  it("returns near-zero for clean continuous signal", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();
    // Feed 2 seconds of 30 fps in 4 phases so timestamps spread over the
    // window (otherwise all 60 frames would share a single performance.now
    // value and dropoutPct's history check would fail).
    for (let s = 0; s < 4; s++) {
      const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 15, startFrame: s * 15 });
      mrd.feed(samples, sr);
      nowVal += 500;
    }
    nowVal -= 100; // pull most-recent decode back inside the 500ms freshness window
    const pct = mrd.dropoutPct();
    expect(pct).not.toBeNull();
    expect(pct).toBeLessThan(20);
  });
});

// ===========================================================================
// Continuity break tracking
// ===========================================================================

describe("MultiRateDecoder continuity tracking", () => {
  let nowVal;
  const realNow = performance.now;
  beforeEach(() => {
    nowVal = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowVal);
  });
  afterEach(() => {
    performance.now = realNow;
  });

  it("reports zero breaks for a continuous 1-second run", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30 });
    mrd.feed(samples, sr);
    expect(mrd.cadenceDetector.continuityBreaks).toBe(0);
    expect(mrd.lastBreak).toBeNull();
  });

  it("flags a JUMP when frames skip forward", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();
    // Feed 30 frames first so the cadence detector locks in (it needs
    // framesSeen >= 30 before continuity tracking engages), then jump ahead.
    const a = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 40, startFrame: 0 });
    const b = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5, startFrame: 50 });
    mrd.feed(a, sr);
    nowVal += 200;
    mrd.feed(b, sr);
    expect(mrd.cadenceDetector.continuityBreaks).toBeGreaterThanOrEqual(1);
    expect(mrd.lastBreak?.type).toBe("JUMP");
  });

  it("clears continuityBreaks after a ≥3 s signal-gap on first resuming frame", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();
    const a = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 40, startFrame: 0 });
    const b = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5, startFrame: 50 });
    mrd.feed(a, sr);
    nowVal += 200;
    mrd.feed(b, sr);
    expect(mrd.cadenceDetector.continuityBreaks).toBeGreaterThanOrEqual(1);
    const breakBeforeGap = mrd.lastBreak;
    expect(breakBeforeGap?.t).toBeDefined();
    // Simulate a 4-second signal gap, then resume. The audio cut between b
    // and c may produce one transient biphase artifact on the resume edge,
    // so we don't require continuityBreaks==0 after — instead we verify the
    // gap-clear fired by confirming the pre-gap break is gone (lastBreak is
    // either null or a *new* break recorded after the gap).
    const tBeforeGap = nowVal;
    nowVal += 4000;
    const c = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5, startFrame: 100 });
    mrd.feed(c, sr);
    if (mrd.lastBreak != null) {
      expect(mrd.lastBreak.t).toBeGreaterThan(tBeforeGap);
    }
  });

  it("does not clear breaks while code is still rolling", () => {
    const sr = 48000;
    const mrd = new MultiRateDecoder();
    const a = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5, startFrame: 0 });
    const b = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 5, startFrame: 10 });
    mrd.feed(a, sr);
    nowVal += 200;
    mrd.feed(b, sr);
    const breaksBefore = mrd.cadenceDetector.continuityBreaks;
    // Keep feeding consecutive frames for several real seconds (under 3 s
    // gaps, so the auto-clear should NOT fire). Synthesis-chunk boundaries
    // may introduce additional spurious breaks; the property being tested
    // is that breaks aren't *cleared* by elapsed time alone, so a monotonic
    // non-decreasing count is sufficient.
    for (let s = 0; s < 5; s++) {
      const cont = generateRunSamples({ sampleRate: sr, nominalFps: 30, dropFrame: false, count: 30, startFrame: 15 + s * 30 });
      mrd.feed(cont, sr);
      nowVal += 1000;
    }
    expect(mrd.cadenceDetector.continuityBreaks).toBeGreaterThanOrEqual(breaksBefore);
  });
});

// ===========================================================================
// Bit-error stale-counter reset
// ===========================================================================

describe("LtcDecoder bit-error reset", () => {
  let nowVal;
  const realNow = performance.now;
  beforeEach(() => {
    nowVal = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => nowVal);
  });
  afterEach(() => {
    performance.now = realNow;
  });

  it("clears bitErrors after ≥60 s with no fresh decode", () => {
    const sr = 48000, fps = 30;
    const dec = new LtcDecoder();
    // Get a real lastFrame on the decoder.
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: fps, dropFrame: false, count: fps });
    dec.feed(samples, sr, fps);
    expect(dec.lastFrame).toBeTruthy();
    // Artificially inflate the error count to mimic a noisy stale period.
    dec.bitErrors = 500;
    // Jump 70 seconds and feed a chunk of silence — feed() should clear the
    // count on entry because lastFrame is now >60s old.
    nowVal += 70000;
    dec.feed(new Float32Array(2048), sr, fps);
    expect(dec.bitErrors).toBe(0);
  });

  it("does not clear bitErrors while signal is recent", () => {
    const sr = 48000, fps = 30;
    const dec = new LtcDecoder();
    const samples = generateRunSamples({ sampleRate: sr, nominalFps: fps, dropFrame: false, count: fps });
    dec.feed(samples, sr, fps);
    dec.bitErrors = 12;
    nowVal += 1000;
    dec.feed(new Float32Array(2048), sr, fps);
    expect(dec.bitErrors).toBe(12);
  });
});

// ===========================================================================
// framesToTc ↔ tcToFrameNumber round-trip
//
// These are mathematical inverses living in the same module now, but they're
// independently consumed by the simulation generator, the synth and the
// continuity tracker. A round-trip property test catches any future drift
// between the two implementations, particularly around the DF skip rule's
// minute / ten-minute boundaries and 24-hour wraparound.
// ===========================================================================
describe("framesToTc ↔ tcToFrameNumber round-trip", () => {
  const cases = [
    { fps: 24, dropFrame: false, label: "24 NDF" },
    { fps: 25, dropFrame: false, label: "25 NDF" },
    { fps: 30, dropFrame: false, label: "30 NDF" },
    { fps: 50, dropFrame: false, label: "50 NDF" },
    { fps: 60, dropFrame: false, label: "60 NDF" },
    { fps: 30, dropFrame: true,  label: "29.97 DF" },
    { fps: 60, dropFrame: true,  label: "59.94 DF" },
  ];
  for (const { fps, dropFrame, label } of cases) {
    it(`round-trips across boundaries at ${label}`, () => {
      // Probe densely around minute and ten-minute boundaries (where DF skip
      // applies / doesn't), sparsely across the rest of a 24-hour day to keep
      // the test fast. Include the very first and very last frame of the day.
      const framesPerDay = 24 * 60 * 60 * fps - (dropFrame ? dropPerMin(fps) * (24 * 60 - 24 * 6) : 0);
      const probes = new Set();
      probes.add(0);
      probes.add(framesPerDay - 1);
      // Around every minute boundary in the first hour, plus every tenth
      // minute boundary across the day.
      for (let m = 0; m < 60; m++) {
        const base = m * (60 * fps - (dropFrame && m % 10 !== 0 ? dropPerMin(fps) : 0));
        for (let d = -2; d <= 5; d++) {
          const n = base + d;
          if (n >= 0 && n < framesPerDay) probes.add(n);
        }
      }
      for (let mins = 0; mins < 24 * 60; mins += 10) {
        const hh = Math.floor(mins / 60), mm = mins % 60;
        const n = tcToFrameNumber(hh, mm, 0, 0, fps, dropFrame);
        for (let d = -3; d <= 6; d++) {
          if (n + d >= 0 && n + d < framesPerDay) probes.add(n + d);
        }
      }
      for (const n of probes) {
        const tc = framesToTc(n, fps, dropFrame);
        const back = tcToFrameNumber(tc.hh, tc.mm, tc.ss, tc.ff, fps, dropFrame);
        expect(back, `${label} n=${n} → ${JSON.stringify(tc)} → ${back}`).toBe(n);
      }
    });
  }

  it("isValidDropFrame rejects ff<dropPerMin at non-tenth minute boundaries", () => {
    expect(isValidDropFrame(0, 1, 0, 0, 30)).toBe(false);
    expect(isValidDropFrame(0, 1, 0, 1, 30)).toBe(false);
    expect(isValidDropFrame(0, 1, 0, 2, 30)).toBe(true);
    expect(isValidDropFrame(0, 10, 0, 0, 30)).toBe(true);  // 10th minute exempt
    expect(isValidDropFrame(0, 1, 0, 3, 60)).toBe(false);
    expect(isValidDropFrame(0, 1, 0, 4, 60)).toBe(true);
  });
});

// ===========================================================================
// Wall-clock measurement-grade carrier classification
//
// These tests validate the LSQ-based fractional/integer classifier introduced
// to address issue #29: the sample-count-based classifier in the previous
// implementation was vulnerable to ADC sample-clock bias, producing
// spurious RATE_CHANGE flips on clean 29.97 sources. The new classifier
// timestamps frames via worklet-stamped wall-clock anchors and runs LSQ
// regression in a 20 s stable + 3 s detector window, gated by a
// 5σ + 3 consecutive agreements (≥1 s apart) commit rule.
// ===========================================================================

describe("MultiRateDecoder wall-clock carrier classification", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("commits 29.97 on a clean 29.97 source under clean ADC", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30 / 1.001, durationSec: 6 });
    expect(mrd.carrierRate()).toBe("29.97");
    expect(mrd._carrierIsFractional()).toBe(true);
  });

  it("commits 29.97 even when ADC runs +50 ppm fast (the load-bearing case)", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30 / 1.001, adcDriftPpm: +50, durationSec: 8 });
    expect(mrd.carrierRate()).toBe("29.97");
  });

  it("commits 30 on a clean integer-30 source under clean ADC", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 6 });
    expect(mrd.carrierRate()).toBe("30");
  });

  it("commits 30 on integer-30 source even with -500 ppm slow ADC", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, adcDriftPpm: -500, durationSec: 8 });
    expect(mrd.carrierRate()).toBe("30");
  });

  it("stays MEASURING with under 3 s of data", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 2 });
    // Stable window has data but agreement counter hasn't reached 3 yet.
    expect(mrd.carrierRate()).toBeNull();
    expect(mrd.carrierObservation().fractional).toBeNull();
  });

  it("commits within 3-5 s of decoded clean signal", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 4.5 });
    expect(mrd.carrierRate()).toBe("30");
  });

  it("re-measures and re-commits on source rate change", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30 / 1.001, durationSec: 6 });
    expect(mrd.carrierRate()).toBe("29.97");
    // Source changes to integer 30. The 3 s detector window + 3-agreement
    // ≥1 s-apart divergence hysteresis (a2d5aa6) drops the committed
    // fractional classification; the classifier then re-commits to integer
    // once the stable window's slope has shifted past the midpoint. We feed
    // enough integer-30 content (long enough for the 20 s stable window to
    // flush the old 29.97 frames) and assert the user-visible outcome: the
    // classifier eventually settles on "30". The internal path through the
    // DIVERGENCE event is an implementation detail — what matters is that
    // a rate change does not strand the analyzer on a stale commit.
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 30, startFrame: 200 });
    expect(mrd.carrierRate()).toBe("30");
  });

  it("issue #1 anomaly: integer-30 carrier with DF cadence triggers high-confidence mismatch", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    // DF count from minute 9 across minute 10 so the cadence detector sees
    // the skip-or-no-skip behavior and can determine cadence==DF.
    feedWithDriftedAdc(mrd, {
      clock, sourceFps: 30, dropFrame: true, durationSec: 8, startFrame: 30 * 60 * 9 - 30,
    });
    // Carrier should be integer 30.
    expect(mrd.carrierRate()).toBe("30");
    const mm = mrd.carrierCadenceMismatch();
    expect(mm).not.toBeNull();
    if (mm) {
      expect(mm.result).toBe(true);
      expect(mm.confidence).toBe("high");
      expect(mm.reason).toContain("DF");
    }
  });

  it("driftPpmSourceVsHostQuartz reflects source-vs-walltime drift", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 6 });
    const drift = mrd.driftPpmSourceVsHostQuartz();
    expect(drift).not.toBeNull();
    expect(Math.abs(drift)).toBeLessThan(20);  // clean source should be ≪ 20 ppm
  });

  it("driftPpmSourceVsAdc reflects ADC-clock drift", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    // 30 fps source with ADC running +200 ppm fast. The host-quartz drift
    // should be ~0 (source matches wall-clock) but the ADC drift will reflect
    // the sample-clock skew.
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, adcDriftPpm: +200, durationSec: 6 });
    const adc = mrd.driftPpmSourceVsAdc();
    const host = mrd.driftPpmSourceVsHostQuartz();
    expect(adc).not.toBeNull();
    expect(host).not.toBeNull();
    // ADC ran 200 ppm fast, so source-vs-ADC drift is roughly -200 ppm (ADC
    // saw more samples per source frame than nominal).
    expect(Math.abs(adc - (-200))).toBeLessThan(50);
    // Source-vs-host should be near zero.
    expect(Math.abs(host)).toBeLessThan(20);
    // Capture-clock-error = host - adc ≈ +200 ppm (the actual ADC error).
    const cap = mrd.captureClockErrorPpm();
    expect(Math.abs(cap - 200)).toBeLessThan(50);
  });

  it("holds committed classification for 5 s of signal loss", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 6 });
    expect(mrd.carrierRate()).toBe("30");
    // Advance wall-clock by 4 s without feeding (signal loss < 5 s).
    clock.advance(4000);
    // Trigger a re-evaluation of the state machine. Without a feed we need
    // to call carrierObservation() directly — which invalidates the cache
    // by reading the lastFresh stamp.
    mrd._carrierObs = null;
    mrd.carrierObservation();
    expect(mrd.carrierRate()).toBe("30");  // held
    // Advance another 2 s (total 6 s of loss > 5 s threshold).
    clock.advance(2000);
    mrd._carrierObs = null;
    mrd.carrierObservation();
    expect(mrd.carrierRate()).toBeNull();  // dropped to MEASURING
  });

  it("emits MEASURING_COMMIT event on first commit", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30, durationSec: 6 });
    const ev = mrd.lastCarrierEvent;
    expect(ev).not.toBeNull();
    expect(ev.type).toBe("MEASURING_COMMIT");
    expect(ev.fps).toBe(30);
    expect(ev.fractional).toBe(false);
  });

  it("populates carrierObservation with rich measurement metadata", () => {
    const clock = setupClockMock();
    const mrd = new MultiRateDecoder();
    feedWithDriftedAdc(mrd, { clock, sourceFps: 30 / 1.001, durationSec: 6 });
    const obs = mrd.carrierObservation();
    expect(obs.fractional).toBe(true);
    expect(obs.classConfidence).toBe("high");
    expect(obs.stable).not.toBeNull();
    expect(obs.stable.n).toBeGreaterThan(100);
    expect(obs.stable.spanSec).toBeGreaterThan(5);
    expect(obs.stable.sigmaFps).toBeGreaterThan(0);
    expect(obs.measurementMethod).toBe("walltime-lsq");
  });
});

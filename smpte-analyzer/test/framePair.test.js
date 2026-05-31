// Issue #34 — spec-conformant ST 12-1 §12 frame-pair decode at 50/60 fps.
//
// A frame-pair source emits one LTC word per frame but FF labels frame *pairs*
// (wraps at 24 for 50, 29 for 60) with the per-field LSB in the field-mark
// flag (bit 27 @ 60, bit 59 @ 50); the true frame is FF*2 + field-mark. The
// de-facto "wide" convention instead labels every frame in FF (bit 58 as a
// frame-tens MSB) with a static field-mark.
//
// These tests round-trip ltcSynth (which now generates both conventions) →
// MultiRateDecoder, asserting that:
//   - a frame-pair source is detected (fieldMarkBehavior TOGGLING), the 50/60
//     decoders switch to frame-pair mode, and the true frame count is
//     reconstructed (FF reaches the full range, contiguous, no spurious
//     REPEAT continuity breaks). WITHOUT the fix a frame-pair source caps at
//     FF≈pair-max and repeats every other frame.
//   - a wide source still decodes as before (STATIC, full FF range, clean).
import { describe, it, expect, vi, afterEach } from "vitest";
import { MultiRateDecoder } from "../src/ltcDecoder.js";
import { buildLtcAudioBuffer } from "../src/ltcSynth.js";
import { tcToFrameNumber } from "../src/dropFrame.js";

const SR = 48000;

// Feed a synth buffer through MultiRateDecoder in ~one-frame chunks with a
// mocked, monotonically-advancing performance.now(). Returns the decoder plus
// the de-duplicated sequence of decoded frames and the max FF seen.
function runDecode({ carrierFps, cadenceFps, convention, dropFrame = false, durationSec = 5, start = { hh: 1, mm: 0, ss: 0, ff: 0 } }) {
  const samples = buildLtcAudioBuffer({ sampleRate: SR, carrierFps, cadenceFps, dropFrame, durationSec, start, convention });
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const mrd = new MultiRateDecoder();
  const chunk = Math.round(SR / carrierFps); // ≈ one frame
  const frames = [];
  let lastT = null, maxFf = -1;
  for (let off = 0; off < samples.length; off += chunk) {
    const end = Math.min(off + chunk, samples.length);
    const t0 = now; now += ((end - off) / SR) * 1000;
    mrd.feed(samples.subarray(off, end), SR, t0, now);
    const lf = mrd.lastFrame;
    if (lf && lf.t !== lastT) {
      lastT = lf.t;
      frames.push({ hh: lf.hh, mm: lf.mm, ss: lf.ss, ff: lf.ff });
      if (lf.ff > maxFf) maxFf = lf.ff;
    }
  }
  return { mrd, frames, maxFf };
}

function decoderFor(mrd, fps) {
  return mrd.decoders.find(d => d.fps === fps).dec;
}

// Are the last `n` decoded frames a strict +1 sequence under the given cadence?
function tailContiguous(frames, cadence, n = 90) {
  const tail = frames.slice(-n);
  for (let i = 1; i < tail.length; i++) {
    const a = tcToFrameNumber(tail[i-1].hh, tail[i-1].mm, tail[i-1].ss, tail[i-1].ff, cadence, false);
    const b = tcToFrameNumber(tail[i].hh, tail[i].mm, tail[i].ss, tail[i].ff, cadence, false);
    if (b - a !== 1) return false;
  }
  return true;
}

describe("ST 12-1 §12 frame-pair decode (#34)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("decodes a conformant 60 fps frame-pair source to the true frame count", () => {
    const { mrd, frames, maxFf } = runDecode({ carrierFps: 60, cadenceFps: 60, convention: "framepair" });
    expect(mrd.nominalFps).toBe(60);
    expect(mrd.fieldMarkBehavior()).toBe("TOGGLING");
    expect(decoderFor(mrd, 60)._frameMode).toBe("framepair");
    // Reconstructed true frame reaches the full 0–59 range. Without the fix a
    // frame-pair source (BGF1=0) would cap FF at the pair max (~29).
    expect(maxFf).toBeGreaterThanOrEqual(50);
    expect(mrd.cadence()?.fps).toBe(60);
    // No spurious REPEATs once frame-pair is locked in.
    expect(mrd.cadenceDetector.continuityBreaks).toBeLessThan(5); // acquisition transient only — not a per-frame REPEAT storm (~150 over 5 s without the fix)
    expect(tailContiguous(frames, 60)).toBe(true);
  });

  it("decodes a conformant 50 fps frame-pair source to the true frame count", () => {
    const { mrd, frames, maxFf } = runDecode({ carrierFps: 50, cadenceFps: 50, convention: "framepair" });
    expect(mrd.nominalFps).toBe(50);
    expect(mrd.fieldMarkBehavior()).toBe("TOGGLING");
    expect(decoderFor(mrd, 50)._frameMode).toBe("framepair");
    expect(maxFf).toBeGreaterThanOrEqual(40);   // wide (BGF1=0) would cap at ~24
    expect(mrd.cadence()?.fps).toBe(50);
    expect(mrd.cadenceDetector.continuityBreaks).toBeLessThan(5); // acquisition transient only — not a per-frame REPEAT storm (~150 over 5 s without the fix)
    expect(tailContiguous(frames, 50)).toBe(true);
  });

  it("still decodes a de-facto wide 60 fps source correctly (regression)", () => {
    const { mrd, frames, maxFf } = runDecode({ carrierFps: 60, cadenceFps: 60, convention: "wide" });
    expect(mrd.nominalFps).toBe(60);
    expect(mrd.fieldMarkBehavior()).toBe("STATIC");
    expect(decoderFor(mrd, 60)._frameMode).toBe("wide");
    expect(maxFf).toBeGreaterThanOrEqual(50);
    expect(mrd.cadence()?.fps).toBe(60);
    expect(mrd.cadenceDetector.continuityBreaks).toBeLessThan(5); // acquisition transient only — not a per-frame REPEAT storm (~150 over 5 s without the fix)
    expect(tailContiguous(frames, 60)).toBe(true);
  });

  it("exposes a real BGF1 (bit 58) in frame-pair mode but null in wide mode at 60", () => {
    const fp = runDecode({ carrierFps: 60, cadenceFps: 60, convention: "framepair" });
    const wide = runDecode({ carrierFps: 60, cadenceFps: 60, convention: "wide" });
    // Frame-pair: bit 58 is BGF1 (synth writes 0) → reported as boolean false.
    expect(fp.mrd.lastFrame.bgf1).toBe(false);
    // Wide: bit 58 is the frame-tens MSB → BGF1 is not disambiguable → null.
    expect(wide.mrd.lastFrame.bgf1).toBe(null);
  });
});

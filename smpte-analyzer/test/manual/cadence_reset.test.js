// Verifies the cadence-reset-on-flavor-change fix: when the source timecode
// flavor changes mid-stream (one continuous feed), the NON-CONFORMANT mismatch
// must clear quickly instead of lingering on the previous stream's cumulative
// cadence evidence.
//
// A/B method: feed an identical continuous wall-clock timeline (phase1 file
// then phase2 file, no gap) through two MultiRateDecoders —
//   fixed:   the real decoder (cadenceDetector.reset() active)
//   control: cadenceDetector.reset() monkeypatched to a no-op (= pre-fix)
// — and measure, after the switch, how long carrierCadenceMismatch().result
// stays true. Two scenarios exercise the two reset triggers:
//   A) 59.94 DF -> 29.97 DF : nominal fps changes -> winner-fps trigger
//   B) 29.97 DF -> 30 ND    : fractional->integer at same nominal -> DIVERGENCE
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder } from "../../src/ltcDecoder.js";

const DIR = "../../../testing_timecode/";
const F1 = DIR + "F1_LTC_01043000_2mins_29_97_DF_FPS_48000x16.wav";   // 29.97 DF
const F3 = DIR + "F3_LTC_01043000_2mins_59_94_DF_FPS_48000x16.wav";   // 59.94 DF
const F6 = DIR + "F6_LTC_01043000_2mins_30_NDF_FPS_48000x16.wav";     // 30 ND (integer)
const CHUNK = 4800; // 100 ms @ 48k

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a WAVE file");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    else if (id === "data") { dataOff = body; dataLen = sz; }
    off = body + sz + (sz & 1);
  }
  const bps = fmt.bitsPerSample / 8, frameBytes = bps * fmt.channels;
  const n = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * frameBytes) / 32768;
  return { samples: out, sampleRate: fmt.sampleRate };
}
const load = (rel) => parseWav(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));

// Feed phase1*p1Loops then phase2*p2Loops on one continuous clock; sample the
// mismatch on every chunk of phase2. Returns the clear-time metric.
function runScenario(phase1, phase2, p1Loops, p2Loops, disableReset) {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const mrd = new MultiRateDecoder();
  if (disableReset) mrd.cadenceDetector.reset = () => {}; // simulate pre-fix
  const sr = phase1.sampleRate;
  const feed = (samples, loops, sample) => {
    const log = [];
    for (let l = 0; l < loops; l++) for (let off = 0; off < samples.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, samples.length);
      const t0 = now; now += ((end - off) / sr) * 1000;
      mrd.feed(samples.subarray(off, end), sr, t0, now);
      if (sample) {
        const mm = mrd.carrierCadenceMismatch();
        log.push({ t: now, present: mm?.result === true });
      }
    }
    return log;
  };
  feed(phase1.samples, p1Loops, false);
  const tSwitch = now;
  const log = feed(phase2.samples, p2Loops, true);
  vi.restoreAllMocks();
  const windowSec = (now - tSwitch) / 1000;
  const finalPresent = log[log.length - 1].present;
  const lastTrue = [...log].reverse().find((s) => s.present);
  const clearSec = lastTrue ? +((lastTrue.t - tSwitch) / 1000).toFixed(1) : 0;
  const cleared = !finalPresent && clearSec < windowSec - 2;
  return { clearSec, cleared, finalPresent, windowSec: +windowSec.toFixed(1) };
}

describe("NON-CONFORMANT clears quickly on mid-stream flavor change", () => {
  afterEach(() => vi.restoreAllMocks());

  it("A) 59.94 DF -> 29.97 DF (nominal fps change; winner-fps trigger)", () => {
    const f3 = load(F3), f1 = load(F1);
    const fixed = runScenario(f3, f1, 2, 1, false);
    const control = runScenario(f3, f1, 2, 1, true);
    writeFileSync(fileURLToPath(new URL("./cadence_reset_A.json", import.meta.url)),
      JSON.stringify({ scenario: "59.94DF->29.97DF", fixed, control }, null, 2));
    expect(fixed.cleared).toBe(true);
    expect(fixed.clearSec).toBeLessThan(30);
    expect(control.finalPresent).toBe(true);              // pre-fix: still NON-CONFORMANT at window end
    expect(control.clearSec).toBeGreaterThan(fixed.clearSec + 20);
  }, 60000);

  it("B) 29.97 DF -> 30 ND (fractional->integer; DIVERGENCE trigger)", () => {
    const f1 = load(F1), f6 = load(F6);
    const fixed = runScenario(f1, f6, 2, 1, false);
    const control = runScenario(f1, f6, 2, 1, true);
    writeFileSync(fileURLToPath(new URL("./cadence_reset_B.json", import.meta.url)),
      JSON.stringify({ scenario: "29.97DF->30ND", fixed, control }, null, 2));
    expect(fixed.cleared).toBe(true);
    expect(fixed.clearSec).toBeLessThan(30);
    expect(control.finalPresent).toBe(true);              // pre-fix: stale DF count -> lingering mismatch
    expect(control.clearSec).toBeGreaterThan(fixed.clearSec + 20);
  }, 60000);
});

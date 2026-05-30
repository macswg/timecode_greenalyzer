// TESTING.md test #1 (real minute boundary). Feeds F1 (29.97 DF, start
// 01:04:30:00) through the real MultiRateDecoder, looped, with wall-clock
// stamped chunks. Verifies rate label 29.97 DF and that dfFlagMatches stays
// true across loop wraps (no "DF flag bit disagrees" warning) — the loop-wrap
// cadence regression test.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const F1 = "../../../testing_timecode/F1_LTC_01043000_2mins_29_97_DF_FPS_48000x16.wav";
const LOOPS = 3;
const CHUNK = 4800;

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not WAVE");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); const sz = buf.readUInt32LE(off + 4); const body = off + 8;
    if (id === "fmt ") fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    else if (id === "data") { dataOff = body; dataLen = sz; }
    off = body + sz + (sz & 1);
  }
  const fb = (fmt.bitsPerSample / 8) * fmt.channels, n = Math.floor(dataLen / fb);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * fb) / 32768;
  return { samples: out, ...fmt };
}

describe("F1 ground truth — test #1 (real minute boundary, 29.97 DF)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads 29.97 DF; dfFlagMatches stays true across loop wraps", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F1, import.meta.url))));
    const { samples, sampleRate, bitsPerSample, channels } = wav;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();
    let firstTc = null, lastTc = null;
    const snapshots = [];
    for (let loop = 0; loop < LOOPS; loop++) {
      for (let off = 0; off < samples.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, samples.length);
        const t0 = now; now += ((end - off) / sampleRate) * 1000;
        mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
        const lf = mrd.lastFrame;
        if (lf) { if (!firstTc) firstTc = tcString(lf); lastTc = tcString(lf); }
      }
      const obs = mrd.carrierObservation(), cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
      const cd = mrd.cadenceDetector;
      snapshots.push({
        loop, carrierRate: mrd.carrierRate(), fractional: obs.fractional, classConfidence: obs.classConfidence,
        cadenceFps: cad?.fps ?? null, dropFrame: cad?.dropFrame ?? null, dfFlagMatches: cad?.dfFlagMatches ?? null,
        detectedRateKey: mrd.detectedRateKey(), mismatchResult: mm?.result ?? null,
        dfHits: cd.minuteBoundaryDfHits, ndfHits: cd.minuteBoundaryNdfHits,
        continuityBreaks: cd.continuityBreaks, lastBreakType: mrd.lastBreak?.type ?? null,
      });
    }
    const final = snapshots[snapshots.length - 1];
    const result = { wav: { sampleRate, bitsPerSample, channels, durationSec: +(samples.length / sampleRate).toFixed(3) }, loops: LOOPS, firstTc, lastTc, final, snapshots };
    writeFileSync(fileURLToPath(new URL("./f1_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    expect(final.carrierRate).toBe("29.97");
    expect(final.fractional).toBe(true);
    expect(final.cadenceFps).toBe(30);
    expect(final.dropFrame).toBe(true);
    expect(final.detectedRateKey).toBe("29.97df");
    expect(final.mismatchResult).toBe(false);
    expect(final.dfHits).toBeGreaterThan(0);
    expect(final.ndfHits).toBe(0);
    // dfFlagMatches true in every loop snapshot (no "DF flag bit disagrees").
    for (const s of snapshots) expect(s.dfFlagMatches).toBe(true);
  }, 60000);
});

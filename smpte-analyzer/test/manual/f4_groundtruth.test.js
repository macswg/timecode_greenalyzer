// Ground-truth harness for TESTING.md test #4 (23.976 carrier classification).
// Feeds the real F4 WAV (23.976 ND, start 01:04:30:00) through the actual
// MultiRateDecoder, looped, with wall-clock-stamped chunks. Verifies the
// carrier classifier commits fractional 23.976 (CLASS: fractional · high) and
// NEVER flips to integer 24 — the closest fractional/integer pair (ratio
// 0.999001 vs 1.000, midpoint 0.9995). Tracks carrierRate on every chunk so a
// single transient "24" anywhere in the run is caught, not just the endpoint.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const F4 = "../../../testing_timecode/F4_LTC_01043000_2mins_23_976_FPS_48000x16.wav";
const LOOPS = 3;
const CHUNK = 4800;

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a WAVE file");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    else if (id === "data") { dataOff = body; dataLen = sz; }
    off = body + sz + (sz & 1);
  }
  const bps = fmt.bitsPerSample / 8, frameBytes = bps * fmt.channels;
  const n = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * frameBytes) / 32768;
  return { samples: out, ...fmt };
}

describe("F4 ground truth — test #4 (23.976 carrier classification)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("commits fractional 23.976 ND and never flips to 24", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F4, import.meta.url))));
    const { samples, sampleRate, bitsPerSample, channels } = wav;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();

    const carrierSeen = {};        // committed carrierRate -> count of chunks
    let sawTwentyFour = 0;         // chunks where carrierRate === "24"
    let firstCommitChunk = null, chunkIdx = 0;
    let firstTc = null, lastTc = null;
    const snapshots = [];

    for (let loop = 0; loop < LOOPS; loop++) {
      for (let off = 0; off < samples.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, samples.length);
        const t0 = now; now += ((end - off) / sampleRate) * 1000;
        mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
        chunkIdx++;
        const cr = mrd.carrierRate();
        if (cr != null) {
          carrierSeen[cr] = (carrierSeen[cr] || 0) + 1;
          if (firstCommitChunk == null) firstCommitChunk = chunkIdx;
          if (cr === "24") sawTwentyFour++;
        }
        const lf = mrd.lastFrame;
        if (lf) { if (!firstTc) firstTc = tcString(lf); lastTc = tcString(lf); }
      }
      const obs = mrd.carrierObservation(), cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
      snapshots.push({
        loop, carrierRate: mrd.carrierRate(), fractional: obs.fractional, classConfidence: obs.classConfidence,
        stableFps: obs.stable?.fps ?? null, sigmaFps: obs.stable?.sigmaFps ?? null,
        cadenceFps: cad?.fps ?? null, dropFrame: cad?.dropFrame ?? null, dfFlagMatches: cad?.dfFlagMatches ?? null,
        detectedRateKey: mrd.detectedRateKey(), mismatchResult: mm?.result ?? null,
        driftHostPpm: mrd.driftPpmSourceVsHostQuartz(),
      });
    }

    const final = snapshots[snapshots.length - 1];
    const result = {
      wav: { sampleRate, bitsPerSample, channels, samples: samples.length, durationSec: +(samples.length / sampleRate).toFixed(3) },
      loops: LOOPS, firstTc, lastTc, firstCommitChunk,
      carrierRatesSeenAfterCommit: carrierSeen, sawTwentyFour, final, snapshots,
    };
    writeFileSync(fileURLToPath(new URL("./f4_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    // Test #4 pass criteria.
    expect(final.carrierRate).toBe("23.976");
    expect(final.fractional).toBe(true);
    expect(final.classConfidence).toBe("high");
    expect(final.cadenceFps).toBe(24);
    expect(final.dropFrame).toBe(false);
    expect(final.detectedRateKey).toBe("23.976");
    expect(final.mismatchResult).toBe(false);
    expect(sawTwentyFour).toBe(0);                          // never flips to 24
    expect(Object.keys(carrierSeen)).toEqual(["23.976"]);   // only ever committed 23.976
  }, 60000);
});

// Ground-truth harness for TESTING.md test #5 (25 / 30 integer rates).
// Feeds F5 (25 PAL) and F6 (30 integer) through the real MultiRateDecoder,
// looped, with wall-clock-stamped chunks. Verifies each commits CLASS integer
// (high), the correct label, and no NON-CONFORMANT banner. Tracks the
// committed carrierRate AND winning decoder fps on every chunk so any transient
// misclassification (F5 -> 24/30, F6 -> 29.97) is caught, not just the endpoint.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const DIR = "../../../testing_timecode/";
const F5 = DIR + "F5_LTC_01043000_2mins_25_FPS_48000x16.wav";
const F6 = DIR + "F6_LTC_01043000_2mins_30_NDF_FPS_48000x16.wav";
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

function decode(rel) {
  const wav = parseWav(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));
  const { samples, sampleRate, bitsPerSample, channels } = wav;
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const mrd = new MultiRateDecoder();
  const carrierSeen = {};   // committed carrierRate -> chunk count
  const winnerFpsSeen = {}; // winning decoder fps -> chunk count (once locked)
  let firstTc = null, lastTc = null;
  for (let loop = 0; loop < LOOPS; loop++) {
    for (let off = 0; off < samples.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, samples.length);
      const t0 = now; now += ((end - off) / sampleRate) * 1000;
      mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
      const cr = mrd.carrierRate();
      if (cr != null) carrierSeen[cr] = (carrierSeen[cr] || 0) + 1;
      const wf = mrd.nominalFps;
      if (wf != null) winnerFpsSeen[wf] = (winnerFpsSeen[wf] || 0) + 1;
      const lf = mrd.lastFrame;
      if (lf) { if (!firstTc) firstTc = tcString(lf); lastTc = tcString(lf); }
    }
  }
  const obs = mrd.carrierObservation(), cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
  const r = {
    wav: { sampleRate, bitsPerSample, channels, samples: samples.length, durationSec: +(samples.length / sampleRate).toFixed(3) },
    firstTc, lastTc, carrierSeen, winnerFpsSeen,
    final: {
      carrierRate: mrd.carrierRate(), fractional: obs.fractional, classConfidence: obs.classConfidence,
      stableFps: obs.stable?.fps ?? null, cadenceFps: cad?.fps ?? null, dropFrame: cad?.dropFrame ?? null,
      dfFlagMatches: cad?.dfFlagMatches ?? null, detectedRateKey: mrd.detectedRateKey(),
      mismatchResult: mm?.result ?? null, mismatchReason: mm?.reason ?? null,
      driftHostPpm: mrd.driftPpmSourceVsHostQuartz(),
    },
  };
  vi.restoreAllMocks();
  return r;
}

describe("test #5 — 25 / 30 integer rates", () => {
  afterEach(() => vi.restoreAllMocks());

  it("F5 commits integer 25 ND; never misframes as 24 or 30", () => {
    const r = decode(F5);
    writeFileSync(fileURLToPath(new URL("./f5_result.json", import.meta.url)), JSON.stringify(r, null, 2));
    expect(r.final.carrierRate).toBe("25");
    expect(r.final.fractional).toBe(false);
    expect(r.final.classConfidence).toBe("high");
    expect(r.final.cadenceFps).toBe(25);
    expect(r.final.dropFrame).toBe(false);
    expect(r.final.detectedRateKey).toBe("25");
    expect(r.final.mismatchResult).toBe(false);
    expect(Object.keys(r.carrierSeen)).toEqual(["25"]);     // only ever committed 25
    expect(Object.keys(r.winnerFpsSeen)).toEqual(["25"]);   // 25 decoder always won; never 24/30
  }, 60000);

  it("F6 commits integer 30 ND; not 29.97, no DF warning", () => {
    const r = decode(F6);
    writeFileSync(fileURLToPath(new URL("./f6_result.json", import.meta.url)), JSON.stringify(r, null, 2));
    expect(r.final.carrierRate).toBe("30");
    expect(r.final.fractional).toBe(false);
    expect(r.final.classConfidence).toBe("high");
    expect(r.final.cadenceFps).toBe(30);
    expect(r.final.dropFrame).toBe(false);
    expect(r.final.detectedRateKey).toBe("30");
    expect(r.final.mismatchResult).toBe(false);             // no "integer 30 carrier carrying DF count"
    expect(Object.keys(r.carrierSeen)).toEqual(["30"]);     // integer 30 only, never 29.97
    expect(Object.keys(r.winnerFpsSeen)).toEqual(["30"]);
  }, 60000);
});

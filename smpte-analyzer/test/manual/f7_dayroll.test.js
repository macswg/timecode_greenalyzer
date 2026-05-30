// TESTING.md test #6 (day rollover). Feeds F7 (29.97 DF, start 23:59:00:00,
// 2 min -> crosses midnight at 23:59:59:29 -> 00:00:00:00) through the real
// MultiRateDecoder, single pass, and checks for a phantom continuity break at
// the 24h rollover. Taps the cadence detector to see every decoded frame and
// every break.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const F7 = "../../../testing_timecode/F7_LTC_23590000_2mins_29_97_DF_FPS_48000x16.wav";
const CHUNK = 4800;

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not WAVE");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4); const sz = buf.readUInt32LE(off + 4); const body = off + 8;
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    else if (id === "data") { dataOff = body; dataLen = sz; }
    off = body + sz + (sz & 1);
  }
  const fb = (fmt.bitsPerSample / 8) * fmt.channels, n = Math.floor(dataLen / fb);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(dataOff + i * fb) / 32768;
  return { samples: out, ...fmt };
}

describe("test #6 — day rollover (F7, 23:59 -> 00:00)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("locks through midnight; report any continuity break at the day roll", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F7, import.meta.url))));
    const { samples, sampleRate } = wav;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();
    const cd = mrd.cadenceDetector;
    const orig = cd.feed.bind(cd);
    let prev = null, firstTc = null, lastTc = null;
    const breaks = [];
    let dayRoll = null;            // the 23:59:59 -> 00:00:00 frame transition
    let dayRollBreak = null;       // break recorded exactly at the day roll
    cd.feed = (frame) => {
      const before = cd.continuityBreaks;
      if (!firstTc) firstTc = tcString(frame);
      lastTc = tcString(frame);
      if (prev && prev.hh === 23 && frame.hh === 0) dayRoll = { from: tcString(prev), to: tcString(frame) };
      const ret = orig(frame);
      if (cd.continuityBreaks > before && cd.lastBreak) {
        const b = { type: cd.lastBreak.type, delta: cd.lastBreak.delta, from: cd.lastBreak.from, to: cd.lastBreak.to };
        breaks.push(b);
        if (prev && prev.hh === 23 && frame.hh === 0) dayRollBreak = b;
      }
      prev = { hh: frame.hh, mm: frame.mm, ss: frame.ss, ff: frame.ff };
      return ret;
    };
    for (let off = 0; off < samples.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, samples.length);
      const t0 = now; now += ((end - off) / sampleRate) * 1000;
      mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
    }
    const obs = mrd.carrierObservation(), cad = mrd.cadence();
    const result = {
      firstTc, lastTc, durationSec: +(samples.length / sampleRate).toFixed(3),
      carrierRate: mrd.carrierRate(), fractional: obs.fractional, cadenceFps: cad?.fps ?? null,
      dropFrame: cad?.dropFrame ?? null, dfFlagMatches: cad?.dfFlagMatches ?? null, detectedRateKey: mrd.detectedRateKey(),
      totalContinuityBreaks: cd.continuityBreaks, breaks, dayRoll, dayRollBreak,
    };
    writeFileSync(fileURLToPath(new URL("./f7_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    // Sanity: it locks and reads 29.97 DF through the rollover.
    expect(result.carrierRate).toBe("29.97");
    expect(result.cadenceFps).toBe(30);
    expect(result.dropFrame).toBe(true);
    expect(result.dayRoll).not.toBeNull();          // the file actually crosses midnight
    // The criterion under test: NO phantom continuity break at the day roll.
    expect(result.dayRollBreak).toBeNull();
  }, 60000);
});

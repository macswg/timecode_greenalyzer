// TESTING.md test #7 (10th-minute exclusion). Feeds F8 (29.97 DF, start
// 01:07:30:00, 3 min -> spans 01:08, 01:09 minute boundaries and the
// 01:09->01:10 tenth-minute boundary) through the real MultiRateDecoder,
// single pass. The 01:10:00 crossing has NO DF skip (lands on ff=0) and would
// bias the cadence histogram toward NDF if counted, so the detector must
// exclude it. Captures every ss:59->00 crossing to prove the exclusion.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const F8 = "../../../testing_timecode/F8_LTC_01073000_3mins_29_97_DF_FPS_48000x16.wav";
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

describe("F8 ground truth — test #7 (10th-minute exclusion)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("infers DF from non-tenth minutes; excludes the 01:09->01:10 crossing", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F8, import.meta.url))));
    const { samples, sampleRate } = wav;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();
    const cd = mrd.cadenceDetector;
    const orig = cd.feed.bind(cd);
    let prev = null, firstTc = null, lastTc = null;
    const crossings = [];   // every ss:59 -> ss:00 minute-advancing crossing
    cd.feed = (frame) => {
      if (!firstTc) firstTc = tcString(frame);
      lastTc = tcString(frame);
      if (prev && frame.ss === 0 && prev.ss === 59 && (frame.mm !== prev.mm || frame.hh !== prev.hh)) {
        crossings.push({ fromTc: tcString(prev), toTc: tcString(frame), mm: frame.mm, ffAfter: frame.ff, tenthMinute: frame.mm % 10 === 0 });
      }
      prev = { hh: frame.hh, mm: frame.mm, ss: frame.ss, ff: frame.ff };
      return orig(frame);
    };
    for (let off = 0; off < samples.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, samples.length);
      const t0 = now; now += ((end - off) / sampleRate) * 1000;
      mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
    }
    const obs = mrd.carrierObservation(), cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
    const tenth = crossings.filter((c) => c.tenthMinute);
    const nonTenth = crossings.filter((c) => !c.tenthMinute);
    const result = {
      firstTc, lastTc, durationSec: +(samples.length / sampleRate).toFixed(3),
      carrierRate: mrd.carrierRate(), fractional: obs.fractional, cadenceFps: cad?.fps ?? null,
      dropFrame: cad?.dropFrame ?? null, dfFlagMatches: cad?.dfFlagMatches ?? null, detectedRateKey: mrd.detectedRateKey(),
      mismatchResult: mm?.result ?? null, dfHits: cd.minuteBoundaryDfHits, ndfHits: cd.minuteBoundaryNdfHits,
      crossings,
    };
    writeFileSync(fileURLToPath(new URL("./f8_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    // Reads as 29.97 DF.
    expect(result.carrierRate).toBe("29.97");
    expect(result.cadenceFps).toBe(30);
    expect(result.dropFrame).toBe(true);
    expect(result.detectedRateKey).toBe("29.97df");
    expect(result.mismatchResult).toBe(false);
    // Crossed exactly one tenth-minute boundary, which lands on ff=0 (no DF skip).
    expect(tenth.length).toBe(1);
    expect(tenth[0].ffAfter).toBe(0);
    expect(tenth[0].mm % 10).toBe(0);
    // Non-tenth crossings skip to ff=2 (the DF skip) and ARE counted.
    expect(nonTenth.length).toBeGreaterThanOrEqual(2);
    for (const c of nonTenth) expect(c.ffAfter).toBe(2);
    // The tenth-minute crossing was excluded: DF hits == non-tenth crossings, NDF hits 0.
    expect(result.dfHits).toBe(nonTenth.length);
    expect(result.ndfHits).toBe(0);
  }, 60000);
});

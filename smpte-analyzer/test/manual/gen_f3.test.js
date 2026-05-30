// Generate + validate F3 (59.94 DF) for TESTING.md test #3, and diagnose the
// existing BAD_F3 file. Uses the project's OWN synthesizer (buildLtcAudioBuffer)
// so the encoded frames match what the analyzer's decoder expects, then feeds
// the result back through the real MultiRateDecoder + CadenceDetector to prove
// it reads as 59.94 DF with the 4-frame skip recognized at minute boundaries.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";
import { buildLtcAudioBuffer } from "../../src/ltcSynth.js";

const DIR = "../../../testing_timecode/";
const BAD = DIR + "BAD_F3_LTC_5994DF_01043000_2mins_48k_59.94dffps_LTC.wav";
const OUT_NAME = "F3_LTC_01043000_2mins_59_94_DF_FPS_48000x16.wav";

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE")
    throw new Error("not a WAVE file");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = {
      audioFormat: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2),
      sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14),
    };
    else if (id === "data") { dataOff = body; dataLen = sz; }
    off = body + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error("missing fmt/data");
  const bps = fmt.bitsPerSample / 8, frameBytes = bps * fmt.channels;
  const n = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = dataOff + i * frameBytes;
    out[i] = fmt.bitsPerSample === 16 ? buf.readInt16LE(p) / 32768
           : fmt.bitsPerSample === 8 ? (buf[p] - 128) / 128
           : (() => { throw new Error("bits " + fmt.bitsPerSample); })();
  }
  return { samples: out, ...fmt };
}

function writeWavInt16Mono(path, f32, sampleRate) {
  const dataLen = f32.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii"); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii"); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii"); buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < f32.length; i++) {
    const v = Math.max(-1, Math.min(1, f32[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// Feed a sample buffer through a fresh MultiRateDecoder, looped, with mocked
// wall-clock advanced at the file's real playback rate. Captures minute-boundary
// frames (ss 59->0, mm advanced, non-tenth) to expose the DF skip directly.
function decodeAndReport(samples, sampleRate, loops) {
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const mrd = new MultiRateDecoder();
  // Tap the cadence detector so we observe EVERY decoded winner frame, not just
  // the last frame per chunk (at 60 fps a 100 ms chunk holds ~6 frames).
  const cd = mrd.cadenceDetector;
  const origFeed = cd.feed.bind(cd);
  let firstTc = null, lastTc = null, prev = null;
  const boundaries = [];
  const breaks = [];
  cd.feed = (frame) => {
    const before = cd.continuityBreaks;
    if (!firstTc) firstTc = tcString(frame);
    lastTc = tcString(frame);
    if (prev && frame.ss === 0 && prev.ss === 59 &&
        (frame.mm !== prev.mm || frame.hh !== prev.hh) && frame.mm % 10 !== 0) {
      boundaries.push({ fromTc: tcString(prev), toTc: tcString(frame), ffAfter: frame.ff });
    }
    const ret = origFeed(frame);
    if (cd.continuityBreaks > before && cd.lastBreak) {
      breaks.push({ type: cd.lastBreak.type, delta: cd.lastBreak.delta, from: cd.lastBreak.from, to: cd.lastBreak.to });
    }
    prev = { hh: frame.hh, mm: frame.mm, ss: frame.ss, ff: frame.ff };
    return ret;
  };
  const CHUNK = 4800;
  for (let loop = 0; loop < loops; loop++) {
    for (let off = 0; off < samples.length; off += CHUNK) {
      const end = Math.min(off + CHUNK, samples.length);
      const t0 = now;
      now += ((end - off) / sampleRate) * 1000;
      mrd.feed(samples.subarray(off, end), sampleRate, t0, now);
    }
  }
  const obs = mrd.carrierObservation(), cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
  const r = {
    firstTc, lastTc,
    carrierRate: mrd.carrierRate(), fractional: obs.fractional, classConfidence: obs.classConfidence,
    stableFps: obs.stable?.fps ?? null,
    cadenceFps: cad?.fps ?? null, dropFrame: cad?.dropFrame ?? null,
    dfFlagMatches: cad?.dfFlagMatches ?? null, detectedRateKey: mrd.detectedRateKey(),
    fieldMarkBehavior: mrd.fieldMarkBehavior(),
    mismatchResult: mm?.result ?? null, mismatchReason: mm?.reason ?? null,
    continuityBreaks: cd.continuityBreaks, lastBreakType: mrd.lastBreak?.type ?? null,
    ndfHits: cd.minuteBoundaryNdfHits, dfHits: cd.minuteBoundaryDfHits,
    driftHostPpm: mrd.driftPpmSourceVsHostQuartz(), framesDecoded: mrd.framesDecoded,
    boundaries,
    breaks,
  };
  vi.restoreAllMocks();
  return r;
}

describe("F3 (59.94 DF) generation + validation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("diagnoses the existing BAD_F3 file", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(BAD, import.meta.url))));
    const r = decodeAndReport(wav.samples, wav.sampleRate, 1);
    console.log("BAD_F3_DIAG " + JSON.stringify(r));
    writeFileSync(fileURLToPath(new URL("./f3_bad_diag.json", import.meta.url)), JSON.stringify(r, null, 2));
  }, 60000);

  it("generates a valid 59.94 DF F3 and the decoder reads it as 59.94df", () => {
    const sampleRate = 48000;
    const samples = buildLtcAudioBuffer({
      sampleRate,
      carrierFps: 60 / 1.001,   // 59.94 fractional carrier
      cadenceFps: 60,           // 60-count
      dropFrame: true,          // apply 4-frame DF skip at minute boundaries
      dfFlag: true,             // assert DF flag bit (spec-conformant)
      durationSec: 120,
      levelDbFS: -18,           // SMPTE nominal
      start: { hh: 1, mm: 4, ss: 30, ff: 0 },
    });
    const outPath = fileURLToPath(new URL(DIR + OUT_NAME, import.meta.url));
    writeWavInt16Mono(outPath, samples, sampleRate);

    // Read back from disk (true round-trip through the 16-bit WAV) and decode.
    const wav = parseWav(readFileSync(outPath));
    const r = decodeAndReport(wav.samples, wav.sampleRate, 3);
    r.wav = { sampleRate: wav.sampleRate, bitsPerSample: wav.bitsPerSample, channels: wav.channels,
              samples: wav.samples.length, durationSec: +(wav.samples.length / wav.sampleRate).toFixed(3) };
    r.outPath = outPath;
    console.log("F3_VALIDATE " + JSON.stringify(r));
    writeFileSync(fileURLToPath(new URL("./f3_result.json", import.meta.url)), JSON.stringify(r, null, 2));

    // Test #3 pass criteria.
    expect(r.carrierRate).toBe("59.94");
    expect(r.cadenceFps).toBe(60);
    expect(r.dropFrame).toBe(true);
    expect(r.dfFlagMatches).toBe(true);
    expect(r.detectedRateKey).toBe("59.94df");
    expect(r.mismatchResult).toBe(false);
    expect(r.dfHits).toBeGreaterThan(0);
    expect(r.ndfHits).toBe(0);
    // Every observed minute boundary must skip to ff=4 (4-frame DF skip at 60).
    expect(r.boundaries.length).toBeGreaterThan(0);
    for (const b of r.boundaries) expect(b.ffAfter).toBe(4);
  }, 60000);
});

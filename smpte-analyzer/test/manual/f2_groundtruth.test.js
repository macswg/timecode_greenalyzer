// Ground-truth harness for TESTING.md test #2 (NDF negative control).
//
// Feeds the real F2 WAV (29.97 NDF, start 01:04:30:00) through the ACTUAL
// MultiRateDecoder + CadenceDetector, reproducing the file-drop / live-worklet
// path: frames arrive at their encoded rate in wall-clock, stamped per chunk.
// performance.now() is mocked and advanced by the chunk's real playback
// duration (chunkSamples / sampleRate). The file is looped LOOPS times to
// exercise loop-wrap behaviour (the d6b2141 "loop-wrap is not a minute
// boundary" fix). Emits a JSON readout of exactly what the analyzer's decode
// logic produces, which is the ground truth the browser display should match.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder, tcString } from "../../src/ltcDecoder.js";

const F2 = "../../../testing_timecode/F2_LTC_01043000_2mins_29_97_NDF_FPS_48000x16.wav";
const LOOPS = 3;
const CHUNK = 4800; // 100 ms at 48 kHz, matches the test suite's chunkMs=100

function parseWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not WAVE");
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const sz = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      dataOff = body;
      dataLen = sz;
    }
    off = body + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error("missing fmt/data chunk");
  const { channels, bitsPerSample } = fmt;
  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = bytesPerSample * channels;
  const nFrames = Math.floor(dataLen / frameBytes);
  const out = new Float32Array(nFrames);
  for (let i = 0; i < nFrames; i++) {
    const p = dataOff + i * frameBytes; // channel 0 only
    let v;
    if (bitsPerSample === 16) v = buf.readInt16LE(p) / 32768;
    else if (bitsPerSample === 24) {
      let x = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      if (x & 0x800000) x -= 0x1000000;
      v = x / 8388608;
    } else if (bitsPerSample === 32 && fmt.audioFormat === 3) v = buf.readFloatLE(p);
    else if (bitsPerSample === 32) v = buf.readInt32LE(p) / 2147483648;
    else if (bitsPerSample === 8) v = (buf[p] - 128) / 128;
    else throw new Error("unsupported bit depth " + bitsPerSample);
    out[i] = v;
  }
  return { samples: out, ...fmt };
}

function snapshot(mrd, loop, t) {
  const obs = mrd.carrierObservation();
  const cad = mrd.cadence();
  const mm = mrd.carrierCadenceMismatch();
  const cd = mrd.cadenceDetector;
  return {
    loop,
    t,
    carrierRate: mrd.carrierRate(),
    fractional: obs.fractional,
    classConfidence: obs.classConfidence,
    stableFps: obs.stable?.fps ?? null,
    sigmaFps: obs.stable?.sigmaFps ?? null,
    agreementCount: obs.agreementCount,
    cadenceFps: cad?.fps ?? null,
    dropFrame: cad?.dropFrame ?? null,
    dropFrameKnown: cad?.dropFrameKnown ?? null,
    dfFlagMatches: cad?.dfFlagMatches ?? null,
    detectedRateKey: mrd.detectedRateKey(),
    mismatchResult: mm?.result ?? null,
    mismatchReason: mm?.reason ?? null,
    continuityBreaks: cd.continuityBreaks,
    lastBreakType: mrd.lastBreak?.type ?? null,
    lastBreakDelta: mrd.lastBreak?.delta ?? null,
    ndfHits: cd.minuteBoundaryNdfHits,
    dfHits: cd.minuteBoundaryDfHits,
    driftHostPpm: mrd.driftPpmSourceVsHostQuartz(),
    driftAdcPpm: mrd.driftPpmSourceVsAdc(),
    framesDecoded: mrd.framesDecoded,
    framesSeen: cd.framesSeen,
  };
}

describe("F2 ground truth — test #2 (29.97 NDF negative control)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("decodes F2 as 29.97 ND, stays ND across loop wraps, no DF inference", () => {
    const wavPath = fileURLToPath(new URL(F2, import.meta.url));
    const wav = parseWav(readFileSync(wavPath));
    const { samples, sampleRate, bitsPerSample, channels } = wav;

    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);

    const mrd = new MultiRateDecoder();
    let firstTc = null, lastTc = null;
    let wrapBreaks = [];
    let prevLf = null;
    const snapshots = [];

    for (let loop = 0; loop < LOOPS; loop++) {
      for (let off = 0; off < samples.length; off += CHUNK) {
        const end = Math.min(off + CHUNK, samples.length);
        const chunk = samples.subarray(off, end);
        const t0 = now;
        now += (chunk.length / sampleRate) * 1000;
        const t1 = now;
        mrd.feed(chunk, sampleRate, t0, t1);
        const lf = mrd.lastFrame;
        if (lf) {
          if (!firstTc) firstTc = tcString(lf);
          lastTc = tcString(lf);
          // capture any continuity break recorded this feed
          const lb = mrd.lastBreak;
          if (lb && (!prevLf || lb.t === lf.t) && lb.delta !== 1) {
            // dedupe by (t,type,delta)
            const key = `${lb.t}|${lb.type}|${lb.delta}`;
            if (!wrapBreaks.length || wrapBreaks[wrapBreaks.length - 1].key !== key) {
              wrapBreaks.push({ key, type: lb.type, delta: lb.delta, from: lb.from, to: lb.to });
            }
          }
          prevLf = lf;
        }
      }
      snapshots.push(snapshot(mrd, loop, now));
    }

    const final = snapshots[snapshots.length - 1];
    const result = {
      wav: {
        sampleRate, bitsPerSample, channels,
        samples: samples.length,
        durationSec: +(samples.length / sampleRate).toFixed(3),
      },
      loops: LOOPS,
      firstTc, lastTc,
      uniqueContinuityBreaks: wrapBreaks,
      final,
      snapshots,
    };
    writeFileSync(fileURLToPath(new URL("./f2_result.json", import.meta.url)),
      JSON.stringify(result, null, 2));
    console.log("F2_RESULT_JSON " + JSON.stringify(result));

    // Test #2 pass criteria.
    expect(final.carrierRate).toBe("29.97");
    expect(final.cadenceFps).toBe(30);
    expect(final.dropFrame).toBe(false);
    expect(final.dfFlagMatches).toBe(true);
    expect(final.detectedRateKey).toBe("29.97");
    expect(final.mismatchResult).toBe(false);
    expect(final.dfHits).toBe(0);
    expect(final.ndfHits).toBeGreaterThan(0);
  });
});

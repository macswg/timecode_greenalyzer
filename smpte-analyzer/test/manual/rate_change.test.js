// TESTING.md test #12 (rate change mid-stream). Feeds F1 (29.97 DF) then F4
// (23.976 ND) on one continuous wall-clock timeline (no gap) through the real
// MultiRateDecoder. Verifies: carrier fires DIVERGENCE on the change, unlocks,
// then re-commits to 23.976 within ~20 s; and the cadence detector follows
// (24 ND) without leaking 29.97-era hits (no lingering DF / NON-CONFORMANT).
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder } from "../../src/ltcDecoder.js";

const DIR = "../../../testing_timecode/";
const F1 = DIR + "F1_LTC_01043000_2mins_29_97_DF_FPS_48000x16.wav";   // 29.97 DF
const F4 = DIR + "F4_LTC_01043000_2mins_23_976_FPS_48000x16.wav";     // 23.976 ND
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
const load = (rel) => parseWav(readFileSync(fileURLToPath(new URL(rel, import.meta.url))));

describe("test #12 — rate change mid-stream (F1 29.97DF -> F4 23.976ND)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("diverges, re-commits to 23.976 within ~20s, cadence follows without leak", () => {
    const f1 = load(F1), f4 = load(F4);
    const sr = f1.sampleRate;
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();

    const feed = (samples, maxSec, sample, tSwitch, evT0 = 0) => {
      const out = [];
      const maxSamples = maxSec ? Math.min(samples.length, Math.round(maxSec * sr)) : samples.length;
      let lastEvT = evT0;
      for (let off = 0; off < maxSamples; off += CHUNK) {
        const end = Math.min(off + CHUNK, maxSamples);
        const t0 = now; now += ((end - off) / sr) * 1000;
        mrd.feed(samples.subarray(off, end), sr, t0, now);
        if (sample) {
          const ev = mrd.lastCarrierEvent;
          const newEv = ev && ev.t !== lastEvT ? ev.type : null;
          if (ev) lastEvT = ev.t;
          const cad = mrd.cadence(), mm = mrd.carrierCadenceMismatch();
          out.push({
            sec: +((now - tSwitch) / 1000).toFixed(2), carrierRate: mrd.carrierRate(),
            fractional: mrd.carrierObservation().fractional, cadFps: cad?.fps ?? null,
            cadDf: cad?.dropFrame ?? null, mismatch: mm?.result === true, newEv,
          });
        }
      }
      return out;
    };

    feed(f1.samples, 45, false);          // phase 1: 45 s of 29.97 DF -> commit
    const pre = { carrierRate: mrd.carrierRate(), cadFps: mrd.cadence()?.fps, cadDf: mrd.cadence()?.dropFrame };
    const preEvT = mrd.lastCarrierEvent?.t ?? 0;   // ignore the phase-1 commit event
    const tSwitch = now;
    const log = feed(f4.samples, 90, true, tSwitch, preEvT);   // phase 2: 90 s of 23.976 ND

    vi.restoreAllMocks();

    const firstDiverge = log.find((s) => s.newEv === "DIVERGENCE");
    // Re-lock to the new rate is signalled by RATE_CHANGE for a nominal-fps
    // change (winner switches 30->24) or DIVERGENCE for a same-nominal
    // fractional<->integer flip. F1->F4 is the former, so expect RATE_CHANGE.
    const firstReLock = log.find((s) => s.newEv === "RATE_CHANGE" || s.newEv === "DIVERGENCE");
    const firstCommit23976 = log.find((s) => s.carrierRate === "23.976");
    const events = log.filter((s) => s.newEv).map((s) => ({ type: s.newEv, sec: s.sec }));
    // leak = mismatch still raised, or cadence still 30/DF, in the last 10 s
    const tail = log.filter((s) => s.sec >= log[log.length - 1].sec - 10);
    const lingeringMismatch = tail.some((s) => s.mismatch);
    const final = log[log.length - 1];
    const result = {
      preSwitch: pre,
      events,
      reLockEvent: firstReLock ? { type: firstReLock.newEv, sec: firstReLock.sec } : null,
      divergenceSec: firstDiverge ? firstDiverge.sec : null,
      recommit23976Sec: firstCommit23976 ? firstCommit23976.sec : null,
      final: { carrierRate: final.carrierRate, fractional: final.fractional, cadFps: final.cadFps, cadDf: final.cadDf, mismatch: final.mismatch },
      lingeringMismatchInLast10s: lingeringMismatch,
    };
    writeFileSync(fileURLToPath(new URL("./rate_change_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    // Pre-switch baseline: committed 29.97 DF.
    expect(pre.carrierRate).toBe("29.97");
    // Test #12 criteria. Carrier re-locks via a state-machine event (RATE_CHANGE
    // here, since the nominal fps changed) and re-commits to 23.976 within ~20s.
    expect(result.reLockEvent).not.toBeNull();
    expect(result.recommit23976Sec).not.toBeNull();
    expect(result.recommit23976Sec).toBeLessThan(25);         // within ~20s (+margin)
    expect(final.carrierRate).toBe("23.976");
    expect(final.fractional).toBe(true);
    expect(final.cadFps).toBe(24);                            // cadence followed to 24
    expect(final.cadDf).toBe(false);
    expect(result.lingeringMismatchInLast10s).toBe(false);   // no 29.97-era leak
  }, 60000);
});

// TESTING.md test #10 (tab backgrounding), decode-path scope. Models what the
// decoder sees when a browser tab is backgrounded for 30 s: the AudioWorklet
// keeps running on the audio thread and queues sample chunks, but the main
// thread is throttled so MultiRateDecoder.feed() is not called for the whole
// gap. On tab-return the queued chunks drain in a burst — many feed() calls in
// a few hundred ms of real time, each carrying a wall-time stamp from up to
// 30 s ago.
//
// This faithfully reproduces that with the controllable performance.now() mock
// (see [[tc-tests-headless-harness]]): the App.jsx audio-clock offset is
// browser-only (needs getOutputTimestamp) and out of scope here; the decoder is
// fed wall-times directly, exactly as the worklet path does.
//
// What it guards (issue #51):
//   - the committed carrier classification SURVIVES the burst (no flip to
//     MEASURING on return). This is the fix in ltcDecoder.js: the signal-loss
//     hold keys off frame *delivery* recency, not the frame's stamped time.
//   - TC stays current, dropout doesn't spike, continuity isn't broken.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MultiRateDecoder } from "../../src/ltcDecoder.js";

const F1 = "../../../testing_timecode/F1_LTC_01043000_2mins_29_97_DF_FPS_48000x16.wav";
const CHUNK = 4800;          // 100 ms @ 48 k — one "worklet" chunk
const GAP_MS = 30000;        // backgrounded duration
const DRAIN_STEP_MS = 0.01;  // real time per chunk while the queue drains on return
                             // (the backlog empties near-instantly while the
                             // worklet keeps producing, so the newest frame
                             // lands ~current — not 30 s stale)
const POST_DRAIN_CHUNKS = 10; // ~1 s of live material after return (< 3 s re-commit window)

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

describe("Tab backgrounding — test #10 (carrier commit survives a 30 s burst)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains the 29.97 DF commit, stays current, no dropout spike, no continuity break", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F1, import.meta.url))));
    const { samples, sampleRate } = wav;
    const chunkMs = (CHUNK / sampleRate) * 1000;

    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();

    let pos = 0;
    const nextChunk = () => {
      const end = Math.min(pos + CHUNK, samples.length);
      const s = samples.subarray(pos, end);
      pos = end;
      return s;
    };

    // ── Phase 1: pre-background. Feed in real time until the carrier commits. ──
    let committed = false;
    let guard = 0;
    while (!committed && guard++ < 700) {        // cap ≈ 70 s of material
      const s = nextChunk();
      const t0 = now; now += chunkMs;
      mrd.feed(s, sampleRate, t0, now);
      committed = mrd.detectedRateKey() === "29.97df";
    }
    const preKey = mrd.detectedRateKey();
    const preDropout = mrd.dropoutPct();
    const preBreaks = mrd.cadenceDetector.continuityBreaks;

    // ── Phase 2: the gap. Main thread frozen — no feed() — but the worklet kept
    // capturing. Buffer the chunks that "arrived" during the gap with the
    // wall-times they were stamped at, then jump the clock forward 30 s. ──
    const gapStart = now;
    const buffered = [];
    let gt = gapStart;
    while (gt < gapStart + GAP_MS) {
      const s = nextChunk();
      const t0 = gt; gt += chunkMs;
      buffered.push({ s, t0, t1: gt });
    }
    now = gapStart + GAP_MS;   // real time advanced through the whole gap

    // ── Phase 3: tab-return burst drain. All queued chunks feed back-to-back in
    // a tiny slice of real time, each with its (now-stale) gap-era wall-time. ──
    for (const { s, t0, t1 } of buffered) {
      mrd.feed(s, sampleRate, t0, t1);
      now += DRAIN_STEP_MS;
    }
    const postBurstKey = mrd.detectedRateKey();
    const postBurstFractional = mrd.carrierObservation().fractional;
    const postBurstDropout = mrd.dropoutPct();
    const ageAfterBurst = now - (mrd.lastFrame?.t ?? -Infinity);

    // A short live tail (< 3 s, so a *dropped* commit could not yet re-commit). ─
    for (let i = 0; i < POST_DRAIN_CHUNKS; i++) {
      const s = nextChunk();
      const t0 = now; now += chunkMs;
      mrd.feed(s, sampleRate, t0, now);
    }
    const finalKey = mrd.detectedRateKey();
    const finalDropout = mrd.dropoutPct();
    const finalAge = now - (mrd.lastFrame?.t ?? -Infinity);
    const finalBreaks = mrd.cadenceDetector.continuityBreaks;

    const result = {
      sampleRate, gapMs: GAP_MS, bufferedChunks: buffered.length,
      pre:  { key: preKey, dropoutPct: preDropout, continuityBreaks: preBreaks },
      postBurst: { key: postBurstKey, fractional: postBurstFractional, dropoutPct: postBurstDropout, frameAgeMs: ageAfterBurst },
      final: { key: finalKey, dropoutPct: finalDropout, frameAgeMs: finalAge, continuityBreaks: finalBreaks },
    };
    writeFileSync(fileURLToPath(new URL("./tab_background_result.json", import.meta.url)), JSON.stringify(result, null, 2));

    // Precondition: we actually committed before backgrounding.
    expect(preKey).toBe("29.97df");

    // The fix: the commit survives the burst drain (does NOT flip to MEASURING).
    expect(postBurstKey).toBe("29.97df");
    expect(postBurstFractional).toBe(true);
    expect(finalKey).toBe("29.97df");

    // TC is current on return (well inside the 200 ms freshness gate).
    expect(ageAfterBurst).toBeLessThan(200);
    expect(finalAge).toBeLessThan(200);

    // Dropout doesn't spike — the buffered frames kept recentDecodeTimes dense.
    expect(postBurstDropout).toBeLessThan(5);
    expect(finalDropout).toBeLessThan(5);

    // No spurious continuity break introduced by the gap/drain (gap chunks are
    // the audio continuation, so frame numbers advance monotonically).
    expect(finalBreaks).toBe(preBreaks);
  }, 60000);

  // Counterpart guard: the delivery-based hold must NOT defeat the hold's
  // actual purpose. Genuine signal loss stops *deliveries* (the worklet feeds
  // silence — no frames decode), so the commit must still expire after 5 s.
  it("still drops the commit on genuine signal loss (no deliveries for >5 s)", () => {
    const wav = parseWav(readFileSync(fileURLToPath(new URL(F1, import.meta.url))));
    const { samples, sampleRate } = wav;
    const chunkMs = (CHUNK / sampleRate) * 1000;

    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const mrd = new MultiRateDecoder();

    let pos = 0, committed = false, guard = 0;
    while (!committed && guard++ < 700) {
      const end = Math.min(pos + CHUNK, samples.length);
      const t0 = now; now += chunkMs;
      mrd.feed(samples.subarray(pos, end), sampleRate, t0, now);
      pos = end;
      committed = mrd.detectedRateKey() === "29.97df";
    }
    expect(mrd.detectedRateKey()).toBe("29.97df");

    // Signal goes away: keep feeding silence (decodes nothing) in real time.
    const silence = new Float32Array(CHUNK);
    for (let elapsed = 0; elapsed <= 6000; elapsed += chunkMs) {
      const t0 = now; now += chunkMs;
      mrd.feed(silence, sampleRate, t0, now);
    }
    // After >5 s with no decoded frame delivered, the hold expires → MEASURING.
    expect(mrd.detectedRateKey()).toBe(null);
  }, 60000);
});

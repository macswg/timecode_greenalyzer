// Issue #32 — auto-detect which channel of a multi-channel file carries LTC.
// detectLtcChannel probes each channel through the real MultiRateDecoder and
// picks the one that actually decodes frames, so program audio / silence on
// the other channels can't win.
import { describe, it, expect } from "vitest";
import { detectLtcChannel } from "../src/channelDetect.js";
import { buildLtcAudioBuffer } from "../src/ltcSynth.js";

const SR = 48000;
const DUR = 4;

function ltc(carrierFps = 30) {
  return buildLtcAudioBuffer({ sampleRate: SR, carrierFps, cadenceFps: carrierFps, dropFrame: false, durationSec: DUR, start: { hh: 1, mm: 0, ss: 0, ff: 0 } });
}
function silence(len) { return new Float32Array(len); }
function tone(len, freq = 1000) {
  // Deterministic "program audio" — a pure tone. Has no biphase structure, so
  // the decoder finds no frames on it.
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
// Minimal AudioBuffer stand-in: detectLtcChannel only uses these two members.
function mockBuffer(channels) {
  return { numberOfChannels: channels.length, getChannelData: i => channels[i] };
}

describe("detectLtcChannel (#32)", () => {
  it("picks the LTC channel out of [silence, LTC, tone]", () => {
    const code = ltc();
    const buf = mockBuffer([silence(code.length), code, tone(code.length)]);
    const det = detectLtcChannel(buf, SR);
    expect(det.channel).toBe(1);
    expect(det.score).toBeGreaterThan(50);          // ~DUR×30 frames
    expect(det.scores[0]).toBeLessThan(10);          // silence decodes nothing
    expect(det.scores[2]).toBeLessThan(10);          // tone decodes nothing
  });

  it("picks the LTC channel when it's last", () => {
    const code = ltc(25);
    const buf = mockBuffer([tone(code.length, 440), tone(code.length, 880), code]);
    expect(detectLtcChannel(buf, SR).channel).toBe(2);
  });

  it("returns channel 0 for a mono buffer without probing", () => {
    const buf = mockBuffer([ltc()]);
    expect(detectLtcChannel(buf, SR)).toEqual({ channel: 0, score: 0, scores: [0] });
  });

  it("returns channel 0 when no channel carries LTC", () => {
    const buf = mockBuffer([silence(SR * DUR), tone(SR * DUR)]);
    const det = detectLtcChannel(buf, SR);
    expect(det.channel).toBe(0);
    expect(det.score).toBeLessThan(10);              // below minFrames → default
  });
});

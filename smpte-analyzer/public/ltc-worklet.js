// LTC capture worklet. Runs on the audio thread and forwards every sample
// in order to the main thread for biphase decode. Unlike AnalyserNode
// snapshots, no samples are dropped between reads.
//
// Each posted chunk carries TWO wall-clock timestamps (performance.now() in
// AudioWorkletGlobalScope):
//   chunkWallStart  — captured at the start of the first process() call that
//                     contributed samples to the chunk
//   chunkWallEnd    — captured just before the chunk is posted
//
// Decoder consumers linearly interpolate frame timestamps across [start, end]
// using the sample-position within the chunk. This recovers true wall-clock
// arrival time independent of the ADC's sample-clock drift: the ADC's clock
// determines how *many* samples are in the chunk, but the wall-clock span
// (end - start) is measured against the host quartz directly. Frame-rate
// classification (integer vs 1.001-divided NTSC) then uses wall-clock-domain
// timing, immune to the ±tens-of-ppm ADC bias that contaminates sample-count
// based measurement.
//
// `performance.now()` is required in AudioWorkletGlobalScope (Chrome 76+,
// Firefox 76+, Safari 14.5+). If absent, we fall back to currentTime*1000,
// which is in audio-clock domain (sample-clock-driven) and so reintroduces
// the ADC bias — consumers can detect this via the `clockDomain` field.
//
// Message envelopes:
//   { type: "samples", samples, chunkWallStart, chunkWallEnd, clockDomain }
//   { type: "glitch",  gapMs }
// Glitch events are posted when the inter-process() gap exceeds ~2.5× the
// quantum period, indicating the audio thread was starved.

const HAS_PERF = typeof performance !== "undefined" && typeof performance.now === "function";
const wallNow = HAS_PERF ? () => performance.now() : () => currentTime * 1000;
const CLOCK_DOMAIN = HAS_PERF ? "wallclock" : "audioclock";

class LtcCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.idx = 0;
    this.chunkWallStart = 0;     // wall-clock at moment first sample of current chunk was captured
    this.lastProcessTime = 0;
    this.expectedDt = 128 / sampleRate;
    this.glitchThresholdSec = this.expectedDt * 2.5;
  }
  process(inputs) {
    const t = currentTime;
    if (this.lastProcessTime > 0) {
      const dt = t - this.lastProcessTime;
      if (dt > this.glitchThresholdSec) {
        this.port.postMessage({ type: "glitch", gapMs: dt * 1000 });
      }
    }
    this.lastProcessTime = t;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    // Stamp chunk start when we begin filling a fresh buffer. This is the
    // wall-clock time of the FIRST sample in the chunk, captured at the
    // earliest possible moment after process() entry.
    if (this.idx === 0) this.chunkWallStart = wallNow();
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.idx++] = ch[i];
      if (this.idx >= this.buf.length) {
        const chunkWallEnd = wallNow();
        this.port.postMessage({
          type: "samples",
          samples: this.buf.slice(0, this.idx),
          chunkWallStart: this.chunkWallStart,
          chunkWallEnd,
          clockDomain: CLOCK_DOMAIN,
        });
        this.idx = 0;
      }
    }
    return true;
  }
}
registerProcessor("ltc-capture", LtcCapture);

// LTC capture worklet. Runs on the audio thread and forwards every sample
// in order to the main thread for biphase decode. Unlike AnalyserNode
// snapshots, no samples are dropped between reads.
//
// Each posted chunk carries TWO timestamps in the AudioContext's audio-clock
// domain (currentTime, in milliseconds since context start):
//   chunkWallStart  — captured at the start of the first process() call that
//                     contributed samples to the chunk
//   chunkWallEnd    — captured just before the chunk is posted
//
// We deliberately do NOT use performance.now() here. AudioWorkletGlobalScope
// has historically inconsistent support for it — and even when present, its
// time origin does not match the Window's, so values are unusable for
// comparison against main-thread performance.now() (e.g. the analyzer's
// `fresh = performance.now() - lf.t < 200` lock check). The main thread is
// responsible for translating these audio-clock stamps into its own
// performance.now() domain via AudioContext.getOutputTimestamp() — see the
// onmessage handler in App.jsx (wireSourceToDecoder).
//
// Audio-clock timing is driven by the ADC's sample clock, so wall-clock-rate
// classification (integer vs 1.001-divided NTSC) would normally be biased by
// the ADC's ±tens-of-ppm error. The main-thread translation removes that:
// getOutputTimestamp() returns paired (contextTime, performanceTime) measured
// against the host quartz, so chunk *deltas* end up in main-thread domain and
// the LSQ classifier reads against the host quartz, not the ADC clock.
//
// Message envelopes:
//   { type: "samples", samples, chunkWallStart, chunkWallEnd, clockDomain }
//   { type: "glitch",  gapMs }
// `clockDomain` is always "audioclock" now; the field is kept for backwards
// compatibility with any inspector code.
// Glitch events are posted when the inter-process() gap exceeds ~2.5× the
// quantum period, indicating the audio thread was starved.

const wallNow = () => currentTime * 1000;
const CLOCK_DOMAIN = "audioclock";

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

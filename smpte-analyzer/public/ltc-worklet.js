// LTC capture worklet. Runs on the audio thread and forwards every sample
// in order to the main thread for biphase decode. Unlike AnalyserNode
// snapshots, no samples are dropped between reads.
//
// Message envelope:
//   { type: "samples", samples: Float32Array }
//   { type: "glitch",  gapMs: number }
// Glitch events are posted when the inter-process() gap exceeds ~2.5× the
// quantum period, indicating the audio thread was starved (system overload,
// blocking work on the worklet, device interruption). Surfacing this lets
// the UI distinguish "no LTC signal" from "no audio at all".

class LtcCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.idx = 0;
    this.lastProcessTime = 0;
    // AudioWorklet quantum is 128 frames; expected dt = 128/sampleRate.
    // Flag anything beyond 2.5× as a glitch — generous enough to ignore
    // normal scheduler jitter (~1.1×) but catches real starvation.
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
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.idx++] = ch[i];
      if (this.idx >= this.buf.length) {
        this.port.postMessage({ type: "samples", samples: this.buf.slice(0, this.idx) });
        this.idx = 0;
      }
    }
    return true;
  }
}
registerProcessor("ltc-capture", LtcCapture);

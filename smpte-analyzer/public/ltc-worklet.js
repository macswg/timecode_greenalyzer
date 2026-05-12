// LTC capture worklet. Runs on the audio thread and forwards every sample
// in order to the main thread for biphase decode. Unlike AnalyserNode
// snapshots, no samples are dropped between reads.

class LtcCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.idx = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.idx++] = ch[i];
      if (this.idx >= this.buf.length) {
        this.port.postMessage(this.buf.slice(0, this.idx));
        this.idx = 0;
      }
    }
    return true;
  }
}
registerProcessor("ltc-capture", LtcCapture);

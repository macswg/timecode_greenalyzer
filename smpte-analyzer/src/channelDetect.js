// LTC channel auto-detection for multi-channel files (#32).
//
// Production files often carry LTC on one channel and program audio (dialog,
// music) on the others. Web Audio's default down-mix would sum them, burying
// the code under program audio. We instead probe each channel independently
// and pick the one that actually decodes LTC.
//
// The probe runs a throwaway MultiRateDecoder over a short window of each
// channel and scores by how many frames it decodes — a real LTC channel
// decodes dozens-to-hundreds of frames in a couple of seconds; noise, silence,
// dialog and music decode essentially none. This reuses the production decoder
// rather than a bespoke heuristic, so "does it decode?" means exactly what it
// means at runtime.

import { MultiRateDecoder } from "./ltcDecoder";

// Probe `audioBuffer` (anything exposing numberOfChannels + getChannelData(i),
// e.g. a Web Audio AudioBuffer) and return { channel, score, scores }:
//   channel — index of the best LTC channel, or 0 if none clears `minFrames`
//             (so mono / non-LTC files keep channel 0 and behave as before).
//   score   — frames decoded on the winning channel.
//   scores  — per-channel frame counts (for UI / diagnostics).
export function detectLtcChannel(audioBuffer, sampleRate, { probeSec = 3, minFrames = 10 } = {}) {
  const nCh = audioBuffer.numberOfChannels;
  if (!nCh || nCh <= 1) return { channel: 0, score: 0, scores: [0] };

  const probeSamples = Math.floor(probeSec * sampleRate);
  const chunk = 4800; // 100 ms @ 48 k — same granularity as the live worklet feed
  // Anchor synthetic chunk timestamps to real wall-clock so the decoder's
  // ">60 s since last frame" staleness reset (which compares lastFrame.t to
  // performance.now()) never fires mid-probe and zeroes framesDecoded.
  const base = performance.now();

  const scores = [];
  let best = 0, bestScore = -1;
  for (let c = 0; c < nCh; c++) {
    const data = audioBuffer.getChannelData(c);
    const n = Math.min(probeSamples, data.length);
    const dec = new MultiRateDecoder();
    let t = base;
    for (let off = 0; off < n; off += chunk) {
      const end = Math.min(off + chunk, n);
      const t0 = t; t += ((end - off) / sampleRate) * 1000;
      dec.feed(data.subarray(off, end), sampleRate, t0, t);
    }
    const score = dec.framesDecoded;
    scores.push(score);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= minFrames
    ? { channel: best, score: bestScore, scores }
    : { channel: 0, score: bestScore, scores };
}

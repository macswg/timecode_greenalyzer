import React, { useState, useEffect, useRef, useCallback } from "react";
import { Publisher } from "./publisher";
import { MultiRateDecoder, rateKeyToNominalFps, tcString } from "./ltcDecoder";
import { framesToTc, isValidDropFrame } from "./dropFrame";
import { buildLtcAudioBuffer } from "./ltcSynth";

// Carrier rates the synthesizer can emit. Independent of counting cadence.
const SYNTH_CARRIER_RATES = {
  "23.976": 24000 / 1001,
  "24":     24,
  "25":     25,
  "29.97":  30000 / 1001,
  "30":     30,
  "50":     50,
  "59.94":  60000 / 1001,
  "60":     60,
};

// Counting cadence options the synthesizer can emit.
const SYNTH_CADENCES = {
  "24":   { fps: 24, dropFrame: false, label: "24 ND" },
  "25":   { fps: 25, dropFrame: false, label: "25 ND" },
  "30":   { fps: 30, dropFrame: false, label: "30 ND" },
  "30df": { fps: 30, dropFrame: true,  label: "30 DF" },
  "50":   { fps: 50, dropFrame: false, label: "50 ND" },
  "60":   { fps: 60, dropFrame: false, label: "60 ND" },
  "60df": { fps: 60, dropFrame: true,  label: "60 DF" },
};

// ─── SMPTE Timecode Spec Constants ──────────────────────────────────────────
// Per SMPTE ST 12-1:2014
const SMPTE_RATES = {
  "23.976": { fps: 24000 / 1001, dropFrame: false, label: "23.976 ND" },
  "24":     { fps: 24,           dropFrame: false, label: "24 ND" },
  "25":     { fps: 25,           dropFrame: false, label: "25 ND" },
  "29.97df":{ fps: 30000 / 1001, dropFrame: true,  label: "29.97 DF" },
  "29.97":  { fps: 30000 / 1001, dropFrame: false, label: "29.97 ND" },
  "30":     { fps: 30,           dropFrame: false, label: "30 ND" },
  "50":     { fps: 50,           dropFrame: false, label: "50 ND" },
  "59.94df":{ fps: 60000 / 1001, dropFrame: true,  label: "59.94 DF" },
  "59.94":  { fps: 60000 / 1001, dropFrame: false, label: "59.94 ND" },
  "60":     { fps: 60,           dropFrame: false, label: "60 ND" },
};

// Operating-level thresholds the analyzer uses to classify the input
// (digital, dBFS). The nominal value reflects common LTC practice.
const LEVEL_SPEC = {
  CLIP_THRESHOLD: -1,     // dBFS — above this = overload risk
  HOT_THRESHOLD: -6,      // dBFS — above this = hot, may cause read errors
  NOMINAL: -18,           // dBFS — common nominal operating level for LTC
  LOW_THRESHOLD: -30,     // dBFS — below this = may fail to lock
  SILENT_THRESHOLD: -60,  // dBFS — below this = dropout / no signal
};

// ─── Audio Analysis Engine ───────────────────────────────────────────────────
// The discrete input-channel index the LTC is tapped from. The analyzer only
// ever looks at one channel; a ChannelSplitter routes this channel to the
// analyser + worklet at unity, bypassing Web Audio's mono down-mix weighting.
const LTC_CHANNEL = 0;

function computeRMS(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  return Math.sqrt(sum / buffer.length);
}

function computePeak(buffer) {
  let peak = 0;
  for (let i = 0; i < buffer.length; i++) {
    const abs = Math.abs(buffer[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

function linearToDB(linear) {
  return linear < 1e-10 ? -100 : 20 * Math.log10(linear);
}

// Read the sample rate from a WAV/RIFF file header. Returns null if the
// buffer isn't a recognisable WAV. We do this because Web Audio's
// decodeAudioData always resamples to the context's rate, hiding the file's
// native rate from the decoded buffer.
function readWavSampleRate(arrayBuffer) {
  if (!arrayBuffer || arrayBuffer.byteLength < 44) return null;
  const view = new DataView(arrayBuffer);
  const tag = (off) => String.fromCharCode(view.getUint8(off), view.getUint8(off+1), view.getUint8(off+2), view.getUint8(off+3));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  // Walk chunks looking for "fmt ". Sample rate is uint32 LE at fmt+12.
  let off = 12;
  while (off + 8 <= view.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt " && size >= 16) return view.getUint32(off + 12, true);
    off += 8 + size + (size & 1); // chunks are word-aligned
  }
  return null;
}

// Estimate SNR, noise floor and THD from the AnalyserNode's spectrum.
//
// LTC at N fps has bit rate N*80, with biphase fundamentals at bitRate/2
// (consecutive 0s) and bitRate (consecutive 1s). The waveform is near-square,
// so it has strong odd harmonics (3rd, 5th, 7th of the bitRate/2 fundamental).
//
// SNR: average power in the LTC fundamentals band vs average power in a
//      "quiet" band well below the lowest fundamental. We deliberately
//      don't count odd harmonics as noise — they're expected signal energy.
// Noise floor: average dB level in the quiet band.
// THD: classical √(ΣPh) / √(P1) × 100, summed across the 3rd/5th/7th odd
//      harmonics of the bitRate/2 fundamental. A perfect square wave has
//      THD ≈ 38%. Heavier values indicate added distortion (saturation,
//      clipping, anti-aliasing problems).
let _snrBins = null;
// Reused valley-bin buffer for the noise-floor median; the loop appends at
// most ~60 entries (one per (h+0.5)*f1 null up to nyquist*0.95) and we sort
// the populated prefix in place. Float32Array.sort() is numerical by default
// and avoids the per-tick Array+sort allocation that the original used.
const _valleyBins = new Float32Array(80);
function computeLtcSpectralMetrics(analyser, sampleRate, nominalFps) {
  if (!_snrBins || _snrBins.length !== analyser.frequencyBinCount) {
    _snrBins = new Float32Array(analyser.frequencyBinCount);
  }
  const bins = _snrBins;
  analyser.getFloatFrequencyData(bins);   // dB values, typically -100..0
  const binWidth = (sampleRate / 2) / bins.length;
  const bitRate = nominalFps * 80;
  const f1 = bitRate / 2;                 // lower LTC fundamental
  const fSigLow = bitRate * 0.4;
  const fSigHigh = bitRate * 1.6;
  const nyquist = sampleRate / 2;

  // Band-limited SNR: total signal-band energy vs the noise floor projected
  // across the same band width.
  //
  // Finding the noise floor is the tricky part. LTC's harmonics extend
  // across the entire audible spectrum (every f1 Hz, where f1 = bitRate/2),
  // so there is no large stretch of "pure noise" we can sample. The only
  // reliable noise reading is at the SPECTRAL NULLS — frequencies exactly
  // halfway between consecutive harmonics, where biphase-coded LTC has no
  // energy by construction. We sample bins at (h + 0.5) × f1 for h = 0..N
  // and take the median; that captures the true noise floor regardless of
  // bit rate.
  let sigPow = 0, sigBins = 0;
  for (let i = 1; i < bins.length; i++) {
    const f = i * binWidth;
    if (f >= fSigLow && f <= fSigHigh) {
      sigPow += Math.pow(10, bins[i] / 10);
      sigBins++;
    }
  }
  if (sigBins === 0 || sigPow <= 0) return null;

  let vCount = 0;
  for (let h = 0; h < 60; h++) {
    const fValley = (h + 0.5) * f1;
    if (fValley < 80) continue;
    if (fValley > nyquist * 0.95) break;
    const binIdx = Math.round(fValley / binWidth);
    if (binIdx >= 1 && binIdx < bins.length && vCount < _valleyBins.length) {
      _valleyBins[vCount++] = Math.pow(10, bins[binIdx] / 10);
    }
  }
  if (vCount === 0) return null;
  const vSlice = _valleyBins.subarray(0, vCount);
  vSlice.sort();
  const noiseFloorLin = vSlice[Math.floor(vCount / 2)];
  if (!(noiseFloorLin > 0)) return null;

  const noiseInSigBandLin = noiseFloorLin * sigBins;
  const snr = 10 * Math.log10(sigPow / noiseInSigBandLin);
  const noiseFloor = 10 * Math.log10(noiseFloorLin);

  // THD: peak power in narrow windows around f1 and each odd harmonic.
  // Each peak is the strongest bin within ±10% of the target frequency, so
  // small clock drift doesn't push the harmonic out of the measurement.
  function peakPowerNear(targetHz) {
    if (targetHz <= 0 || targetHz >= nyquist) return 0;
    const tol = 0.10;
    const loBin = Math.max(1, Math.floor((targetHz * (1 - tol)) / binWidth));
    const hiBin = Math.min(bins.length - 1, Math.ceil((targetHz * (1 + tol)) / binWidth));
    let best = -Infinity;
    for (let i = loBin; i <= hiBin; i++) if (bins[i] > best) best = bins[i];
    return Math.pow(10, best / 10);
  }
  const p1 = peakPowerNear(f1);
  const p3 = peakPowerNear(f1 * 3);
  const p5 = peakPowerNear(f1 * 5);
  const p7 = peakPowerNear(f1 * 7);
  const thd = p1 > 0 ? Math.sqrt((p3 + p5 + p7) / p1) * 100 : null;
  return { snr, noiseFloor, thd };
}


// ─── Simulated LTC Generator (for demo — real app uses Web Audio API decode) ─
function generateSimulatedAnalysis(rateKey, levelDbFS, noiseLevel, dropoutProb) {
  const rate = SMPTE_RATES[rateKey];
  const nomFps = rateKeyToNominalFps(rateKey);

  // Simulate running timecode
  const totalFrames = Math.floor((Date.now() / 1000) * rate.fps);
  const { hh, mm, ss, ff } = framesToTc(totalFrames, nomFps, rate.dropFrame);

  // Simulate errors
  const hasDropout = Math.random() < dropoutProb;
  const hasNoise = noiseLevel > 0.15;
  const isClipping = levelDbFS > LEVEL_SPEC.CLIP_THRESHOLD;
  const isHot = levelDbFS > LEVEL_SPEC.HOT_THRESHOLD;
  const isTooQuiet = levelDbFS < LEVEL_SPEC.LOW_THRESHOLD;
  const isDropout = levelDbFS < LEVEL_SPEC.SILENT_THRESHOLD || hasDropout;

  const errors = [];
  if (isClipping) errors.push("CLIP");
  if (isHot && !isClipping) errors.push("HOT");
  if (isTooQuiet) errors.push("LOW");
  if (isDropout) errors.push("DROPOUT");
  if (hasNoise) errors.push("NOISE");

  const frameValid = !isDropout && !isClipping && !isTooQuiet;

  return {
    hh, mm, ss, ff,
    dropFrame: rate.dropFrame,
    colorFrame: false,
    rateKey,
    levelDbFS,
    peakDbFS: levelDbFS + (isClipping ? 0 : (Math.random() * 3 - 1.5)),
    noiseFloor: levelDbFS - 20 - noiseLevel * 30,
    snr: 60 - noiseLevel * 50,
    thd: noiseLevel * 5,
    errors,
    frameValid,
    isHot,
    isTooQuiet,
    isDropout,
  };
}

// ─── Formatting helpers ──────────────────────────────────────────────────────
const padTc = (n) => String(n ?? 0).padStart(2, "0");
// HH:MM:SS:FF / HH:MM:SS;FF formatting comes from ltcDecoder's tcString().

// ─── Shared style tokens ─────────────────────────────────────────────────────
const PANEL = { border: "1px solid #1a1a1a", borderRadius: 3, background: "#080808" };
function buttonStyle(color, { padding = "6px 16px", fontSize = 10, borderAlpha = "44" } = {}) {
  return {
    background: "transparent",
    border: `1px solid ${color}${borderAlpha}`,
    color,
    padding, fontSize, letterSpacing: 2,
  };
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function TimecodeDisplay({ hh, mm, ss, ff, dropFrame, rateKey, valid, dim }) {
  const sep = dropFrame ? ";" : ":";
  const color = dim ? "#333" : valid ? "#00ff88" : "#ff3b3b";
  const textShadow = dim
    ? "none"
    : valid
      ? "0 0 20px rgba(0,255,136,0.5), 0 0 40px rgba(0,255,136,0.2)"
      : "0 0 20px rgba(255,59,59,0.5)";
  return (
    <div style={{
      fontFamily: "'B612 Mono', 'Share Tech Mono', monospace",
      fontSize: "clamp(32px, 6vw, 72px)",
      letterSpacing: "0.03em",
      fontWeight: 700,
      color, textShadow,
      transition: "color 0.1s, text-shadow 0.1s",
    }}>
      {padTc(hh)}<span style={{opacity:0.5}}>:</span>{padTc(mm)}<span style={{opacity:0.5}}>:</span>{padTc(ss)}<span style={{opacity:0.5}}>{sep}</span>{padTc(ff)}
    </div>
  );
}

function LevelMeter({ label, value, peak, min=-60, max=0 }) {
  const clamp = (v) => Math.max(0, Math.min(1, (v - min) / (max - min)));
  const pct = clamp(value) * 100;
  const peakPct = clamp(peak) * 100;
  const color = value > LEVEL_SPEC.CLIP_THRESHOLD ? "#ff1a1a"
              : value > LEVEL_SPEC.HOT_THRESHOLD ? "#ffaa00"
              : value > LEVEL_SPEC.NOMINAL ? "#ccff33"
              : value > LEVEL_SPEC.LOW_THRESHOLD ? "#00ff88"
              : "#ff5500";

  const markers = [-60, -40, -30, -20, -18, -12, -6, -3, 0];

  return (
    <div className="level-meter" style={{ display:"flex", flexDirection:"column", gap:2 }}>
      <div className="lm-header" style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
        <span className="lm-label" style={{ fontSize:12, color:"#888", fontFamily:"monospace", letterSpacing:2 }}>{label}</span>
        <span className="lm-value" style={{ fontSize:12, color, fontFamily:"monospace" }}>
          {value.toFixed(1)} dBFS
        </span>
      </div>
      <div className="lm-bar" style={{ position:"relative", height:14, background:"#0a0a0a", border:"1px solid #222", borderRadius:2 }}>
        {/* Colored fill */}
        <div style={{
          position:"absolute", left:0, top:0, bottom:0,
          width:`${pct}%`,
          background: `linear-gradient(to right, #00aa55, #ccff33 ${clamp(LEVEL_SPEC.HOT_THRESHOLD)*100}%, #ffaa00 ${clamp(LEVEL_SPEC.CLIP_THRESHOLD)*100}%, #ff1a1a)`,
          clipPath: `inset(0 ${100-pct}% 0 0)`,
          transition: "width 0.05s",
        }} />
        {/* Tick marks */}
        {markers.map(db => (
          <div key={db} style={{
            position:"absolute", top:0, bottom:0,
            left:`${clamp(db)*100}%`,
            width:1, background:"rgba(0,0,0,0.5)",
          }} />
        ))}
        {/* Peak hold */}
        {peak > min && (
          <div style={{
            position:"absolute", top:0, bottom:0,
            left:`${Math.min(99.5, peakPct)}%`,
            width:2, background: color,
            boxShadow:`0 0 4px ${color}`,
          }} />
        )}
      </div>
      <div className="lm-ticks" style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#444", fontFamily:"monospace" }}>
        {markers.filter((_,i)=>i%2===0).map(db => (
          <span key={db} style={{ position:"relative", left: db===-60?0:0 }}>{db}</span>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ label, active, color="#ff3b3b", warn=false, count=null }) {
  return (
    <div style={{
      padding:"4px 10px",
      borderRadius:2,
      border:`1px solid ${active ? color : "#222"}`,
      background: active ? `${color}22` : "#0d0d0d",
      color: active ? color : "#333",
      fontFamily:"monospace",
      fontSize:13,
      letterSpacing:2,
      fontWeight:700,
      boxShadow: active ? `0 0 8px ${color}44, inset 0 0 8px ${color}11` : "none",
      transition:"all 0.15s",
    }}>
      {active && <span style={{marginRight:4, animation: warn?"blink 0.5s step-end infinite":"none"}}>●</span>}
      {label}
      {count != null && count > 0 && (
        <span style={{ marginLeft:6, fontSize:11, fontWeight:400, color: active ? color : "#555" }}>
          {count}
        </span>
      )}
    </div>
  );
}

function Gauge({ label, value, min=0, max=100, unit="", thresholds=[] }) {
  const hasValue = value !== null && value !== undefined && Number.isFinite(value);
  const pct = hasValue ? Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100)) : 0;
  const color = hasValue
    ? thresholds.reduce((c, t) => value >= t.above ? t.color : c, "#00ff88")
    : "#333";
  return (
    <div className="gauge" style={{ display:"flex", flexDirection:"column", gap:3 }}>
      <div className="gauge-header" style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
        <span style={{ fontSize:11, color:"#666", fontFamily:"monospace", letterSpacing:2 }}>{label}</span>
        <span style={{ fontSize:13, color, fontFamily:"monospace" }}>
          {hasValue ? `${value.toFixed(1)}${unit}` : "—"}
        </span>
      </div>
      <div className="gauge-bar" style={{ height:4, background:"#111", borderRadius:2, border:"1px solid #1a1a1a" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:2, boxShadow:`0 0 6px ${color}88`, transition:"width 0.1s" }} />
      </div>
    </div>
  );
}

// Real bit-integrity map: renders the 80 bits of the most recently decoded
// LTC frame. Bits 64-79 are the fixed sync word
// — they're rendered in a distinct colour. Bits 0-63 are user/timecode data.
// When no frame has been decoded the cells are dim.
function BitStreamView({ bits, bitErrors, locked }) {
  const size = 80;
  return (
    <div>
      <div style={{ fontSize:11, color:"#555", fontFamily:"monospace", letterSpacing:2, marginBottom:6 }}>
        LAST FRAME · 80 BITS
      </div>
      <div className="bit-grid" style={{ display:"grid", gridTemplateColumns:"repeat(20, 1fr)", gap:2 }}>
        {Array.from({ length: size }, (_, i) => {
          const isSync = i >= 64;
          const bit = bits ? bits[i] : null;
          const cellBg = bit == null
            ? "#0c0c0c"
            : isSync
              ? (bit ? "#22d3ee" : "#22d3ee33")
              : (bit ? "#00ff88" : "#00ff8822");
          const isDfFlag = i === 10;
          return (
            <div key={i} title={`bit ${i}${isSync ? " (sync)" : ""}${isDfFlag ? " (DF flag)" : ""}: ${bit ?? "—"}`} style={{
              width:"100%", aspectRatio:"1", background:cellBg,
              border:`1px solid ${bit == null ? "#1a1a1a" : isSync ? "#22d3ee55" : "#00ff8833"}`,
              borderRadius:1,
              display:"flex", alignItems:"center", justifyContent:"center",
              fontFamily:"monospace", fontSize:9, fontWeight:"bold",
              color: isDfFlag ? (bit ? "#000" : "#ffaa00") : "transparent",
              lineHeight:1,
            }}>{isDfFlag ? "D" : ""}</div>
          );
        })}
      </div>
      <div style={{ marginTop:8, display:"flex", justifyContent:"space-between", fontSize:11, color:"#444", fontFamily:"monospace" }}>
        <span>
          <span style={{ color:"#00ff88" }}>■</span> data bits ·{" "}
          <span style={{ color:"#22d3ee" }}>■</span> sync word
        </span>
        <span>
          {locked ? `${bitErrors} cumulative bit error${bitErrors === 1 ? "" : "s"}` : "no frame decoded yet"}
        </span>
      </div>
    </div>
  );
}

// Shows just the currently detected rate as a single bar with its confidence
// fill. Previously rendered one bar per candidate rate, but the unselected
// bars carried no information once the winner was determined.
function RateDetector({ rateKey, candidateStatus, confidence }) {
  // Confidence for the active rate. In live mode derive from the winning
  // candidate's frame count (60 frames ≈ 2 s of clean LTC → full). In sim
  // mode the supplied `confidence` is the source of truth.
  let pct = confidence;
  if (candidateStatus && rateKey) {
    const fps = rateKeyToNominalFps(rateKey);
    const s = candidateStatus.find(c => c.fps === fps);
    if (s) pct = Math.min(100, (s.framesDecoded ?? 0) * (100 / 60));
  }
  const label = rateKey ? (SMPTE_RATES[rateKey]?.label ?? rateKey) : "—";
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      <div style={{ fontSize:11, color:"#555", fontFamily:"monospace", letterSpacing:2, marginBottom:2 }}>DETECTED RATE</div>
      <div style={{ display:"flex", alignItems:"center", gap:8, lineHeight:1.4 }}>
        <span style={{ fontSize:13, fontFamily:"monospace", color:"#00ff88", width:80, lineHeight:1.4 }}>
          {label}
        </span>
        <div style={{ flex:1, height:4, background:"#111", borderRadius:2 }}>
          <div style={{
            height:"100%", borderRadius:2,
            width:`${pct}%`,
            background:"#00ff88",
            boxShadow:"0 0 6px #00ff8866",
            transition:"width 0.3s",
          }} />
        </div>
        <span style={{ fontSize:10, color:"#00ff88", fontFamily:"monospace" }}>●</span>
      </div>
    </div>
  );
}

function SpecRefPanel() {
  const para = { color:"#555", textAlign:"left", maxWidth:720, margin:"0 auto" };
  return (
    <div style={{
      border:"1px solid #1a1a1a",
      borderRadius:3,
      padding:14,
      background:"#080808",
      fontSize:12,
      fontFamily:"monospace",
      color:"#666",
      lineHeight:1.6,
    }}>
      <div style={{ color:"#ff9900", letterSpacing:2, fontSize:13, marginBottom:8 }}>ANALYZER REFERENCE</div>
      <div>LTC analyzer — see ST 12-1 for the underlying standard</div>
      <div style={{ marginTop:6, color:"#333" }}>ANALYZER LEVEL THRESHOLDS (digital):</div>
      <div>Nominal ........... {LEVEL_SPEC.NOMINAL} dBFS</div>
      <div>Hot (error risk) .. {LEVEL_SPEC.HOT_THRESHOLD} dBFS</div>
      <div>Clip threshold .... {LEVEL_SPEC.CLIP_THRESHOLD} dBFS</div>
      <div>Min readable ...... {LEVEL_SPEC.LOW_THRESHOLD} dBFS</div>
      <div>Dropout ........... {LEVEL_SPEC.SILENT_THRESHOLD} dBFS</div>
      <div style={{ marginTop:6, color:"#333" }}>LTC FRAME (summary):</div>
      <div>80 bits/frame, biphase mark</div>
      <div>16-bit sync word at end of frame</div>
      <div>Drop frame: skip 2 frames each minute</div>
      <div>except every 10th minute</div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>SNR (dB)</div>
      <div style={para}>
        Band-limited signal-to-noise ratio: total power in the LTC fundamentals
        band [0.4–1.6 × bitRate], divided by the noise-floor power projected
        across that same band width. The noise floor is sampled at biphase
        mark's spectral nulls — frequencies exactly halfway between
        consecutive LTC harmonics — where the signal has no energy by
        construction. Computed only when locked; "—" otherwise. Display is
        EMA-smoothed (alpha 0.025, ~0.5 Hz effective bandwidth, ~2 s settle)
        to reduce per-tick jitter.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        clean source 20–30 dB,
        moderately noisy 10–20 dB,
        decoder at risk &lt; 10 dB.
        <br/><span style={{color:"#777"}}>Gauge thresholds:</span>{" "}
        ≥15 green, 10–15 orange, &lt;10 red.
        <br/>(Lower than classical audio SNR conventions because LTC's
        Blackman-window spectral leakage limits the measurable floor; numbers
        below ~30 dB are normal even for digitally pure sources.)
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>THD (%)</div>
      <div style={para}>
        Total Harmonic Distortion — √(ΣP<sub>h</sub>) / √(P<sub>1</sub>) × 100
        for the 3rd / 5th / 7th odd harmonics of the bit-rate-half fundamental.
        Because LTC is a near-square wave it has strong odd harmonics by
        design, so a clean signal is NOT 0% — it's ≈38%. Rising above that
        baseline indicates added distortion (saturation, clipping,
        anti-aliasing). Computed only when locked.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        ideal square wave 38%,
        clean LTC 35–45%,
        moderate saturation 50–65%,
        heavy distortion &gt; 70%.
        <br/><span style={{color:"#777"}}>Gauge thresholds:</span>{" "}
        ≤50% green, 50–70% orange, &gt;70% red.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>SAMPLE RATE</div>
      <div style={para}>
        <span style={{color:"#777"}}>Live input —</span>{" "}
        <span style={{color:"#777"}}>measured</span> is the true sample-
        delivery rate counted from the capture worklet over wall-clock time
        (ground truth, what's actually arriving at the decoder).{" "}
        <span style={{color:"#777"}}>nominal</span> is the device's declared
        rate from browser getSettings().sampleRate; only shown when it
        disagrees with measured (the OS is resampling the input), in which
        case the readout is flagged{" "}
        <span style={{color:"#ffaa00"}}>RESAMPLED</span>.
        <br/><span style={{color:"#777"}}>File input —</span>{" "}
        shown as <span style={{color:"#777"}}>file · decoded</span>:{" "}
        the file's native rate read from the WAV header (or "—" for
        formats without one), then the rate at which the AudioContext
        decoded it. For non-WAV files only the decoded rate is shown
        because decodeAudioData resamples without exposing the source rate.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>CARRIER CLASSIFICATION</div>
      <div style={para}>
        Decides whether the source's true carrier rate is the integer SMPTE
        rate (e.g. 30 fps) or its 1.001-divided NTSC sibling (29.97 fps).
        Measurement-grade, wall-clock-referenced: the worklet stamps
        performance.now() at each audio-chunk boundary, the decoder
        interpolates per-frame arrival times across the chunk, and a
        least-squares fit of frame-index vs wall-clock-time over a 20 s
        stable window produces the rate estimate. Immune to the ±tens-of-
        ppm ADC sample-clock bias that contaminates sample-count-based
        timing.
        <br/><span style={{color:"#777"}}>Commit rule:</span>{" "}
        the estimate must sit ≥5σ off the integer/fractional midpoint
        AND produce 3 consecutive same-side measurement updates ≥1 s
        apart. Until committed, the rate label reads MEASURING; the AUDIT
        panel shows the agreements counter.
        <br/><span style={{color:"#777"}}>Divergence rule:</span>{" "}
        once committed, a 3 s short window watches for source rate
        changes. To drop the commit it must report the opposite side at
        ≥5σ on 3 consecutive measurements ≥1 s apart (same hysteresis as
        commit). Single-shot noise excursions on borderline sources do
        not flip the commit; a genuine rate change is confirmed in
        ~3–5 s.
        <br/><span style={{color:"#777"}}>Hold:</span>{" "}
        on signal loss (&gt;500 ms without a fresh frame) the committed
        classification is held for 5 s, then dropped back to MEASURING.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>CLOCK DRIFT (ppm)</div>
      <div style={para}>
        Deviation of the source clock from the host machine's quartz,
        expressed in parts per million. Derived from the same wall-clock
        LSQ that drives carrier classification; EMA-smoothed for steadiness.
        It is a steady FREQUENCY OFFSET — it does NOT affect chasing /
        resolving, which slave to whatever rate arrives and absorb a
        constant offset of even a few hundred ppm. Chase-ability is
        governed by DROPOUT RATE and CONTINUITY, not drift. The host
        quartz is itself undisciplined (typically ±50 ppm absolute on
        consumer hardware), so this is drift relative to your laptop's
        crystal, not absolute. For an absolute number you'd discipline
        against an external reference.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        digital / genlocked source ≈ 0 ppm,
        free-running generator ±50–150 ppm (normal, chaseable).
        <br/><span style={{color:"#777"}}>Status thresholds:</span>{" "}
        &lt;5 ppm LOCKED green, 5–500 OK TO CHASE cyan,
        &gt;500 CHECK RATE amber (large enough to imply a mis-detected rate).
        <br/>The AUDIT panel exposes a second drift readout — SOURCE → ADC,
        from sample-count timing — and their difference as CAPTURE CLOCK
        ERROR. See AUDIT below.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>DROPOUT RATE (%)</div>
      <div style={para}>
        Percentage of expected frames that weren't successfully decoded over a
        rolling 2-second window:
        100 × (1 − decoded_frames / (window_sec × detected_fps)).
        Distinguishes a clean signal from one with occasional or serious
        dropouts. EMA-smoothed.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        clean digital source &lt; 1% (every frame decoded),
        signal degraded 5–20%,
        signal severely degraded &gt; 50%,
        no signal in window = 100%.
        <br/><span style={{color:"#777"}}>Status thresholds:</span>{" "}
        &lt;1% CLEAN green, 1–10% OCCASIONAL orange, 10–50% FREQUENT amber,
        &gt;50% SEVERE red.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>CONTINUITY</div>
      <div style={para}>
        Consecutive in-order LTC frames must differ by exactly one frame
        (with drop-frame rules applied at minute boundaries).
        Anything else is a continuity break:
        <br/><span style={{color:"#777"}}>REPEAT</span> — same frame
        decoded twice (delta = 0). Typically from a freeze-frame in source
        playback.
        <br/><span style={{color:"#777"}}>JUMP</span> — TC advanced by more
        than one frame (delta &gt; 1). From edit splices, dropouts, or skips.
        <br/><span style={{color:"#777"}}>REWIND</span> — TC went backwards
        (delta &lt; 0). From player rewinds, freewheel resets, or non-
        monotonic generators.
        <br/>The LIVE INPUT STATUS readout (`CONTINUITY · 60s`) counts
        breaks over a rolling 60-second window — older breaks scroll off
        the live count but stay in the session log. Gaps of ≥500 ms
        between decoded frames reset continuity *tracking* without
        producing a spurious JUMP across the gap; gaps of ≥3 s additionally
        clear the underlying break counter on the resuming frame (a long
        signal stop is treated as the start of a new run). Each break is
        also broadcast over the API publisher as a `continuity` message.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>AUDIT PANEL</div>
      <div style={para}>
        Collapsed by default under the LIVE INPUT STATUS readouts. Exposes
        the raw measurement numbers behind the carrier classification, so
        an engineer can audit the analyzer's conclusions instead of taking
        them on faith.
        <br/><span style={{color:"#777"}}>MEASURED FPS</span> — the
        wall-clock LSQ slope, in frames per second, with its 1σ uncertainty
        expressed in ppm of the nominal rate. The σ is floored by
        performance.now() quantization to prevent over-confidence when
        residuals happen to be tiny.
        <br/><span style={{color:"#777"}}>WINDOW</span> — number of frames
        and elapsed wall-clock span feeding the stable LSQ. Fills to the
        20 s target as code rolls.
        <br/><span style={{color:"#777"}}>CLASS</span> — the committed
        classification (fractional / integer) and its confidence, or
        MEASURING with the agreement counter (k/3) while accumulating
        toward commit.
        <br/><span style={{color:"#777"}}>SOURCE → HOST QUARTZ</span> —
        the primary CLOCK DRIFT reading. Same value displayed above; shown
        again here for context next to the other drifts. Positive = source
        faster than this host's crystal.
        <br/><span style={{color:"#777"}}>SOURCE → ADC</span> — drift
        derived from the capture device's sample count instead of host
        time. Compares the source against whatever clock drives the audio
        interface's ADC.
        <br/><span style={{color:"#777"}}>CAPTURE CLOCK ERROR</span> —
        host − ADC drift with the LTC source as the common reference. If
        this exceeds ±100 ppm the row turns amber: a healthy capture chain
        should agree within a few tens of ppm, so a large value suggests
        a faulty interface, an in-line sample rate converter, or a
        mislabelled file rate.
        <br/><span style={{color:"#777"}}>perf.now() RES</span> —
        measured quantization of performance.now() on this browser /
        cross-origin-isolation context. Bounds the floor on σ for the
        carrier classifier; 100 µs is typical, 1 ms means the browser is
        coarse-clamping clocks for Spectre mitigation.
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function SMPTEAnalyzer() {
  const [rateKey, setRateKey] = useState("29.97df");
  const [levelDbFS, setLevelDbFS] = useState(-18);
  const [noiseLevel, setNoiseLevel] = useState(0.02);
  const [dropoutProb, setDropoutProb] = useState(0.002);
  const [analysis, setAnalysis] = useState(null);
  const [useRealAudio, setUseRealAudio] = useState(false);
  // True from mount until either live audio is up OR the user has explicitly
  // chosen simulation. Suppresses the simulator output during the ~1 s window
  // while getUserMedia / AudioContext / Worklet are spinning up, so the user
  // never sees a flash of wall-clock-derived simulated timecode on refresh.
  const [bootstrapping, setBootstrapping] = useState(true);
  const [audioError, setAudioError] = useState(null);
  const [peakHold, setPeakHold] = useState(-60);
  const [frameCount, setFrameCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [errorCounts, setErrorCounts] = useState({ CLIP:0, HOT:0, LOW:0, DROPOUT:0, NOISE:0, DF_INVALID:0, AUDIO_GAP:0 });
  const [sessionLog, setSessionLog] = useState([]);
  const audioCtxRef = useRef(null);
  // Offset (in ms) added to audio-clock-domain chunk stamps from the worklet
  // to translate them into main-thread performance.now() domain. Computed
  // once per wired source via AudioContext.getOutputTimestamp(); see
  // wireSourceToDecoder. Null until the first samples message.
  const audioClockOffsetMsRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafRef = useRef(null);
  const peakDecayRef = useRef(-60);
  // Wall-clock time the current peak-hold value was latched. Re-latched only
  // by a strictly higher peak; recurring peaks at the same level do not
  // restart the hold — otherwise LTC's stable per-edge transients would
  // pin the marker forever.
  const peakHoldUntilRef = useRef(0);
  const lastErrSigRef = useRef("");
  // Tick count of the currently-active error signature; rolled into the most
  // recent session log entry's `count` field on transition (and periodically
  // while sustained) so a repeating error isn't logged 60× — just once with
  // an accurate tick count.
  const currentSigTicksRef = useRef(0);
  const currentSigFlushTickRef = useRef(0);
  const lastBreakTRef = useRef(0);
  // Edge-trigger ref for carrier-measurement events (MEASURING_COMMIT,
  // RATE_CHANGE, DIVERGENCE). Watches lastCarrierEvent.t for change so we
  // log each transition exactly once.
  const lastCarrierEventTRef = useRef(0);
  // Carrier-snapshot heartbeat: emits a CARRIER_SNAPSHOT log entry every 30 s
  // with the current measurement + drift numbers, so post-show analysis has
  // a continuous audit trail even when nothing surface-level was wrong.
  const lastSnapshotTRef = useRef(0);
  // Most recently logged detected rate key, so we only push a log entry on
  // transitions (e.g. 29.97df → 30 carrier flip) rather than every tick.
  const lastLoggedRateRef = useRef(null);
  // Debounce for RATE_CHANGE logging. A candidate rate must persist for
  // PENDING_MS before it gets logged; if it flips back to the committed rate
  // before then, no entry is written. Hysteresis in the carrier classifier
  // (ltcDecoder.js carrierObservation) handles the underlying wobble; this is
  // the second layer that keeps the session log readable when a transition
  // does happen and briefly flickers.
  const pendingRateRef = useRef({ rate: null, since: 0 });
  // Tracks ltcLocked across ticks so we can log one entry per lock acquisition
  // (false → true transition). Records the starting timecode for the run.
  const lastLockedRef = useRef(false);
  // Pending lock-acquisition entry: captured at the false→true transition,
  // emitted only after the lock has been sustained for 5 s. Avoids logging
  // momentary syncs on noisy/garbage signals.
  const pendingLockRef = useRef(null);
  // Most recent worklet underrun: { t, gapMs, count } updated whenever the
  // audio thread reports a process()-call gap beyond ~2.5× the quantum.
  // Distinct from "no LTC signal" — the audio path itself was starved.
  const workletGlitchRef = useRef(null);
  // Rolling 60 s window of recent continuity breaks (performance.now() timestamps).
  // The decoder's `continuityBreaks` is a lifetime counter; for a long session
  // (e.g. continuous playback across many songs, each cut producing a JUMP)
  // the lifetime count is uninformative. The CONTINUITY readout uses this
  // rolling count instead; the full history is still in the session log.
  const recentBreakTimesRef = useRef([]);
  const sessionStartRef = useRef(Date.now());
  const publisherRef = useRef(null);
  const tickRef = useRef(null);
  const decoderRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sampleRateRef = useRef(48000);
  // Measured sample rate: the worklet forwards every sample, so counting them
  // against wall-clock time gives the *actual* delivery rate of the input —
  // which can differ from the AudioContext's nominal rate when the device or
  // OS is resampling (e.g. across a Dante clock domain). `marks` is a rolling
  // ~4 s window of {t, n} (wall-clock ms, cumulative samples).
  const sampleClockRef = useRef({ n: 0, marks: [] });
  const measuredRateEmaRef = useRef(null);
  // Last detected carrier rate / cadence in live mode. Held across signal
  // dropouts so the displayed label doesn't collapse to "DETECTING…" the
  // moment code stops. Reset on mode switch or source teardown.
  const lastSeenCarrierRef = useRef(null);
  const lastSeenCadenceRef = useRef(null);
  const [auditExpanded, setAuditExpanded] = useState(false);
  const [measuredSampleRate, setMeasuredSampleRate] = useState(null);
  // The current device's reported native rate (track.getSettings().sampleRate).
  // Unlike the reused AudioContext's fixed rate, this updates per input.
  const [deviceSampleRate, setDeviceSampleRate] = useState(null);
  const timeBufRef = useRef(null);
  // EMA state for the displayed SNR / THD / noise-floor gauges. The raw FFT
  // measurement is left untouched so the underlying math stays honest; only
  // the gauge readouts are smoothed to keep them legible.
  const smoothedMetricsRef = useRef({ snr: null, thd: null, noiseFloor: null, driftPpm: null, dropoutPct: null });

  const [apiUrl, setApiUrl] = useState("ws://localhost:8765/ingest");
  const [apiEnabled, setApiEnabled] = useState(false);
  const [apiState, setApiState] = useState("idle");
  const [apiSubscribers, setApiSubscribers] = useState(0);
  const [audioDevices, setAudioDevices] = useState([]);
  const [currentDeviceId, setCurrentDeviceId] = useState(null);
  const [currentDeviceLabel, setCurrentDeviceLabel] = useState("");
  // How many channels the current input exposes, and which one we tap for LTC.
  // selectedChannelRef mirrors the state so wireSourceToDecoder (called from
  // async paths) reads the latest value without a stale closure.
  const [inputChannelCount, setInputChannelCount] = useState(1);
  const [selectedChannel, setSelectedChannel] = useState(LTC_CHANNEL);
  const selectedChannelRef = useRef(LTC_CHANNEL);
  const splitterRef = useRef(null);
  const streamRef = useRef(null);
  const bufferSourceRef = useRef(null);
  // Software-paced sample feeder for AudioBufferSource inputs (file / synth).
  // See startPacedDecoderFeed() for the why.
  const pacedFeederRef = useRef(null);
  // Decoded AudioBuffer + sample-rate for the current file/synth, kept so we
  // can re-extract a different channel and restart the paced feeder when the
  // user switches input channels mid-playback.
  const loadedBufferRef = useRef(null);
  const [playingFile, setPlayingFile] = useState(null); // { name, durationSec, loop }
  const [fileLoading, setFileLoading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);
  // LTC synthesizer state. Carrier rate and counting cadence are independent
  // knobs so the user can generate out-of-spec material (e.g. "30 DF") that
  // exercises the carrier/cadence split.
  const [synthCarrierKey, setSynthCarrierKey] = useState("30");
  const [synthCadenceKey, setSynthCadenceKey] = useState("30df");
  // DF flag bit (frame bit 10) override. "auto" = match the cadence's DF
  // behaviour (spec-conformant). "on"/"off" force the flag independent of the
  // count, so dfFlagMatchesObservedCadence() can be exercised.
  const [synthDfFlagKey, setSynthDfFlagKey] = useState("auto");
  const [synthing, setSynthing] = useState(false);

  const LOG_CAP = 1000;
  // Session-log entries fall into two classes by their leading tag:
  //   info  — operational events that aren't problems (lock acquired, rate
  //           detected). Rendered green.
  //   error — actual problems (level, decode, continuity). Rendered red.
  // Continuity breaks use `TC_<TYPE>` so we match by prefix as well.
  const INFO_TAGS = new Set(["LOCK_ACQUIRED", "MEASURING_COMMIT", "CARRIER_SNAPSHOT"]);
  function logEntryClass(e) {
    const lead = e.errors?.[0];
    if (lead && INFO_TAGS.has(lead)) return "info";
    return "error";
  }

  function pushLog(entry) {
    setSessionLog(prev => {
      const next = prev.length >= LOG_CAP ? prev.slice(prev.length - LOG_CAP + 1) : prev;
      return [...next, entry];
    });
  }
  // Update the most recent log entry's `count` (used to roll up repeated
  // ticks of the same error signature without flooding the log).
  function updateLastLogCount(count) {
    setSessionLog(prev => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.count === count) return prev;
      const next = prev.slice(0, -1);
      next.push({ ...last, count });
      return next;
    });
  }

  const tick = useCallback(() => {
    // During the bootstrap window we don't yet know which mode to render —
    // skip the simulator so the user doesn't see a flash of wall-clock TC.
    if (bootstrapping) return;
    const srcLabel = playingFile ? "file" : useRealAudio ? "live" : "sim";
    let lvl = levelDbFS;
    let nz = noiseLevel;
    let dp = dropoutProb;
    let realPeakDb = null;

    if (analyserRef.current) {
      const size = analyserRef.current.fftSize;
      if (!timeBufRef.current || timeBufRef.current.length !== size) {
        timeBufRef.current = new Float32Array(size);
      }
      const buf = timeBufRef.current;
      analyserRef.current.getFloatTimeDomainData(buf);
      const rms = computeRMS(buf);
      const peak = computePeak(buf);
      lvl = linearToDB(rms);
      realPeakDb = linearToDB(peak);
      nz = Math.max(0, Math.min(1, (linearToDB(rms) - linearToDB(peak) + 30) / 30));
    }

    // Measured sample rate from the worklet's sample count over wall-clock
    // time. Needs ≥0.5 s of window to be meaningful; EMA-smoothed so the
    // readout doesn't jitter with per-chunk arrival timing.
    if (useRealAudio) {
      const sc = sampleClockRef.current;
      if (sc.marks.length >= 2) {
        const first = sc.marks[0];
        const last = sc.marks[sc.marks.length - 1];
        const dt = (last.t - first.t) / 1000;
        if (dt >= 0.5) {
          const inst = (last.n - first.n) / dt;
          const ema = measuredRateEmaRef.current;
          measuredRateEmaRef.current = ema == null ? inst : ema + 0.05 * (inst - ema);
          setMeasuredSampleRate(Math.round(measuredRateEmaRef.current));
        }
      }
    } else {
      measuredRateEmaRef.current = null;
      setMeasuredSampleRate(null);
    }

    const effectiveRate = useRealAudio
      ? (decoderRef.current?.detectedRateKey() ?? rateKey)
      : rateKey;
    // Sim path generates randomised tc/level/noise fields; live path overwrites
    // those with real measurements, so calling the sim generator in live mode
    // pollutes peakDbFS/etc. with random values that get overwritten on the
    // next line. Build the minimal live skeleton directly when useRealAudio.
    const data = useRealAudio
      ? { rateKey: effectiveRate, dropFrame: false, colorFrame: false, errors: [] }
      : generateSimulatedAnalysis(effectiveRate, lvl, nz, dp);
    if (useRealAudio) {
      // Live audio path: only show timecode the biphase decoder actually
      // produced from the incoming signal. If the last decoded frame is
      // older than ~200 ms (≈6 frames @ 30fps) treat the signal as lost.
      const dec = decoderRef.current;
      const lf = dec?.lastFrame;
      const fresh = lf && (performance.now() - lf.t) < 200;

      // Real SNR + noise floor estimate: only meaningful when locked to LTC.
      // Compare spectral energy in the LTC band (around the bit-rate
      // fundamentals) to energy outside it. With no signal locked, neither
      // metric is defined — leave them null so the gauges show "—".
      if (fresh && analyserRef.current && dec?.nominalFps) {
        // Use the detected actual fps (fractional for NTSC carriers) so the
        // biphase spectral-null bins land on true nulls — at integer fps the
        // 0.1% offset on 29.97/23.976/59.94 carriers slides the null sample
        // point slightly toward an adjacent harmonic, biasing the noise floor.
        const obs = dec.carrierObservation();
        const actualFps = obs?.fractional ? obs.nominalFps / 1.001 : obs?.nominalFps ?? dec.nominalFps;
        const m = computeLtcSpectralMetrics(analyserRef.current, sampleRateRef.current, actualFps);
        // Smooth the displayed gauges with a low-pass EMA so they don't
        // jitter ~30Hz with each tick. alpha = 0.025 → ~0.5 Hz effective
        // bandwidth; settles in roughly two seconds, very steady to read.
        const alpha = 0.025;
        const sm = smoothedMetricsRef.current;
        const smooth = (prev, next) =>
          next == null || !Number.isFinite(next)
            ? prev
            : prev == null
              ? next
              : prev + alpha * (next - prev);
        sm.snr = smooth(sm.snr, m?.snr ?? null);
        sm.thd = smooth(sm.thd, Number.isFinite(m?.thd) ? m.thd : null);
        sm.noiseFloor = smooth(sm.noiseFloor, m?.noiseFloor ?? null);
        sm.driftPpm = smooth(sm.driftPpm, dec?.driftPpm() ?? null);
        sm.dropoutPct = smooth(sm.dropoutPct, dec?.dropoutPct() ?? null);
        data.snr = sm.snr;
        data.noiseFloor = sm.noiseFloor;
        data.thd = sm.thd;
        data.driftPpm = sm.driftPpm;
        data.dropoutPct = sm.dropoutPct;
      } else {
        data.snr = null;
        data.thd = null;
        data.noiseFloor = null;
        data.driftPpm = null;
        data.dropoutPct = null;
        smoothedMetricsRef.current = { snr: null, thd: null, noiseFloor: null, driftPpm: null, dropoutPct: null };
      }
      // Real peak from the time-domain buffer (overrides the sim's jittered fake).
      data.peakDbFS = realPeakDb;
      data.levelDbFS = lvl;
      if (lf) {
        // Hold the last decoded timecode even after the signal stops, so the
        // operator can see what frame the code died on. frameValid only goes
        // true when the frame is fresh — TimecodeDisplay renders the held
        // value in red once valid flips off.
        data.hh = lf.hh; data.mm = lf.mm; data.ss = lf.ss; data.ff = lf.ff;
        data.dropFrame = lf.dropFrame;
        data.colorFrame = lf.colorFrame;
        data.bgf = [lf.bgf0, lf.bgf1, lf.bgf2];
        data.userBits = lf.userBits ?? null;
        data.frameValid = fresh;
      } else {
        data.hh = 0; data.mm = 0; data.ss = 0; data.ff = 0;
        data.dropFrame = false;
        data.colorFrame = false;
        data.bgf = null;
        data.userBits = null;
        data.frameValid = false;
      }
      data.ltcLocked = !!fresh;
      data.detectedRateKey = dec?.detectedRateKey() ?? null;
      data.detectedFps = dec?.nominalFps ?? null;
      // Carrier rate (timing-only) and counting cadence (FF-sequence-only)
      // are observed independently — see ltcDecoder.js / cadenceDetector.js.
      data.carrierRate = dec?.carrierRate() ?? null;
      data.cadence = dec?.cadence() ?? null;
      data.carrierCadenceMismatch = dec?.carrierCadenceMismatch() ?? null;
      // Rich carrier observation for the AUDIT panel: measured fps with σ,
      // window n / spanSec, commit confidence, clock-resolution probe.
      // See ltcDecoder.js carrierObservation().
      data.carrierObs = dec?.carrierObservation() ?? null;
      // State-machine events (MEASURING_COMMIT / RATE_CHANGE / DIVERGENCE),
      // surfaced for session-log writing. Same pattern as lastBreak.
      data.lastCarrierEvent = dec?.lastCarrierEvent ?? null;
      // Dual drift readouts: source-vs-host-quartz is the primary, source-vs-
      // ADC plus the derived capture-clock error are for the audit panel.
      data.driftPpmSourceVsAdc = dec?.driftPpmSourceVsAdc() ?? null;
      data.captureClockErrorPpm = dec?.captureClockErrorPpm() ?? null;
      // Field-mark bit toggle pattern at 50/60. TOGGLING ⇒ frame-pair LTC;
      // STATIC ⇒ de-facto wide LTC. Null
      // outside 50/60 or while still gathering samples. See #34, #37.
      data.fieldMarkBehavior = dec?.fieldMarkBehavior?.() ?? null;
      data.framesDecoded = dec?.framesDecoded ?? 0;
      data.bitErrors = dec?.bitErrors ?? 0;
      data.lastFrameBits = dec?.lastFrameBits ?? null;
      data.candidateStatus = dec?.candidateStatus() ?? null;
      data.lastBreak = dec?.lastBreak ?? null;
      data.rateKey = effectiveRate;

      // Re-derive the error tag list from real measurements only. The sim's
      // errors[] mixed in randomness (DROPOUT roll) and slider-default state
      // (NOISE = crest-factor proxy), neither of which is a real condition.
      // We deliberately don't include a NOISE tag here: the decoder's own
      // bit-error counter (BIT ERRORS in the FRAME INTEGRITY panel) and the
      // SNR gauge already report signal-quality information without a
      // misleading boolean.
      const live = [];
      if (lvl > LEVEL_SPEC.CLIP_THRESHOLD) live.push("CLIP");
      else if (lvl > LEVEL_SPEC.HOT_THRESHOLD) live.push("HOT");
      // LOW / DROPOUT only mean something for an LTC signal that's degrading.
      // Without a recent decoded frame the input is either silence (idle
      // device) or non-LTC audio (music, speech, room tone) — neither case
      // benefits from level tagging, and music below LOW_THRESHOLD would
      // otherwise flood the log with spurious LOW entries. Gate both tags on
      // a frame decoded within the last 2 s.
      const lastDecodeAge = dec?.lastFrame ? performance.now() - dec.lastFrame.t : Infinity;
      const hasRecentFrame = lastDecodeAge < 2000;
      if (lvl < LEVEL_SPEC.LOW_THRESHOLD && hasRecentFrame) live.push("LOW");
      if (lvl < LEVEL_SPEC.SILENT_THRESHOLD && hasRecentFrame) live.push("DROPOUT");
      // DF conformance: a frame asserting DF that lands on FF<dropPerMin at
      // a non-tenth-minute boundary is the spec violation captured by
      // isValidDropFrame. Only meaningful once cadence is known (so we can
      // pick the right dropPerMin), and only when looking at a fresh frame.
      const cadenceFps = data.cadence?.fps;
      if (fresh && lf?.dropFrame && cadenceFps
          && !isValidDropFrame(lf.hh, lf.mm, lf.ss, lf.ff, cadenceFps)) {
        live.push("DF_INVALID");
      }
      // Surface a recent worklet underrun for 2 s so an intermittent audio
      // starvation event is visible without permanently latching.
      const g = workletGlitchRef.current;
      if (g && performance.now() - g.t < 2000) live.push("AUDIO_GAP");
      data.workletGlitches = g?.count ?? 0;
      data.errors = live;
      data.frameValid = fresh && live.length === 0;
    }
    setAnalysis(data);
    setFrameCount(c => c + 1);
    if (data.errors.length > 0) {
      setErrorCount(c => c + 1);
      setErrorCounts(prev => {
        const next = { ...prev };
        for (const e of data.errors) if (e in next) next[e] = next[e] + 1;
        return next;
      });
    }

    const sig = data.errors.join(",");
    const tcStr = tcString(data);
    if (sig && sig !== lastErrSigRef.current) {
      // Finalize tick count for the previous sustained event AND push the new
      // one in a single state update — splitting into two setSessionLog calls
      // caused a second render per error rollover.
      const finalCount = currentSigTicksRef.current;
      const entry = {
        t: Date.now(),
        tc: tcStr,
        rate: rateKey,
        errors: [...data.errors],
        levelDbFS: +lvl.toFixed(2),
        snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
        source: srcLabel,
        count: 1,
      };
      setSessionLog(prev => {
        let next = prev;
        if (finalCount > 0 && next.length > 0) {
          const last = next[next.length - 1];
          if (last.count !== finalCount) {
            next = [...next.slice(0, -1), { ...last, count: finalCount }];
          }
        }
        if (next.length >= LOG_CAP) next = next.slice(next.length - LOG_CAP + 1);
        return [...next, entry];
      });
      currentSigTicksRef.current = 1;
      currentSigFlushTickRef.current = 1;
    } else if (sig && sig === lastErrSigRef.current) {
      currentSigTicksRef.current += 1;
      // Flush the live count into the log entry roughly once per second
      // (~30 ticks) so the visible row updates while a long error persists,
      // without doing a state write every tick.
      if (currentSigTicksRef.current - currentSigFlushTickRef.current >= 30) {
        updateLastLogCount(currentSigTicksRef.current);
        currentSigFlushTickRef.current = currentSigTicksRef.current;
      }
    } else if (!sig && currentSigTicksRef.current > 0) {
      // Error cleared — flush final count.
      updateLastLogCount(currentSigTicksRef.current);
      currentSigTicksRef.current = 0;
      currentSigFlushTickRef.current = 0;
    }
    if (sig !== lastErrSigRef.current && publisherRef.current && sig) {
      publisherRef.current.send({
        type: "error", t: Date.now(), tc: tcStr,
        rate: rateKey, errors: [...data.errors],
      });
    }
    lastErrSigRef.current = sig;

    // Log lock acquisition (live mode only) so the session log records the
    // starting timecode of each run. The entry is captured at the false→true
    // transition but only emitted after 5 s of sustained lock, so a brief
    // sync on noise/garbage doesn't pollute the log.
    if (useRealAudio) {
      const nowLocked = !!data.ltcLocked;
      if (nowLocked && !lastLockedRef.current) {
        pendingLockRef.current = {
          startT: Date.now(),
          tc: tcStr,
          rate: data.detectedRateKey ?? "—",
          levelDbFS: +lvl.toFixed(2),
          snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
        };
      } else if (!nowLocked && pendingLockRef.current) {
        pendingLockRef.current = null;
      }
      const pl = pendingLockRef.current;
      if (nowLocked && pl && Date.now() - pl.startT >= 5000) {
        pushLog({
          t: pl.startT,
          tc: pl.tc,
          rate: pl.rate,
          errors: ["LOCK_ACQUIRED"],
          levelDbFS: pl.levelDbFS,
          snr: pl.snr,
          source: srcLabel,
        });
        pendingLockRef.current = null;
      }
      lastLockedRef.current = nowLocked;
    }

    // Log detected-rate transitions (live mode only) so troubleshooting can
    // see when the carrier/cadence classification flips. First lock counts as
    // a transition from null → rateKey.
    if (useRealAudio) {
      const detRate = data.detectedRateKey ?? null;
      const committed = lastLoggedRateRef.current;
      const PENDING_MS = 1500;
      // First lock (no committed rate yet): log immediately so the user gets
      // an initial RATE_CHANGE entry from none → detected.
      if (committed === null && detRate !== null) {
        pushLog({
          t: Date.now(),
          tc: tcStr,
          rate: detRate,
          errors: ["RATE_CHANGE", `none→${detRate}`],
          levelDbFS: +lvl.toFixed(2),
          snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
          source: srcLabel,
        });
        lastLoggedRateRef.current = detRate;
        pendingRateRef.current = { rate: null, since: 0 };
      } else if (detRate !== committed) {
        const pr = pendingRateRef.current;
        if (pr.rate !== detRate) {
          pendingRateRef.current = { rate: detRate, since: Date.now() };
        } else if (pr.rate !== null && Date.now() - pr.since >= PENDING_MS) {
          pushLog({
            t: Date.now(),
            tc: tcStr,
            rate: detRate ?? "—",
            errors: ["RATE_CHANGE", `${committed ?? "none"}→${detRate ?? "none"}`],
            levelDbFS: +lvl.toFixed(2),
            snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
            source: srcLabel,
          });
          lastLoggedRateRef.current = detRate;
          pendingRateRef.current = { rate: null, since: 0 };
        }
      } else if (pendingRateRef.current.rate !== null) {
        // detRate snapped back to the committed value before the debounce
        // window elapsed — discard the pending change.
        pendingRateRef.current = { rate: null, since: 0 };
      }
    }

    // Carrier-measurement events. The decoder emits MEASURING_COMMIT (first
    // commit after acquire), RATE_CHANGE (carrier flipped between integer/
    // fractional after re-measurement), and DIVERGENCE (detector window
    // disagreed with stable, classification dropped to MEASURING). These are
    // edge-triggered on lastCarrierEvent.t. The pre-existing detectedRateKey
    // RATE_CHANGE handler above still logs basic rate flips for back-compat,
    // but the rich metadata (σ, n, spanSec) only lives on these entries.
    const ce = data.lastCarrierEvent;
    if (useRealAudio && ce && ce.t !== lastCarrierEventTRef.current) {
      lastCarrierEventTRef.current = ce.t;
      const fpsLabel = ce.fps != null
        ? (ce.fractional ? `${ce.fps}/1.001` : `${ce.fps}`)
        : "—";
      const baseEntry = {
        t: Date.now(),
        tc: tcStr,
        rate: data.detectedRateKey ?? fpsLabel,
        levelDbFS: +lvl.toFixed(2),
        snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
        source: srcLabel,
      };
      if (ce.type === "MEASURING_COMMIT" || ce.type === "RATE_CHANGE") {
        pushLog({
          ...baseEntry,
          errors: [ce.type, fpsLabel,
            `σ=${ce.sigmaFps != null ? (ce.sigmaFps * 1e6 / ce.fps).toFixed(1) + "ppm" : "—"}`,
            `n=${ce.windowFrames ?? "—"}`,
            `${ce.windowSeconds != null ? ce.windowSeconds.toFixed(1) + "s" : "—"}`,
          ],
        });
      } else if (ce.type === "DIVERGENCE") {
        pushLog({
          ...baseEntry,
          errors: ["DIVERGENCE",
            `committed=${ce.committedFractional ? "fractional" : "integer"}`,
            `detector=${ce.detectorFractional ? "fractional" : "integer"}`,
            `detector_fps=${ce.detectorFps?.toFixed(3) ?? "—"}`,
          ],
        });
      }
    }

    // CARRIER_SNAPSHOT heartbeat. Emits an audit-trail entry every 30 s of
    // wall-clock so post-show analysis has a continuous record of measured
    // fps, σ, drift, and dropout — independent of whether anything alerted.
    if (useRealAudio && data.carrierObs?.fractional != null) {
      const tNow = Date.now();
      if (tNow - lastSnapshotTRef.current >= 30000) {
        lastSnapshotTRef.current = tNow;
        const obs = data.carrierObs;
        pushLog({
          t: tNow,
          tc: tcStr,
          rate: data.detectedRateKey ?? "—",
          errors: ["CARRIER_SNAPSHOT",
            `fps=${obs.stable?.fps.toFixed(5) ?? "—"}`,
            `σ=${obs.stable?.sigmaFps != null ? (obs.stable.sigmaFps * 1e6 / obs.nominalFps).toFixed(2) + "ppm" : "—"}`,
            `n=${obs.stable?.n ?? "—"}`,
            `host=${Number.isFinite(data.driftPpm) ? data.driftPpm.toFixed(1) + "ppm" : "—"}`,
            `adc=${Number.isFinite(data.driftPpmSourceVsAdc) ? data.driftPpmSourceVsAdc.toFixed(1) + "ppm" : "—"}`,
            `drop=${Number.isFinite(data.dropoutPct) ? data.dropoutPct.toFixed(1) + "%" : "—"}`,
          ],
          levelDbFS: +lvl.toFixed(2),
          snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
          source: srcLabel,
        });
      }
    }

    // Log and publish continuity breaks as they happen.
    const lb = data.lastBreak;
    if (lb && lb.t !== lastBreakTRef.current) {
      lastBreakTRef.current = lb.t;
      recentBreakTimesRef.current.push(lb.t);
      pushLog({
        t: Date.now(),
        tc: lb.to,
        from: lb.from,
        rate: rateKey,
        errors: [`TC_${lb.type}`, `${lb.delta > 0 ? "+" : ""}${lb.delta}`],
        levelDbFS: +lvl.toFixed(2),
        snr: Number.isFinite(data.snr) ? +data.snr.toFixed(1) : null,
        source: srcLabel,
      });
      if (publisherRef.current) {
        publisherRef.current.send({
          type: "continuity", t: Date.now(),
          breakType: lb.type, delta: lb.delta,
          from: lb.from, to: lb.to, rate: rateKey,
        });
      }
    }

    if (publisherRef.current) {
      publisherRef.current.send({
        type: "tc", t: Date.now(),
        hh: data.hh, mm: data.mm, ss: data.ss, ff: data.ff,
        rate: rateKey, dropFrame: data.dropFrame,
        // Carrier rate and counting cadence are independent observations.
        // `rate` (above) is the combined SMPTE key kept for compat.
        carrierRate: data.carrierRate ?? null,
        cadenceFps: data.cadence?.fps ?? null,
        cadenceDropFrame: data.cadence?.dropFrame ?? null,
        carrierCadenceMismatch: data.carrierCadenceMismatch ?? null,
        fieldMarkBehavior: data.fieldMarkBehavior ?? null,
        bgf: data.bgf ?? null,
        // User bits as 8-char hex string in transmission order (UB1..UB8).
        // Null when no live frame. Semantic decoding (date/time, etc.) is a
        // downstream concern — wire the raw bits.
        userBits: data.userBits
          ? Array.from(data.userBits, n => n.toString(16).toUpperCase()).join("")
          : null,
        source: srcLabel,
        ltcLocked: useRealAudio ? !!data.ltcLocked : true,
        frameValid: data.frameValid !== false,
        levelDbFS: +lvl.toFixed(2),
        peakDbFS: Number.isFinite(data.peakDbFS) ? +data.peakDbFS.toFixed(2) : null,
        driftPpm:   Number.isFinite(data.driftPpm)   ? +data.driftPpm.toFixed(2)   : null,
        dropoutPct: Number.isFinite(data.dropoutPct) ? +data.dropoutPct.toFixed(2) : null,
        snr:        Number.isFinite(data.snr)        ? +data.snr.toFixed(1)        : null,
        errors: data.errors,
      });
    }

    // Peak-hold: latch on a strictly higher peak and hold for 10 s, then
    // decay toward current at ~20 dB/s. Recurring peaks at or below the
    // current hold do NOT reset the timer, so a stable signal whose edges
    // occasionally hit the hold value still lets the marker eventually
    // relax to the live level.
    const nowMs = performance.now();
    if (data.peakDbFS > peakDecayRef.current) {
      peakDecayRef.current = data.peakDbFS;
      peakHoldUntilRef.current = nowMs + 10000;
    } else if (nowMs >= peakHoldUntilRef.current) {
      peakDecayRef.current = Math.max(peakDecayRef.current - 0.67, data.peakDbFS);
    }
    setPeakHold(peakDecayRef.current);
  }, [rateKey, levelDbFS, noiseLevel, dropoutProb, useRealAudio, bootstrapping, playingFile]);

  useEffect(() => { tickRef.current = tick; }, [tick]);

  // Reset the displayed detection state every time we switch modes, so the
  // detected rate / lock confidence visibly clear and re-acquire instead of
  // appearing to carry over from the previous session.
  useEffect(() => {
    setAnalysis(null);
    setPeakHold(-60);
    peakDecayRef.current = -60;
    peakHoldUntilRef.current = 0;
    recentBreakTimesRef.current = [];
    lastBreakTRef.current = 0;
    lastSeenCarrierRef.current = null;
    lastSeenCadenceRef.current = null;
    lastLoggedRateRef.current = null;
    pendingRateRef.current = { rate: null, since: 0 };
    lastLockedRef.current = false;
    pendingLockRef.current = null;
  }, [useRealAudio]);

  // Attempt to start in live audio mode on first load. If the browser blocks
  // getUserMedia before a user gesture (or the user denies), we surface the
  // error and stay in simulation mode until they click the connect button.
  useEffect(() => {
    startAudioCapture();
    const onChange = () => refreshAudioDevices();
    navigator.mediaDevices?.addEventListener?.("devicechange", onChange);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Web Worker drives the tick so it keeps running at full rate when the
    // tab is backgrounded (setInterval/rAF get throttled to ~1 Hz there,
    // which would stutter any downstream API subscribers).
    const worker = new Worker(new URL("./tickWorker.js", import.meta.url), { type: "module" });
    worker.onmessage = () => tickRef.current?.();
    worker.postMessage({ type: "start", intervalMs: 33 });
    return () => { worker.postMessage({ type: "stop" }); worker.terminate(); };
  }, []);

  useEffect(() => {
    if (!apiEnabled) {
      if (publisherRef.current) { publisherRef.current.close(); publisherRef.current = null; }
      setApiState("idle");
      setApiSubscribers(0);
      return;
    }
    const p = new Publisher(apiUrl);
    publisherRef.current = p;
    p.on("state", s => setApiState(s));
    p.on("status", msg => setApiSubscribers(msg.subscribers ?? 0));
    p.connect();
    return () => { p.close(); publisherRef.current = null; };
  }, [apiEnabled, apiUrl]);

  async function refreshAudioDevices() {
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      setAudioDevices(list.filter(d => d.kind === "audioinput"));
    } catch { /* ignore */ }
  }

  // Lazily get-or-create the single AudioContext for the app's lifetime.
  // Reusing one context across device switches is critical on macOS: each
  // `new AudioContext()` is a fresh Core Audio negotiation that can pull the
  // system output along with it. Keep one context, swap the MediaStream.
  async function getOrCreateAudioContext() {
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
      if (audioCtxRef.current.state === "suspended") {
        try { await audioCtxRef.current.resume(); } catch { /* ignore */ }
      }
      return audioCtxRef.current;
    }
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule("/ltc-worklet.js");
    audioCtxRef.current = ctx;
    sampleRateRef.current = ctx.sampleRate;
    return ctx;
  }

  // Software-paced sample feeder for AudioBufferSource inputs.
  //
  // Why this exists: when an AudioBufferSourceNode plays into a headless graph
  // (no node connected to ctx.destination — which we deliberately avoid on
  // macOS to keep Core Audio from re-negotiating the system output device),
  // Chrome renders the graph in deferred bursts rather than at strict real-
  // time pacing. That means the worklet receives many chunks at once every
  // ~250–300 ms instead of one chunk every ~42 ms. Cumulative decode counters
  // still climb at the right average rate, but at any given UI tick the most
  // recent decoded frame is usually >200 ms old, so the freshness check
  // (App.jsx tick: `now - lastFrame.t < 200`) is false → ltcLocked false →
  // "NO LTC SIGNAL" banner on a perfectly clean file.
  //
  // The MediaStreamSource path (live mic) is not affected: the input device's
  // hardware clock drives the render thread at real time regardless of graph
  // topology, so its worklet chunks arrive at strict ~42 ms cadence.
  //
  // Fix: for buffer-source inputs (file / synth), bypass the worklet for the
  // decoder feed entirely. Schedule 2048-sample chunks with setTimeout at the
  // sample-rate-derived cadence, stamping wall-clock times from
  // performance.now(). The decoder receives a deterministic, real-time-paced
  // stream identical in shape to what the worklet would produce for live mic.
  // The audio graph (source → splitter → analyser) is still built for level/
  // spectral meters, where bursty delivery is harmless.
  function startPacedDecoderFeed({ samples, sampleRate, decoder, loop = true }) {
    stopPacedDecoderFeed();
    const CHUNK = 2048;
    const chunkMs = (CHUNK / sampleRate) * 1000;
    const total = samples.length;
    if (total === 0) return;
    const startWall = performance.now();
    let readPos = 0;
    let chunkIdx = 0;
    const state = { stopped: false, timeoutId: null };
    pacedFeederRef.current = state;

    const tick = () => {
      if (state.stopped) return;
      // Build a CHUNK-sized window, wrapping the source buffer if looping.
      let chunk;
      if (readPos + CHUNK <= total) {
        chunk = samples.subarray(readPos, readPos + CHUNK);
        readPos += CHUNK;
        if (readPos === total && loop) readPos = 0;
      } else if (loop) {
        const tail = total - readPos;
        chunk = new Float32Array(CHUNK);
        chunk.set(samples.subarray(readPos, total), 0);
        const head = CHUNK - tail;
        chunk.set(samples.subarray(0, head), tail);
        readPos = head;
      } else {
        stopPacedDecoderFeed();
        return;
      }
      // Stamp the chunk with its scheduled-arrival wall-clock span. Using the
      // schedule (not performance.now() at tick time) keeps frame timestamps
      // smooth even if setTimeout jitters by a few ms — the LSQ classifier
      // sees ideal sample-rate-derived timing rather than scheduler noise.
      const chunkStartWall = startWall + chunkIdx * chunkMs;
      const chunkEndWall = chunkStartWall + chunkMs;
      decoder.feed(chunk, sampleRate, chunkStartWall, chunkEndWall);
      chunkIdx++;
      const nextDeadline = startWall + chunkIdx * chunkMs;
      const delay = Math.max(0, nextDeadline - performance.now());
      state.timeoutId = setTimeout(tick, delay);
    };
    state.timeoutId = setTimeout(tick, 0);
  }

  function stopPacedDecoderFeed() {
    const f = pacedFeederRef.current;
    if (!f) return;
    f.stopped = true;
    if (f.timeoutId) clearTimeout(f.timeoutId);
    pacedFeederRef.current = null;
  }

  // Wires a source node into the analyser only, on the shared AudioContext.
  // Used for buffer-source inputs (file / synth) where the decoder is fed by
  // the software-paced feeder instead of the worklet. Returns the analyser.
  function wireSourceForAnalysis(ctx, source, channelCount) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    analyser.smoothingTimeConstant = 0;
    const nCh = Math.max(1, channelCount || source.channelCount || 1);
    const ch = Math.min(Math.max(0, selectedChannelRef.current), nCh - 1);
    selectedChannelRef.current = ch;
    setInputChannelCount(nCh);
    setSelectedChannel(ch);
    const splitter = ctx.createChannelSplitter(nCh);
    splitterRef.current = splitter;
    source.connect(splitter);
    splitter.connect(analyser, ch);
    return analyser;
  }

  // Wires a source node into a fresh analyser + worklet + decoder on the
  // shared AudioContext. Returns the new analyser and worklet so callers
  // can stash them. Used by the live-mic path only — buffer-source inputs
  // (file / synth) use wireSourceForAnalysis + startPacedDecoderFeed instead.
  function wireSourceToDecoder(ctx, source, channelCount) {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    // Defaults are tuned for VU-style visualisation, not measurement:
    //   minDecibels: -100 (clamps real noise floors that go lower)
    //   maxDecibels: -30  (clips real signal peaks)
    //   smoothingTimeConstant: 0.8 (heavy temporal averaging that flattens
    //                              the spectrum and crushes peak-to-valley
    //                              ratios — kills SNR readings)
    // Widen the dB window and disable smoothing so the FFT we read is the
    // raw current-block spectrum.
    analyser.minDecibels = -120;
    analyser.maxDecibels = 0;
    analyser.smoothingTimeConstant = 0;
    // LTC is always a single channel of timecode. Multichannel devices (e.g.
    // Dante Virtual Soundcard) hand us 2+ channels with the code on one of
    // them. Feeding that straight into the analyser/worklet triggers Web
    // Audio's default "speakers" down-mix to mono — for stereo that's
    // 0.5×(L+R), which halves a single-channel signal and reads 6.02 dB low
    // vs. tools that read the discrete channel. A ChannelSplitter sized to the
    // input lets us tap exactly one channel at unity, with no down-mix
    // weighting. The tapped channel is user-selectable (selectedChannelRef).
    const nCh = Math.max(1, channelCount || source.channelCount || 1);
    const ch = Math.min(Math.max(0, selectedChannelRef.current), nCh - 1);
    selectedChannelRef.current = ch;
    setInputChannelCount(nCh);
    setSelectedChannel(ch);
    const splitter = ctx.createChannelSplitter(nCh);
    splitterRef.current = splitter;
    source.connect(splitter);
    splitter.connect(analyser, ch);
    // numberOfOutputs:0 makes the worklet a pure sink — process() runs as
    // long as inputs are flowing, and we never touch ctx.destination, so
    // no system output stream is opened.
    const worklet = new AudioWorkletNode(ctx, "ltc-capture", { numberOfOutputs: 0 });
    const decoder = new MultiRateDecoder();
    decoderRef.current = decoder;
    // Fresh source → restart the measured-rate accounting so a device switch
    // doesn't average across two clocks.
    sampleClockRef.current = { n: 0, marks: [] };
    measuredRateEmaRef.current = null;
    // Re-measure the audio-clock → main-thread perf.now() offset on the next
    // worklet message. The offset is constant for the AudioContext, but
    // resetting per-source guarantees we sample it while the new graph is
    // actually running (getOutputTimestamp can be stale when ctx was just
    // suspended).
    audioClockOffsetMsRef.current = null;
    worklet.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "glitch") {
        workletGlitchRef.current = { t: performance.now(), gapMs: msg.gapMs,
          count: (workletGlitchRef.current?.count ?? 0) + 1 };
        return;
      }
      // type === "samples"
      const samples = msg.samples;
      // The worklet stamps chunkWallStart/End in AudioContext audio-clock
      // domain (currentTime*1000), which has a different time origin than
      // main-thread performance.now() — the freshness check (App.jsx:905)
      // and dropoutPct compare lf.t against main-thread performance.now(),
      // so we must translate. AudioContext.getOutputTimestamp() returns
      // paired (contextTime in s, performanceTime in ms); the offset is
      // constant for the lifetime of the context, so cache it once.
      // Chunk-to-chunk deltas are preserved exactly, so the LSQ carrier-rate
      // classifier still reads against the host quartz via this offset.
      if (audioClockOffsetMsRef.current == null) {
        try {
          const ots = ctx.getOutputTimestamp();
          if (ots && Number.isFinite(ots.contextTime) && Number.isFinite(ots.performanceTime)) {
            audioClockOffsetMsRef.current = ots.performanceTime - ots.contextTime * 1000;
          }
        } catch { /* fall through to receipt-stamp fallback */ }
        if (audioClockOffsetMsRef.current == null) {
          // Fallback: anchor to receipt time. Less precise (adds main-thread
          // scheduling jitter) but works if getOutputTimestamp is unavailable.
          audioClockOffsetMsRef.current = performance.now() - msg.chunkWallEnd;
        }
      }
      const off = audioClockOffsetMsRef.current;
      decoder.feed(samples, sampleRateRef.current, msg.chunkWallStart + off, msg.chunkWallEnd + off);
      const sc = sampleClockRef.current;
      sc.n += samples.length;
      const now = performance.now();
      sc.marks.push({ t: now, n: sc.n });
      while (sc.marks.length > 2 && now - sc.marks[0].t > 4000) sc.marks.shift();
    };
    splitter.connect(worklet, ch);
    return { analyser, worklet };
  }

  // Re-tap the splitter to a different input channel without rebuilding the
  // stream/source graph. disconnect() on the splitter drops only its outgoing
  // edges (to analyser + worklet); the source→splitter edge is untouched.
  function selectInputChannel(idx) {
    selectedChannelRef.current = idx;
    setSelectedChannel(idx);
    const sp = splitterRef.current;
    const an = analyserRef.current;
    const wk = workletNodeRef.current;
    if (sp && an) {
      try { sp.disconnect(); } catch {}
      sp.connect(an, idx);
      // Live-mic path also retaps the worklet; buffer-source paths have no
      // worklet because the decoder is fed by the software-paced feeder.
      if (wk) sp.connect(wk, idx);
    }
    // For buffer-source inputs (file / synth), restart the paced feeder on
    // the newly-selected channel's samples so the decoder sees the right
    // audio. The live-mic path doesn't need this — the worklet retap above
    // already routes the chosen channel to the existing decoder.
    const lb = loadedBufferRef.current;
    const dec = decoderRef.current;
    if (lb && dec && !wk) {
      const chIdx = Math.min(idx, lb.audioBuffer.numberOfChannels - 1);
      const channelSamples = lb.audioBuffer.getChannelData(chIdx);
      startPacedDecoderFeed({ samples: channelSamples, sampleRate: lb.sampleRate, decoder: dec, loop: lb.loop });
    }
    // The decoder self-heals on the new channel: with no fresh frames it
    // unlocks after ~200 ms and the windowed metrics decay on their own.
  }

  // Tear down whatever source is currently feeding the decoder so a new one
  // can be wired up cleanly.
  function teardownCurrentSource() {
    stopPacedDecoderFeed();
    loadedBufferRef.current = null;
    if (bufferSourceRef.current) {
      try { bufferSourceRef.current.stop(); } catch {}
      try { bufferSourceRef.current.disconnect(); } catch {}
      bufferSourceRef.current = null;
    }
    if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch {} sourceRef.current = null; }
    if (workletNodeRef.current) { try { workletNodeRef.current.disconnect(); } catch {} workletNodeRef.current = null; }
    if (splitterRef.current) { try { splitterRef.current.disconnect(); } catch {} splitterRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    setSynthing(false);
    lastSeenCarrierRef.current = null;
    lastSeenCadenceRef.current = null;
  }

  async function startAudioCapture(deviceId) {
    try {
      teardownCurrentSource();
      setPlayingFile(null);

      const constraints = {
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          // Ask for every channel the device exposes (Chrome clamps to the
          // device max). Without this, multichannel inputs like Dante Virtual
          // Soundcard are delivered as a single down-mixed channel and we'd
          // never see the discrete LTC channel.
          channelCount: { ideal: 64 },
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() || {};
      setCurrentDeviceId(settings.deviceId || deviceId || null);
      setCurrentDeviceLabel(track?.label || "Unknown input");
      setDeviceSampleRate(settings.sampleRate ?? null);
      refreshAudioDevices();

      const ctx = await getOrCreateAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const { analyser, worklet } = wireSourceToDecoder(ctx, source, settings.channelCount);

      analyserRef.current = analyser;
      sourceRef.current = source;
      workletNodeRef.current = worklet;
      setUseRealAudio(true);
      setBootstrapping(false);
      setAudioError(null);
    } catch (e) {
      console.error(e);
      setBootstrapping(false);
      setAudioError(`Audio input failed: ${e.message || e}`);
    }
  }

  // Decode a dropped/picked audio file and route it into the decoder. The
  // file plays through the AnalyserNode + worklet only, never to
  // ctx.destination, so it is silent on the system output — analysis only.
  async function startFilePlayback(file) {
    try {
      setFileLoading(true);
      setAudioError(null);
      const arrayBuf = await file.arrayBuffer();
      const ctx = await getOrCreateAudioContext();
      // The file's native sample rate can't be obtained from the Web Audio
      // API — both AudioContext and OfflineAudioContext resample on decode.
      // For WAV (the most common LTC format) we can read it straight from
      // the header. For other formats we leave it null and just show the
      // decoded rate.
      const fileNativeRate = readWavSampleRate(arrayBuf);

      const audioBuffer = await ctx.decodeAudioData(arrayBuf);

      teardownCurrentSource();
      setCurrentDeviceId(null);
      setCurrentDeviceLabel("");

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = true;
      const analyser = wireSourceForAnalysis(ctx, source, audioBuffer.numberOfChannels);
      source.start();

      // Decoder is fed by the software-paced feeder, not the worklet —
      // headless audio graphs deliver buffer-source samples in deferred
      // bursts. See startPacedDecoderFeed() for the full rationale.
      const decoder = new MultiRateDecoder();
      decoderRef.current = decoder;
      sampleClockRef.current = { n: 0, marks: [] };
      measuredRateEmaRef.current = null;
      loadedBufferRef.current = { audioBuffer, sampleRate: ctx.sampleRate, loop: true };
      const channelSamples = audioBuffer.getChannelData(selectedChannelRef.current);
      startPacedDecoderFeed({ samples: channelSamples, sampleRate: ctx.sampleRate, decoder, loop: true });

      bufferSourceRef.current = source;
      analyserRef.current = analyser;
      setPlayingFile({
        name: file.name,
        durationSec: audioBuffer.duration,
        loop: true,
        nativeSampleRate: fileNativeRate,
        decoderSampleRate: ctx.sampleRate,
      });
      setUseRealAudio(true);
      setBootstrapping(false);
      setFileLoading(false);
    } catch (e) {
      console.error(e);
      setFileLoading(false);
      setAudioError(`File decode failed: ${e.message || e}`);
    }
  }

  async function startSynthPlayback() {
    try {
      setAudioError(null);
      const ctx = await getOrCreateAudioContext();
      const carrierFps = SYNTH_CARRIER_RATES[synthCarrierKey];
      const cad = SYNTH_CADENCES[synthCadenceKey];
      // 120 s buffer crosses a non-tenth minute boundary at common cadences,
      // so DF skip behaviour and minute-boundary cadence inference can be
      // exercised. The buffer loops — every wrap is a continuity break event.
      const dfFlag = synthDfFlagKey === "auto" ? cad.dropFrame
                   : synthDfFlagKey === "on";
      const samples = buildLtcAudioBuffer({
        sampleRate: ctx.sampleRate,
        carrierFps,
        cadenceFps: cad.fps,
        dropFrame: cad.dropFrame,
        dfFlag,
        durationSec: 120,
        levelDbFS,
        start: { hh: 0, mm: 0, ss: 59, ff: 0 },
      });
      const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
      audioBuffer.copyToChannel(samples, 0);

      teardownCurrentSource();
      setCurrentDeviceId(null);
      setCurrentDeviceLabel("");
      setPlayingFile(null);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.loop = true;
      const analyser = wireSourceForAnalysis(ctx, source, 1);
      source.start();

      const decoder = new MultiRateDecoder();
      decoderRef.current = decoder;
      sampleClockRef.current = { n: 0, marks: [] };
      measuredRateEmaRef.current = null;
      loadedBufferRef.current = { audioBuffer, sampleRate: ctx.sampleRate, loop: true };
      startPacedDecoderFeed({ samples, sampleRate: ctx.sampleRate, decoder, loop: true });

      bufferSourceRef.current = source;
      analyserRef.current = analyser;
      setUseRealAudio(true);
      setBootstrapping(false);
      setSynthing(true);
    } catch (e) {
      console.error(e);
      setAudioError(`Synth start failed: ${e.message || e}`);
    }
  }

  function stopSynthPlayback() {
    teardownCurrentSource();
    setSynthing(false);
  }

  function clearLog() {
    setSessionLog([]);
    setErrorCount(0);
    setErrorCounts({ CLIP:0, HOT:0, LOW:0, DROPOUT:0, NOISE:0, DF_INVALID:0, AUDIO_GAP:0 });
    lastErrSigRef.current = "";
    currentSigTicksRef.current = 0;
    currentSigFlushTickRef.current = 0;
    sessionStartRef.current = Date.now();
  }

  // Count-only reset: zeroes the error tally without touching the session log.
  function clearErrorCount() {
    setErrorCount(0);
    setErrorCounts({ CLIP:0, HOT:0, LOW:0, DROPOUT:0, NOISE:0, DF_INVALID:0, AUDIO_GAP:0 });
  }

  function downloadFile(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJSON() {
    const payload = {
      sessionStart: new Date(sessionStartRef.current).toISOString(),
      exportedAt: new Date().toISOString(),
      frameCount, errorCount, errorCounts,
      entries: sessionLog.map(e => ({ ...e, t: new Date(e.t).toISOString() })),
    };
    downloadFile(`ltc-session-${Date.now()}.json`, "application/json", JSON.stringify(payload, null, 2));
  }

  function exportCSV() {
    const header = "timestamp,timecode,from,rate,source,levelDbFS,snrDb,errors,count";
    const rows = sessionLog.map(e =>
      `${new Date(e.t).toISOString()},${e.tc},${e.from ?? ""},${e.rate},${e.source},${e.levelDbFS},${e.snr ?? ""},${e.errors.join("|")},${e.count ?? 1}`
    );
    downloadFile(`ltc-session-${Date.now()}.csv`, "text/csv", [header, ...rows].join("\n"));
  }

  function stopAudio() {
    // Tear down the input chain but keep the AudioContext alive (suspended)
    // so we don't trigger another Core Audio negotiation if/when the user
    // reconnects. Closing + recreating the context is what caused macOS to
    // switch the system output during the round-trip.
    teardownCurrentSource();
    if (audioCtxRef.current && audioCtxRef.current.state === "running") {
      try { audioCtxRef.current.suspend(); } catch { /* ignore */ }
    }
    analyserRef.current = null;
    decoderRef.current = null;
    setCurrentDeviceId(null);
    setCurrentDeviceLabel("");
    setPlayingFile(null);
    setUseRealAudio(false);
    setBootstrapping(false);
  }

  const liveMode = useRealAudio;
  const simMode = !useRealAudio;
  const ltcLocked = !!analysis?.ltcLocked;
  const tc = analysis ?? { hh:0, mm:0, ss:0, ff:0, dropFrame: SMPTE_RATES[rateKey].dropFrame };
  const hasErrors = (analysis?.errors?.length ?? 0) > 0;

  // Confidence derives from current state, so it resets to 0 whenever we
  // switch modes (analysis is cleared on switch) and climbs as real decode
  // activity accumulates.
  // Confidence tracks RECENT decode quality, not cumulative counts. The old
  // ratio (framesDecoded / (framesDecoded + bitErrors + 1)) took ~60 s to
  // recover after a rate change on the same device, because stale bit
  // errors from running the wrong rate dominated the denominator. dropoutPct
  // is a windowed metric — % of expected frames in the last ~2 s that
  // didn't decode — so it self-clears within the window.
  const confidence = liveMode
    ? (ltcLocked
        ? (Number.isFinite(analysis?.dropoutPct)
            ? Math.max(0, Math.min(99.5, 100 - analysis.dropoutPct))
            // Pre-window: show a small non-zero value so the bar starts
            // moving the moment we see the first frame, rather than sitting
            // at 0 until the window fills.
            : 25)
        : 0)
    : (analysis ? Math.max(0, 100 - (analysis.errors?.length ?? 0) * 18) : 0);
  const detectorRateKey = liveMode ? (analysis?.detectedRateKey ?? null) : rateKey;

  return (
    <div className="app-root" style={{
      minHeight:"100vh",
      background:"#050505",
      color:"#ccc",
      fontFamily:"monospace",
      padding:"20px",
      boxSizing:"border-box",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700&family=B612+Mono:wght@400;700&display=swap');
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }
        @keyframes scanline {
          0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)}
        }
        * { box-sizing:border-box; }
        input[type=range] {
          -webkit-appearance:none; appearance:none;
          width:100%; height:3px; background:#1a1a1a;
          border-radius:2px; outline:none;
        }
        input[type=range]::-webkit-slider-thumb {
          -webkit-appearance:none; width:12px; height:12px;
          border-radius:50%; background:#00ff88;
          box-shadow:0 0 6px #00ff8888; cursor:pointer;
        }
        select {
          background:#0a0a0a; border:1px solid #222; color:#00ff88;
          fontFamily:monospace; padding:4px 8px; borderRadius:2px;
          fontSize:12px; outline:none; cursor:pointer;
        }
        button {
          fontFamily:monospace; cursor:pointer; border-radius:2px;
          transition:all 0.15s;
        }
        button:hover { filter:brightness(1.2); }

        /* Mobile reflow: collapse multi-column grids to a single column and
           shrink chrome on narrow viewports. */
        @media (max-width: 720px) {
          .app-root { padding: 10px !important; }
          .three-col,
          .two-col { grid-template-columns: 1fr !important; }
          /* Keep the bit grid at 20 columns so cells stay small on mobile
             (~half the size of the 10-col mobile layout we used to ship). */
          .bit-grid { grid-template-columns: repeat(20, 1fr) !important; gap: 1px !important; }
          .tc-row { flex-direction: column; align-items: flex-start !important; gap: 12px !important; }
          .tc-meta { align-items: flex-start !important; width: 100%; }
          .audio-row,
          .api-row { flex-direction: column; align-items: stretch !important; }
          .audio-row > *,
          .api-row > * { margin-left: 0 !important; text-align: left !important; }
          .session-toolbar { flex-wrap: wrap; }
          .header-row { flex-direction: column; align-items: flex-start !important; gap: 6px; }
          .tc-input-wide { min-width: 0 !important; width: 100%; }

          /* Compact the SIGNAL LEVEL panel: each meter becomes
             [LABEL] [——— bar ———] [VALUE] on a single row; tick scale hidden. */
          .panel-level { padding: 10px !important; gap: 6px !important; }
          .level-meter {
            display: grid !important;
            grid-template-columns: 42px 1fr 70px !important;
            align-items: center;
            gap: 8px !important;
          }
          .level-meter .lm-ticks { display: none !important; }
          .level-meter .lm-value { text-align: right !important; }
          .gauge { gap: 2px !important; }

          /* Compact RATE DETECTION panel and its CONFIDENCE box. */
          .panel-rate { padding: 10px !important; gap: 6px !important; }
          .confidence-box { padding: 6px !important; }
        }
      `}</style>

      {/* Scanline overlay */}
      <div style={{
        position:"fixed", inset:0, pointerEvents:"none", zIndex:100,
        background:"repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
      }} />

      {/* Header */}
      <div className="header-row" style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <div style={{
            fontFamily:"'Orbitron', monospace",
            fontSize:"clamp(14px,2.5vw,22px)",
            color:"#00ff88",
            letterSpacing:4,
            textShadow:"0 0 20px rgba(0,255,136,0.3)",
          }}>SMPTE TIMECODE ANALYZER</div>
          <div style={{ fontSize:11, color:"#333", letterSpacing:3, marginTop:2 }}>
            LTC ANALYZER · IMPLEMENTS ST 12-1
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:11, fontFamily:"monospace", color:"#333", letterSpacing:2 }}>FRAMES ANALYZED</div>
          <div style={{ fontSize:18, fontFamily:"'Share Tech Mono'", color:"#555" }}>
            {frameCount.toLocaleString()}
          </div>
          <div style={{ fontSize:11, color: errorCount > 0 ? "#ff5500" : "#333", letterSpacing:2 }}>
            {errorCount} ERRORS
          </div>
          <button onClick={clearErrorCount} disabled={errorCount === 0} style={{
            ...buttonStyle(errorCount === 0 ? "#333" : "#ff3b3b", { padding:"3px 10px", fontSize:10 }),
            opacity: errorCount === 0 ? 0.4 : 1,
            marginTop:4,
          }}>✕ CLEAR</button>
        </div>
      </div>

      {/* Main TC Display */}
      {bootstrapping && (
        <div style={{
          fontSize:12, fontFamily:"monospace", letterSpacing:4,
          color:"#666",
          marginBottom:6,
        }}>
          ○ STARTING — requesting audio input…
        </div>
      )}
      {!bootstrapping && simMode && (
        <div style={{
          fontSize:12, fontFamily:"monospace", letterSpacing:4,
          color:"#d946ef", textShadow:"0 0 8px rgba(217,70,239,0.5)",
          animation:"blink 1.4s infinite",
          marginBottom:6,
        }}>
          ▲ SIMULATING CODE
        </div>
      )}
      {!bootstrapping && liveMode && (
        <div style={{
          fontSize:12, fontFamily:"monospace", letterSpacing:4,
          color: ltcLocked ? "#00ff88" : "#888",
          textShadow: ltcLocked ? "0 0 8px rgba(0,255,136,0.5)" : "none",
          marginBottom:6,
        }}>
          {ltcLocked
            ? `● LTC LOCKED · ${analysis.framesDecoded} FRAMES DECODED`
            : "○ NO LTC SIGNAL — feed valid LTC into the selected input"}
        </div>
      )}
      <div style={{
        border: !bootstrapping && simMode ? "1px solid #d946ef" : "1px solid #1a1a1a",
        boxShadow: !bootstrapping && simMode ? "0 0 16px rgba(217,70,239,0.25), inset 0 0 12px rgba(217,70,239,0.08)" : "none",
        borderRadius:4,
        padding:"24px 28px",
        marginBottom:16,
        background:"linear-gradient(180deg, #0a0a0a 0%, #050505 100%)",
        position:"relative",
        overflow:"hidden",
        transition:"border-color 0.2s, box-shadow 0.2s",
      }}>
        {/* Corner accents */}
        {["topLeft","topRight","bottomLeft","bottomRight"].map(pos => (
          <div key={pos} style={{
            position:"absolute",
            top: pos.includes("top") ? 0 : "auto",
            bottom: pos.includes("bottom") ? 0 : "auto",
            left: pos.includes("Left") ? 0 : "auto",
            right: pos.includes("Right") ? 0 : "auto",
            width:16, height:16,
            borderTop: pos.includes("top") ? "1px solid #00ff8844" : "none",
            borderBottom: pos.includes("bottom") ? "1px solid #00ff8844" : "none",
            borderLeft: pos.includes("Left") ? "1px solid #00ff8844" : "none",
            borderRight: pos.includes("Right") ? "1px solid #00ff8844" : "none",
          }} />
        ))}

        <div className="tc-row" style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:16 }}>
          <TimecodeDisplay
            hh={tc.hh} mm={tc.mm} ss={tc.ss} ff={tc.ff}
            dropFrame={tc.dropFrame}
            rateKey={analysis?.rateKey ?? rateKey}
            valid={analysis?.frameValid === true}
            dim={bootstrapping}
          />
          {(() => {
            // In live mode: carrier rate (timing) and counting cadence (FF
            // wrap behaviour) are observed independently. In sim mode the
            // synthesized stream uses one consistent rate, so we just show
            // the selected SMPTE rate.
            //
            // Hold-last behaviour: once code has been detected, keep showing
            // the most recent carrier+cadence even after the signal stops.
            // Only show "DETECTING…" when nothing has ever been detected this
            // session — otherwise the label collapses into "ND DETECTING…"
            // smashed together the moment code drops.
            if (liveMode && ltcLocked && analysis?.carrierRate) {
              lastSeenCarrierRef.current = analysis.carrierRate;
            }
            if (liveMode && analysis?.cadence) {
              lastSeenCadenceRef.current = analysis.cadence;
            }
            const haveEverDetected = lastSeenCarrierRef.current != null;
            const carrierKey = bootstrapping
              ? null
              : liveMode
                ? (ltcLocked ? analysis?.carrierRate : lastSeenCarrierRef.current)
                : rateKey;
            const cad = liveMode ? (analysis?.cadence ?? lastSeenCadenceRef.current) : null;
            const simIsDf = !liveMode && !!SMPTE_RATES[rateKey]?.dropFrame;
            const cadenceLabel = !liveMode
              ? (simIsDf ? "DF" : "ND")
              : cad
                ? (cad.dropFrameKnown
                    ? (cad.dropFrame ? "DF" : "ND")
                    : "ND?")
                : null;
            const isDf = liveMode ? (cad?.dropFrame === true) : simIsDf;
            const rateColor = isDf ? "#ffaa00" : "#3b9cff";
            const rateGlow = isDf ? "rgba(255,170,0,0.4)" : "rgba(59,156,255,0.4)";
            // Only raise the NON-CONFORMANT banner on high-confidence mismatches
            // — while either side is still MEASURING the result is unsettled
            // and not worth alarming operators about.
            const mm = liveMode ? analysis?.carrierCadenceMismatch : null;
            const mismatch = mm?.result === true && mm.confidence === "high";
            // MEASURING state: locked, decoder seeing frames, but the carrier
            // classifier has not yet committed (5σ + 3 agreements over ≥3 s).
            // Show the timecode digits but suppress the rate label and badge it.
            const isMeasuring = liveMode && ltcLocked && analysis?.carrierObs?.fractional == null
              && analysis?.detectedFps != null
              && analysis.detectedFps !== 25 && analysis.detectedFps !== 50;
            return (
          <div className="tc-meta" style={{ display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
            <div style={{
              fontFamily:"'Orbitron', monospace",
              fontSize:20, color: rateColor,
              textShadow: `0 0 12px ${rateGlow}`,
              letterSpacing:2,
              transition: "color 0.2s, text-shadow 0.2s",
            }}>
              {carrierKey ? carrierKey : (liveMode ? "" : "— —")}
              {cadenceLabel && (
                <span style={{ fontSize:14, color: mismatch ? "#ff3b3b" : "#888", letterSpacing:2, marginLeft:8 }}>
                  · {cadenceLabel}
                </span>
              )}
              {isMeasuring && (
                <span style={{ fontSize:11, color:"#ffaa00", letterSpacing:3, marginLeft: 8 }}>
                  MEASURING…
                </span>
              )}
              {!isMeasuring && !bootstrapping && liveMode && (ltcLocked || !haveEverDetected) && (
                <span style={{ fontSize:11, color:"#22d3ee", letterSpacing:3, marginLeft: 8 }}>
                  {ltcLocked ? "DETECTED" : "DETECTING…"}
                </span>
              )}
            </div>
            {mismatch && (
              <div style={{ fontSize:10, color:"#ff3b3b", fontFamily:"monospace", letterSpacing:2, maxWidth:280, textAlign:"right", lineHeight:1.4 }}>
                ⚠ NON-CONFORMANT: {mm.reason || `carrier ${analysis?.carrierRate} / cadence ${cad?.fps}${cad?.dropFrame ? " DF" : " ND"}`}
              </div>
            )}
            {liveMode && cad && cad.dfFlagMatches === false && (
              <div style={{ fontSize:10, color:"#ffaa00", fontFamily:"monospace", letterSpacing:2, maxWidth:280, textAlign:"right", lineHeight:1.4 }}>
                ⚠ DF FLAG BIT DISAGREES WITH COUNT BEHAVIOUR
              </div>
            )}
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"flex-end" }}>
              <StatusBadge label="LOCK" active={!bootstrapping && analysis?.frameValid === true} color="#00ff88" />
              <StatusBadge label="DF" active={tc.dropFrame && (!liveMode || !!analysis?.ltcLocked)} color="#ffaa00" />
              <StatusBadge label="CF" active={tc.colorFrame} color="#8888ff" />
            </div>
          </div>
            );
          })()}
        </div>
      </div>

      {/* Error Badges */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
        {["CLIP","HOT","LOW","DROPOUT","NOISE","DF_INVALID","AUDIO_GAP"].map(e => (
          <StatusBadge
            key={e} label={e}
            active={analysis?.errors?.includes(e)}
            color={e==="CLIP"?"#ff0000":e==="HOT"?"#ff6600":e==="LOW"?"#ff9900":e==="DROPOUT"?"#ff3399":e==="NOISE"?"#cc88ff":e==="DF_INVALID"?"#ffaa00":"#22d3ee"}
            warn={true}
            count={errorCounts[e]}
          />
        ))}
        <div style={{ marginLeft:"auto", fontSize:11, fontFamily:"monospace", color: hasErrors ? "#ff3b3b" : "#00ff88", alignSelf:"center", letterSpacing:2 }}>
          {hasErrors ? `⚠ ${analysis.errors.join(" · ")} DETECTED` : "● ALL PARAMETERS NOMINAL"}
        </div>
      </div>

      <div className="three-col" style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>

        {/* Level Section */}
        <div className="panel-level" style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:6 }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>SIGNAL LEVEL</div>
          <LevelMeter label="RMS" value={analysis?.levelDbFS ?? levelDbFS} />
          <LevelMeter label="PEAK" value={analysis?.peakDbFS ?? levelDbFS + 2} peak={peakHold} />
          <div style={{ height:"1px", background:"#111" }} />
          <Gauge label="SNR" value={analysis?.snr} min={0} max={80} unit=" dB"
            thresholds={[{above:-100,color:"#ff3b3b"},{above:10,color:"#ffaa00"},{above:15,color:"#00ff88"}]} />
          <Gauge label="THD" value={analysis?.thd} min={0} max={100} unit="%"
            thresholds={[{above:0,color:"#00ff88"},{above:50,color:"#ffaa00"},{above:70,color:"#ff3b3b"}]} />
          <div style={{ fontSize:11, color:"#333", fontFamily:"monospace", lineHeight:1.8, marginTop:4 }}>
            NOISE FLOOR: {Number.isFinite(analysis?.noiseFloor)
              ? `${analysis.noiseFloor.toFixed(1)} dB`
              : "—"}
          </div>
        </div>

        {/* Rate Detection */}
        <div className="panel-rate" style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>RATE DETECTION</div>
          <RateDetector
            rateKey={detectorRateKey}
            candidateStatus={liveMode ? analysis?.candidateStatus : null}
            confidence={confidence}
          />
          <div className="confidence-box" style={{ marginTop:"auto", padding:"4px 6px", background:"#0d0d0d", border:"1px solid #1a1a1a", borderRadius:2, display:"flex", alignItems:"center", gap:8 }}>
            <div style={{ fontSize:10, color:"#555", letterSpacing:2 }}>CONFIDENCE</div>
            <div style={{ flex:1, height:4, background:"#111", borderRadius:2 }}>
              <div style={{ width:`${confidence}%`, height:"100%", background:"#00ff88", borderRadius:2, boxShadow:"0 0 6px #00ff8866" }} />
            </div>
            <div style={{ fontSize:12, color:"#00ff88", fontFamily:"monospace", minWidth:42, textAlign:"right" }}>
              {confidence.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Bit Integrity */}
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>FRAME INTEGRITY</div>
          <BitStreamView
            bits={liveMode ? analysis?.lastFrameBits : null}
            bitErrors={analysis?.bitErrors ?? 0}
            locked={ltcLocked}
          />
          <div style={{ height:"1px", background:"#111" }} />
          <div style={{ fontSize:11, fontFamily:"monospace", color:"#444", lineHeight:2 }}>
            <div>SYNC WORD: <span style={{color: ltcLocked ? "#00ff88" : "#ff3b3b"}}>
              {ltcLocked ? "VALID" : "—"}
            </span></div>
            <div>BIT ERRORS: <span style={{color: (analysis?.bitErrors ?? 0) > 0 ? "#ffaa00" : "#00ff88"}}>
              {liveMode ? (analysis?.bitErrors ?? 0) : "—"}
            </span></div>
            <div>BIT CLOCK: <span style={{color: ltcLocked ? "#00ff88" : "#666"}}>
              {ltcLocked ? "LOCKED" : "UNLOCKED"}
            </span></div>
            <div>FRAMES DECODED: <span style={{color:"#888"}}>
              {liveMode ? (analysis?.framesDecoded ?? 0) : "—"}
            </span></div>
          </div>
        </div>
      </div>

      {/* Audio input (left) + Live status / sim controls (right) */}
      <div className="two-col" style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12, alignItems:"stretch" }}>
        {/* Left column: Audio input on top, API publisher below */}
        <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
        {/* Audio input */}
        <div
          style={{ ...PANEL, padding:12, display:"flex", flexDirection:"column", gap:10,
            outline: fileDragOver ? "2px dashed #22d3ee" : "none", outlineOffset:-2 }}
          onDragEnter={e => { e.preventDefault(); setFileDragOver(true); }}
          onDragOver={e => { e.preventDefault(); setFileDragOver(true); }}
          onDragLeave={e => { e.preventDefault(); setFileDragOver(false); }}
          onDrop={e => {
            e.preventDefault();
            setFileDragOver(false);
            const f = e.dataTransfer?.files?.[0];
            if (f) startFilePlayback(f);
          }}
        >
          <div className="audio-row" style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
            <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>AUDIO INPUT</div>
            {playingFile ? (
              <>
                <div style={{ fontSize:11, color:"#22d3ee", letterSpacing:2 }}>FILE</div>
                <div style={{ fontSize:13, color:"#22d3ee", fontFamily:"monospace", maxWidth:320, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                  {playingFile.name}
                </div>
                <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>
                  {playingFile.durationSec.toFixed(1)}s · LOOPED · ANALYSIS ONLY · NO OUTPUT
                </div>
              </>
            ) : liveMode ? (
              <>
                <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>DEVICE</div>
                <select
                  className="tc-input-wide"
                  value={currentDeviceId ?? ""}
                  onChange={e => startAudioCapture(e.target.value)}
                  style={{ minWidth:200, fontSize:12 }}
                >
                  {audioDevices.length === 0 && currentDeviceLabel && (
                    <option value={currentDeviceId ?? ""}>{currentDeviceLabel}</option>
                  )}
                  {audioDevices.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label || `Input ${d.deviceId.slice(0,6)}`}
                    </option>
                  ))}
                </select>
                <button
                  onClick={refreshAudioDevices}
                  title="Refresh device list"
                  style={{
                    background:"transparent", border:"1px solid #222",
                    color:"#666", padding:"4px 10px", fontSize:12, letterSpacing:1,
                  }}
                >↻</button>
                {inputChannelCount > 1 && (
                  <>
                    <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>CH</div>
                    <select
                      value={selectedChannel}
                      onChange={e => selectInputChannel(Number(e.target.value))}
                      title="Input channel carrying the LTC"
                      style={{ fontSize:12 }}
                    >
                      {Array.from({ length: inputChannelCount }, (_, i) => (
                        <option key={i} value={i}>{`CH ${i + 1}`}</option>
                      ))}
                    </select>
                    <span style={{ fontSize:11, color:"#555", letterSpacing:1 }}>
                      of {inputChannelCount}
                    </span>
                  </>
                )}
                <div style={{ fontSize:11, color:"#00ff88", fontFamily:"monospace", letterSpacing:2 }}>
                  ● LIVE
                </div>
              </>
            ) : (
              <>
                <button onClick={() => startAudioCapture()} style={buttonStyle("#00ff88")}>
                  ▶ CONNECT AUDIO INPUT
                </button>
                <div style={{ fontSize:11, color:"#333", fontFamily:"monospace", letterSpacing:2 }}>
                  ○ SIMULATION MODE
                </div>
              </>
            )}
            {audioError && <div style={{ fontSize:11, color:"#ff3b3b" }}>{audioError}</div>}
          </div>

          {/* File drop / pick row — always visible so user can switch to file
              analysis from any state. Routes through the same decoder; never
              connected to ctx.destination, so it's silent on system output. */}
          <div style={{ display:"flex", alignItems:"center", gap:10, borderTop:"1px solid #111", paddingTop:8, flexWrap:"wrap" }}>
            <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>FILE</div>
            <label style={{
              cursor:"pointer", fontSize:12, letterSpacing:2,
              border:"1px solid #22d3ee44", color:"#22d3ee",
              padding:"4px 12px", borderRadius:2, background:"transparent",
            }}>
              ⇧ {playingFile ? "REPLACE FILE" : "ANALYZE FILE…"}
              <input
                type="file"
                accept="audio/*,.wav,.aif,.aiff,.mp3,.m4a,.flac,.ogg"
                style={{ display:"none" }}
                onChange={e => { const f = e.target.files?.[0]; if (f) startFilePlayback(f); e.target.value = ""; }}
              />
            </label>
            {playingFile && (
              <button
                onClick={() => startAudioCapture()}
                style={buttonStyle("#666", { padding:"4px 12px", fontSize:11 })}
                title="Stop file playback and return to live audio input"
              >
                ■ STOP FILE
              </button>
            )}
            {fileLoading && <span style={{ fontSize:11, color:"#22d3ee", letterSpacing:2 }}>DECODING…</span>}
            <span style={{ fontSize:12, color:"#555", letterSpacing:1 }}>
              drop a file on this panel
            </span>
          </div>

          {liveMode && !playingFile && (
            <div style={{ display:"flex", justifyContent:"flex-end", borderTop:"1px solid #111", paddingTop:8 }}>
              <button onClick={stopAudio} style={buttonStyle("#d946ef", { padding:"4px 12px", fontSize:11, borderAlpha:"66" })}>
                ▲ SWITCH TO SIMULATED TIMECODE
              </button>
            </div>
          )}
        </div>

        {/* API publisher (below audio input in left column) */}
        <div className="api-row" style={{ ...PANEL, padding:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>API PUBLISHER</div>
          <input
            className="tc-input-wide"
            type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)}
            disabled={apiEnabled}
            style={{ background:"#0a0a0a", border:"1px solid #222", color:"#00ff88",
                     fontFamily:"monospace", fontSize:12, padding:"4px 8px",
                     minWidth:180, flex:1, outline:"none", opacity: apiEnabled ? 0.5 : 1 }}
          />
          {!apiEnabled ? (
            <button onClick={() => setApiEnabled(true)} style={buttonStyle("#00ff88")}>▶ PUBLISH</button>
          ) : (
            <button onClick={() => setApiEnabled(false)} style={buttonStyle("#ff3b3b")}>■ STOP</button>
          )}
          <div style={{ fontSize:11, fontFamily:"monospace", letterSpacing:2,
            color: apiState === "open" ? "#00ff88" : apiState === "connecting" ? "#ff9900" : apiState === "closed" ? "#ff3b3b" : "#333" }}>
            {apiState === "open" ? `● CONNECTED · ${apiSubscribers} SUB${apiSubscribers === 1 ? "" : "S"}`
              : apiState === "connecting" ? "◐ CONNECTING…"
              : apiState === "closed" ? "○ RECONNECTING…"
              : "○ OFFLINE"}
          </div>
        </div>
        </div>

        {/* Controls / status */}
        <div>
        {bootstrapping ? (
          <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontSize:11, color:"#666", letterSpacing:3, marginBottom:4 }}>STARTING</div>
            <div style={{ fontSize:12, color:"#444", fontFamily:"monospace" }}>
              Requesting audio input. The simulator and live controls will
              appear here once the mode is established.
            </div>
          </div>
        ) : liveMode ? (
          <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:14 }}>
            {synthing && (
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:8, padding:"6px 10px", background:"#3b9cff11", border:"1px solid #3b9cff44" }}>
                <div style={{ fontSize:10, color:"#3b9cff", letterSpacing:2, fontFamily:"monospace" }}>
                  ▶ SYNTH · CARRIER {synthCarrierKey} · CADENCE {SYNTH_CADENCES[synthCadenceKey].label}
                </div>
                <button
                  onClick={stopSynthPlayback}
                  style={{ padding:"3px 10px", background:"#ff333322", color:"#ff6666", border:"1px solid #ff333366", letterSpacing:2, fontSize:10, cursor:"pointer" }}
                >
                  ■ STOP
                </button>
              </div>
            )}
            <div style={{ fontSize:11, color:"#22d3ee", letterSpacing:3, marginBottom:4 }}>LIVE INPUT STATUS</div>
            <div style={{ display:"grid", gridTemplateColumns:"auto 1fr", gap:"10px 18px", fontSize:13, fontFamily:"monospace" }}>
              <span style={{ color:"#555", letterSpacing:2 }}>LOCK STATE</span>
              <span style={{ color: ltcLocked ? "#00ff88" : "#888" }}>
                {ltcLocked ? "● LOCKED" : "○ NO SIGNAL"}
              </span>
              <span style={{ color:"#555", letterSpacing:2 }}>FRAMES DECODED</span>
              <span style={{ color:"#ccc" }}>{analysis?.framesDecoded ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>BIT ERRORS</span>
              <span style={{ color: (analysis?.bitErrors ?? 0) > 0 ? "#ff9900" : "#ccc" }}>{analysis?.bitErrors ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>SAMPLE RATE</span>
              {(() => {
                if (playingFile?.nativeSampleRate) {
                  return (
                    <span style={{ color:"#666" }}>
                      {playingFile.nativeSampleRate} Hz file · {playingFile.decoderSampleRate} Hz decoded
                    </span>
                  );
                }
                // Live path. `measured` is the ground truth — samples actually
                // delivered per second. `nominal` is what the device reports
                // via getSettings().sampleRate; only shown when it diverges
                // from measured (i.e. the OS is resampling the input). The
                // old code fell back to the AudioContext's rate when
                // getSettings was unavailable, which displayed a misleading
                // "48000 Hz nominal" that was really just the context rate.
                const measured = ltcLocked ? measuredSampleRate : null;
                const nominal = deviceSampleRate;
                const diverges = measured != null && nominal != null
                  && Math.abs(measured - nominal) > 10;
                if (measured == null) {
                  return (
                    <span style={{ color:"#666" }}>
                      — measured{nominal != null ? ` · ${nominal} Hz nominal` : ""}
                    </span>
                  );
                }
                if (diverges) {
                  return (
                    <span style={{ color:"#ffaa00" }}>
                      {measured} Hz measured · {nominal} Hz nominal · RESAMPLED
                    </span>
                  );
                }
                return <span style={{ color:"#666" }}>{measured} Hz measured</span>;
              })()}
              <span style={{ color:"#555", letterSpacing:2 }}>CLOCK DRIFT</span>
              {(() => {
                const d = analysis?.driftPpm;
                if (!Number.isFinite(d)) {
                  return <span style={{ color:"#666" }}>—</span>;
                }
                const abs = Math.abs(d);
                // Clock drift is a steady FREQUENCY OFFSET between the source
                // and our capture clock — it does NOT affect chasing/resolving,
                // which slaves to whatever rate arrives. So a non-trivial
                // offset is informational, not a fault. Only flag a warning
                // when the offset is large enough to suggest a mis-detected
                // rate (≈±500 ppm ≫ any real generator). What actually breaks
                // a chase is continuity breaks + dropouts, reported separately.
                const color = abs < 5 ? "#00ff88" : abs < 500 ? "#22d3ee" : "#ffaa00";
                const status = abs < 5 ? "LOCKED" : abs < 500 ? "OK TO CHASE" : "CHECK RATE";
                const sign = d > 0 ? "+" : d < 0 ? "−" : "";
                return (
                  <span style={{ color }}>
                    {sign}{abs.toFixed(1)} ppm · {status}
                  </span>
                );
              })()}
              <span style={{ color:"#555", letterSpacing:2 }}>DROPOUT RATE</span>
              {(() => {
                const p = analysis?.dropoutPct;
                if (!Number.isFinite(p)) {
                  return <span style={{ color:"#666" }}>—</span>;
                }
                // 2-second rolling window. Clean < 1%, occasional 1–10%,
                // serious 10–50%, severe > 50%.
                const color = p < 1 ? "#00ff88" : p < 10 ? "#ffaa00" : p < 50 ? "#ff6600" : "#ff3b3b";
                const status = p < 1 ? "CLEAN" : p < 10 ? "OCCASIONAL" : p < 50 ? "FREQUENT" : "SEVERE";
                return (
                  <span style={{ color }}>
                    {p.toFixed(1)}% · {status}
                  </span>
                );
              })()}
              <span style={{ color:"#555", letterSpacing:2 }}>CONTINUITY · 60s</span>
              {(() => {
                const cutoff = performance.now() - 60000;
                const arr = recentBreakTimesRef.current;
                while (arr.length && arr[0] < cutoff) arr.shift();
                const breaks = arr.length;
                const last = analysis?.lastBreak;
                const lastIsRecent = last && last.t >= cutoff;
                if (breaks === 0) {
                  return <span style={{ color:"#00ff88" }}>● CONTINUOUS · 0 BREAKS</span>;
                }
                const sign = last?.delta > 0 ? "+" : "";
                const detail = lastIsRecent
                  ? ` · last: ${last.type}${last.delta != null ? ` ${sign}${last.delta}` : ""} @ ${last.to}`
                  : "";
                return (
                  <span style={{ color:"#ffaa00" }}>
                    {breaks} BREAK{breaks === 1 ? "" : "S"}{detail}
                  </span>
                );
              })()}
            </div>
            <div style={{ fontSize:10, color:"#333", letterSpacing:1, marginTop:4 }}>
              Auto-detecting from biphase bit rate (24 / 25 / 30 / 50 / 60 candidates run in parallel).
              NDF vs DF resolved from the frame's drop-frame flag.
            </div>
            {/* AUDIT panel: exposes the raw measurement numbers a SMPTE
                engineer would want to audit the analyzer's conclusions.
                Collapsed by default — primary readouts above are enough for
                routine operation; this is for diagnostics. */}
            <div style={{ borderTop:"1px solid #1a1a1a", marginTop:8, paddingTop:8 }}>
              <button
                onClick={() => setAuditExpanded(v => !v)}
                style={{ background:"none", border:"none", color:"#888", fontFamily:"monospace",
                         fontSize:10, letterSpacing:3, cursor:"pointer", padding:0 }}
              >
                {auditExpanded ? "▼" : "▶"} AUDIT
              </button>
              {auditExpanded && (
                <div style={{ marginTop:8, display:"grid", gridTemplateColumns:"auto 1fr",
                              gap:"6px 12px", fontSize:11, fontFamily:"monospace" }}>
                  {(() => {
                    const obs = analysis?.carrierObs;
                    const host = analysis?.driftPpm;
                    const adc = analysis?.driftPpmSourceVsAdc;
                    const cap = analysis?.captureClockErrorPpm;
                    const fmt = (v, digits = 1) => Number.isFinite(v)
                      ? (v > 0 ? "+" : "") + v.toFixed(digits) : "—";
                    return (
                      <>
                        <span style={{ color:"#555", letterSpacing:1 }}>MEASURED FPS</span>
                        <span style={{ color:"#ccc" }}>
                          {obs?.stable
                            ? `${obs.stable.fps.toFixed(5)} ± ${(obs.stable.sigmaFps * 1e6 / obs.nominalFps).toFixed(2)} ppm`
                            : "—"}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>WINDOW</span>
                        <span style={{ color:"#888" }}>
                          {obs?.stable
                            ? `${obs.stable.n} frames · ${obs.stable.spanSec.toFixed(1)} s`
                            : "—"}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>CLASS</span>
                        <span style={{ color: obs?.fractional == null ? "#ffaa00" : "#00ff88" }}>
                          {obs?.fractional == null
                            ? `MEASURING (${obs?.agreementCount ?? 0}/${obs?.agreementsRequired ?? 3} agreements)`
                            : `${obs.fractional ? "fractional" : "integer"} · ${obs.classConfidence}`}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>SOURCE → HOST QUARTZ</span>
                        <span style={{ color:"#ccc" }}>{fmt(host)} ppm</span>
                        <span style={{ color:"#555", letterSpacing:1 }}>SOURCE → ADC</span>
                        <span style={{ color:"#888" }}>{fmt(adc)} ppm</span>
                        <span style={{ color:"#555", letterSpacing:1 }}>CAPTURE CLOCK ERROR</span>
                        <span style={{ color: Math.abs(cap ?? 0) > 100 ? "#ffaa00" : "#888" }}>
                          {fmt(cap)} ppm{Math.abs(cap ?? 0) > 100 ? " ⚠ check capture device" : ""}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>USER BITS</span>
                        <span style={{ color:"#ccc", fontFamily:"B612 Mono, monospace", letterSpacing:2 }}>
                          {analysis?.userBits
                            ? Array.from(analysis.userBits, n => n.toString(16).toUpperCase()).join(" ")
                            : "—"}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>BGF 0/1/2</span>
                        <span style={{ color:"#888" }}>
                          {analysis?.bgf
                            ? analysis.bgf.map(b => b == null ? "—" : (b ? "1" : "0")).join(" ")
                            : "—"}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>FIELD-MARK</span>
                        <span style={{ color: analysis?.fieldMarkBehavior == null ? "#666"
                                                : analysis.fieldMarkBehavior === "TOGGLING" ? "#00ff88" : "#ffaa00" }}>
                          {analysis?.fieldMarkBehavior == null
                            ? "—"
                            : analysis.fieldMarkBehavior === "TOGGLING"
                              ? "TOGGLING · frame-pair LTC"
                              : "STATIC · wide LTC (de-facto)"}
                        </span>
                        <span style={{ color:"#555", letterSpacing:1 }}>perf.now() RES</span>
                        <span style={{ color:"#666" }}>
                          {obs?.clockResolutionMs != null
                            ? `${obs.clockResolutionMs.toFixed(3)} ms`
                            : "—"}
                        </span>
                      </>
                    );
                  })()}
                </div>
              )}
              {auditExpanded && (
                <div style={{ marginTop:8, fontSize:9, color:"#444", lineHeight:1.5 }}>
                  Host quartz is undisciplined (typically ±50 ppm absolute). For
                  absolute source drift you'd need an external reference. Capture-
                  clock error is host − ADC drift with the LTC source as common
                  reference.
                </div>
              )}
            </div>
          </div>
        ) : (
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:14, border:"1px solid #c084fc", boxShadow:"0 0 12px rgba(192,132,252,0.35)" }}>
          <div style={{ fontSize:11, color:"#c084fc", letterSpacing:3, marginBottom:4 }}>SIMULATION CONTROLS</div>

          <div>
            <div style={{ fontSize:11, color:"#555", letterSpacing:2, marginBottom:8 }}>FRAME RATE</div>
            <select value={rateKey} onChange={e => setRateKey(e.target.value)} style={{width:"100%"}}>
              {Object.entries(SMPTE_RATES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>SIGNAL LEVEL</span>
              <span style={{color: levelDbFS > LEVEL_SPEC.HOT_THRESHOLD ? "#ff6600" : levelDbFS < LEVEL_SPEC.LOW_THRESHOLD ? "#ff9900" : "#00ff88"}}>
                {levelDbFS.toFixed(0)} dBFS
              </span>
            </div>
            <input type="range" min={-70} max={0} step={0.5}
              value={levelDbFS} onChange={e => setLevelDbFS(+e.target.value)} />
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, color:"#333", fontFamily:"monospace", marginTop:2 }}>
              <span>DROPOUT</span><span>NOMINAL</span><span>HOT</span><span>CLIP</span>
            </div>
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>NOISE / DISTORTION</span>
              <span style={{color: noiseLevel > 0.3 ? "#ff3b3b" : "#555"}}>{(noiseLevel*100).toFixed(0)}%</span>
            </div>
            <input type="range" min={0} max={1} step={0.01}
              value={noiseLevel} onChange={e => setNoiseLevel(+e.target.value)} />
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:11, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>DROPOUT PROBABILITY</span>
              <span style={{color: dropoutProb > 0.05 ? "#ff3b3b" : "#555"}}>{(dropoutProb*100).toFixed(1)}%</span>
            </div>
            <input type="range" min={0} max={0.5} step={0.005}
              value={dropoutProb} onChange={e => setDropoutProb(+e.target.value)} />
          </div>

          {/* LTC synthesizer: generates real biphase audio fed through the
              decoder, so the carrier/cadence split can be exercised end-to-end
              with mismatched settings (e.g. 30 carrier + 30 DF cadence). */}
          <div style={{ borderTop:"1px solid #1a1a1a", paddingTop:12, marginTop:4 }}>
            <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3, marginBottom:8 }}>SYNTHESIZE LTC AUDIO</div>
            <div style={{ fontSize:10, color:"#555", marginBottom:10, lineHeight:1.5 }}>
              Generates real LTC audio through the decoder.
              Carrier rate = bit-clock timing. Cadence = how the count wraps + DF skip.
              Pick mismatched values to trigger the new warnings.
            </div>
            <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:10 }}>
              <div>
                <div style={{ fontSize:11, color:"#555", letterSpacing:2, marginBottom:4 }}>
                  CARRIER RATE <span style={{color:"#3b9cff"}}>{synthCarrierKey}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={Object.keys(SYNTH_CARRIER_RATES).length - 1}
                  step={1}
                  value={Object.keys(SYNTH_CARRIER_RATES).indexOf(synthCarrierKey)}
                  onChange={e => setSynthCarrierKey(Object.keys(SYNTH_CARRIER_RATES)[+e.target.value])}
                  style={{ width:"100%" }}
                />
                {(() => {
                  // Native range thumb sits with its center at thumbRadius
                  // from the input edges, so labels using space-between on a
                  // 100%-wide container land outside the actual thumb travel.
                  // Position each label centered at its corresponding stop,
                  // inset by the thumb radius from each side of the track.
                  const keys = Object.keys(SYNTH_CARRIER_RATES);
                  const thumbRadius = 8;
                  return (
                    <div style={{ position:"relative", height:14, marginTop:2, marginLeft:thumbRadius, marginRight:thumbRadius }}>
                      {keys.map((k, i) => (
                        <span key={k} style={{
                          position:"absolute",
                          left:`${(i / (keys.length - 1)) * 100}%`,
                          transform:"translateX(-50%)",
                          fontSize:9,
                          color: k === synthCarrierKey ? "#3b9cff" : "#333",
                          whiteSpace:"nowrap",
                        }}>{k}</span>
                      ))}
                    </div>
                  );
                })()}
              </div>
              <div>
                <div style={{ fontSize:11, color:"#555", letterSpacing:2, marginBottom:4 }}>COUNTING CADENCE</div>
                <select
                  value={synthCadenceKey}
                  onChange={e => setSynthCadenceKey(e.target.value)}
                  style={{ width:"100%" }}
                >
                  {Object.entries(SYNTH_CADENCES).map(([k, v]) => (
                    <option key={k} value={k}>{v.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div style={{ fontSize:11, color:"#555", letterSpacing:2, marginBottom:4 }}>DF FLAG BIT (frame bit 10)</div>
                <select
                  value={synthDfFlagKey}
                  onChange={e => setSynthDfFlagKey(e.target.value)}
                  style={{ width:"100%" }}
                >
                  <option value="auto">AUTO — match cadence (spec)</option>
                  <option value="on">FORCE ON — assert flag regardless of cadence</option>
                  <option value="off">FORCE OFF — clear flag regardless of cadence</option>
                </select>
              </div>
            </div>
            {(() => {
              const carrierFps = SYNTH_CARRIER_RATES[synthCarrierKey];
              const cad = SYNTH_CADENCES[synthCadenceKey];
              const carrierNomInt = Math.round(carrierFps);
              const fractional = Math.abs(carrierFps - carrierNomInt) > 0.01;
              const carrierMismatch = carrierNomInt !== cad.fps || (cad.dropFrame && !fractional && (carrierNomInt === 30 || carrierNomInt === 60));
              const dfFlagVal = synthDfFlagKey === "auto" ? cad.dropFrame : synthDfFlagKey === "on";
              const flagMismatch = dfFlagVal !== cad.dropFrame;
              const mismatch = carrierMismatch || flagMismatch;
              const msgs = [];
              if (carrierMismatch) msgs.push("carrier/cadence");
              if (flagMismatch) msgs.push("DF flag/cadence");
              return (
                <div style={{ fontSize:10, color: mismatch ? "#ff6600" : "#444", fontFamily:"monospace", marginBottom:10, letterSpacing:1 }}>
                  {mismatch
                    ? `⚠ OUT-OF-SPEC — should trigger ${msgs.join(" + ")} warning${msgs.length > 1 ? "s" : ""}`
                    : "✓ spec-conformant — carrier, cadence, and DF flag agree"}
                </div>
              );
            })()}
            {!synthing ? (
              <button
                onClick={startSynthPlayback}
                style={{ width:"100%", padding:"8px 12px", background:"#00ff8822", color:"#00ff88", border:"1px solid #00ff8866", letterSpacing:2, fontSize:11, cursor:"pointer" }}
              >
                ▶ START LTC SYNTH
              </button>
            ) : (
              <button
                onClick={stopSynthPlayback}
                style={{ width:"100%", padding:"8px 12px", background:"#ff333322", color:"#ff6666", border:"1px solid #ff333366", letterSpacing:2, fontSize:11, cursor:"pointer" }}
              >
                ■ STOP LTC SYNTH
              </button>
            )}
          </div>
        </div>
        )}
        </div>
      </div>

      {/* Session log */}
      <div style={{ marginTop:12, ...PANEL }}>
        <div className="session-toolbar" style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", borderBottom:"1px solid #1a1a1a", flexWrap:"wrap" }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>SESSION LOG</div>
          <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>
            {sessionLog.length} ENTR{sessionLog.length === 1 ? "Y" : "IES"} · {errorCount} ERROR TICKS · {frameCount} FRAMES
          </div>
          <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
            {[
              { label:"⇩ CSV", onClick: exportCSV, color:"#00ff88" },
              { label:"⇩ JSON", onClick: exportJSON, color:"#00ff88" },
              { label:"✕ CLEAR LOGS", onClick: clearLog, color:"#ff3b3b" },
            ].map(b => {
              const disabled = sessionLog.length === 0;
              return (
                <button key={b.label} onClick={b.onClick} disabled={disabled} style={{
                  ...buttonStyle(disabled ? "#333" : b.color, { padding:"4px 12px", fontSize:11 }),
                  opacity: disabled ? 0.4 : 1,
                }}>{b.label}</button>
              );
            })}
          </div>
        </div>
        <div style={{ maxHeight:220, overflowY:"auto", fontFamily:"monospace", fontSize:12 }}>
          {sessionLog.length === 0 ? (
            <div style={{ padding:16, color:"#333", textAlign:"center", letterSpacing:2, fontSize:11 }}>
              NO EVENTS LOGGED — session clean since {new Date(sessionStartRef.current).toLocaleTimeString(undefined, { hour12: false })}
            </div>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ color:"#444", fontSize:10, letterSpacing:2 }}>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"left" }}>TIME</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"left" }}>TIMECODE</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"left" }}>RATE</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"left" }}>SRC</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"right" }}>LEVEL</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"right" }}>SNR</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"left" }}>EVENT</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"right" }}>COUNT</th>
                </tr>
              </thead>
              <tbody>
                {[...sessionLog].reverse().map((e, i) => (
                  <tr key={sessionLog.length - i} style={{ borderTop:"1px solid #111", color:"#999" }}>
                    <td style={{ padding:"3px 12px", color:"#555", textAlign:"left" }}>{new Date(e.t).toLocaleTimeString(undefined, { hour12: false })}</td>
                    <td style={{ padding:"3px 12px", color:"#00ff88", textAlign:"left" }}>
                      {e.from ? <>{e.from} <span style={{color:"#555"}}>→</span> {e.tc}</> : e.tc}
                    </td>
                    <td style={{ padding:"3px 12px", color:"#666", textAlign:"left" }}>{e.rate}</td>
                    <td style={{ padding:"3px 12px", color: e.source === "live" ? "#00ff88" : "#666", textAlign:"left" }}>{e.source}</td>
                    <td style={{ padding:"3px 12px", color:"#888", textAlign:"right" }}>{e.levelDbFS} dBFS</td>
                    <td style={{ padding:"3px 12px", color: e.snr == null ? "#333" : e.snr < 10 ? "#ff6600" : "#888", textAlign:"right" }}>
                      {e.snr == null ? "—" : `${e.snr.toFixed(1)} dB`}
                    </td>
                    <td style={{ padding:"3px 12px", color: logEntryClass(e) === "info" ? "#00ff88" : "#ff3b3b", textAlign:"left" }}>{e.errors.join(" · ")}</td>
                    <td style={{ padding:"3px 12px", color:"#888", textAlign:"right" }}>{e.count > 1 ? `×${e.count}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* SMPTE Spec Reference — bottom of page */}
      <div style={{ marginTop:12 }}>
        <SpecRefPanel />
      </div>

      <div style={{ marginTop:16, padding:"10px 0", textAlign:"center", fontSize:10, fontFamily:"monospace", color:"#444", letterSpacing:1 }}>
        v{__APP_VERSION__} · build {__GIT_COMMIT_COUNT__} · {__GIT_COMMIT__}
      </div>
    </div>
  );
}

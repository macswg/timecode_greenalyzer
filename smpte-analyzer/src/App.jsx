import { useState, useEffect, useRef, useCallback } from "react";
import { Publisher } from "./publisher";
import { MultiRateDecoder, rateKeyToNominalFps } from "./ltcDecoder";

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

// SMPTE ST 12-1 Level recommendations (dBFS for digital, dBu for analog)
const LEVEL_SPEC = {
  CLIP_THRESHOLD: -1,     // dBFS — above this = overload risk
  HOT_THRESHOLD: -6,      // dBFS — above this = hot, may cause read errors
  NOMINAL: -18,           // dBFS — SMPTE nominal level
  LOW_THRESHOLD: -30,     // dBFS — below this = may fail to lock
  SILENT_THRESHOLD: -60,  // dBFS — below this = dropout / no signal
};

// ─── Drop Frame helpers (SMPTE ST 12-1 §7) ───────────────────────────────────
// DF rule: at the start of each minute that is not a multiple of 10, the
// first `dropPerMin` frame numbers (00..dropPerMin-1) are skipped. The math
// below is the single source of truth for that rule.
//   29.97 DF → 30 fps nominal → skip 2 frames each minute (except every 10th)
//   59.94 DF → 60 fps nominal → skip 4 frames each minute (except every 10th)
function dropPerMin(nomFps) { return nomFps === 60 ? 4 : 2; }

function isValidDropFrame(hh, mm, ss, ff, nominalFps) {
  const maxFrame = nominalFps === 30 ? 29 : 59;
  if (hh > 23 || mm > 59 || ss > 59 || ff > maxFrame) return false;
  if (ss === 0 && mm % 10 !== 0 && ff < dropPerMin(nominalFps)) return false;
  return true;
}

// frames → HH:MM:SS:FF, applying DF skipping when requested.
function framesToTc(totalFrames, nomFps, dropFrame) {
  if (!dropFrame) {
    const ff = totalFrames % nomFps;
    const totalSec = Math.floor(totalFrames / nomFps);
    const ss = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    return {
      hh: Math.floor(totalMin / 60) % 24,
      mm: totalMin % 60,
      ss, ff,
    };
  }
  const drop = dropPerMin(nomFps);
  const framesPerMin = nomFps * 60 - drop;
  const framesPerTenMin = nomFps * 60 * 10 - drop * 9;
  const tenMins = Math.floor(totalFrames / framesPerTenMin);
  let rem = totalFrames % framesPerTenMin;
  const minsInChunk = Math.min(9, Math.floor((rem + drop) / framesPerMin));
  const mins = tenMins * 10 + minsInChunk;
  rem = rem - minsInChunk * framesPerMin + drop;
  if (mins % 10 !== 0) rem += drop;
  return {
    hh: Math.floor(mins / 60) % 24,
    mm: mins % 60,
    ss: Math.floor(rem / nomFps),
    ff: rem % nomFps,
  };
}

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

  const valleyBinsLin = [];
  for (let h = 0; h < 60; h++) {
    const fValley = (h + 0.5) * f1;
    if (fValley < 80) continue;
    if (fValley > nyquist * 0.95) break;
    const binIdx = Math.round(fValley / binWidth);
    if (binIdx >= 1 && binIdx < bins.length) {
      valleyBinsLin.push(Math.pow(10, bins[binIdx] / 10));
    }
  }
  if (valleyBinsLin.length === 0) return null;
  valleyBinsLin.sort((a, b) => a - b);
  const noiseFloorLin = valleyBinsLin[Math.floor(valleyBinsLin.length / 2)];
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
function formatTc(hh, mm, ss, ff, dropFrame) {
  return `${padTc(hh)}:${padTc(mm)}:${padTc(ss)}${dropFrame ? ";" : ":"}${padTc(ff)}`;
}

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
      <div className="lm-label" style={{ fontSize:12, color:"#888", fontFamily:"monospace", letterSpacing:2 }}>{label}</div>
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
      <div className="lm-value" style={{ fontSize:13, color, fontFamily:"monospace", textAlign:"right" }}>
        {value.toFixed(1)} dBFS
      </div>
    </div>
  );
}

function StatusBadge({ label, active, color="#ff3b3b", warn=false }) {
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
// LTC frame (per SMPTE ST 12-1 Table 2). Bits 64-79 are the fixed sync word
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
          return (
            <div key={i} title={`bit ${i}${isSync ? " (sync)" : ""}: ${bit ?? "—"}`} style={{
              width:"100%", aspectRatio:"1", background:cellBg,
              border:`1px solid ${bit == null ? "#1a1a1a" : isSync ? "#22d3ee55" : "#00ff8833"}`,
              borderRadius:1,
            }} />
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

// In live mode `candidateStatus` is the per-candidate score array from the
// MultiRateDecoder (real frames decoded / bit errors / lock state). Bars are
// drawn from those scores: the active candidate ramps from 0 toward 100% as
// it accumulates clean frames, while inactive candidates show how many
// frames their (wrong-rate) decode produced before being rejected.
// In sim mode `candidateStatus` is null and we fall back to a single-bar
// view of the picked rate.
function RateDetector({ rateKey, candidateStatus, confidence }) {
  const allRates = Object.keys(SMPTE_RATES);
  // Map candidate fps → status for quick lookup.
  const byFps = new Map((candidateStatus || []).map(s => [s.fps, s]));
  // For "rate key → candidate fps" we use the same mapping as the decoder.
  const keyToFps = (k) => {
    if (k === "59.94df" || k === "59.94" || k === "60") return 60;
    if (k === "50") return 50;
    if (k === "29.97df" || k === "29.97" || k === "30") return 30;
    if (k === "25") return 25;
    return 24;
  };
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      <div style={{ fontSize:11, color:"#555", fontFamily:"monospace", letterSpacing:2, marginBottom:2 }}>RATE DETECTION</div>
      {allRates.map(r => {
        const active = r === rateKey;
        let pct = 0;
        if (candidateStatus) {
          // Live: derive bar from the candidate decoder's real frame count.
          // 60 frames ≈ 2 s of clean LTC → bar full.
          const s = byFps.get(keyToFps(r));
          const frames = s?.framesDecoded ?? 0;
          pct = Math.min(100, frames * (100 / 60));
        } else if (active) {
          // Sim: only the picked rate has a meaningful confidence value.
          pct = confidence;
        }
        const color = active ? "#00ff88" : pct > 5 ? "#3a3a3a" : "#222";
        return (
          <div key={r} style={{ display:"flex", alignItems:"center", gap:8, lineHeight:1.4 }}>
            <span style={{ fontSize:13, fontFamily:"monospace", color: active ? "#00ff88" : "#333", width:80, lineHeight:1.4 }}>
              {SMPTE_RATES[r].label}
            </span>
            <div style={{ flex:1, height:4, background:"#111", borderRadius:2 }}>
              <div style={{
                height:"100%", borderRadius:2,
                width:`${pct}%`,
                background: color,
                boxShadow: active ? "0 0 6px #00ff8866" : "none",
                transition:"width 0.3s",
              }} />
            </div>
            {active && <span style={{ fontSize:10, color:"#00ff88", fontFamily:"monospace" }}>●</span>}
          </div>
        );
      })}
    </div>
  );
}

function SpecRefPanel() {
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
      <div style={{ color:"#ff9900", letterSpacing:2, fontSize:13, marginBottom:8 }}>SMPTE SPEC REFERENCE</div>
      <div>ST 12-1:2014 — Linear Timecode (LTC)</div>
      <div style={{ marginTop:6, color:"#333" }}>LEVEL THRESHOLDS (digital):</div>
      <div>Nominal ........... {LEVEL_SPEC.NOMINAL} dBFS</div>
      <div>Hot (error risk) .. {LEVEL_SPEC.HOT_THRESHOLD} dBFS</div>
      <div>Clip threshold .... {LEVEL_SPEC.CLIP_THRESHOLD} dBFS</div>
      <div>Min readable ...... {LEVEL_SPEC.LOW_THRESHOLD} dBFS</div>
      <div>Dropout ........... {LEVEL_SPEC.SILENT_THRESHOLD} dBFS</div>
      <div style={{ marginTop:6, color:"#333" }}>LTC FRAME STRUCTURE:</div>
      <div>80 bits/frame, biphase mark</div>
      <div>Sync word bits 64–79: 0011111111111101</div>
      <div>Drop frame: skip fr 0,1 at min start</div>
      <div>Except every 10th minute</div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>SNR (dB)</div>
      <div style={{ color:"#555" }}>
        Band-limited signal-to-noise ratio: total power in the LTC fundamentals
        band [0.4–1.6 × bitRate], divided by the noise-floor power projected
        across that same band width. The noise floor is sampled at biphase
        mark's spectral nulls — frequencies exactly halfway between
        consecutive LTC harmonics — where the signal has no energy by
        construction. Computed only when locked; "—" otherwise. Display is
        EMA-smoothed (~1 Hz) to reduce per-tick jitter.
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
      <div style={{ color:"#555" }}>
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
      <div style={{ color:"#555" }}>
        Two readings of the input's sample rate.
        <br/><span style={{color:"#777"}}>nominal</span> — the device's declared
        rate (browser getSettings().sampleRate, else the audio engine's fixed
        rate); a reported integer, updates per connected input.
        <br/><span style={{color:"#777"}}>measured</span> — the true sample-delivery
        rate, counted from the capture worklet over wall-clock time.
        <br/>Web Audio resamples the input into one long-lived context, so
        measured tracks the context clock; a gap between the two usually means
        the OS is resampling the device, not a fault.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>CLOCK DRIFT (ppm)</div>
      <div style={{ color:"#555" }}>
        Deviation of the measured frame period from the exact expected period
        for the detected SMPTE rate (integer or 1.001-divided NTSC), expressed
        in parts per million. EMA-smoothed for steadiness. It is a steady
        FREQUENCY OFFSET between the source and our capture clock — it does NOT
        affect chasing/resolving, which slave to whatever rate arrives and
        absorb a constant offset of even a few hundred ppm. Chase-ability is
        governed by DROPOUT RATE and CONTINUITY, not drift.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        digital / genlocked source ≈ 0 ppm,
        free-running generator ±50–150 ppm (normal, chaseable).
        <br/><span style={{color:"#777"}}>Status thresholds:</span>{" "}
        &lt;5 ppm LOCKED green, 5–500 OFFSET · OK TO CHASE cyan,
        &gt;500 CHECK RATE amber (large enough to imply a mis-detected rate).
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>DROPOUT RATE (%)</div>
      <div style={{ color:"#555" }}>
        Percentage of expected frames that weren't successfully decoded over a
        rolling 2-second window:
        100 × (1 − decoded_frames / (window_sec × detected_fps)).
        Distinguishes a clean signal from one with occasional or serious
        dropouts. EMA-smoothed.
        <br/><span style={{color:"#777"}}>Expected for LTC:</span>{" "}
        clean digital source &lt; 1% (every frame decoded),
        analog tape with minor head wear 1–5%,
        worn / damaged tape 5–20%,
        signal severely degraded &gt; 50%,
        no signal in window = 100%.
        <br/><span style={{color:"#777"}}>Status thresholds:</span>{" "}
        &lt;1% CLEAN green, 1–10% OCCASIONAL orange, 10–50% FREQUENT amber,
        &gt;50% SEVERE red.
      </div>
      <div style={{ marginTop:12, color:"#ff9900", letterSpacing:2, fontSize:13 }}>CONTINUITY</div>
      <div style={{ color:"#555" }}>
        Consecutive in-order LTC frames must differ by exactly one frame
        (with drop-frame rules applied at minute boundaries per ST 12-1 §7).
        Anything else is a continuity break:
        <br/><span style={{color:"#777"}}>REPEAT</span> — same frame
        decoded twice (delta = 0). Typically from a freeze-frame in source
        playback.
        <br/><span style={{color:"#777"}}>JUMP</span> — TC advanced by more
        than one frame (delta &gt; 1). From edit splices, dropouts, or skips.
        <br/><span style={{color:"#777"}}>REWIND</span> — TC went backwards
        (delta &lt; 0). From player rewinds, freewheel resets, or non-
        monotonic generators.
        <br/>The break counter persists until lock is lost for ≥500 ms; gaps
        from temporary signal loss do not count. Each break is also written
        to the session log and broadcast over the API publisher as a
        `continuity` message.
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
  const [sessionLog, setSessionLog] = useState([]);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafRef = useRef(null);
  const peakDecayRef = useRef(-60);
  const lastErrSigRef = useRef("");
  const lastBreakTRef = useRef(0);
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
  const [playingFile, setPlayingFile] = useState(null); // { name, durationSec, loop }
  const [fileLoading, setFileLoading] = useState(false);
  const [fileDragOver, setFileDragOver] = useState(false);

  const LOG_CAP = 1000;
  function pushLog(entry) {
    setSessionLog(prev => {
      const next = prev.length >= LOG_CAP ? prev.slice(prev.length - LOG_CAP + 1) : prev;
      return [...next, entry];
    });
  }

  const tick = useCallback(() => {
    // During the bootstrap window we don't yet know which mode to render —
    // skip the simulator so the user doesn't see a flash of wall-clock TC.
    if (bootstrapping) return;
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
    const data = generateSimulatedAnalysis(effectiveRate, lvl, nz, dp);
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
        const m = computeLtcSpectralMetrics(analyserRef.current, sampleRateRef.current, dec.nominalFps);
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
      if (fresh) {
        data.hh = lf.hh; data.mm = lf.mm; data.ss = lf.ss; data.ff = lf.ff;
        data.dropFrame = lf.dropFrame;
        data.colorFrame = lf.colorFrame;
        data.frameValid = true;
      } else {
        data.hh = 0; data.mm = 0; data.ss = 0; data.ff = 0;
        data.colorFrame = false;
        data.frameValid = false;
      }
      data.ltcLocked = !!fresh;
      data.detectedRateKey = dec?.detectedRateKey() ?? null;
      data.detectedFps = dec?.nominalFps ?? null;
      data.framesDecoded = dec?.framesDecoded ?? 0;
      data.bitErrors = dec?.bitErrors ?? 0;
      data.lastFrameBits = dec?.lastFrameBits ?? null;
      data.candidateStatus = dec?.candidateStatus() ?? null;
      data.continuityBreaks = dec?.continuityBreaks ?? 0;
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
      // LOW / DROPOUT both imply "there is (or was) a signal that's now
      // weak or gone". Suppress them when the input is just idle (silent
      // device, nothing routed) so switching to e.g. BlackHole doesn't
      // light up the tags. A signal counts as present if level is above
      // the silent threshold OR a frame decoded within the last 2 s.
      const lastDecodeAge = dec?.lastFrame ? performance.now() - dec.lastFrame.t : Infinity;
      const hasSignal = lvl >= LEVEL_SPEC.SILENT_THRESHOLD || lastDecodeAge < 2000;
      if (lvl < LEVEL_SPEC.LOW_THRESHOLD && hasSignal) live.push("LOW");
      if (lvl < LEVEL_SPEC.SILENT_THRESHOLD && lastDecodeAge < 2000) live.push("DROPOUT");
      data.errors = live;
      data.frameValid = fresh && live.length === 0;
    }
    setAnalysis(data);
    setFrameCount(c => c + 1);
    if (data.errors.length > 0) setErrorCount(c => c + 1);

    const sig = data.errors.join(",");
    const tcStr = formatTc(data.hh, data.mm, data.ss, data.ff, data.dropFrame);
    if (sig && sig !== lastErrSigRef.current) {
      pushLog({
        t: Date.now(),
        tc: tcStr,
        rate: rateKey,
        errors: [...data.errors],
        levelDbFS: +lvl.toFixed(2),
        source: useRealAudio ? "live" : "sim",
      });
    }
    if (sig !== lastErrSigRef.current && publisherRef.current && sig) {
      publisherRef.current.send({
        type: "error", t: Date.now(), tc: tcStr,
        rate: rateKey, errors: [...data.errors],
      });
    }
    lastErrSigRef.current = sig;

    // Log and publish continuity breaks as they happen.
    const lb = data.lastBreak;
    if (lb && lb.t !== lastBreakTRef.current) {
      lastBreakTRef.current = lb.t;
      pushLog({
        t: Date.now(),
        tc: lb.to,
        rate: rateKey,
        errors: [`TC_${lb.type}`, `${lb.delta > 0 ? "+" : ""}${lb.delta}`],
        levelDbFS: +lvl.toFixed(2),
        source: useRealAudio ? "live" : "sim",
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
        source: useRealAudio ? "live" : "sim",
        levelDbFS: +lvl.toFixed(2),
        errors: data.errors,
      });
    }

    // Peak hold with decay
    peakDecayRef.current = Math.max(peakDecayRef.current - 0.3, data.peakDbFS);
    setPeakHold(peakDecayRef.current);
  }, [rateKey, levelDbFS, noiseLevel, dropoutProb, useRealAudio, bootstrapping]);

  useEffect(() => { tickRef.current = tick; }, [tick]);

  // Reset the displayed detection state every time we switch modes, so the
  // detected rate / lock confidence visibly clear and re-acquire instead of
  // appearing to carry over from the previous session.
  useEffect(() => {
    setAnalysis(null);
    setPeakHold(-60);
    peakDecayRef.current = -60;
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

  // Wires a source node into a fresh analyser + worklet + decoder on the
  // shared AudioContext. Returns the new analyser and worklet so callers
  // can stash them. Used by both the live-mic and file-playback paths.
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
    worklet.port.onmessage = (e) => {
      decoder.feed(e.data, sampleRateRef.current);
      const sc = sampleClockRef.current;
      sc.n += e.data.length;
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
    if (!sp || !an || !wk) return;
    try { sp.disconnect(); } catch {}
    sp.connect(an, idx);
    sp.connect(wk, idx);
    // The decoder self-heals on the new channel: with no fresh frames it
    // unlocks after ~200 ms and the windowed metrics decay on their own.
  }

  // Tear down whatever source is currently feeding the decoder so a new one
  // can be wired up cleanly.
  function teardownCurrentSource() {
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
      const { analyser, worklet } = wireSourceToDecoder(ctx, source, audioBuffer.numberOfChannels);
      source.start();

      bufferSourceRef.current = source;
      analyserRef.current = analyser;
      workletNodeRef.current = worklet;
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

  function clearLog() {
    setSessionLog([]);
    setErrorCount(0);
    lastErrSigRef.current = "";
    sessionStartRef.current = Date.now();
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
      frameCount, errorCount,
      entries: sessionLog.map(e => ({ ...e, t: new Date(e.t).toISOString() })),
    };
    downloadFile(`ltc-session-${Date.now()}.json`, "application/json", JSON.stringify(payload, null, 2));
  }

  function exportCSV() {
    const header = "timestamp,timecode,rate,source,levelDbFS,errors";
    const rows = sessionLog.map(e =>
      `${new Date(e.t).toISOString()},${e.tc},${e.rate},${e.source},${e.levelDbFS},${e.errors.join("|")}`
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
            ST 12-1:2014 COMPLIANT · LTC
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
            const shownRateKey = bootstrapping
              ? null
              : liveMode
                ? (ltcLocked ? analysis?.detectedRateKey : null)
                : rateKey;
            const isDf = shownRateKey ? !!SMPTE_RATES[shownRateKey]?.dropFrame : false;
            // Blue for non-drop (avoids visual confusion with the green
            // "frame valid" digit color); orange (matches DF badge) for DF.
            const rateColor = isDf ? "#ffaa00" : "#3b9cff";
            const rateGlow = isDf ? "rgba(255,170,0,0.4)" : "rgba(59,156,255,0.4)";
            return (
          <div className="tc-meta" style={{ display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
            <div style={{
              fontFamily:"'Orbitron', monospace",
              fontSize:20, color: rateColor,
              textShadow: `0 0 12px ${rateGlow}`,
              letterSpacing:2,
              transition: "color 0.2s, text-shadow 0.2s",
            }}>
              {shownRateKey ? SMPTE_RATES[shownRateKey].label : (liveMode ? "" : "— —")}
              {!bootstrapping && liveMode && (
                <span style={{ fontSize:11, color:"#22d3ee", letterSpacing:3, marginLeft: ltcLocked ? 8 : 0 }}>
                  {ltcLocked ? "DETECTED" : "DETECTING…"}
                </span>
              )}
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"flex-end" }}>
              <StatusBadge label="LOCK" active={!bootstrapping && analysis?.frameValid === true} color="#00ff88" />
              <StatusBadge label="DF" active={tc.dropFrame} color="#ffaa00" />
              <StatusBadge label="CF" active={tc.colorFrame} color="#8888ff" />
            </div>
          </div>
            );
          })()}
        </div>
      </div>

      {/* Error Badges */}
      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:16 }}>
        {["CLIP","HOT","LOW","DROPOUT","NOISE"].map(e => (
          <StatusBadge
            key={e} label={e}
            active={analysis?.errors?.includes(e)}
            color={e==="CLIP"?"#ff0000":e==="HOT"?"#ff6600":e==="LOW"?"#ff9900":e==="DROPOUT"?"#ff3399":"#cc88ff"}
            warn={true}
          />
        ))}
        <div style={{ marginLeft:"auto", fontSize:11, fontFamily:"monospace", color:"#333", alignSelf:"center", letterSpacing:2 }}>
          {hasErrors ? `⚠ ${analysis.errors.join(" · ")} DETECTED` : "● ALL PARAMETERS NOMINAL"}
        </div>
      </div>

      <div className="three-col" style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>

        {/* Level Section */}
        <div className="panel-level" style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:6 }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>SIGNAL LEVEL</div>
          <LevelMeter label="RMS" value={analysis?.levelDbFS ?? levelDbFS} peak={peakHold} />
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
            <div style={{ fontSize:11, color:"#22d3ee", letterSpacing:3, marginBottom:4 }}>LIVE INPUT STATUS</div>
            <div style={{ display:"grid", gridTemplateColumns:"auto 1fr", gap:"10px 18px", fontSize:13, fontFamily:"monospace" }}>
              <span style={{ color:"#555", letterSpacing:2 }}>DETECTED RATE</span>
              <span style={{ color: analysis?.detectedRateKey ? "#22d3ee" : "#666" }}>
                {analysis?.detectedRateKey ? SMPTE_RATES[analysis.detectedRateKey].label : "— detecting —"}
              </span>
              <span style={{ color:"#555", letterSpacing:2 }}>LOCK STATE</span>
              <span style={{ color: ltcLocked ? "#00ff88" : "#888" }}>
                {ltcLocked ? "● LOCKED" : "○ NO SIGNAL"}
              </span>
              <span style={{ color:"#555", letterSpacing:2 }}>FRAMES DECODED</span>
              <span style={{ color:"#ccc" }}>{analysis?.framesDecoded ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>BIT ERRORS</span>
              <span style={{ color: (analysis?.bitErrors ?? 0) > 0 ? "#ff9900" : "#ccc" }}>{analysis?.bitErrors ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>SAMPLE RATE</span>
              <span style={{ color:"#666" }}>
                {playingFile?.nativeSampleRate
                  ? `${playingFile.nativeSampleRate} Hz file · ${playingFile.decoderSampleRate} Hz decoded`
                  : measuredSampleRate != null
                    ? `${measuredSampleRate} Hz measured · ${deviceSampleRate || sampleRateRef.current} Hz nominal`
                    : `${deviceSampleRate || sampleRateRef.current} Hz nominal`}
              </span>
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
                const status = abs < 5 ? "LOCKED" : abs < 500 ? "OFFSET · OK TO CHASE" : "CHECK RATE";
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
              <span style={{ color:"#555", letterSpacing:2 }}>CONTINUITY</span>
              {(() => {
                const breaks = analysis?.continuityBreaks ?? 0;
                const last = analysis?.lastBreak;
                if (breaks === 0) {
                  return <span style={{ color:"#00ff88" }}>● CONTINUOUS · 0 BREAKS</span>;
                }
                const sign = last?.delta > 0 ? "+" : "";
                const detail = last
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
          </div>
        ) : (
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3, marginBottom:4 }}>SIMULATION CONTROLS</div>

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
        </div>
        )}
        </div>
      </div>

      {/* Session log */}
      <div style={{ marginTop:12, ...PANEL }}>
        <div className="session-toolbar" style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", borderBottom:"1px solid #1a1a1a", flexWrap:"wrap" }}>
          <div style={{ fontSize:11, color:"#ff9900", letterSpacing:3 }}>SESSION LOG</div>
          <div style={{ fontSize:11, color:"#555", letterSpacing:2 }}>
            {sessionLog.length} ENTR{sessionLog.length === 1 ? "Y" : "IES"} · {errorCount} ERROR EVENTS · {frameCount} FRAMES
          </div>
          <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
            {[
              { label:"⇩ CSV", onClick: exportCSV, color:"#00ff88" },
              { label:"⇩ JSON", onClick: exportJSON, color:"#00ff88" },
              { label:"✕ CLEAR", onClick: clearLog, color:"#ff3b3b" },
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
              NO ERRORS LOGGED — session clean since {new Date(sessionStartRef.current).toLocaleTimeString()}
            </div>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ color:"#444", fontSize:10, letterSpacing:2, textAlign:"left" }}>
                  <th style={{ padding:"4px 12px", fontWeight:"normal" }}>TIME</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal" }}>TIMECODE</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal" }}>RATE</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal" }}>SRC</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal", textAlign:"right" }}>LEVEL</th>
                  <th style={{ padding:"4px 12px", fontWeight:"normal" }}>ERRORS</th>
                </tr>
              </thead>
              <tbody>
                {[...sessionLog].reverse().map((e, i) => (
                  <tr key={sessionLog.length - i} style={{ borderTop:"1px solid #111", color:"#999" }}>
                    <td style={{ padding:"3px 12px", color:"#555" }}>{new Date(e.t).toLocaleTimeString()}</td>
                    <td style={{ padding:"3px 12px", color:"#00ff88" }}>{e.tc}</td>
                    <td style={{ padding:"3px 12px", color:"#666" }}>{e.rate}</td>
                    <td style={{ padding:"3px 12px", color: e.source === "live" ? "#00ff88" : "#666" }}>{e.source}</td>
                    <td style={{ padding:"3px 12px", color:"#888", textAlign:"right" }}>{e.levelDbFS} dBFS</td>
                    <td style={{ padding:"3px 12px", color:"#ff3b3b" }}>{e.errors.join(" · ")}</td>
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
    </div>
  );
}

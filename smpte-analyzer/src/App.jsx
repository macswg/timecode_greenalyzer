import { useState, useEffect, useRef, useCallback } from "react";
import { Publisher } from "./publisher";
import { MultiRateDecoder, rateKeyToNominalFps } from "./ltcDecoder";

// ─── SMPTE Timecode Spec Constants ──────────────────────────────────────────
// Per SMPTE ST 12-1:2014 and ST 12-2:2014
const SMPTE_RATES = {
  "23.976": { fps: 24000 / 1001, dropFrame: false, label: "23.976 ND" },
  "24":     { fps: 24,           dropFrame: false, label: "24 ND" },
  "25":     { fps: 25,           dropFrame: false, label: "25 ND" },
  "29.97df":{ fps: 30000 / 1001, dropFrame: true,  label: "29.97 DF" },
  "29.97":  { fps: 30000 / 1001, dropFrame: false, label: "29.97 ND" },
  "30":     { fps: 30,           dropFrame: false, label: "30 ND" },
  "47.95":  { fps: 48000 / 1001, dropFrame: false, label: "47.95 ND" },
  "48":     { fps: 48,           dropFrame: false, label: "48 ND" },
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

// Estimate LTC signal-to-noise ratio in dB from the AnalyserNode's spectrum.
// LTC at N fps has bit rate N*80; biphase produces fundamentals at the bit
// rate (consecutive 1s) and half the bit rate (consecutive 0s), plus
// harmonics. We sum spectral power in that band and compare to the average
// power outside it. Returns null if the spectrum is empty (silence).
let _snrBins = null;
function computeLtcSnr(analyser, sampleRate, nominalFps) {
  if (!_snrBins || _snrBins.length !== analyser.frequencyBinCount) {
    _snrBins = new Float32Array(analyser.frequencyBinCount);
  }
  const bins = _snrBins;
  analyser.getFloatFrequencyData(bins);   // dB values, typically -100..0
  const binWidth = (sampleRate / 2) / bins.length;
  const bitRate = nominalFps * 80;
  const fLow = bitRate * 0.4;
  const fHigh = bitRate * 1.6;

  let inPow = 0, outPow = 0, inN = 0, outN = 0;
  for (let i = 1; i < bins.length; i++) {
    const f = i * binWidth;
    if (f < 80 || f > sampleRate * 0.45) continue; // ignore DC drift and near-Nyquist
    const p = Math.pow(10, bins[i] / 10);
    if (f >= fLow && f <= fHigh) { inPow += p; inN++; }
    else { outPow += p; outN++; }
  }
  if (inN === 0 || outN === 0 || outPow <= 0 || inPow <= 0) return null;
  // Compare average power per bin so band widths don't bias the ratio.
  return 10 * Math.log10((inPow / inN) / (outPow / outN));
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
      fontFamily: "'Share Tech Mono', 'Courier New', monospace",
      fontSize: "clamp(32px, 6vw, 72px)",
      letterSpacing: "0.05em",
      color, textShadow,
      transition: "color 0.1s, text-shadow 0.1s",
      fontWeight: 400,
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
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      <div style={{ fontSize:10, color:"#888", fontFamily:"monospace", letterSpacing:2 }}>{label}</div>
      <div style={{ position:"relative", height:14, background:"#0a0a0a", border:"1px solid #222", borderRadius:2 }}>
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
      <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#444", fontFamily:"monospace" }}>
        {markers.filter((_,i)=>i%2===0).map(db => (
          <span key={db} style={{ position:"relative", left: db===-60?0:0 }}>{db}</span>
        ))}
      </div>
      <div style={{ fontSize:11, color, fontFamily:"monospace", textAlign:"right" }}>
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
      fontSize:11,
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
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
        <span style={{ fontSize:9, color:"#666", fontFamily:"monospace", letterSpacing:2 }}>{label}</span>
        <span style={{ fontSize:13, color, fontFamily:"monospace" }}>
          {hasValue ? `${value.toFixed(1)}${unit}` : "—"}
        </span>
      </div>
      <div style={{ height:4, background:"#111", borderRadius:2, border:"1px solid #1a1a1a" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:2, boxShadow:`0 0 6px ${color}88`, transition:"width 0.1s" }} />
      </div>
    </div>
  );
}

function BitStreamView({ errors, frameCount }) {
  const size = 64;
  const blocks = Array.from({length: size}, (_, i) => ({
    error: Math.random() < (errors.length > 0 ? 0.08 : 0.005),
  }));
  return (
    <div>
      <div style={{ fontSize:9, color:"#555", fontFamily:"monospace", letterSpacing:2, marginBottom:6 }}>BIT INTEGRITY MAP</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:2 }}>
        {blocks.map((b, i) => (
          <div key={i} style={{
            width:7, height:7,
            background: b.error ? "#ff3b3b" : "#00ff8822",
            border:`1px solid ${b.error ? "#ff3b3b44" : "#00ff8811"}`,
            borderRadius:1,
          }} />
        ))}
      </div>
      <div style={{ marginTop:6, fontSize:9, color:"#444", fontFamily:"monospace" }}>
        {blocks.filter(b=>b.error).length} / {size} BIT ERRORS DETECTED
      </div>
    </div>
  );
}

function RateDetector({ rateKey, confidence, dropFrame }) {
  const allRates = Object.keys(SMPTE_RATES);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
      <div style={{ fontSize:9, color:"#555", fontFamily:"monospace", letterSpacing:2, marginBottom:4 }}>RATE DETECTION</div>
      {allRates.map(r => {
        const active = r === rateKey;
        const bar = active ? confidence : Math.random() * 5;
        return (
          <div key={r} style={{ display:"flex", alignItems:"center", gap:8 }}>
            <span style={{ fontSize:9, fontFamily:"monospace", color: active ? "#00ff88" : "#333", width:70 }}>
              {SMPTE_RATES[r].label}
            </span>
            <div style={{ flex:1, height:4, background:"#111", borderRadius:2 }}>
              <div style={{
                height:"100%", borderRadius:2,
                width:`${active ? confidence : Math.random()*8}%`,
                background: active ? "#00ff88" : "#222",
                boxShadow: active ? "0 0 6px #00ff8866" : "none",
                transition:"width 0.3s",
              }} />
            </div>
            {active && <span style={{ fontSize:8, color:"#00ff88", fontFamily:"monospace" }}>●</span>}
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
      padding:12,
      background:"#080808",
      fontSize:9,
      fontFamily:"monospace",
      color:"#444",
      lineHeight:1.7,
    }}>
      <div style={{ color:"#ff9900", letterSpacing:2, fontSize:9, marginBottom:8 }}>SMPTE SPEC REFERENCE</div>
      <div>ST 12-1:2014 — Linear Timecode (LTC)</div>
      <div>ST 12-2:2014 — Timecode for 1125-Line HDTV</div>
      <div>ST 2059 — Sync of IP Media Transport</div>
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
      <div style={{ marginTop:10, color:"#ff9900", letterSpacing:2, fontSize:9 }}>SNR (dB)</div>
      <div style={{ color:"#555" }}>
        Logarithmic ratio of LTC-band signal power to out-of-band power
        (20·log₁₀ signal/noise). Computed only when locked to incoming LTC —
        shown as "—" otherwise, since SNR is undefined without a signal.
        Rough guide: 20 dB = signal 10× noise, 40 dB clean, 60 dB broadcast-clean.
      </div>
      <div style={{ marginTop:10, color:"#ff9900", letterSpacing:2, fontSize:9 }}>THD (%)</div>
      <div style={{ color:"#555" }}>
        Total Harmonic Distortion — energy in unwanted harmonics of the LTC
        fundamentals as a percentage of the fundamental's energy. Caused by
        clipping, tape saturation, or non-linear gain stages, which round off
        LTC's square edges and degrade biphase timing. Computed only when
        locked. Rough guide: &lt;1% clean, 1–2% acceptable, &gt;3% likely to cause
        bit errors.
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
  const sessionStartRef = useRef(Date.now());
  const publisherRef = useRef(null);
  const tickRef = useRef(null);
  const decoderRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sampleRateRef = useRef(48000);
  const timeBufRef = useRef(null);

  const [apiUrl, setApiUrl] = useState("ws://localhost:8765/ingest");
  const [apiEnabled, setApiEnabled] = useState(false);
  const [apiState, setApiState] = useState("idle");
  const [apiSubscribers, setApiSubscribers] = useState(0);
  const [audioDevices, setAudioDevices] = useState([]);
  const [currentDeviceId, setCurrentDeviceId] = useState(null);
  const [currentDeviceLabel, setCurrentDeviceLabel] = useState("");
  const streamRef = useRef(null);

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
      nz = Math.max(0, Math.min(1, (linearToDB(rms) - linearToDB(peak) + 30) / 30));
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

      // Real SNR estimate: only meaningful when we're actually locked to
      // LTC. Compare spectral energy in the LTC band (around the bit-rate
      // fundamentals) to energy outside it. With no signal locked,
      // there's no defined SNR — leave it null so the gauge shows "—".
      if (fresh && analyserRef.current && dec?.nominalFps) {
        data.snr = computeLtcSnr(analyserRef.current, sampleRateRef.current, dec.nominalFps);
      } else {
        data.snr = null;
        data.thd = null;
      }
      if (fresh) {
        data.hh = lf.hh; data.mm = lf.mm; data.ss = lf.ss; data.ff = lf.ff;
        data.dropFrame = lf.dropFrame;
        data.frameValid = true;
      } else {
        data.hh = 0; data.mm = 0; data.ss = 0; data.ff = 0;
        data.frameValid = false;
      }
      data.ltcLocked = !!fresh;
      data.detectedRateKey = dec?.detectedRateKey() ?? null;
      data.detectedFps = dec?.nominalFps ?? null;
      data.framesDecoded = dec?.framesDecoded ?? 0;
      data.bitErrors = dec?.bitErrors ?? 0;
      data.rateKey = effectiveRate;
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

  async function startAudioCapture(deviceId) {
    try {
      // Disconnect any previous source/worklet so we can rebuild them on the
      // same context. Stop the previous stream so the OS releases the device.
      if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch {} sourceRef.current = null; }
      if (workletNodeRef.current) { try { workletNodeRef.current.disconnect(); } catch {} workletNodeRef.current = null; }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      const constraints = {
        audio: {
          echoCancellation: false, noiseSuppression: false, autoGainControl: false,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      const settings = track?.getSettings?.() || {};
      setCurrentDeviceId(settings.deviceId || deviceId || null);
      setCurrentDeviceLabel(track?.label || "Unknown input");
      refreshAudioDevices();

      const ctx = await getOrCreateAudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      // numberOfOutputs:0 makes the worklet a pure sink — process() runs as
      // long as inputs are flowing, and we never touch ctx.destination, so
      // no output stream is opened on the context. (Connecting to
      // ctx.destination would cause macOS Core Audio to switch the system
      // output when opening an input on an audio interface.)
      const worklet = new AudioWorkletNode(ctx, "ltc-capture", { numberOfOutputs: 0 });
      const decoder = new MultiRateDecoder();
      decoderRef.current = decoder;
      worklet.port.onmessage = (e) => {
        decoder.feed(e.data, sampleRateRef.current);
      };
      source.connect(worklet);

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
    if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch {} sourceRef.current = null; }
    if (workletNodeRef.current) { try { workletNodeRef.current.disconnect(); } catch {} workletNodeRef.current = null; }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (audioCtxRef.current && audioCtxRef.current.state === "running") {
      try { audioCtxRef.current.suspend(); } catch { /* ignore */ }
    }
    analyserRef.current = null;
    decoderRef.current = null;
    setCurrentDeviceId(null);
    setCurrentDeviceLabel("");
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
  const confidence = liveMode
    ? (ltcLocked
        ? Math.min(99.5, 100 * (analysis.framesDecoded || 0) / ((analysis.framesDecoded || 0) + (analysis.bitErrors || 0) + 1))
        : 0)
    : (analysis ? Math.max(0, 100 - (analysis.errors?.length ?? 0) * 18) : 0);
  const detectorRateKey = liveMode ? (analysis?.detectedRateKey ?? null) : rateKey;

  return (
    <div style={{
      minHeight:"100vh",
      background:"#050505",
      color:"#ccc",
      fontFamily:"monospace",
      padding:"20px",
      boxSizing:"border-box",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@400;700&display=swap');
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
      `}</style>

      {/* Scanline overlay */}
      <div style={{
        position:"fixed", inset:0, pointerEvents:"none", zIndex:100,
        background:"repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,0,0,0.03) 2px, rgba(0,0,0,0.03) 4px)",
      }} />

      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:20 }}>
        <div>
          <div style={{
            fontFamily:"'Orbitron', monospace",
            fontSize:"clamp(14px,2.5vw,22px)",
            color:"#00ff88",
            letterSpacing:4,
            textShadow:"0 0 20px rgba(0,255,136,0.3)",
          }}>SMPTE TIMECODE ANALYZER</div>
          <div style={{ fontSize:9, color:"#333", letterSpacing:3, marginTop:2 }}>
            ST 12-1:2014 / ST 12-2:2014 COMPLIANT · LTC / VITC
          </div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:9, fontFamily:"monospace", color:"#333", letterSpacing:2 }}>FRAMES ANALYZED</div>
          <div style={{ fontSize:18, fontFamily:"'Share Tech Mono'", color:"#555" }}>
            {frameCount.toLocaleString()}
          </div>
          <div style={{ fontSize:9, color: errorCount > 0 ? "#ff5500" : "#333", letterSpacing:2 }}>
            {errorCount} ERRORS
          </div>
        </div>
      </div>

      {/* Main TC Display */}
      {bootstrapping && (
        <div style={{
          fontSize:10, fontFamily:"monospace", letterSpacing:4,
          color:"#666",
          marginBottom:6,
        }}>
          ○ STARTING — requesting audio input…
        </div>
      )}
      {!bootstrapping && simMode && (
        <div style={{
          fontSize:10, fontFamily:"monospace", letterSpacing:4,
          color:"#d946ef", textShadow:"0 0 8px rgba(217,70,239,0.5)",
          animation:"blink 1.4s infinite",
          marginBottom:6,
        }}>
          ▲ SIMULATING CODE
        </div>
      )}
      {!bootstrapping && liveMode && (
        <div style={{
          fontSize:10, fontFamily:"monospace", letterSpacing:4,
          color: ltcLocked ? "#22d3ee" : "#888",
          textShadow: ltcLocked ? "0 0 8px rgba(34,211,238,0.5)" : "none",
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

        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:16 }}>
          <TimecodeDisplay
            hh={tc.hh} mm={tc.mm} ss={tc.ss} ff={tc.ff}
            dropFrame={tc.dropFrame}
            rateKey={analysis?.rateKey ?? rateKey}
            valid={analysis?.frameValid !== false}
            dim={bootstrapping}
          />
          <div style={{ display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
            <div style={{
              fontFamily:"'Orbitron', monospace",
              fontSize:20, color:"#ffaa00",
              textShadow:"0 0 12px rgba(255,170,0,0.4)",
              letterSpacing:2,
            }}>
              {bootstrapping
                ? ""
                : liveMode
                  ? (ltcLocked && analysis?.detectedRateKey
                      ? SMPTE_RATES[analysis.detectedRateKey].label
                      : "")
                  : (SMPTE_RATES[rateKey]?.label ?? "— —")}
              {!bootstrapping && liveMode && (
                <span style={{ fontSize:9, color:"#22d3ee", letterSpacing:3, marginLeft: ltcLocked ? 8 : 0 }}>
                  {ltcLocked ? "DETECTED" : "DETECTING…"}
                </span>
              )}
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"flex-end" }}>
              <StatusBadge label="LOCK" active={!bootstrapping && analysis?.frameValid !== false} color="#00ff88" />
              <StatusBadge label="DF" active={tc.dropFrame} color="#ffaa00" />
              <StatusBadge label="CF" active={tc.colorFrame} color="#8888ff" />
            </div>
          </div>
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
        <div style={{ marginLeft:"auto", fontSize:9, fontFamily:"monospace", color:"#333", alignSelf:"center", letterSpacing:2 }}>
          {hasErrors ? `⚠ ${analysis.errors.join(" · ")} DETECTED` : "● ALL PARAMETERS NOMINAL"}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:12, marginBottom:12 }}>

        {/* Level Section */}
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>SIGNAL LEVEL</div>
          <LevelMeter label="RMS" value={analysis?.levelDbFS ?? levelDbFS} peak={peakHold} />
          <LevelMeter label="PEAK" value={analysis?.peakDbFS ?? levelDbFS + 2} peak={peakHold} />
          <div style={{ height:"1px", background:"#111" }} />
          <Gauge label="SNR" value={analysis?.snr} min={0} max={80} unit=" dB"
            thresholds={[{above:0,color:"#ff3b3b"},{above:20,color:"#ffaa00"},{above:40,color:"#ccff33"},{above:50,color:"#00ff88"}]} />
          <Gauge label="THD" value={analysis?.thd} min={0} max={5} unit="%"
            thresholds={[{above:0,color:"#00ff88"},{above:1,color:"#ccff33"},{above:2,color:"#ffaa00"},{above:3,color:"#ff3b3b"}]} />
          <div style={{ fontSize:9, color:"#333", fontFamily:"monospace", lineHeight:1.8, marginTop:4 }}>
            NOISE FLOOR: {(analysis?.noiseFloor ?? -78).toFixed(1)} dBFS
          </div>
        </div>

        {/* Rate Detection */}
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>RATE DETECTION</div>
          <RateDetector rateKey={detectorRateKey} confidence={confidence} dropFrame={tc.dropFrame} />
          <div style={{ marginTop:"auto", padding:"8px", background:"#0d0d0d", border:"1px solid #1a1a1a", borderRadius:2 }}>
            <div style={{ fontSize:8, color:"#555", letterSpacing:2, marginBottom:4 }}>CONFIDENCE</div>
            <div style={{ height:4, background:"#111", borderRadius:2 }}>
              <div style={{ width:`${confidence}%`, height:"100%", background:"#00ff88", borderRadius:2, boxShadow:"0 0 6px #00ff8866" }} />
            </div>
            <div style={{ fontSize:11, color:"#00ff88", fontFamily:"monospace", marginTop:4, textAlign:"right" }}>
              {confidence.toFixed(1)}%
            </div>
          </div>
        </div>

        {/* Bit Integrity */}
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>FRAME INTEGRITY</div>
          <BitStreamView errors={analysis?.errors ?? []} frameCount={frameCount} />
          <div style={{ height:"1px", background:"#111" }} />
          <div style={{ fontSize:9, fontFamily:"monospace", color:"#444", lineHeight:2 }}>
            <div>SYNC WORD: <span style={{color: analysis?.frameValid!==false?"#00ff88":"#ff3b3b"}}>
              {analysis?.frameValid!==false ? "VALID" : "MISSING"}
            </span></div>
            <div>BIPHASE: <span style={{color: "#00ff88"}}>
              {hasErrors ? "ERRORS" : "CLEAN"}
            </span></div>
            <div>BIT CLOCK: <span style={{color:"#00ff88"}}>LOCKED</span></div>
            <div>LTC TYPE: <span style={{color:"#ffaa00"}}>LINEAR</span></div>
          </div>
        </div>
      </div>

      {/* Controls */}
      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
        {bootstrapping ? (
          <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:10 }}>
            <div style={{ fontSize:9, color:"#666", letterSpacing:3, marginBottom:4 }}>STARTING</div>
            <div style={{ fontSize:10, color:"#444", fontFamily:"monospace" }}>
              Requesting audio input. The simulator and live controls will
              appear here once the mode is established.
            </div>
          </div>
        ) : liveMode ? (
          <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:14 }}>
            <div style={{ fontSize:9, color:"#22d3ee", letterSpacing:3, marginBottom:4 }}>LIVE INPUT STATUS</div>
            <div style={{ display:"grid", gridTemplateColumns:"auto 1fr", gap:"10px 18px", fontSize:11, fontFamily:"monospace" }}>
              <span style={{ color:"#555", letterSpacing:2 }}>DETECTED RATE</span>
              <span style={{ color: analysis?.detectedRateKey ? "#22d3ee" : "#666" }}>
                {analysis?.detectedRateKey ? SMPTE_RATES[analysis.detectedRateKey].label : "— detecting —"}
              </span>
              <span style={{ color:"#555", letterSpacing:2 }}>LOCK STATE</span>
              <span style={{ color: ltcLocked ? "#22d3ee" : "#888" }}>
                {ltcLocked ? "● LOCKED" : "○ NO SIGNAL"}
              </span>
              <span style={{ color:"#555", letterSpacing:2 }}>FRAMES DECODED</span>
              <span style={{ color:"#ccc" }}>{analysis?.framesDecoded ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>BIT ERRORS</span>
              <span style={{ color: (analysis?.bitErrors ?? 0) > 0 ? "#ff9900" : "#ccc" }}>{analysis?.bitErrors ?? 0}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>INPUT LEVEL</span>
              <span style={{ color:"#ccc" }}>{analysis ? `${analysis.rmsDbFS?.toFixed?.(1) ?? "—"} dBFS` : "—"}</span>
              <span style={{ color:"#555", letterSpacing:2 }}>SAMPLE RATE</span>
              <span style={{ color:"#666" }}>{sampleRateRef.current} Hz</span>
            </div>
            <div style={{ fontSize:8, color:"#333", letterSpacing:1, marginTop:4 }}>
              Auto-detecting from biphase bit rate (24 / 25 / 30 / 50 / 60 candidates run in parallel).
              NDF vs DF resolved from the frame's drop-frame flag.
            </div>
          </div>
        ) : (
        <div style={{ ...PANEL, padding:14, display:"flex", flexDirection:"column", gap:14 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3, marginBottom:4 }}>SIMULATION CONTROLS</div>

          <div>
            <div style={{ fontSize:9, color:"#555", letterSpacing:2, marginBottom:8 }}>FRAME RATE</div>
            <select value={rateKey} onChange={e => setRateKey(e.target.value)} style={{width:"100%"}}>
              {Object.entries(SMPTE_RATES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>SIGNAL LEVEL</span>
              <span style={{color: levelDbFS > LEVEL_SPEC.HOT_THRESHOLD ? "#ff6600" : levelDbFS < LEVEL_SPEC.LOW_THRESHOLD ? "#ff9900" : "#00ff88"}}>
                {levelDbFS.toFixed(0)} dBFS
              </span>
            </div>
            <input type="range" min={-70} max={0} step={0.5}
              value={levelDbFS} onChange={e => setLevelDbFS(+e.target.value)} />
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:8, color:"#333", fontFamily:"monospace", marginTop:2 }}>
              <span>DROPOUT</span><span>NOMINAL</span><span>HOT</span><span>CLIP</span>
            </div>
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>NOISE / DISTORTION</span>
              <span style={{color: noiseLevel > 0.3 ? "#ff3b3b" : "#555"}}>{(noiseLevel*100).toFixed(0)}%</span>
            </div>
            <input type="range" min={0} max={1} step={0.01}
              value={noiseLevel} onChange={e => setNoiseLevel(+e.target.value)} />
          </div>

          <div>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#555", letterSpacing:2, marginBottom:6 }}>
              <span>DROPOUT PROBABILITY</span>
              <span style={{color: dropoutProb > 0.05 ? "#ff3b3b" : "#555"}}>{(dropoutProb*100).toFixed(1)}%</span>
            </div>
            <input type="range" min={0} max={0.5} step={0.005}
              value={dropoutProb} onChange={e => setDropoutProb(+e.target.value)} />
          </div>
        </div>
        )}

        <SpecRefPanel />
      </div>

      {/* Audio input */}
      <div style={{ ...PANEL, padding:12, display:"flex", flexDirection:"column", gap:10 }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>AUDIO INPUT</div>
          {liveMode ? (
            <>
              <div style={{ fontSize:9, color:"#555", letterSpacing:2 }}>DEVICE</div>
              <select
                value={currentDeviceId ?? ""}
                onChange={e => startAudioCapture(e.target.value)}
                style={{ minWidth:280, fontSize:10 }}
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
                  color:"#666", padding:"4px 10px", fontSize:10, letterSpacing:1,
                }}
              >↻</button>
              <div style={{ fontSize:9, color:"#00ff88", fontFamily:"monospace", letterSpacing:2 }}>
                ● LIVE
              </div>
            </>
          ) : (
            <>
              <button onClick={() => startAudioCapture()} style={buttonStyle("#00ff88")}>
                ▶ CONNECT AUDIO INPUT
              </button>
              <div style={{ fontSize:9, color:"#333", fontFamily:"monospace", letterSpacing:2 }}>
                ○ SIMULATION MODE
              </div>
            </>
          )}
          {audioError && <div style={{ fontSize:9, color:"#ff3b3b" }}>{audioError}</div>}
          <div style={{ marginLeft:"auto", fontSize:8, color:"#222", fontFamily:"monospace", textAlign:"right" }}>
            Web Audio API · AnalyserNode · Float32 · BiphaseMarkDecoder<br/>
            SMPTE ST 12-1:2014 · 80-bit LTC frame · fftSize 2048
          </div>
        </div>
        {liveMode && (
          <div style={{ display:"flex", justifyContent:"flex-end", borderTop:"1px solid #111", paddingTop:8 }}>
            <button onClick={stopAudio} style={buttonStyle("#d946ef", { padding:"4px 12px", fontSize:9, borderAlpha:"66" })}>
              ▲ SWITCH TO SIMULATED TIMECODE
            </button>
          </div>
        )}
      </div>

      {/* API publisher */}
      <div style={{ marginTop:12, ...PANEL, padding:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
        <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>API PUBLISHER</div>
        <input
          type="text" value={apiUrl} onChange={e => setApiUrl(e.target.value)}
          disabled={apiEnabled}
          style={{ background:"#0a0a0a", border:"1px solid #222", color:"#00ff88",
                   fontFamily:"monospace", fontSize:10, padding:"4px 8px",
                   minWidth:280, outline:"none", opacity: apiEnabled ? 0.5 : 1 }}
        />
        {!apiEnabled ? (
          <button onClick={() => setApiEnabled(true)} style={buttonStyle("#00ff88")}>▶ PUBLISH</button>
        ) : (
          <button onClick={() => setApiEnabled(false)} style={buttonStyle("#ff3b3b")}>■ STOP</button>
        )}
        <div style={{ fontSize:9, fontFamily:"monospace", letterSpacing:2,
          color: apiState === "open" ? "#00ff88" : apiState === "connecting" ? "#ff9900" : apiState === "closed" ? "#ff3b3b" : "#333" }}>
          {apiState === "open" ? `● CONNECTED · ${apiSubscribers} SUB${apiSubscribers === 1 ? "" : "S"}`
            : apiState === "connecting" ? "◐ CONNECTING…"
            : apiState === "closed" ? "○ RECONNECTING…"
            : "○ OFFLINE"}
        </div>
        <div style={{ marginLeft:"auto", fontSize:8, color:"#222", textAlign:"right" }}>
          WebSocket JSON · 30 Hz tick · Worker-driven (background-stable)
        </div>
      </div>

      {/* Session log */}
      <div style={{ marginTop:12, ...PANEL }}>
        <div style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 12px", borderBottom:"1px solid #1a1a1a" }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>SESSION LOG</div>
          <div style={{ fontSize:9, color:"#555", letterSpacing:2 }}>
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
                  ...buttonStyle(disabled ? "#333" : b.color, { padding:"4px 12px", fontSize:9 }),
                  opacity: disabled ? 0.4 : 1,
                }}>{b.label}</button>
              );
            })}
          </div>
        </div>
        <div style={{ maxHeight:220, overflowY:"auto", fontFamily:"monospace", fontSize:10 }}>
          {sessionLog.length === 0 ? (
            <div style={{ padding:16, color:"#333", textAlign:"center", letterSpacing:2, fontSize:9 }}>
              NO ERRORS LOGGED — session clean since {new Date(sessionStartRef.current).toLocaleTimeString()}
            </div>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead>
                <tr style={{ color:"#444", fontSize:8, letterSpacing:2, textAlign:"left" }}>
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
    </div>
  );
}

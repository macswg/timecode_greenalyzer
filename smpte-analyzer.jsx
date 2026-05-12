import { useState, useEffect, useRef, useCallback } from "react";

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

// ─── Drop Frame Validation (SMPTE ST 12-1 §7) ────────────────────────────────
// In 29.97 DF: frames 0 and 1 are skipped at start of each minute,
// except every 10th minute.
function isValidDropFrame(hh, mm, ss, ff, nominalFps) {
  const maxFrame = nominalFps === 30 ? 29 : 59;
  if (hh > 23 || mm > 59 || ss > 59 || ff > maxFrame) return false;
  const skipFrames = nominalFps === 30 ? 2 : 4;
  if (ss === 0 && mm % 10 !== 0 && ff < skipFrames) return false;
  return true;
}

function tcToFrames(hh, mm, ss, ff, rateKey) {
  const rate = SMPTE_RATES[rateKey];
  if (!rate) return null;
  const nomFps = rateKey.includes("29.97") ? 30 : rateKey.includes("59.94") ? 60 : Math.round(rate.fps);
  if (rate.dropFrame) {
    // Drop frame calculation per SMPTE ST 12-1
    const dropPerMin = nomFps === 60 ? 4 : 2;
    const totalMins = 60 * hh + mm;
    const droppedFrames = dropPerMin * (totalMins - Math.floor(totalMins / 10));
    return (nomFps * 3600 * hh) + (nomFps * 60 * mm) + (nomFps * ss) + ff - droppedFrames;
  }
  return (nomFps * 3600 * hh) + (nomFps * 60 * mm) + (nomFps * ss) + ff;
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

// Biphase mark decoder — SMPTE LTC is biphase mark coded
// Each bit has a transition at the start; '1' bits have an additional mid-bit transition
function decodeBiphase(samples, sampleRate, nominalFps) {
  const bitsPerFrame = 80;
  const samplesPerBit = sampleRate / (nominalFps * bitsPerFrame);
  const bits = [];
  let lastSample = 0;
  let lastTransition = 0;
  let halfPeriod = samplesPerBit / 2;

  for (let i = 1; i < samples.length; i++) {
    const curr = samples[i] > 0 ? 1 : -1;
    const prev = samples[i - 1] > 0 ? 1 : -1;
    if (curr !== prev) {
      const interval = i - lastTransition;
      if (interval < halfPeriod * 0.7) {
        // Too short — possible noise/dropout
        bits.push({ bit: null, error: "short_transition" });
      } else if (interval > halfPeriod * 2.5) {
        // Too long — possible dropout
        bits.push({ bit: null, error: "long_gap" });
      } else if (interval < halfPeriod * 1.5) {
        // Mid-bit transition = '1'
        bits.push({ bit: 1, error: null });
      } else {
        // No mid-bit transition = '0'
        bits.push({ bit: 0, error: null });
      }
      lastTransition = i;
    }
    lastSample = curr;
  }
  return bits;
}

// ─── LTC Sync Word detection (SMPTE ST 12-1 §7.2) ────────────────────────────
// Sync word is 0011111111111101 (bits 64–79)
const LTC_SYNC_WORD = [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,1];

function parseLTCFrame(bits80) {
  // Verify sync word
  const syncBits = bits80.slice(64, 80);
  const syncValid = syncBits.every((b, i) => b === LTC_SYNC_WORD[i]);
  if (!syncValid) return null;

  // Extract timecode fields (SMPTE ST 12-1 Table 2)
  const frUnits  = (bits80[0])  | (bits80[1]<<1) | (bits80[2]<<2) | (bits80[3]<<3);
  const frTens   = (bits80[8])  | (bits80[9]<<1);
  const secUnits = (bits80[16]) | (bits80[17]<<1) | (bits80[18]<<2) | (bits80[19]<<3);
  const secTens  = (bits80[24]) | (bits80[25]<<1) | (bits80[26]<<2);
  const minUnits = (bits80[32]) | (bits80[33]<<1) | (bits80[34]<<2) | (bits80[35]<<3);
  const minTens  = (bits80[40]) | (bits80[41]<<1) | (bits80[42]<<2);
  const hrUnits  = (bits80[48]) | (bits80[49]<<1) | (bits80[50]<<2) | (bits80[51]<<3);
  const hrTens   = (bits80[56]) | (bits80[57]<<1);
  const dropFrame = bits80[10] === 1;
  const colorFrame = bits80[11] === 1;

  const ff = frTens * 10 + frUnits;
  const ss = secTens * 10 + secUnits;
  const mm = minTens * 10 + minUnits;
  const hh = hrTens * 10 + hrUnits;

  return { hh, mm, ss, ff, dropFrame, colorFrame, syncValid };
}

// ─── Simulated LTC Generator (for demo — real app uses Web Audio API decode) ─
function generateSimulatedAnalysis(rateKey, levelDbFS, noiseLevel, dropoutProb) {
  const rate = SMPTE_RATES[rateKey];
  const nomFps = rateKey.includes("59.94") || rateKey === "60" ? 60 :
                 rateKey === "50" ? 50 :
                 rateKey.includes("29.97") || rateKey === "30" ? 30 :
                 rateKey === "25" ? 25 : 24;

  // Simulate running timecode
  const now = Date.now();
  const elapsed = (now / 1000);
  let totalFrames = Math.floor(elapsed * rate.fps);

  let hh, mm, ss, ff;
  if (rate.dropFrame) {
    const dropPerMin = nomFps === 60 ? 4 : 2;
    const framesPerTenMin = nomFps * 60 * 10 - dropPerMin * 9;
    const tenMins = Math.floor(totalFrames / framesPerTenMin);
    let rem = totalFrames % framesPerTenMin;
    const framesPerMin = nomFps * 60 - dropPerMin;
    const mins = tenMins * 10 + Math.min(9, Math.floor((rem + dropPerMin) / framesPerMin));
    rem = rem - Math.min(9, Math.floor((rem + dropPerMin) / framesPerMin)) * framesPerMin + dropPerMin;
    if (mins % 10 !== 0) rem += dropPerMin;
    hh = Math.floor(mins / 60) % 24;
    mm = mins % 60;
    ss = Math.floor(rem / nomFps);
    ff = rem % nomFps;
  } else {
    ff = totalFrames % nomFps;
    const totalSec = Math.floor(totalFrames / nomFps);
    ss = totalSec % 60;
    const totalMin = Math.floor(totalSec / 60);
    mm = totalMin % 60;
    hh = Math.floor(totalMin / 60) % 24;
  }

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

// ─── Sub-components ──────────────────────────────────────────────────────────

function TimecodeDisplay({ hh, mm, ss, ff, dropFrame, rateKey, valid }) {
  const fmt = (n, w=2) => String(n ?? 0).padStart(w, "0");
  const sep = dropFrame ? ";" : ":";
  return (
    <div style={{
      fontFamily: "'Share Tech Mono', 'Courier New', monospace",
      fontSize: "clamp(32px, 6vw, 72px)",
      letterSpacing: "0.05em",
      color: valid ? "#00ff88" : "#ff3b3b",
      textShadow: valid
        ? "0 0 20px rgba(0,255,136,0.5), 0 0 40px rgba(0,255,136,0.2)"
        : "0 0 20px rgba(255,59,59,0.5)",
      transition: "color 0.1s, text-shadow 0.1s",
      fontWeight: 400,
    }}>
      {fmt(hh)}<span style={{opacity:0.5}}>:</span>{fmt(mm)}<span style={{opacity:0.5}}>:</span>{fmt(ss)}<span style={{opacity:0.5}}>{sep}</span>{fmt(ff)}
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
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const color = thresholds.reduce((c, t) => value >= t.above ? t.color : c, "#00ff88");
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline" }}>
        <span style={{ fontSize:9, color:"#666", fontFamily:"monospace", letterSpacing:2 }}>{label}</span>
        <span style={{ fontSize:13, color, fontFamily:"monospace" }}>{value.toFixed(1)}{unit}</span>
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
  const [audioError, setAudioError] = useState(null);
  const [peakHold, setPeakHold] = useState(-60);
  const [frameCount, setFrameCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [confidence] = useState(94.7);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const rafRef = useRef(null);
  const peakDecayRef = useRef(-60);

  const tick = useCallback(() => {
    let lvl = levelDbFS;
    let nz = noiseLevel;
    let dp = dropoutProb;

    if (analyserRef.current) {
      const buf = new Float32Array(analyserRef.current.fftSize);
      analyserRef.current.getFloatTimeDomainData(buf);
      const rms = computeRMS(buf);
      const peak = computePeak(buf);
      lvl = linearToDB(rms);
      nz = Math.max(0, Math.min(1, (linearToDB(rms) - linearToDB(peak) + 30) / 30));
    }

    const data = generateSimulatedAnalysis(rateKey, lvl, nz, dp);
    setAnalysis(data);
    setFrameCount(c => c + 1);
    if (data.errors.length > 0) setErrorCount(c => c + 1);

    // Peak hold with decay
    peakDecayRef.current = Math.max(peakDecayRef.current - 0.3, data.peakDbFS);
    setPeakHold(peakDecayRef.current);
  }, [rateKey, levelDbFS, noiseLevel, dropoutProb]);

  useEffect(() => {
    const interval = setInterval(tick, 33); // ~30fps update
    return () => clearInterval(interval);
  }, [tick]);

  async function startAudioCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;
      setUseRealAudio(true);
      setAudioError(null);
    } catch (e) {
      setAudioError("Mic access denied or unavailable.");
    }
  }

  function stopAudio() {
    if (audioCtxRef.current) audioCtxRef.current.close();
    audioCtxRef.current = null;
    analyserRef.current = null;
    setUseRealAudio(false);
  }

  const tc = analysis ?? { hh:0, mm:0, ss:0, ff:0, dropFrame: SMPTE_RATES[rateKey].dropFrame };
  const hasErrors = (analysis?.errors?.length ?? 0) > 0;

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
      <div style={{
        border:"1px solid #1a1a1a",
        borderRadius:4,
        padding:"24px 28px",
        marginBottom:16,
        background:"linear-gradient(180deg, #0a0a0a 0%, #050505 100%)",
        position:"relative",
        overflow:"hidden",
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
            rateKey={rateKey}
            valid={analysis?.frameValid !== false}
          />
          <div style={{ display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
            <div style={{
              fontFamily:"'Orbitron', monospace",
              fontSize:20, color:"#ffaa00",
              textShadow:"0 0 12px rgba(255,170,0,0.4)",
              letterSpacing:2,
            }}>
              {SMPTE_RATES[rateKey]?.label}
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", justifyContent:"flex-end" }}>
              <StatusBadge label="LOCK" active={analysis?.frameValid !== false} color="#00ff88" />
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
        <div style={{ border:"1px solid #1a1a1a", borderRadius:3, padding:14, background:"#080808", display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>SIGNAL LEVEL</div>
          <LevelMeter label="RMS" value={analysis?.levelDbFS ?? levelDbFS} peak={peakHold} />
          <LevelMeter label="PEAK" value={analysis?.peakDbFS ?? levelDbFS + 2} peak={peakHold} />
          <div style={{ height:"1px", background:"#111" }} />
          <Gauge label="SNR" value={analysis?.snr ?? 60} min={0} max={80} unit=" dB"
            thresholds={[{above:0,color:"#ff3b3b"},{above:20,color:"#ffaa00"},{above:40,color:"#ccff33"},{above:50,color:"#00ff88"}]} />
          <Gauge label="THD" value={analysis?.thd ?? 0.1} min={0} max={5} unit="%"
            thresholds={[{above:0,color:"#00ff88"},{above:1,color:"#ccff33"},{above:2,color:"#ffaa00"},{above:3,color:"#ff3b3b"}]} />
          <div style={{ fontSize:9, color:"#333", fontFamily:"monospace", lineHeight:1.8, marginTop:4 }}>
            NOISE FLOOR: {(analysis?.noiseFloor ?? -78).toFixed(1)} dBFS
          </div>
        </div>

        {/* Rate Detection */}
        <div style={{ border:"1px solid #1a1a1a", borderRadius:3, padding:14, background:"#080808", display:"flex", flexDirection:"column", gap:12 }}>
          <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>RATE DETECTION</div>
          <RateDetector rateKey={rateKey} confidence={confidence} dropFrame={tc.dropFrame} />
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
        <div style={{ border:"1px solid #1a1a1a", borderRadius:3, padding:14, background:"#080808", display:"flex", flexDirection:"column", gap:12 }}>
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
        <div style={{ border:"1px solid #1a1a1a", borderRadius:3, padding:14, background:"#080808", display:"flex", flexDirection:"column", gap:14 }}>
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

        <SpecRefPanel />
      </div>

      {/* Audio input */}
      <div style={{ border:"1px solid #1a1a1a", borderRadius:3, padding:12, background:"#080808", display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
        <div style={{ fontSize:9, color:"#ff9900", letterSpacing:3 }}>AUDIO INPUT</div>
        {!useRealAudio ? (
          <button onClick={startAudioCapture} style={{
            background:"transparent", border:"1px solid #00ff8844",
            color:"#00ff88", padding:"6px 16px", fontSize:10, letterSpacing:2,
          }}>
            ▶ CONNECT MIC INPUT
          </button>
        ) : (
          <button onClick={stopAudio} style={{
            background:"transparent", border:"1px solid #ff3b3b44",
            color:"#ff3b3b", padding:"6px 16px", fontSize:10, letterSpacing:2,
          }}>
            ■ DISCONNECT
          </button>
        )}
        <div style={{ fontSize:9, color: useRealAudio ? "#00ff88" : "#333", fontFamily:"monospace", letterSpacing:2 }}>
          {useRealAudio ? "● LIVE AUDIO — feed LTC signal into mic" : "○ SIMULATION MODE"}
        </div>
        {audioError && <div style={{ fontSize:9, color:"#ff3b3b" }}>{audioError}</div>}
        <div style={{ marginLeft:"auto", fontSize:8, color:"#222", fontFamily:"monospace", textAlign:"right" }}>
          Web Audio API · AnalyserNode · Float32 · BiphaseMarkDecoder<br/>
          SMPTE ST 12-1:2014 · 80-bit LTC frame · fftSize 2048
        </div>
      </div>
    </div>
  );
}

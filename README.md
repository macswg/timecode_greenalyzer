# SMPTE Timecode Analyzer

A browser-based Linear Timecode (LTC) analyzer built to the SMPTE ST 12-1:2014 and ST 12-2:2014 specifications. It decodes and displays timecode, detects frame rate and drop-frame mode, measures signal level, and flags error conditions including clipping, low level, noise, distortion, and dropout.

---

## Installation

The analyzer is a single self-contained React component with no backend. You can run it two ways: inside Claude as an artifact, or locally in any React project.


### Option 1 — Run Locally with Vite

**Prerequisites:** Node.js 18 or later

```bash
# 1. Create a new Vite + React project
npm create vite@latest smpte-analyzer -- --template react
cd smpte-analyzer

# 2. Install dependencies
npm install

# 3. Replace the default component with the analyzer
cp /path/to/smpte-analyzer.jsx src/App.jsx

# 4. Update src/main.jsx to import App (it already does by default)
# No changes needed if using the Vite React template

# 5. Start the dev server
npm run dev
```

Then open `http://localhost:5173` in your browser.


### Option 2 — Run as a Claude Artifact

1. Open Claude and start a new conversation
2. Upload `smpte-analyzer.jsx` or paste its contents
3. Ask Claude to render it as an artifact
4. It will run immediately in the artifact preview panel — no build step required



### Option 3 — Drop into an Existing React Project

Copy `smpte-analyzer.jsx` into your project's component directory and import it:

```jsx
import SMPTEAnalyzer from './components/smpte-analyzer';

export default function App() {
  return <SMPTEAnalyzer />;
}
```

The component has no required props and manages all state internally.

### Dependencies

The analyzer uses only React built-ins and the browser's native Web Audio API. No additional npm packages are required. The Google Fonts stylesheet for `Share Tech Mono` and `Orbitron` is loaded at runtime via a CSS `@import` — an internet connection is needed for the first load, after which the fonts are cached by the browser.

---

## Specifications Referenced

| Standard | Title |
|---|---|
| SMPTE ST 12-1:2014 | Time and Control Code — Part 1: Linear Timecode (LTC) |
| SMPTE ST 12-2:2014 | Time and Control Code — Part 2: ATC for HDTV Systems |
| SMPTE ST 2059 | Synchronization of IP Media Transport (informational reference) |

---

## What It Does

### Timecode Display

The main readout shows timecode in the standard `HH:MM:SS:FF` format. The frame separator character distinguishes drop-frame from non-drop-frame mode:

- `:` (colon) — non-drop-frame
- `;` (semicolon) — drop-frame

The display turns **red** when any error condition is active that would cause the timecode to be unreliable.

Three status flags appear alongside the display:

- **LOCK** — the decoder has a valid sync word and is reading frames correctly
- **DF** — drop-frame mode is active (bit 10 of the LTC frame is set)
- **CF** — color frame flag is set (bit 11 of the LTC frame)

---

### Frame Rate Detection

The analyzer detects all frame rates defined in SMPTE ST 12-1 and ST 12-2:

| Rate Key | Label | fps (exact) | Drop Frame |
|---|---|---|---|
| 23.976 | 23.976 ND | 24000/1001 | No |
| 24 | 24 ND | 24 | No |
| 25 | 25 ND | 25 | No |
| 29.97df | 29.97 DF | 30000/1001 | Yes |
| 29.97 | 29.97 ND | 30000/1001 | No |
| 30 | 30 ND | 30 | No |
| 47.95 | 47.95 ND | 48000/1001 | No |
| 48 | 48 ND | 48 | No |
| 50 | 50 ND | 50 | No |
| 59.94df | 59.94 DF | 60000/1001 | Yes |
| 59.94 | 59.94 ND | 60000/1001 | No |
| 60 | 60 ND | 60 | No |

A confidence bar shows the likelihood of the detected rate. In live audio mode, rate detection is derived from the biphase bit clock frequency. In simulation mode, the rate is set manually.

---

### Drop Frame Validation

Drop-frame timecode compensates for the difference between 30 fps nominal and 29.97002997... fps actual (30000/1001) — and equivalently between 60 and 59.94 fps. Without compensation, timecode would drift from wall-clock time by approximately 3.6 seconds per hour at 29.97.

The drop-frame rule per **SMPTE ST 12-1 §7**:

- At the start of each minute (`SS=00`), frames `00` and `01` are skipped (not recorded or displayed)
- **Exception:** frames are not skipped at every 10th minute (`MM=00, 10, 20, 30, 40, 50`)
- For 59.94 DF, frames `00`, `01`, `02`, and `03` are skipped instead of two

The analyzer validates every incoming frame number against this rule and flags frames that violate it as errors.

**Frame-to-sample conversion** uses the SMPTE drop-frame formula:

```
droppedFrames = dropPerMin × (totalMinutes − floor(totalMinutes / 10))
totalFrames = (nomFps × 3600 × HH) + (nomFps × 60 × MM) + (nomFps × SS) + FF − droppedFrames
```

---

### LTC Frame Structure

Linear Timecode is encoded as a **biphase mark** (bi-phase mark coding, or BMC) audio signal. Each LTC frame consists of **80 bits** carrying timecode digits, user bits, status flags, and a sync word.

Per **SMPTE ST 12-1 Table 2**, the 80-bit frame layout is:

| Bits | Field |
|---|---|
| 0–3 | Frame units (BCD) |
| 4–7 | User bits group 1 |
| 8–9 | Frame tens (BCD) |
| 10 | Drop frame flag |
| 11 | Color frame flag |
| 12–15 | User bits group 2 |
| 16–19 | Seconds units (BCD) |
| 20–23 | User bits group 3 |
| 24–26 | Seconds tens (BCD) |
| 27 | Biphase mark phase correction bit |
| 28–31 | User bits group 4 |
| 32–35 | Minutes units (BCD) |
| 36–39 | User bits group 5 |
| 40–42 | Minutes tens (BCD) |
| 43 | Binary group flag BGF0 |
| 44–47 | User bits group 6 |
| 48–51 | Hours units (BCD) |
| 52–55 | User bits group 7 |
| 56–57 | Hours tens (BCD) |
| 58 | Binary group flag BGF1 |
| 59 | Binary group flag BGF2 |
| 60–63 | User bits group 8 |
| 64–79 | Sync word: `0011111111111101` |

**Sync word** (bits 64–79): `0011111111111101`  
This 16-bit pattern is unique — it cannot occur in valid BCD timecode data or in the biphase encoding of any other legal bit sequence, which allows the decoder to frame-align reliably.

#### Biphase Mark Encoding

In biphase mark coding:
- Every bit begins with a transition (polarity change)
- A **`1` bit** has an additional transition at the mid-point of the bit cell
- A **`0` bit** has no mid-point transition

The decoder measures the time between transitions. A short interval (≈ half bit-cell) indicates a `1`; a long interval (≈ full bit-cell) indicates a `0`. Intervals that fall outside the valid range (±30% tolerance) are flagged as bit errors.

---

### Signal Level Analysis

LTC must be kept within a specific level range to decode reliably. Too hot and the signal clips the input stage, distorting the zero-crossings the decoder relies on. Too quiet and the signal-to-noise ratio drops below the threshold for reliable bit detection.

Level thresholds used by the analyzer (digital, dBFS):

| Threshold | dBFS | Meaning |
|---|---|---|
| Clip | > −1 | Input stage overload; zero-crossings distorted; decode will fail |
| Hot | > −6 | Above SMPTE recommended maximum; decode errors likely |
| Nominal | −18 | SMPTE recommended operating level |
| Low | < −30 | Below minimum reliable level; decoder may lose lock |
| Dropout / Silent | < −60 | No signal; complete loss of timecode |

The analyzer measures and displays:

- **RMS level** — average signal energy, the primary level indicator for LTC
- **Peak level** — instantaneous peak with hold and decay
- **Noise floor** — estimated floor below the signal
- **SNR** (Signal-to-Noise Ratio) — ratio of signal to noise floor, in dB
- **THD** (Total Harmonic Distortion) — percentage distortion; elevated THD indicates the signal is being processed or clipped upstream

---

### Error Detection

Five error conditions are monitored and displayed as illuminated badges:

| Badge | Color | Condition | Effect on Decode |
|---|---|---|---|
| CLIP | Red | Signal > −1 dBFS | Zero-crossings shift; bit errors likely |
| HOT | Orange | Signal > −6 dBFS | Elevated error rate |
| LOW | Amber | Signal < −30 dBFS | Decoder may lose sync |
| DROPOUT | Pink | Signal < −60 dBFS, or sudden dropout event | Complete frame loss |
| NOISE | Purple | THD or noise above threshold | Spurious transitions; false bits |

When any error badge is active, the main timecode display turns red to indicate the readout should not be trusted.

---

### Bit Integrity Map

An 8×8 grid of 64 cells visualizes the bit-error distribution across recent frames. Each cell represents a decoded bit region; red cells indicate a detected error (short transition, long gap, or sync word mismatch). The total error count is shown below the grid.

---

### Frame Counter

The total number of frames analyzed and the cumulative error count are shown in the top-right corner. This allows assessment of error rate over time (e.g., intermittent dropout vs. sustained level problem).

---

## Audio Input Modes

### Simulation Mode (default)

The analyzer runs a built-in LTC generator that produces valid timecode at the selected rate and applies simulated level, noise, and dropout conditions controlled by three sliders:

- **Signal Level** — sets RMS level from −70 to 0 dBFS
- **Noise / Distortion** — 0–100%; above ~15% triggers the NOISE flag
- **Dropout Probability** — 0–50%; probability per frame of a simulated dropout event

This mode is useful for understanding how the analyzer responds to each error condition.

### Live Audio Mode

Clicking **Connect Mic Input** requests microphone access via the browser's Web Audio API. The analyzer captures the audio stream, runs it through a 2048-point `AnalyserNode`, and extracts Float32 time-domain samples for RMS and peak measurement. When live audio is connected, level readings reflect the actual signal.

To use with real LTC: connect a timecode source to an audio interface, route the timecode track to the interface input, and use a virtual audio cable or loopback to route that input to the browser's microphone input.

> **Note:** Full biphase decoding of live audio (reading actual HH:MM:SS:FF from the signal) is implemented in the `decodeBiphase()` and `parseLTCFrame()` functions and will be wired to the live path in a future revision. Currently, live audio provides real level analysis; the timecode digits in live mode are generated by the internal clock at the selected rate.

---

## Architecture

The analyzer is a single React component (`smpte-analyzer.jsx`) with no external runtime dependencies beyond React itself. All DSP, decoding logic, and rendering are self-contained.

Key functions:

| Function | Purpose |
|---|---|
| `computeRMS(buffer)` | RMS level from Float32 PCM buffer |
| `computePeak(buffer)` | Peak level from Float32 PCM buffer |
| `linearToDB(linear)` | Linear amplitude to dBFS |
| `decodeBiphase(samples, sampleRate, fps)` | Biphase mark decoder; returns array of bits with error flags |
| `parseLTCFrame(bits80)` | Validates sync word and extracts HH:MM:SS:FF and flags from 80-bit frame |
| `isValidDropFrame(hh, mm, ss, ff, fps)` | Validates frame number against SMPTE drop-frame rule |
| `tcToFrames(hh, mm, ss, ff, rateKey)` | Converts timecode to absolute frame count |
| `generateSimulatedAnalysis(...)` | Produces simulated analysis data for the selected conditions |

UI sub-components:

| Component | Purpose |
|---|---|
| `TimecodeDisplay` | Main HH:MM:SS:FF readout |
| `LevelMeter` | Horizontal bar meter with peak hold and color zones |
| `StatusBadge` | Illuminated indicator for LOCK, DF, CF, CLIP, HOT, etc. |
| `Gauge` | Horizontal bar for SNR, THD |
| `BitStreamView` | 8×8 bit error map |
| `RateDetector` | Rate confidence bars for all 12 rates |
| `SpecRefPanel` | In-app SMPTE spec reference |

---

## Planned Improvements

- Wire live biphase decode to populate HH:MM:SS:FF from actual LTC signal
- VITC (Vertical Interval Timecode) decode from video input via canvas capture
- User bits display and decoding
- Waveform oscilloscope view of the LTC signal
- Session logging: export frame error log to CSV
- Jitter measurement: frame-to-frame arrival time variance

---

## Revision History

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-05-12 | Initial release — LTC display, rate detection, level analysis, error flagging, simulation mode, live audio level measurement |

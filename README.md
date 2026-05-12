# SMPTE Timecode Analyzer

A browser-based Linear Timecode (LTC) analyzer built to the SMPTE ST 12-1:2014 and ST 12-2:2014 specifications. It decodes and displays timecode from a live audio input, detects frame rate and drop-frame mode automatically, measures signal level, and flags error conditions including clipping, low level, noise, and dropout.

---

## Project Structure

```
timecode_greenalyzer/
├── smpte-analyzer/     Vite + React app — the analyzer UI
│   ├── src/
│   │   ├── App.jsx         Root component, UI, audio glue
│   │   ├── ltcDecoder.js   Biphase decoder, MultiRateDecoder
│   │   ├── publisher.js    Reconnecting WebSocket publisher
│   │   └── tickWorker.js   Web Worker tick source
│   └── public/
│       └── ltc-worklet.js  AudioWorklet sample capture
└── smpte-bridge/       Node WS sidecar — fan-out to subscribers
    └── src/index.js
```

---

## Running the Analyzer

**Prerequisites:** Node.js 18 or later

```bash
cd smpte-analyzer
npm install
npm run dev
```

Open `http://localhost:5173` in your browser. The app immediately attempts to open your default audio input. Grant microphone permission when prompted.

To use a real LTC source: connect a timecode output to an audio interface, then select that interface in the device picker inside the app.

---

## Running the Bridge Sidecar (optional)

The bridge is only needed if you want to forward the timecode feed to other applications on the network.

```bash
cd smpte-bridge
npm install
npm start
```

Listens on `:8765` by default. Set the `PORT` environment variable to override. See `smpte-bridge/README.md` for endpoints and message types.

To connect the analyzer to the bridge, enter the WebSocket URL (`ws://localhost:8765/ingest`) in the API PUBLISHER section of the UI and click PUBLISH.

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

In live audio mode, rate detection is fully automatic: five `LtcDecoder` instances run in parallel at 24/25/30/50/60 fps candidates and the winner is chosen by frames-decoded score. NDF vs DF is resolved from the drop-frame flag in the parsed frame. A confidence bar shows the current lock strength.

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

The decoder measures the time between transitions. A short interval (≈ half bit-cell) indicates a `1`; a long interval (≈ full bit-cell) indicates a `0`. Intervals that fall outside the valid range (±25% tolerance) are flagged as bit errors.

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
- **SNR** (Signal-to-Noise Ratio) — ratio of LTC-band spectral power to out-of-band power, in dB; shown only when locked to a live signal
- **THD** (Total Harmonic Distortion) — percentage distortion; shown only in simulation mode (null in live mode)

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

### Session Log

The app maintains an in-session error log that captures each distinct error-state transition with timestamp, timecode, rate, source (live or sim), and level. The log can be exported as CSV or JSON. Clearing the log also resets the error counter.

---

## Audio Input Modes

### Live Audio Mode (default)

On startup the app calls `getUserMedia` immediately and attempts to open the default audio input. If the browser blocks this before a user gesture (common in some browsers) or the user denies access, the app surfaces the error and falls back to simulation mode until the user clicks **CONNECT AUDIO INPUT**.

When live audio is active:
- A device picker (`enumerateDevices`) lets you select among all available audio inputs. Switching reopens the stream with the selected `deviceId`. The app listens for `devicechange` events and updates the list automatically.
- An `AudioWorklet` (`ltc-worklet.js`) runs on the audio thread and forwards every sample to the main thread without dropping any between reads. The `MultiRateDecoder` (`ltcDecoder.js`) receives these samples and runs five `LtcDecoder` instances in parallel at 24/25/30/50/60 fps. The winner is selected by score (frames decoded minus a weighted bit-error penalty, with a recency bonus for frames decoded within the last 500 ms).
- The timecode digits (HH:MM:SS:FF) shown in the display come directly from the decoded LTC frame. If no valid frame has been decoded within ~200 ms, the display shows `00:00:00:00` and LOCK turns off.
- SNR is computed from the FFT (`computeLtcSnr`) — it compares spectral power inside the LTC bit-rate band to power outside it. It is only populated when locked; otherwise it shows `—`.
- THD is not computed in live mode and shows `—`.

To use with real LTC: connect a timecode source to an audio interface input and select that interface in the device picker.

### Simulation Mode

Click **SWITCH TO SIMULATED TIMECODE** (visible at the bottom of the audio input panel when live mode is active, or **CONNECT AUDIO INPUT** switches back to live) to enter simulation mode.

In simulation mode:
- An internal LTC generator produces valid timecode at the selected frame rate.
- Three sliders inject conditions: **Signal Level** (−70 to 0 dBFS), **Noise / Distortion** (0–100%), and **Dropout Probability** (0–50% per frame).
- SNR is a synthetic estimate based on the noise slider; THD is computed from the noise slider.

The timecode card gets a fuchsia outline and a blinking **SIMULATING CODE** indicator while in this mode.

---

## API Publisher

The app can publish timecode frames to the `smpte-bridge` sidecar over WebSocket. Enter the bridge URL in the **API PUBLISHER** section and click **PUBLISH**. The publisher reconnects automatically with exponential back-off if the bridge is not running.

Every tick emits a `{type:"tc"}` message. Each error-state transition emits a `{type:"error"}` message. See `smpte-bridge/README.md` for the full schema.

---

## Revision History

| Version | Date | Notes |
|---|---|---|
| 1.0 | 2026-05-12 | Initial release — LTC display, rate detection, level analysis, error flagging, simulation mode, live audio level measurement |
| 1.1 | 2026-05-12 | Live biphase decode wired (MultiRateDecoder + AudioWorklet); auto rate detection; device picker; API publisher; session log; Web Worker tick |

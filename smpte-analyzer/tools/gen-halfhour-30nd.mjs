// One-off generator: a series of 30 fps non-drop LTC WAV files, each starting
// on a half-hour timecode mark and running 10 minutes.
//
//   start marks: 01:30:00:00, 02:00:00:00, 02:30:00:00 … 23:30:00:00
//   rate:        true 30.000 fps, non-drop  (decodes as rate key "30")
//   length:      10 minutes each
//
// Reuses the app's tested encoder (src/ltcSynth.js). Run via:
//   npm run gen:halfhour
// or:
//   node --import ./tools/register-loader.mjs tools/gen-halfhour-30nd.mjs

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildLtcAudioBuffer } from "../src/ltcSynth.js";
import { float32ToWav } from "./wav.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "generated_tc");
mkdirSync(OUT_DIR, { recursive: true });

const SAMPLE_RATE = 48000;     // standard pro audio rate
const DURATION = 600;          // 10 minutes per file
const LEVEL_DBFS = -18;        // SMPTE nominal
const CARRIER_FPS = 30;        // true 30.000 fps timing
const CADENCE_FPS = 30;        // 30-frame count
const DROP_FRAME = false;      // non-drop

// Build the list of start marks: every 30 min from 01:30 through 23:30.
const starts = [];
for (let totalMin = 90; totalMin <= 23 * 60 + 30; totalMin += 30) {
  starts.push({ hh: Math.floor(totalMin / 60), mm: totalMin % 60 });
}

const pad = (n) => String(n).padStart(2, "0");

for (const { hh, mm } of starts) {
  const samples = buildLtcAudioBuffer({
    sampleRate: SAMPLE_RATE,
    carrierFps: CARRIER_FPS,
    cadenceFps: CADENCE_FPS,
    dropFrame: DROP_FRAME,
    durationSec: DURATION,
    levelDbFS: LEVEL_DBFS,
    start: { hh, mm, ss: 0, ff: 0 },
    convention: "wide",
  });
  const wav = float32ToWav(samples, SAMPLE_RATE);
  const name = `ltc_30nd_${pad(hh)}${pad(mm)}.wav`;
  writeFileSync(join(OUT_DIR, name), wav);
  console.log(
    `wrote ${name}  ${(wav.length / 1024 / 1024).toFixed(1)} MB  ` +
    `start=${pad(hh)}:${pad(mm)}:00:00  ${DURATION / 60}min  30NDF @ ${SAMPLE_RATE}Hz`
  );
}
console.log(`\nDone. ${starts.length} files in ${OUT_DIR}`);

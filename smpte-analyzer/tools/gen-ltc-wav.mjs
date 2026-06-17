// One-off LTC WAV generator. Reuses the app's tested encoder
// (src/ltcSynth.js -> buildLtcAudioBuffer) and writes standard 16-bit PCM
// mono WAV files that play on Windows (Media Player, foobar2000, Audacity,
// etc.) and can be fed back into the analyzer's "ANALYZE FILE…" drop zone.
//
// Run it with the extensionless-import loader so it can pull in the app source
// unmodified:
//
//   node --import ./tools/register-loader.mjs tools/gen-ltc-wav.mjs
//
// or just use the npm script:  npm run gen:ltc
//
// Edit the JOBS array below to choose what to generate. Each job is one file.

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildLtcAudioBuffer } from "../src/ltcSynth.js";
import { float32ToWav } from "./wav.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "out");

const SAMPLE_RATE = 48000;   // standard pro audio rate
const DURATION = 60;         // seconds per file
const LEVEL_DBFS = -18;      // SMPTE nominal

// carrierFps: the actual playback timing (29.97 => 30000/1001, etc.)
// cadenceFps: the count wrap value (24/25/30/50/60)
// dropFrame:  apply DF skip in the count + set the DF flag bit
const FPS_2997 = 30000 / 1001;
const FPS_5994 = 60000 / 1001;
const FPS_2398 = 24000 / 1001;

const JOBS = [
  { name: "ltc_24",       carrierFps: 24,        cadenceFps: 24, dropFrame: false },
  { name: "ltc_23976",    carrierFps: FPS_2398,  cadenceFps: 24, dropFrame: false },
  { name: "ltc_25",       carrierFps: 25,        cadenceFps: 25, dropFrame: false },
  { name: "ltc_2997df",   carrierFps: FPS_2997,  cadenceFps: 30, dropFrame: true  },
  { name: "ltc_2997ndf",  carrierFps: FPS_2997,  cadenceFps: 30, dropFrame: false },
  { name: "ltc_30",       carrierFps: 30,        cadenceFps: 30, dropFrame: false },
  { name: "ltc_50",       carrierFps: 50,        cadenceFps: 50, dropFrame: false },
  { name: "ltc_5994df",   carrierFps: FPS_5994,  cadenceFps: 60, dropFrame: true  },
  { name: "ltc_60",       carrierFps: 60,        cadenceFps: 60, dropFrame: false },
];

for (const job of JOBS) {
  const samples = buildLtcAudioBuffer({
    sampleRate: SAMPLE_RATE,
    carrierFps: job.carrierFps,
    cadenceFps: job.cadenceFps,
    dropFrame: job.dropFrame,
    durationSec: DURATION,
    levelDbFS: LEVEL_DBFS,
    start: { hh: 1, mm: 0, ss: 0, ff: 0 }, // start at 01:00:00:00
    convention: "wide",
  });
  const wav = float32ToWav(samples, SAMPLE_RATE);
  const path = join(OUT_DIR, job.name + ".wav");
  writeFileSync(path, wav);
  console.log(
    `wrote ${job.name}.wav  ${(wav.length / 1024).toFixed(0)} KB  ` +
    `carrier=${job.carrierFps.toFixed(3)}fps cadence=${job.cadenceFps} ` +
    `df=${job.dropFrame} ${DURATION}s @ ${SAMPLE_RATE}Hz`
  );
}
console.log(`\nDone. Files in ${OUT_DIR}`);

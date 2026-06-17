# tools — one-off LTC WAV generators

Node scripts that synthesize **standalone LTC timecode WAV files** for playback
(Windows Media Player, foobar2000, VLC, Audacity, hardware players) or for
re-ingesting through the analyzer's **ANALYZE FILE…** drop zone.

They reuse the app's tested encoder (`../src/ltcSynth.js` →
`buildLtcAudioBuffer`), so generated audio matches exactly what the analyzer
expects. Output is standard 16-bit PCM mono WAV, 48 kHz, −18 dBFS (SMPTE
nominal). Nothing here is part of the app build — it's dev-only tooling.

## Generators

| npm script | Script | What it makes |
|---|---|---|
| `npm run gen:ltc` | `gen-ltc-wav.mjs` | One sample file per common rate (24, 23.976, 25, 29.97 DF/NDF, 30, 50, 59.94 DF, 60) → `out/` |
| `npm run gen:halfhour` | `gen-halfhour-30nd.mjs` | A series of 30 fps non-drop files, each 10 min, starting on every half-hour mark from 01:30:00:00 → 23:30:00:00 (45 files) → `generated_tc/` |

```bash
cd smpte-analyzer
npm run gen:halfhour      # writes to tools/generated_tc/
```

To change start time, duration, level, sample rate, or which rates are emitted,
edit the constants / `JOBS` at the top of the relevant script. Both share the
WAV writer in `wav.mjs`.

The encoder can also produce **intentionally out-of-spec** material (e.g. 30 fps
carrier timing carrying a drop-frame count) by setting `carrierFps` and
`cadenceFps` differently in a job — useful for exercising the analyzer's
non-conformance detection.

## How it runs

The app source uses Vite-style extensionless imports (e.g. `import … from
"./dropFrame"`), which plain Node won't resolve. `register-loader.mjs` installs
a tiny resolve hook (`extless-loader.mjs`) that appends `.js`, so the scripts can
import the app source unmodified. The npm scripts wire this up via
`node --import ./tools/register-loader.mjs …`.

## Verifying output

`verify-ltc.mjs` and `verify-hh.mjs` decode generated files back through
`MultiRateDecoder` and print the detected rate key, drop-frame flag, and
first/last timecode — a round-trip sanity check.

```bash
node --import ./tools/register-loader.mjs tools/verify-hh.mjs
```

## Output folders

- `out/` — sample-per-rate files from `gen:ltc`
- `generated_tc/` — the half-hour 30 NDF series

Both are generated artifacts (large — the half-hour series is ~2.4 GB) and are
not meant to be committed.

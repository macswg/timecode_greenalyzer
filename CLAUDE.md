# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Scope

This repo is a single self-contained React component (`smpte-analyzer.jsx`) implementing an SMPTE LTC (Linear Timecode) analyzer per **SMPTE ST 12-1:2014** and **ST 12-2:2014**. There is no package.json, no build config, and no test runner — the component is consumed either as a Claude artifact or by dropping `smpte-analyzer.jsx` into an external Vite/React host.

## Running / Iterating

There is no in-repo dev server. To exercise changes:

- **Artifact path:** paste `smpte-analyzer.jsx` into a Claude conversation and render as an artifact (fastest iteration loop).
- **Local path:** `npm create vite@latest <dir> -- --template react`, then copy `smpte-analyzer.jsx` to `src/App.jsx` and `npm run dev`. See README for full steps.

Because there is no build/test tooling colocated, treat correctness checks as manual: render the component, exercise simulation sliders, and verify behavior against the SMPTE rules documented in the README.

## Architecture

Everything lives in `smpte-analyzer.jsx` (~750 lines, single default export). The file is organized into four conceptual layers — preserve this layout when adding code:

1. **Spec constants** (`SMPTE_RATES`, `LEVEL_SPEC`, drop-frame tables) — authoritative values pulled from the SMPTE standards. Do not adjust these to make tests pass; they encode the spec.
2. **Pure DSP / decode functions** — `computeRMS`, `computePeak`, `linearToDB`, `decodeBiphase`, `parseLTCFrame`, `isValidDropFrame`, `tcToFrames`, `generateSimulatedAnalysis`. These are framework-free and the right place to land logic changes.
3. **UI sub-components** — `TimecodeDisplay`, `LevelMeter`, `StatusBadge`, `Gauge`, `BitStreamView`, `RateDetector`, `SpecRefPanel`. Presentational; state lives in the parent.
4. **Root component** — owns all state, runs the simulation/live-audio loop via `useEffect`, and wires Web Audio's `AnalyserNode` to the meters.

### Two input modes — important asymmetry

- **Simulation mode (default):** internal LTC generator produces timecode digits at the selected rate; sliders inject level/noise/dropout.
- **Live audio mode:** microphone via Web Audio API drives **only the level/THD/SNR meters**. The biphase decoder (`decodeBiphase` → `parseLTCFrame`) exists and is correct, but is **not yet wired to the live audio path** — timecode digits in live mode are still produced by the internal clock. Wiring this is a known planned improvement; do not assume live HH:MM:SS:FF reflects the input signal.

### Drop-frame rule (load-bearing)

The `isValidDropFrame` check and `tcToFrames` conversion implement SMPTE ST 12-1 §7 exactly:
- 29.97 DF: skip frames 00, 01 at the start of every minute except every 10th minute.
- 59.94 DF: skip frames 00, 01, 02, 03 with the same 10th-minute exception.

Any change to drop-frame handling should be cross-checked against both the rule and the formula in `tcToFrames` — they must agree.

### LTC frame layout

The 80-bit frame structure (BCD digits, flags, user bits, sync word `0011111111111101` at bits 64–79) is defined by SMPTE ST 12-1 Table 2 and mirrored in `parseLTCFrame`. The README's "LTC Frame Structure" table is the reference if bit-field code needs to change.

## Conventions

- Style is plain React function components with hooks (`useState`, `useEffect`, `useRef`, `useCallback`) — no class components, no state library, no TypeScript.
- Tailwind-style utility classes are used inline. Fonts (`Share Tech Mono`, `Orbitron`) load via a runtime CSS `@import` from Google Fonts.
- Keep the file single-file and dependency-free beyond React + browser APIs. Adding npm dependencies would break the "paste into Claude artifact" usage path described in the README.

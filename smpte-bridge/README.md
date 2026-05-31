# smpte-bridge

Fan-out sidecar for the SMPTE timecode analyzer. The browser-side analyzer
publishes timecode frames over WebSocket; this process rebroadcasts the JSON
feed to any number of subscribers.

## Run

```
cd smpte-bridge
npm install
npm start
```

`127.0.0.1` is always bound so a same-machine analyzer can reach
`ws://localhost:8765/ingest`. `HOSTS` (comma-separated) adds extra interfaces
without exposing all of LAN; `HOST` is accepted as an alias. `npm start` sets
`HOSTS=$(tailscale ip -4)` so the bridge is reachable over Tailscale too.
Override port with `PORT=9000`.

## Endpoints

- `ws://localhost:8765/ingest` — analyzer connects here as the single publisher.
- `ws://localhost:8765/subscribe` — downstream apps connect here; receive the
  JSON feed verbatim.
- `http://localhost:8765/status` — JSON snapshot (publisher state, subscriber
  count, frame counters, last timecode).
- `http://localhost:8765/` — phone-friendly live viewer (see below).

## Phone viewer

Open `http://localhost:8765/` in any browser to see the running timecode, the
current error tags, and the last 10 continuity breaks. The page connects to
`/subscribe` itself and auto-reconnects with 1 s → 10 s back-off.

To view from a phone over Tailscale:

1. Start the bridge (`npm start`) and click **▶ PUBLISH** in the analyzer.
2. Get the Mac's Tailscale IP: `tailscale ip -4`.
3. On the phone (Tailscale connected), open `http://<that-ip>:8765/`.

The viewer needs no audio input of its own — it's purely a readout of whatever
the analyzer is currently publishing. Drop-frame rates render with `;` and an
orange rate label; non-drop with `:` and blue, matching the analyzer.

## Message types

- `{"type":"tc", t, seq, hh, mm, ss, ff, rate, dropFrame, carrierRate, cadenceFps,
  cadenceDropFrame, carrierCadenceMismatch, fieldMarkBehavior, bgf, userBits, source,
  ltcLocked, frameValid, levelDbFS, peakDbFS, driftPpm, dropoutPct, snr, errors}`
  emitted every tick (~30 Hz). `seq` is a publisher-monotonic counter starting at 1.
  `rate` is the combined SMPTE rate key (e.g. `"29.97df"`); `dropFrame` is boolean.
  `carrierRate` / `cadenceFps` / `cadenceDropFrame` are the independent carrier-rate
  and counting-cadence observations (combined into `rate` for convenience).
  `fieldMarkBehavior` is `"TOGGLING"` / `"STATIC"` / `null` (50/60 frame-pair vs
  wide-LTC). `userBits` is an 8-char hex string (UB1..UB8). Fields with no value yet
  (e.g. before the carrier classifier commits) are `null`.
- `{"type":"error", t, seq, tc, rate, errors}` emitted once per error-set transition.
  `tc` is a formatted timecode string; `;` is used as the frame separator for drop-frame.
- `{"type":"continuity", t, seq, breakType, delta, from, to, rate}` emitted when
  a continuity break is detected. `breakType` is `"REPEAT"` (freeze frame, delta = 0),
  `"JUMP"` (edit splice / dropout, delta > 1), or `"REWIND"` (backwards, delta < 0).
  `from` and `to` are formatted timecode strings. Gaps ≥ 500 ms between decoded frames
  reset continuity tracking and do not produce this message.
- `{"type":"status", t, subscribers, publisher}` heartbeat on connection
  state changes.
- `{"type":"hello", t, lastTc}` sent to each new subscriber on connect.

## Quick test

```
# in another terminal:
npx wscat -c ws://localhost:8765/subscribe
```



Dark-blue is wscat's default color for incoming messages — it tags them with ANSI color 34 (blue), which on iTerm2's default dark theme is hard to read.

To fix it:

​	Pipe through jq — kills wscat's coloring entirely
​	`npx wscat -c ws://localhost:8765/subscribe | jq -C .`
​	jq -C applies its own (much more readable) color scheme. As a bonus you get pretty-printing.

​	If you don't want JSON pretty-printing, just plain text:
​	`npx wscat -c ws://localhost:8765/subscribe | cat`
​	Piping to anything strips wscat's terminal-detection, so it falls back to uncolored output.







Phases 2+ (OSC fan-out, Art-Net timecode, optional MTC) will be added as
additional listeners on the same ingest stream.

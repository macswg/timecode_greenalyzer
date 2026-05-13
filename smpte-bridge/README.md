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

Listens on `:8765` by default (`PORT=9000 npm start` to override).

## Endpoints

- `ws://localhost:8765/ingest` — analyzer connects here as the single publisher.
- `ws://localhost:8765/subscribe` — downstream apps connect here; receive the
  JSON feed verbatim.
- `http://localhost:8765/status` — JSON snapshot (publisher state, subscriber
  count, frame counters, last timecode).

## Message types

- `{"type":"tc", t, seq, hh, mm, ss, ff, rate, dropFrame, source, levelDbFS, errors}`
  emitted every tick (~30 Hz). `seq` is a publisher-monotonic counter starting at 1.
  `rate` is the SMPTE rate key string (e.g. `"29.97df"`); `dropFrame` is boolean.
  Both rate fields are always present and explicit.
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

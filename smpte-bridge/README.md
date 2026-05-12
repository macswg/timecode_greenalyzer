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

- `{"type":"tc", t, hh, mm, ss, ff, rate, dropFrame, source, levelDbFS, errors, seq}`
  emitted every tick (~30 Hz).
- `{"type":"error", t, tc, rate, errors}` emitted once per error-set transition.
- `{"type":"status", t, subscribers, publisher}` heartbeat on connection
  state changes.
- `{"type":"hello", t, lastTc}` sent to each new subscriber on connect.

## Quick test

```
# in another terminal:
npx wscat -c ws://localhost:8765/subscribe
```

Phases 2+ (OSC fan-out, Art-Net timecode, optional MTC) will be added as
additional listeners on the same ingest stream.

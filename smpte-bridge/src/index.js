// SMPTE bridge sidecar — Phase 1.
// One HTTP server hosts two WebSocket endpoints:
//   /ingest    — the analyzer browser tab publishes timecode frames here
//   /subscribe — any number of downstream apps subscribe to the JSON feed
// Future phases will fan out to OSC and Art-Net from the same ingest stream.

import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8765);

const subscribers = new Set();
let publisher = null;
let lastTc = null;
let stats = { framesIn: 0, framesOut: 0, errorsIn: 0, startedAt: Date.now() };

const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      publisher: publisher ? "connected" : "disconnected",
      subscribers: subscribers.size,
      lastTc, stats,
      uptimeMs: Date.now() - stats.startedAt,
    }, null, 2));
    return;
  }
  res.writeHead(404); res.end();
});

const wssIngest = new WebSocketServer({ noServer: true });
const wssSubscribe = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { url } = req;
  if (url === "/ingest") {
    wssIngest.handleUpgrade(req, socket, head, (ws) => wssIngest.emit("connection", ws, req));
  } else if (url === "/subscribe") {
    wssSubscribe.handleUpgrade(req, socket, head, (ws) => wssSubscribe.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

function broadcastStatus() {
  const msg = JSON.stringify({ type: "status", t: Date.now(), subscribers: subscribers.size, publisher: !!publisher });
  if (publisher && publisher.readyState === 1) publisher.send(msg);
  for (const s of subscribers) if (s.readyState === 1) s.send(msg);
}

wssIngest.on("connection", (ws, req) => {
  if (publisher && publisher.readyState === 1) {
    console.log(`[ingest] rejected second publisher from ${req.socket.remoteAddress}`);
    ws.close(1008, "publisher already connected");
    return;
  }
  publisher = ws;
  console.log(`[ingest] publisher connected from ${req.socket.remoteAddress}`);
  broadcastStatus();

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "tc") { stats.framesIn++; lastTc = msg; }
    else if (msg.type === "error") { stats.errorsIn++; }
    const payload = JSON.stringify(msg);
    for (const s of subscribers) {
      if (s.readyState === 1) { s.send(payload); stats.framesOut++; }
    }
  });

  ws.on("close", () => {
    console.log("[ingest] publisher disconnected");
    if (publisher === ws) publisher = null;
    broadcastStatus();
  });
});

wssSubscribe.on("connection", (ws, req) => {
  subscribers.add(ws);
  console.log(`[sub] +1 from ${req.socket.remoteAddress} (total ${subscribers.size})`);
  ws.send(JSON.stringify({ type: "hello", t: Date.now(), lastTc }));
  broadcastStatus();
  ws.on("close", () => {
    subscribers.delete(ws);
    console.log(`[sub] -1 (total ${subscribers.size})`);
    broadcastStatus();
  });
});

server.listen(PORT, () => {
  console.log(`smpte-bridge listening on :${PORT}`);
  console.log(`  publish  →  ws://localhost:${PORT}/ingest`);
  console.log(`  subscribe → ws://localhost:${PORT}/subscribe`);
  console.log(`  status   →  http://localhost:${PORT}/status`);
});

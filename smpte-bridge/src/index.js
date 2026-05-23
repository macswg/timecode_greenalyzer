// SMPTE bridge sidecar — Phase 1.
// One HTTP server hosts two WebSocket endpoints:
//   /ingest    — the analyzer browser tab publishes timecode frames here
//   /subscribe — any number of downstream apps subscribe to the JSON feed
// Future phases will fan out to OSC and Art-Net from the same ingest stream.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8765);
// Always bind localhost so the same-machine analyzer works; HOSTS adds
// extra interfaces (e.g. the Tailscale IP) without exposing all of LAN.
const EXTRA_HOSTS = (process.env.HOSTS || process.env.HOST || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const HOSTS = ["127.0.0.1", ...EXTRA_HOSTS.filter(h => h !== "127.0.0.1")];
const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
};

const subscribers = new Set();
let publisher = null;
let lastTc = null;
let stats = { framesIn: 0, framesOut: 0, errorsIn: 0, startedAt: Date.now() };

async function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405); res.end(); return true;
  }
  const urlPath = req.url.split("?")[0];
  const rel = urlPath === "/" ? "viewer.html" : urlPath.replace(/^\/+/, "");
  const full = normalize(join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end(); return true; }
  try {
    const body = await readFile(full);
    const type = MIME[extname(full).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    res.writeHead(500); res.end(); return true;
  }
}

async function handleRequest(req, res) {
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
  if (await serveStatic(req, res)) return;
  res.writeHead(404); res.end();
}

const wssIngest = new WebSocketServer({ noServer: true });
const wssSubscribe = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
  const { url } = req;
  if (url === "/ingest") {
    wssIngest.handleUpgrade(req, socket, head, (ws) => wssIngest.emit("connection", ws, req));
  } else if (url === "/subscribe") {
    wssSubscribe.handleUpgrade(req, socket, head, (ws) => wssSubscribe.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
}

const servers = HOSTS.map((host) => {
  const s = http.createServer(handleRequest);
  s.on("upgrade", handleUpgrade);
  return { host, server: s };
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

for (const { host, server } of servers) {
  server.on("error", (err) => {
    console.error(`[bridge] ${host}:${PORT} failed: ${err.message}`);
  });
  server.listen(PORT, host, () => {
    console.log(`smpte-bridge listening on ${host}:${PORT}`);
  });
}
console.log(`  publish   →  ws://<host>:${PORT}/ingest`);
console.log(`  subscribe →  ws://<host>:${PORT}/subscribe`);
console.log(`  status    →  http://<host>:${PORT}/status`);
console.log(`  viewer    →  http://<host>:${PORT}/`);

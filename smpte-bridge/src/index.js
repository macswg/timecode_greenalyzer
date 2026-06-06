// SMPTE bridge sidecar — Phase 1.
// One HTTP server hosts two WebSocket endpoints:
//   /ingest    — the analyzer browser tab publishes timecode frames here
//   /subscribe — any number of downstream apps subscribe to the JSON feed
// Future phases will fan out to OSC and Art-Net from the same ingest stream.

import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 8765);
// Always bind localhost so the same-machine analyzer works; HOSTS adds
// extra interfaces (e.g. the Tailscale IP) without exposing all of LAN.
// A wildcard host (0.0.0.0 / ::, used by the Docker image) already covers
// localhost and every interface, so bind it alone — binding the wildcard and
// 127.0.0.1 on the same port collides (EADDRINUSE).
const EXTRA_HOSTS = (process.env.HOSTS || process.env.HOST || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const wildcard = EXTRA_HOSTS.find(h => h === "0.0.0.0" || h === "::");
const HOSTS = wildcard
  ? [wildcard]
  : ["127.0.0.1", ...EXTRA_HOSTS.filter(h => h !== "127.0.0.1")];

// Optional bring-your-own-cert TLS. When BOTH TLS_CERT and TLS_KEY point to
// readable PEM files, the bridge serves https/wss instead of http/ws. We never
// obtain or renew certs — point these at `tailscale cert` output, Let's Encrypt
// files, or any cert you already have. Default (vars unset) is plain http/ws,
// byte-for-byte the previous behaviour. NOTE: TLS is per-server, so enabling it
// makes this instance wss-only — plain ws://localhost will not connect to it.
function loadTlsConfig() {
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  if (!certPath && !keyPath) return null;                 // not requested
  if (!certPath || !keyPath) {                            // half-configured → fail loud
    console.error("[bridge] TLS misconfigured: set BOTH TLS_CERT and TLS_KEY (or neither). Refusing to start.");
    process.exit(1);
  }
  try {
    return { cert: readFileSync(certPath), key: readFileSync(keyPath) };
  } catch (e) {
    // Fail loud rather than silently falling back to insecure http.
    console.error(`[bridge] TLS cert/key could not be read (${e.message}). Refusing to start.`);
    process.exit(1);
  }
}

const tls = loadTlsConfig();
const SCHEME = tls ? "https" : "http";
const WS_SCHEME = tls ? "wss" : "ws";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const subscribers = new Set();
let publisher = null;
let lastTc = null;
// Latest session-log snapshot from the publisher, cached so a phone that
// connects mid-session is handed the full log immediately (see /subscribe
// hello). Live updates arrive via generic fan-out like every other message.
let lastLog = null;
// framesOut: count of tc messages forwarded (per ingest message, not per
// subscriber). fanoutSends: total ws.send() calls across all subscribers
// (framesOut × current subscriber count, roughly), useful for diagnosing
// fan-out load.
let stats = { framesIn: 0, framesOut: 0, fanoutSends: 0, errorsIn: 0, startedAt: Date.now() };

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
  const s = tls ? https.createServer(tls, handleRequest) : http.createServer(handleRequest);
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
    else if (msg.type === "log") { lastLog = msg; }
    const payload = JSON.stringify(msg);
    if (msg.type === "tc") stats.framesOut++;
    for (const s of subscribers) {
      if (s.readyState === 1) { s.send(payload); stats.fanoutSends++; }
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
  ws.send(JSON.stringify({ type: "hello", t: Date.now(), lastTc, lastLog }));
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
    console.log(`smpte-bridge listening on ${SCHEME}://${host}:${PORT}`);
  });
}
if (tls) console.log("[bridge] TLS enabled — connect with wss:// (plain ws:// will not work on this instance).");
console.log(`  publish   →  ${WS_SCHEME}://<host>:${PORT}/ingest`);
console.log(`  subscribe →  ${WS_SCHEME}://<host>:${PORT}/subscribe`);
console.log(`  status    →  ${SCHEME}://<host>:${PORT}/status`);
console.log(`  viewer    →  ${SCHEME}://<host>:${PORT}/`);

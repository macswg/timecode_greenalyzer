// Background-resilient tick source. Browsers throttle setInterval/rAF in
// inactive tabs (~1 Hz); Workers keep running at full rate, so downstream
// API subscribers don't stutter when the analyzer tab loses focus.

let timer = null;
let intervalMs = 33;

function start() {
  stop();
  timer = setInterval(() => self.postMessage({ type: "tick", t: Date.now() }), intervalMs);
}
function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

self.onmessage = (e) => {
  const { type, intervalMs: ms } = e.data || {};
  if (type === "start") { if (ms) intervalMs = ms; start(); }
  else if (type === "stop") { stop(); }
  else if (type === "setInterval") { intervalMs = ms; if (timer) start(); }
};

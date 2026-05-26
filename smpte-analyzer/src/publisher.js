// Reconnecting WebSocket publisher for the SMPTE bridge sidecar.
// Usage: const p = new Publisher(url); p.connect(); p.send(payload); p.close();
// Listen via p.on("state", fn) / p.on("status", fn).
//
// Wire-format timestamps: every payload's `t` field is wall-clock ms since
// Unix epoch (Date.now()). Internally the analyzer also uses performance.now()
// for monotonic intervals (decoder lastFrame.t, lastBreak.t, recent-break
// window), but those never reach the wire — call sites convert to Date.now()
// at the publisher boundary. Subscribers should treat all received `t` values
// as the same epoch-based clock.

export class Publisher {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.state = "idle"; // idle | connecting | open | closed | error
    this.listeners = { state: new Set(), status: new Set() };
    this.reconnectMs = 1000;
    this.shouldRun = false;
    this.lastSendError = null;
    this.seq = 0;
  }

  on(event, fn) { this.listeners[event]?.add(fn); return () => this.listeners[event]?.delete(fn); }
  _emit(event, payload) { this.listeners[event]?.forEach(fn => fn(payload)); }
  _setState(s) { this.state = s; this._emit("state", s); }

  connect() {
    this.shouldRun = true;
    this._open();
  }

  _open() {
    if (!this.shouldRun) return;
    try {
      this._setState("connecting");
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => {
        this.reconnectMs = 1000;
        this._setState("open");
      };
      this.ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "status") {
            this._emit("status", msg);
          }
        } catch { /* ignore */ }
      };
      this.ws.onerror = () => { this.lastSendError = "socket error"; };
      this.ws.onclose = () => {
        this.ws = null;
        if (this.shouldRun) {
          this._setState("closed");
          setTimeout(() => this._open(), this.reconnectMs);
          this.reconnectMs = Math.min(this.reconnectMs * 2, 10000);
        } else {
          this._setState("idle");
        }
      };
    } catch (e) {
      this.lastSendError = String(e);
      this._setState("error");
    }
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify({ ...payload, seq: ++this.seq }));
      return true;
    } catch (e) {
      this.lastSendError = String(e);
      return false;
    }
  }

  close() {
    this.shouldRun = false;
    if (this.ws) this.ws.close();
    this.ws = null;
    this._setState("idle");
  }
}

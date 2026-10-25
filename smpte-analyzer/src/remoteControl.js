// Remote record start/stop, relayed by the OSC listener (OSC_listener/server.py).
// Usage: const rc = new RemoteControl({ url, onCommand, getState, onStatus });
//        rc.start(); ... rc.stop();
//
// A web page can't take requests from other devices, so the listener takes
// them for it (HTTP POST /api/greenalyzer/record/start|stop, or OSC
// /greenalyzer/record/...) and pushes each one to this page as a `command`
// event on GET /api/greenalyzer/events. The page runs it, then answers with
// POST /api/greenalyzer/state carrying `ack` = the command's id, which is how
// the caller's request learns it worked. The same POST, sent every second,
// keeps GET /api/greenalyzer/status current. See REMOTE_RECORD.md.

const HEARTBEAT_MS = 1000;
const RETRY_MS = 5000;

export class RemoteControl {
  // onCommand({id, cmd: "start"|"stop", label}) → Promise; a throw is reported back as ackError.
  // getState() → {recording, file, mode, folder, lines, bytes, started, error}.
  // onStatus("connecting" | "open" | "closed").
  // onTdRec({rec, recording, files, rec_started}) — the TouchDesigner
  // recorder's REC state (rec_started in Unix seconds), from listener ≥ 1.9.0:
  // on each command (before onCommand) and each state reply.
  constructor({ url, onCommand, getState, onStatus, onTdRec }) {
    this.base = url.replace(/\/+$/, "");
    this.onCommand = onCommand;
    this.getState = getState;
    this.onStatus = onStatus;
    this.onTdRec = onTdRec;
    this._es = null;
    this._beat = null;
    this._retry = null;
    this._stopped = false;
  }

  start() {
    this._stopped = false;
    this._connect();
    this._beat = setInterval(() => { if (this._es?.readyState === EventSource.OPEN) this._post(); }, HEARTBEAT_MS);
  }

  stop() {
    this._stopped = true;
    clearInterval(this._beat);
    clearTimeout(this._retry);
    this._es?.close();
    this._es = null;
    this.onStatus?.("closed");
  }

  _connect() {
    this.onStatus?.("connecting");
    const es = new EventSource(this.base + "/api/greenalyzer/events");
    this._es = es;
    es.addEventListener("hello", () => { this.onStatus?.("open"); this._post(); });
    es.addEventListener("command", async (e) => {
      let cmd;
      try { cmd = JSON.parse(e.data); } catch { return; }
      if (cmd.td_rec) this.onTdRec?.(cmd.td_rec);
      let ackError = null;
      try { await this.onCommand(cmd); } catch (err) { ackError = String(err?.message ?? err); }
      this._post({ ack: cmd.id, ackError });
    });
    es.onerror = () => {
      if (this._stopped) return;
      this.onStatus?.("connecting");
      // EventSource retries by itself unless the failure was fatal (e.g. CORS);
      // then it closes, so start over.
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(this._retry);
        this._retry = setTimeout(() => { if (!this._stopped) this._connect(); }, RETRY_MS);
      }
    };
  }

  _post(extra = {}) {
    fetch(this.base + "/api/greenalyzer/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...this.getState(), ...extra }),
    })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j?.td_rec) this.onTdRec?.(j.td_rec); })
      .catch(() => { /* the event stream's onerror reports the outage */ });
  }
}

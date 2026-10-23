// In-browser NDJSON recorder for the API message stream — no bridge needed.
// Usage: const r = new Recorder({ onProgress }); await r.start({ suggestedName, header });
//        r.write(payload); ... await r.stop(trailerMessages);
//
// Records exactly the messages the publisher would send (tc, error,
// continuity, carrier), one JSON object per line, each stamped with a
// recorder-monotonic `seq`. Same wire schema as smpte-bridge/README.md.
//
// Two storage modes:
//   "disk"   — Chromium (Chrome/Edge): the File System Access API lets the
//              user pick a file up front and lines stream into it. NOTE: the
//              browser writes to a swap file and only commits to the chosen
//              path on close(), i.e. when recording stops.
//   "memory" — everywhere else (Safari/Firefox, or picker unavailable):
//              lines accumulate in memory and download as a file on stop.
// In both modes, closing the tab before stopping loses the recording — the
// app installs a beforeunload guard while recording.
//
// Writes are batched and flushed once per second, so the ~30 Hz tc stream
// costs one write call per second rather than thirty.

const FLUSH_MS = 1000;

export class Recorder {
  constructor({ onProgress } = {}) {
    this.onProgress = onProgress;
    this.mode = null;          // "disk" | "memory"
    this.filename = null;
    this.lines = 0;
    this.bytes = 0;
    this.seq = 0;
    this.startedAt = null;     // Date.now() epoch ms
    this._pending = [];
    this._chunks = [];         // memory mode: flushed batches
    this._writable = null;     // disk mode: FileSystemWritableFileStream
    this._chain = Promise.resolve();
    this._timer = null;
    this.error = null;
  }

  // Must be called from a user gesture (button click) — the save picker
  // requires one. Throws AbortError if the user cancels the picker.
  async start({ suggestedName, header } = {}) {
    this.filename = suggestedName;
    if (typeof window !== "undefined" && typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: "NDJSON timecode recording", accept: { "application/x-ndjson": [".ndjson"] } }],
        });
        this._writable = await handle.createWritable();
        this.filename = handle.name;
        this.mode = "disk";
      } catch (e) {
        if (e?.name === "AbortError") throw e;   // user cancelled → don't record
        this.mode = "memory";                    // picker blocked/unsupported
      }
    } else {
      this.mode = "memory";
    }
    this.startedAt = Date.now();
    if (header) this.write(header);
    this._timer = setInterval(() => this._flush(), FLUSH_MS);
    this._report();
  }

  write(payload) {
    if (!this.startedAt) return;
    const line = JSON.stringify({ ...payload, seq: ++this.seq }) + "\n";
    this._pending.push(line);
    this.lines++;
    this.bytes += line.length;
  }

  _flush() {
    if (!this._pending.length) { this._report(); return this._chain; }
    const batch = this._pending.join("");
    this._pending = [];
    if (this.mode === "disk") {
      this._chain = this._chain
        .then(() => this._writable.write(batch))
        .catch(e => { this.error = String(e?.message ?? e); });
    } else {
      this._chunks.push(batch);
    }
    this._report();
    return this._chain;
  }

  _report() {
    this.onProgress?.({
      active: !!this.startedAt, mode: this.mode, filename: this.filename,
      lines: this.lines, bytes: this.bytes, startedAt: this.startedAt, error: this.error,
    });
  }

  // Writes any trailer messages (e.g. the final session-log snapshot), then
  // commits the file (disk) or triggers the download (memory).
  async stop(trailer = []) {
    if (!this.startedAt) return;
    clearInterval(this._timer);
    for (const m of trailer) this.write(m);
    await this._flush();
    if (this.mode === "disk") {
      await this._chain;
      try { await this._writable.close(); } catch (e) { this.error = String(e?.message ?? e); }
    } else {
      const blob = new Blob(this._chunks, { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = this.filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      this._chunks = [];
    }
    this.startedAt = null;
    this._report();
  }
}

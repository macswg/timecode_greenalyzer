# Remote record start/stop

How another device starts and stops the SMPTE Timecode Greenalyzer's recorder.

The Greenalyzer is a web page, and a web page can't accept requests from other devices. The
**OSC listener** (`OSC_listener/server.py`, version 1.8.0 or later) runs on the same Mac and relays
the requests for it. Your device talks to the OSC listener over **HTTP** or **OSC**, and the
listener passes each command to the open Greenalyzer page.

```
your device ──HTTP or OSC──▶ OSC listener (Greenalyzer Mac) ──▶ Greenalyzer page ──▶ recording file
            ◀── reply: did the page start/stop? ──────────────────┘
```

## On the Greenalyzer Mac (once)

1. Run the OSC listener (`start_osc_listener.command`).
2. Open the Greenalyzer in Chrome or Edge.
3. In the **RECORDER** panel:
   - Click **CHOOSE FOLDER…** and pick where recordings go. Each recording becomes a new file there,
     with no save dialog. The page remembers the folder; after a reload it may show
     **ALLOW FOLDER …**, which needs one click before remote starts write to disk again.
   - Click **REMOTE: OFF** to turn it **ON**. Leave the address as `http://127.0.0.1:8415`. Chrome
     may ask once to let the page reach devices on your local network: allow it.
   - The panel should say **● REMOTE READY**.

If no folder is chosen (or the browser isn't Chrome/Edge), a remote start records in memory and the
file downloads to the Downloads folder on stop. The panel says **NO FOLDER (IN MEMORY)** when so.

The page has to stay open. Closing or reloading it ends the connection, and loses a recording in
progress.

## Addresses

| Your device is | Use |
|---|---|
| The Greenalyzer Mac itself | `http://127.0.0.1:8415` |
| Another machine on Tailscale | `http://<Greenalyzer Mac's Tailscale IP>:8415` (currently `100.96.181.83`) |
| Anything else (e.g. the venue LAN) | Refused with 403 for HTTP. OSC isn't limited, see [OSC](#osc) |

## HTTP

| Request | Does |
|---|---|
| `POST /api/greenalyzer/record/start` | Start recording. Optional `label` |
| `POST /api/greenalyzer/record/stop` | Stop recording and save the file |
| `GET /api/greenalyzer/status` | Whether the page is connected and recording |

**Label:** `?label=Show8` in the URL, `{"label": "Show8"}` as a JSON body, or `label=Show8`
form-encoded. It goes on the end of the file name: `greenalyzer-20261024-201500_Show8.ndjson`.
Anything other than letters, digits, `_` and `-` becomes `-`, and it's cut to 40 characters.

**Rules:**
- Start while already recording keeps the current file (the label is ignored).
- Stop while not recording does nothing.
- Commands only reach a page that's open and connected **at that moment**. Nothing is queued: a
  start sent while the page is closed is lost, and the reply says so (`"pages": 0`).

### Reply

Start and stop wait up to 3 seconds for the page to confirm, then answer:

```json
{
  "command": "start", "label": "Show8", "id": 12,
  "pages": 1,
  "acknowledged": true,
  "error": null,
  "greenalyzer": {
    "pages": 1, "age": 0.0, "stale": false,
    "recording": true,
    "file": "greenalyzer-20261024-201500_Show8.ndjson",
    "mode": "folder", "folder": "LTC recordings",
    "lines": 1, "bytes": 412, "started": 1792894500123,
    "error": null, "version": "1.7.7"
  }
}
```

| Field | Meaning |
|---|---|
| `pages` | Greenalyzer pages the command was sent to. `0` = none open with REMOTE on: nothing happened |
| `acknowledged` | A page confirmed it ran the command. `false` with `pages` ≥ 1 = no answer within 3 s |
| `error` | The page's error if the command failed, e.g. the folder needs allowing again |
| `greenalyzer.recording` | Whether it's recording now. **Check this to know it worked** |
| `greenalyzer.file` | The current (or last) file name |
| `greenalyzer.mode` | `folder` (writing to the chosen folder), `disk` (a file picked by hand), `memory` (downloads on stop) |
| `greenalyzer.lines` / `bytes` | Size so far |
| `greenalyzer.started` | When recording started, ms since 1970 |
| `greenalyzer.age` / `stale` | Seconds since the page last reported in (it does every second); `stale` after 5 s means it's gone, and `recording` then reads `false` |

`GET /api/greenalyzer/status` returns the `greenalyzer` object alone. The OSC listener's own
`GET /api/status` includes it too, as `greenalyzer`.

A good integration: send start, then check `acknowledged && greenalyzer.recording`. If not,
show a warning on your device.

### Examples

**curl:**

```sh
curl -d '' "http://100.96.181.83:8415/api/greenalyzer/record/start?label=Show8"
curl -d '' http://100.96.181.83:8415/api/greenalyzer/record/stop
curl http://100.96.181.83:8415/api/greenalyzer/status
```

**TouchDesigner** (Web Client DAT named `webclient1`; the reply arrives in its callbacks):

```python
op('webclient1').request('http://100.96.181.83:8415/api/greenalyzer/record/start?label=Show8', 'POST')
op('webclient1').request('http://100.96.181.83:8415/api/greenalyzer/record/stop', 'POST')
```

**Python** (standard library):

```python
import json, urllib.request

def greenalyzer(cmd, label=""):
    url = "http://100.96.181.83:8415/api/greenalyzer/record/" + cmd
    req = urllib.request.Request(url, json.dumps({"label": label}).encode(),
                                 {"Content-Type": "application/json"})
    reply = json.load(urllib.request.urlopen(req, timeout=5))
    if cmd == "start" and not (reply["acknowledged"] and reply["greenalyzer"]["recording"]):
        print("Greenalyzer did not start:", reply.get("error") or "no page connected")
    return reply
```

**Node / browser `fetch`** from your own server or app (not from a web page on another site: the
listener refuses those):

```js
await fetch("http://100.96.181.83:8415/api/greenalyzer/record/start", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ label: "Show8" }),
});
```

## OSC

Send to the OSC listener's UDP port, **7415**, on the Greenalyzer Mac.

| Address | Arguments | Does |
|---|---|---|
| `/greenalyzer/record/start` | optional string: label | Start |
| `/greenalyzer/record/stop` | none | Stop |
| `/greenalyzer/record` | int / float / bool, then optional string label | Start if the value is ≥ 0.5 or true, stop if 0 or false |

`/greenalyzer/record` suits a latching button that sends 1 on and 0 off. For a momentary button
that sends 1 on press and 0 on release, use the separate start and stop addresses. A start on
release is harmless (it keeps the current file), but a 0 on `/greenalyzer/record` would stop it.

OSC gets no reply. To confirm, check `GET /api/greenalyzer/status` over HTTP, or watch the
panel. OSC isn't limited to this Mac and Tailscale: anything that can reach UDP 7415 can send it.
The listener's hidden-value rules don't block these commands. The messages also show in its log
and recordings like any other OSC, unless a rule hides them.

Examples:

```sh
# python-osc
python3 -c "from pythonosc.udp_client import SimpleUDPClient as C; C('100.96.181.83', 7415).send_message('/greenalyzer/record/start', 'Show8')"
```

```python
# TouchDesigner: OSC Out DAT named oscout1, pointed at the Greenalyzer Mac, port 7415
op('oscout1').sendOSC('/greenalyzer/record/start', ['Show8'])
op('oscout1').sendOSC('/greenalyzer/record/stop', [])
```

## What gets recorded

The same file as clicking **● RECORD**: NDJSON, one JSON object per line. A `session` header
(now with `label` and `startedBy: "remote"`), then every `tc` (about 30 a second), `error`,
`continuity`, `carrier` and `rec` message, then one final `log` snapshot.

### Lining it up with other recordings

Every line's `t` is UTC, ms since 1970, from this Mac's clock: the same clock as the OSC
listener's `t` (seconds). For timecode, use each `tc` line's `frameT` instead: when that frame
actually arrived, not when the 30 Hz tick happened to send it.

- The `session` header has `started` (local time with UTC offset), `zone` (minutes east of
  UTC) and `tdRec`, the TouchDesigner recorder's take at that moment.
- With OSC listener 1.9.0 or later and REMOTE on, the page also follows the TouchDesigner
  recorder's REC state. Each `tc` line then has `recT`, seconds into the take on the same axis as
  the marker files' `time` column, and every change of take is written as a `rec` message.

### Calibrating `frameT`

`frameT` is corrected for two delays, and each `tc` line says how much was taken off in total as
`latencyMs`:

- **Render lead**, measured automatically: how far the browser's audio runs ahead of the output
  device (shown as **RENDER LEAD** in the RECORDER panel).
- **LATENCY CAL**, set by hand in the RECORDER panel: everything else, mainly the audio
  interface's input latency. It's remembered per browser and written into each recording's
  `session` header. Measure it once per setup (interface, buffer size), and again after changing
  either.

To measure it, something that reads the same LTC has to send an OSC message to the listener at a
known frame. For example, a grandMA3 timecode show with a cue at `01:00:00:00` that sends
`/greenalyzer/cal`.

1. Run the OSC listener and record on both it and the Greenalyzer.
2. Roll the LTC through that frame a few times (5–10 is plenty), then stop both recordings.
3. Run:

   ```sh
   python3 smpte-analyzer/tools/latency-cal.py greenalyzer-….ndjson osc_….jsonl \
     --addr /greenalyzer/cal --tc 01:00:00:00
   ```

4. Enter the **Set LATENCY CAL to** value it prints. The spread between events should be a few
   ms; much more means something in the chain varies.

The result includes the sender's own reaction time to the LTC. That's what's wanted for placing
that sender's OSC against the timecode, but it isn't a pure measure of the Greenalyzer. The message fields are in
`smpte-bridge/README.md`. Expect about 100+ MB per hour.

**The file is only complete after stop.** Chrome writes to a temporary file and moves it into the
folder on stop. If the page closes or the Mac crashes mid-recording, that recording is lost. So
always send stop.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Connection refused | The OSC listener isn't running, or it's older than 1.8.0 (answers 404) |
| 403 | You're not on this Mac or Tailscale, or you're calling from a web page on another site |
| `"pages": 0` | No Greenalyzer page has REMOTE on and connected. Check the panel says **● REMOTE READY** |
| `acknowledged: false`, `pages` ≥ 1 | The page didn't answer in 3 s (tab asleep or busy). Check status again |
| `error` mentions permission | The folder needs allowing again: click **ALLOW FOLDER …** on the page |
| Panel stuck on **LOOKING FOR OSC LISTENER…** | Listener not running, wrong address, or Chrome's local network prompt was blocked (site settings → Local network access) |

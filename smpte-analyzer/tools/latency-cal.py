#!/usr/bin/env python3
"""Measure the Greenalyzer's LATENCY CAL from a recording made alongside the OSC listener.

Needs an OSC message sent at a known LTC frame, from something that reads the same LTC
(e.g. a grandMA3 timecode show with a cue at 01:00:00:00 that sends /greenalyzer/cal).
Fire it several times. For each one, this works out when the Greenalyzer says that frame
began (frameT) and compares it with when the listener received the message (t):

    python3 tools/latency-cal.py greenalyzer-….ndjson osc_….jsonl --addr /greenalyzer/cal --tc 01:00:00:00

If the OSC message has the timecode as a string argument (HH:MM:SS:FF or HH:MM:SS;FF),
--tc can be left out. Prints the LATENCY CAL to enter on the page: the one in force for
the recording plus the median difference. Positive difference = frameT reads late.
The result includes the sender's own reaction time to the LTC, so it lines the Greenalyzer
up with that sender's view of the code — which is what placing its OSC on a timeline needs.
"""
import argparse
import json
import re
import statistics
import sys

TC_RE = re.compile(r"^(\d\d):(\d\d):(\d\d)[:;.](\d\d)$")


def parse_tc(s):
    m = TC_RE.match(s.strip())
    return tuple(int(g) for g in m.groups()) if m else None


def frame_number(hh, mm, ss, ff, nom, df):
    """Frames since 00:00:00:00, with the SMPTE drop-frame skip (2/min, 4/min at 60)."""
    total_min = hh * 60 + mm
    n = (total_min * 60 + ss) * nom + ff
    if df:
        drop = 4 if nom == 60 else 2
        n -= drop * (total_min - total_min // 10)
    return n


def rate_info(rate):
    """'29.97df' → (nominal 30, actual fps, drop-frame)."""
    m = re.match(r"^(\d+(?:\.\d+)?)(df|ndf|nd)?$", str(rate or "").lower())
    if not m:
        return None
    fps = float(m.group(1))
    nom = round(fps)
    fractional = abs(fps - nom) > 0.01
    return nom, (nom / 1.001 if fractional else nom), m.group(2) == "df"


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("greenalyzer", help="Greenalyzer recording (.ndjson)")
    ap.add_argument("osc", help="OSC listener recording (.jsonl)")
    ap.add_argument("--addr", required=True, help="OSC address sent at the known frame")
    ap.add_argument("--tc", help="the frame it's sent at, HH:MM:SS:FF (else read from its args)")
    ap.add_argument("--window", type=float, default=1.0, help="seconds of tc lines to use per event")
    a = ap.parse_args()

    cal_in_force = 0.0
    frames = []  # (frameT ms, frame number, actual fps, nominal, df)
    with open(a.greenalyzer) as f:
        for line in f:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("type") == "session":
                cal_in_force = float(m.get("latencyCalMs") or 0)
            elif m.get("type") == "tc" and m.get("frameT") is not None:
                ri = rate_info(m.get("rate"))
                if not ri:
                    continue
                nom, fps, df = ri
                frames.append((m["frameT"], frame_number(m["hh"], m["mm"], m["ss"], m["ff"], nom, df), fps, nom, df))
    if not frames:
        sys.exit("No tc lines with frameT in the Greenalyzer recording (made before frameT existed?)")

    fixed_tc = parse_tc(a.tc) if a.tc else None
    if a.tc and not fixed_tc:
        sys.exit("--tc must be HH:MM:SS:FF")

    diffs = []
    with open(a.osc) as f:
        for line in f:
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("addr") != a.addr:
                continue
            tc = fixed_tc or next((parse_tc(x) for x in m.get("args", []) if isinstance(x, str) and parse_tc(x)), None)
            if not tc:
                print("skip: %s at %.3f has no timecode (use --tc)" % (a.addr, m["t"]), file=sys.stderr)
                continue
            osc_ms = m["t"] * 1000
            # Each tc line within the window predicts when the target frame began:
            # its own frameT plus whole frames to the target. Median of those.
            preds = []
            for ft, n, fps, nom, df in frames:
                if abs(ft - osc_ms) <= a.window * 1000:
                    target = frame_number(*tc, nom, df)
                    preds.append(ft + (target - n) * 1000 / fps)
            if not preds:
                print("skip: no Greenalyzer frames within %.1f s of %s at %.3f" % (a.window, a.addr, m["t"]), file=sys.stderr)
                continue
            d = statistics.median(preds) - osc_ms
            diffs.append(d)
            print("%s at %.3f  %02d:%02d:%02d:%02d  frameT − t = %+.1f ms" % (a.addr, m["t"], *tc, d))

    if not diffs:
        sys.exit("No usable events.")
    med = statistics.median(diffs)
    spread = (max(diffs) - min(diffs)) if len(diffs) > 1 else 0.0
    print()
    print("events: %d   median %+.1f ms   spread %.1f ms" % (len(diffs), med, spread))
    print("LATENCY CAL in force for this recording: %.1f ms" % cal_in_force)
    print("Set LATENCY CAL to: %.1f ms" % (cal_in_force + med))


if __name__ == "__main__":
    main()

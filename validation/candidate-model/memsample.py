"""Samples the largest Chromium renderer's RSS and PSS (smaps_rollup) every second until killed; prints the peak at exit.

Run alongside validation/score-prompts.ts (its headless Chromium holds the model worker in the extension's renderer).
  python3 -I memsample.py OUT.json
"""
import json
import os
import signal
import sys
import time

out = sys.argv[1]
peak = {"rss_mb": 0, "pss_mb": 0, "pid": None, "samples": 0}
series = []


def finish(*_):
    peak["series_tail"] = series[-5:]
    with open(out, "w") as f:
        json.dump(peak, f, indent=1)
    sys.exit(0)


signal.signal(signal.SIGTERM, finish)
signal.signal(signal.SIGINT, finish)
while True:
    best = None
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            raw = open(f"/proc/{pid}/cmdline", "rb").read()  # Chrome rewrites its title: arguments may be space-separated
            if b"chrom" not in raw.split(b" ")[0].split(b"\0")[0] or b"--type=renderer" not in raw:
                continue
            fields = {}
            for line in open(f"/proc/{pid}/smaps_rollup"):
                parts = line.split()
                if parts[0] in ("Rss:", "Pss:"):
                    fields[parts[0]] = int(parts[1]) / 1024
            if best is None or fields.get("Rss:", 0) > best[1]:
                best = (int(pid), fields.get("Rss:", 0), fields.get("Pss:", 0))
        except OSError:
            continue
    if best:
        series.append([round(time.time()), round(best[1]), round(best[2])])
        peak["samples"] += 1
        if best[1] > peak["rss_mb"]:
            peak.update(rss_mb=round(best[1]), pss_mb=round(best[2]), pid=best[0])
    time.sleep(1)

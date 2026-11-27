#!/bin/bash
# quiet.sh LABEL LOGFILE: waits until the 1-minute load average is below 1.5 and all java processes (the other session's
# Gradle daemons) together used under 5% of one core over 10 s, then appends one line with both to LOGFILE.
case "${1:-}" in ''|-h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; [ -n "${1:-}" ]; exit $? ;; esac
label=$1; log=${2:?usage: quiet.sh LABEL LOGFILE}
ticks() { local t=0; for p in $(pgrep -x java); do read -r -a s < /proc/$p/stat 2>/dev/null && t=$((t + s[13] + s[14])); done; echo $t; }
while :; do
  a=$(ticks); sleep 10; b=$(ticks)
  java_pct=$(( (b - a) * 100 / $(getconf CLK_TCK) / 10 ))
  load=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$load" -v j="$java_pct" 'BEGIN{exit !(l < 1.5 && j < 5)}'; then break; fi
done
echo "$(date -u +%FT%TZ) $label load $(cut -d' ' -f1-3 /proc/loadavg) java_cpu_10s ${java_pct}% java_processes $(pgrep -xc java)" >> "$log"

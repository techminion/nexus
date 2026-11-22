#!/bin/bash
# Nexus VPS companion: read-only status for the Pi. The Pi's key is pinned to this script (authorized_keys
# command=), so printing this is all it can do. Output: tab-separated "key value..." lines, parsed by vps.ts.
set -u
[ "${SSH_ORIGINAL_COMMAND:-status}" = status ] || { echo "unknown command" >&2; exit 2; }
snap=/var/lib/nexus-vps/containers.tsv

cpu() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
read -r t1 i1 <<<"$(cpu)"; sleep 0.5; read -r t2 i2 <<<"$(cpu)"
awk -v t=$((t2 - t1)) -v i=$((i2 - i1)) 'BEGIN { if (t > 0) printf "cpu\t%.1f\n", (1 - i / t) * 100 }'
awk '/^MemTotal:/ {t = $2} /^MemAvailable:/ {a = $2} END {printf "mem\t%d\t%d\n", t, a}' /proc/meminfo
df -Pk / | awk 'NR == 2 {printf "disk\t%d\t%d\n", $2, $3}'
awk '{printf "load\t%s\t%s\t%s\n", $1, $2, $3}' /proc/loadavg
awk '{printf "uptime\t%d\n", $1}' /proc/uptime
# Containers come from the root snapshot (this account cannot see other users' rootless containers).
# Age and rows are read through one open file, so a concurrent replace cannot mix two snapshots.
if [ -r "$snap" ] && exec 3<"$snap"; then
  printf 'snapshot\t%d\n' $(( $(date +%s) - $(stat -L -c %Y /dev/fd/3) ))
  cat <&3
fi
exit 0

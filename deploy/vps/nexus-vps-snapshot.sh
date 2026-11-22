#!/bin/bash
# Run by root (nexus-vps-snapshot.timer): root's and every lingering user's rootless containers, for nexus-vps.sh.
# Lines: "c owner name image state status" per container, "e owner" when that owner's podman failed. Replaced atomically.
set -u
out=/var/lib/nexus-vps/containers.tsv
tmp=$(mktemp "$out.XXXXXX")
trap 'rm -f "$tmp"' EXIT
list() {
  # owner comes from this loop, not from podman; strip tabs so a field can never shift columns
  if timeout 20 "$@" podman ps -a --format '{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}' > "$tmp.p" 2>/dev/null; then
    tr -d '\t' < "$tmp.p" | awk -F'|' -v o="$owner" 'NF == 4 {printf "c\t%s\t%s\t%s\t%s\t%s\n", o, $1, $2, $3, $4}'
  else
    printf 'e\t%s\n' "$owner"; echo "podman ps failed for $owner" >&2
  fi
  rm -f "$tmp.p"
}
{
  owner=root list env
  for u in $(ls /var/lib/systemd/linger 2>/dev/null); do
    uid=$(id -u "$u" 2>/dev/null) || continue
    owner=$u list runuser -u "$u" -- env XDG_RUNTIME_DIR="/run/user/$uid"
  done
} > "$tmp"
chgrp nexusmon "$tmp" && chmod 640 "$tmp" && mv "$tmp" "$out"

#!/bin/bash
# Nightly encrypted backup of everything Nexus keeps on the Pi (run as root by nexus-backup.service).
#   nexus-backup.sh          back up
#   nexus-backup.sh --after  ExecStopPost: remove the plaintext staging copy; on failure, push an alert
set -euo pipefail
. /usr/local/libexec/nexus-backup-lib.sh
state=/var/lib/nexus-backup
stage=/var/lib/nexus-backup/stage
tmp=/var/lib/nexus-backup/tmp

if [ "${1:-}" = --after ]; then
  rm -rf /var/lib/nexus-backup/stage /var/lib/nexus-backup/tmp
  [ "${SERVICE_RESULT:-success}" = success ] && exit 0
  url=$(sed -n 's/^NTFY_URL=//p' $nb_conf/nexus.env 2>/dev/null | tail -1); token=$(sed -n 's/^NTFY_TOKEN=//p' $nb_conf/nexus.env 2>/dev/null | tail -1)
  [[ $url =~ ^https?://[^\"[:space:]]+$ && $token =~ ^[A-Za-z0-9_-]*$ ]] || exit 0
  # URL (the topic) and token via a curl config on stdin: neither appears in the process list.
  { printf 'url = "%s"\n' "$url"; [ -z "$token" ] || printf 'header = "Authorization: Bearer %s"\n' "$token"; } |
    curl -sf -m 15 -K - -H "Title: Nexus: backup failed" -H "Tags: warning" -H "Priority: high" \
      -d "Nightly backup failed on $(hostname) ($SERVICE_RESULT). See: journalctl -u nexus-backup" >/dev/null || true
  exit 0
fi

nb_load
# Same repository every night: the first successful run records its id; later runs refuse any other repository
# (a typo or a different server must fail loudly, not quietly start a new history).
repo_id() { r cat config | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["id"])'; }
if [ -s $state/repo-id ]; then
  [ "$(repo_id)" = "$(cat $state/repo-id)" ] || { echo "repository id changed: refusing (see $state/repo-id)" >&2; exit 1; }
elif ! r cat config >/dev/null 2>&1; then
  r init
fi
[ -s $state/repo-id ] || repo_id > $state/repo-id

rm -rf /var/lib/nexus-backup/stage /var/lib/nexus-backup/tmp
install -d -m 700 "$stage" "$tmp"
for v in nexus-data homeassistant-config nexus-caddy-data; do
  src=$(podman volume inspect "$v" --format '{{.Mountpoint}}')
  [ -d "${src:?}" ]
  # Every live database journal must belong to a database snapshotted below.
  while IFS= read -r -d '' j; do
    [[ ${j%-*} =~ \.(db|sqlite|sqlite3)$ ]] || { echo "unsupported database journal: $j" >&2; exit 1; }
  done < <(find "$src" -type f \( -name '*-wal' -o -name '*-journal' \) -print0)
  rsync -a --exclude '*-wal' --exclude '*-shm' --exclude '*-journal' --exclude 'home-assistant.log*' "$src/" "$stage/$v/"
  # Live SQLite databases: replace the plain copy (possibly mid-write) with a consistent online-backup snapshot,
  # written in a root-only temp dir (never through a path the volume controls), then renamed into place.
  find "$src" -type f \( -name '*.db' -o -name '*.sqlite' -o -name '*.sqlite3' \) -print0 | while IFS= read -r -d '' db; do
    python3 -I - "$db" "$stage/$v/${db#"$src"/}" "$tmp" <<'PY'
import os, pathlib, sqlite3, sys, tempfile
src, out, tmpdir = sys.argv[1:4]
st = os.stat(src)
fd, tmp = tempfile.mkstemp(dir=tmpdir); os.close(fd)
s = sqlite3.connect(pathlib.Path(src).as_uri() + "?mode=ro", uri=True)
d = sqlite3.connect(tmp)
s.backup(d)
d.close(); s.close()
os.chown(tmp, st.st_uid, st.st_gid); os.chmod(tmp, st.st_mode & 0o7777)
if os.path.islink(out) or not os.path.isfile(out):
    raise SystemExit(f"unexpected staged path: {out}")
os.replace(tmp, out)
PY
  done
done
cp -a $nb_conf "$stage/etc-nexus"   # secrets too: the repository is encrypted

r backup --host $NB_HOST --tag nexus "$stage"
r forget --quiet --host $NB_HOST --tag nexus --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
date -u +%FT%TZ > $state/last-ok

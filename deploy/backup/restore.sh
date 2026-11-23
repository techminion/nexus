#!/bin/bash
# Restore Nexus on this Pi from the backup:
#   sudo bash deploy/backup/restore.sh [--dry-run] [snapshot-id|latest]
# Needs a working backup setup (on a new Pi: ./install.sh, then setup-pi.sh with the SAME server and path, put your
# saved backup password into /etc/nexus/backup.pass, and authorize the new key with backup-target.sh). It replaces the
# three data volumes and /etc/nexus (keeping this Pi's backup settings), stopping the services meanwhile.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
. "$here/lib.sh"
dry=""; [ "${1:-}" = --dry-run ] && { dry=1; shift; }
snap=${1:-latest}
[[ $snap =~ ^(latest|[0-9a-f]{8,64})$ ]] || { echo "snapshot: latest or a snapshot id" >&2; exit 1; }
nb_load
r snapshots --host $NB_HOST --tag nexus --compact | tail -n 6
t=$(mktemp -d /var/tmp/nexus-restore.XXXXXX)   # root-only; holds plaintext secrets while it exists
trap 'rm -rf "${t:?}"' EXIT
r restore "$snap" --host $NB_HOST --tag nexus --target "$t" >/dev/null
s="$t/var/lib/nexus-backup/stage"
for d in nexus-data homeassistant-config nexus-caddy-data etc-nexus; do [ -d "$s/$d" ] || { echo "snapshot lacks $d" >&2; exit 1; }; done
vols=(nexus-data homeassistant-config nexus-caddy-data)
echo "Changes (first lines per volume):"
for v in "${vols[@]}"; do
  m=$(podman volume inspect "$v" --format '{{.Mountpoint}}')
  echo "== $v"; rsync -an --delete --numeric-ids --itemize-changes "$s/$v/" "${m:?}/" | head -5
done
echo "== /etc/nexus (backup settings kept)"; rsync -an --delete --numeric-ids --itemize-changes --exclude 'backup*' "$s/etc-nexus/" /etc/nexus/ | head -5
[ -z "$dry" ] || { echo "Dry run: nothing changed."; exit 0; }
read -r -p "Replace the current data with snapshot $snap? [y/N] " a
[[ $a =~ ^[Yy] ]] || { echo "Nothing changed."; exit 1; }
systemctl stop nexus caddy homeassistant
for v in "${vols[@]}"; do m=$(podman volume inspect "$v" --format '{{.Mountpoint}}'); rsync -a --delete --numeric-ids "$s/$v/" "${m:?}/"; done
rsync -a --delete --numeric-ids --exclude 'backup*' "$s/etc-nexus/" /etc/nexus/
systemctl start homeassistant nexus caddy
echo "Restored $snap. Check https://<pi>/ and Home Assistant."

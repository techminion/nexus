#!/bin/sh
# On the backup server, as root (nexus-backup-vault.timer): a daily copy of the backup repository into a folder
# only root can read or change, kept 30 days. A compromised Pi can delete what is in the backup account, never these.
# shortcut: full copies (the repository is a few MB); for a large one use restic's rest-server --append-only.
#   nexus-backup-vault.sh <repository folder>
set -eu
src=${1:?usage: nexus-backup-vault.sh <repository folder>}
[ -d "$src" ] || exit 0
install -d -m 700 /var/lib/nexus-backup-vault
day=$(date +%F)
if [ ! -e "/var/lib/nexus-backup-vault/$day" ]; then
  rm -rf "/var/lib/nexus-backup-vault/$day.tmp"
  cp -a "$src" "/var/lib/nexus-backup-vault/$day.tmp"
  mv "/var/lib/nexus-backup-vault/$day.tmp" "/var/lib/nexus-backup-vault/$day"
fi
find /var/lib/nexus-backup-vault -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

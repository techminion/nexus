# Shared by nexus-backup.sh and restore.sh (bash). Reads /etc/nexus/backup.env (written by setup-pi.sh), never sources it.
nb_conf=/etc/nexus

nb_load() {
  local k v
  BACKUP_TARGET="" BACKUP_PATH=""
  while IFS='=' read -r k v; do case $k in BACKUP_TARGET|BACKUP_PATH) printf -v "$k" '%s' "$v" ;; esac; done < $nb_conf/backup.env
  [[ $BACKUP_TARGET =~ ^[a-z_][a-z0-9_.-]*@[a-zA-Z0-9.-]+$ && $BACKUP_PATH =~ ^[A-Za-z0-9_./-]+$ ]] ||
    { echo "backup.env: bad BACKUP_TARGET/BACKUP_PATH" >&2; return 1; }
  export RESTIC_REPOSITORY="sftp:$BACKUP_TARGET:$BACKUP_PATH" RESTIC_PASSWORD_FILE=$nb_conf/backup.pass
  export XDG_CACHE_HOME=${XDG_CACHE_HOME:-/var/cache/nexus-backup}
  # Only this key, only the pinned host key; the server forces sftp for it anyway.
  nb_sftp="ssh -F /dev/null -i $nb_conf/backup/id_ed25519 -o IdentitiesOnly=yes -o IdentityAgent=none -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$nb_conf/backup/known_hosts -o ConnectTimeout=20 $BACKUP_TARGET -s sftp"
}
r() { restic -o sftp.command="$nb_sftp" "$@"; }
# Snapshots carry this host name, not the Pi's, so a replacement Pi continues the same history and retention.
NB_HOST=nexus

#!/bin/bash
# One-time backup setup on the Pi, after a deploy:  sudo bash deploy/backup/setup-pi.sh <user>@<backup-host> [path]
# Installs restic, creates the backup ssh key and the repository password, pins the server's host key and
# writes /etc/nexus/backup.env. Then run backup-target.sh on the server with the key it prints.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
target=${1:?usage: sudo bash setup-pi.sh <user>@<backup-host> [path]}; path=${2:-nexus}
[[ $target =~ ^[a-z_][a-z0-9_.-]*@[a-zA-Z0-9.-]+$ && $path =~ ^[A-Za-z0-9_./-]+$ ]] || { echo "bad target or path" >&2; exit 1; }
d=/etc/nexus/backup
command -v restic >/dev/null || apt-get install -y -q restic
install -d -m 700 "$d" /var/lib/nexus-backup
[ -f "$d/id_ed25519" ] || ssh-keygen -q -t ed25519 -N '' -C "nexus-backup@$(hostname)" -f "$d/id_ed25519"
if [ ! -s "$d/known_hosts" ]; then
  ssh-keyscan -t ed25519 "${target#*@}" 2>/dev/null > "$d/known_hosts.new"
  echo "Host key of ${target#*@}:"; ssh-keygen -lf "$d/known_hosts.new"
  read -r -p "Does this match the server's /etc/ssh/ssh_host_ed25519_key.pub fingerprint? [y/N] " a
  [[ $a =~ ^[Yy] ]] || { rm -f "$d/known_hosts.new"; echo "not pinned" >&2; exit 1; }
  mv "$d/known_hosts.new" "$d/known_hosts"
fi
if [ ! -s /etc/nexus/backup.pass ]; then
  (umask 077; openssl rand -base64 32 > /etc/nexus/backup.pass)
  echo
  echo "Created /etc/nexus/backup.pass, the repository password. SAVE A COPY OUTSIDE THE PI (a password manager):"
  echo "without it the backups cannot be decrypted, and the copy on the Pi dies with the Pi."
fi
chown root:root /etc/nexus/backup.pass; chmod 600 /etc/nexus/backup.pass
printf 'BACKUP_TARGET=%s\nBACKUP_PATH=%s\n' "$target" "$path" > /etc/nexus/backup.env
chmod 600 /etc/nexus/backup.env
echo
echo "Now on ${target#*@}:  sudo bash backup-target.sh '$(cat "$d/id_ed25519.pub")'"
echo "Then here:  sudo systemctl start nexus-backup && sudo systemctl enable --now nexus-backup.timer"
echo "Keep off the Pi: the password, and the server and path ($target, $path). Restoring needs them and a key the server accepts."

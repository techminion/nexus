#!/bin/bash
# On the backup server (any Linux with OpenSSH):  sudo bash backup-target.sh '<Pi backup public key>' [user]
# Creates an account (default nexusbak; locked password, no sudo) whose key can only speak sftp. The backups are
# encrypted on the Pi; this server never sees the password.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
key=${1:?usage: sudo bash backup-target.sh '<ssh-ed25519 ... nexus-backup@pi>' [user]}; user=${2:-nexusbak}
[[ $key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]*)?$ ]] && ssh-keygen -l -f /dev/stdin <<<"$key" >/dev/null 2>&1 ||
  { echo "expected one ssh-ed25519 public key" >&2; exit 1; }
[[ $user =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "bad user name" >&2; exit 1; }
sftp=$(for p in /usr/libexec/openssh/sftp-server /usr/lib/openssh/sftp-server /usr/lib/ssh/sftp-server; do [ -x "$p" ] && echo "$p" && break; done)
[ -n "$sftp" ] || { echo "sftp-server not found" >&2; exit 1; }
comment="Nexus backups (sftp only)"
id "$user" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash --comment "$comment" "$user"
[ "$(getent passwd "$user" | cut -d: -f5)" = "$comment" ] || { echo "$user exists and was not created by this script" >&2; exit 1; }
home=$(getent passwd "$user" | cut -d: -f6)
[ -L "$home/.ssh" ] && { echo "$home/.ssh is a symlink, refusing" >&2; exit 1; }
# Root owns the home folder, .ssh and the key file: over sftp the account can neither change its key nor rename
# .ssh away and plant its own. It may write only in its repository folder.
chown root:root "$home"; chmod 755 "$home"
install -d -m 755 -o root -g root "$home/.ssh"
install -d -m 700 -o "$user" -g "$user" "$home/nexus"
# Its startup files too: bash reads ~/.bashrc even for an sshd forced command, so a writable one is a way out of sftp.
find "$home" -mindepth 1 -maxdepth 1 ! -name nexus -exec chown -R root:root {} +
tmp=$(mktemp "$home/.ssh/.ak.XXXXXX")
echo "restrict,command=\"$sftp\" $key" > "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$home/.ssh/authorized_keys"
# Daily root-only copies of the repository (see nexus-backup-vault.sh).
install -m 755 "$here/nexus-backup-vault.sh" /usr/local/libexec/nexus-backup-vault.sh
sed "s|@REPO@|$home/nexus|" "$here/nexus-backup-vault.service" > /etc/systemd/system/nexus-backup-vault.service
install -m 644 "$here/nexus-backup-vault.timer" /etc/systemd/system/nexus-backup-vault.timer
if command -v restorecon >/dev/null && selinuxenabled 2>/dev/null; then
  restorecon -R "$home" /usr/local/libexec/nexus-backup-vault.sh /etc/systemd/system/nexus-backup-vault.service /etc/systemd/system/nexus-backup-vault.timer
fi
systemctl daemon-reload
systemctl enable --now nexus-backup-vault.timer >/dev/null
echo "Vault: daily root-only copies of the repository in /var/lib/nexus-backup-vault (30 days)."
echo "Ready: $user@$(hostname -f 2>/dev/null || hostname) accepts the key for sftp only. Repository: $home/nexus"

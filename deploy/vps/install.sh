#!/bin/bash
# Install or update the Nexus VPS companion (read-only status: CPU, memory, disk, containers).
#   sudo bash install.sh '<contents of /etc/nexus/vps/id_ed25519.pub on the Pi>'
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo" >&2; exit 1; }
key=${1:?usage: sudo bash install.sh '<ssh-ed25519 ... nexus-pi>'}
[[ $key =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]*)?$ ]] || { echo "expected one ssh-ed25519 public key" >&2; exit 1; }
ssh-keygen -l -f /dev/stdin <<<"$key" >/dev/null 2>&1 || { echo "not a valid ssh public key" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

# Own account, no password (locked), not in wheel: it can only run nexus-vps.sh.
comment="Nexus read-only status"
id nexusmon >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash --comment "$comment" nexusmon
[ "$(getent passwd nexusmon | cut -d: -f5)" = "$comment" ] || { echo "a nexusmon account exists that this installer did not create" >&2; exit 1; }
home=$(getent passwd nexusmon | cut -d: -f6)

install -m 755 "$here/nexus-vps.sh" /usr/local/bin/nexus-vps.sh
install -d /usr/local/libexec
install -m 755 "$here/nexus-vps-snapshot.sh" /usr/local/libexec/nexus-vps-snapshot.sh
install -d -m 750 -g nexusmon /var/lib/nexus-vps
install -m 644 "$here/nexus-vps-snapshot.service" "$here/nexus-vps-snapshot.timer" /etc/systemd/system/

# Root owns .ssh and the key file (sshd accepts that), so the account cannot change its own key.
[ -L "$home/.ssh" ] && { echo "$home/.ssh is a symlink, refusing" >&2; exit 1; }
install -d -m 755 -o root -g root "$home/.ssh"
# shortcut: no from= (the home's public IP is dynamic); the key can only print status. Add from="<ip>" if it becomes static.
tmp=$(mktemp "$home/.ssh/.ak.XXXXXX")
echo "restrict,command=\"/usr/local/bin/nexus-vps.sh\" $key" > "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$home/.ssh/authorized_keys"
if command -v restorecon >/dev/null && selinuxenabled 2>/dev/null; then
  restorecon -R "$home/.ssh" /usr/local/bin/nexus-vps.sh /usr/local/libexec/nexus-vps-snapshot.sh /var/lib/nexus-vps
fi

systemctl daemon-reload
systemctl enable --now nexus-vps-snapshot.timer
systemctl start nexus-vps-snapshot.service
echo "Installed. Containers seen: $(wc -l < /var/lib/nexus-vps/containers.tsv)"

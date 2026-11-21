#!/bin/bash
# Run on the Mac: bash install.sh '<Nexus Pi public key>' [pi-ip]
# Installs nexus-mac.sh and pins the Pi's key to it: that key can run only the companion's verbs,
# only from the Pi, with no shell, pty or forwarding. Re-running replaces the previous entry.
set -eu
key=${1:-}; from=${2:-192.168.31.128}
case $key in "ssh-ed25519 "*" nexus-pi") ;; *) echo "usage: install.sh '<ssh-ed25519 ... nexus-pi>' [pi-ip]" >&2; exit 2 ;; esac
dir=$(cd "$(dirname "$0")" && pwd)
mkdir -p ~/.local/bin ~/.config/nexus-mac ~/.ssh
chmod 700 ~/.ssh
install -m 755 "$dir/nexus-mac.sh" ~/.local/bin/nexus-mac.sh
touch ~/.config/nexus-mac/apps ~/.config/nexus-mac/shortcuts
ak=~/.ssh/authorized_keys
touch "$ak"
blob=$(echo "$key" | cut -d' ' -f2)
{ grep -vF -- "$blob" "$ak" || true; echo "restrict,command=\"$HOME/.local/bin/nexus-mac.sh\",from=\"$from\" $key"; } > "$ak.tmp"
chmod 600 "$ak.tmp"; mv "$ak.tmp" "$ak"
echo "Installed. Allow apps in ~/.config/nexus-mac/apps and Shortcuts in ~/.config/nexus-mac/shortcuts (one name per line)."

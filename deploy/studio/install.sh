#!/usr/bin/env bash
# Install or update the Nexus Studio camera server on this machine (crashmetheus). No root needed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
conf=~/.config/nexus-studio
install -d -m 700 "$conf"
install -d ~/.local/opt/mediamtx ~/.config/systemd/user

# Pinned release, verified against its published SHA-256.
ver=v1.21.4
sha=be0c05d9c8af8338116977e7f1c3fcb409fbf882075e5ab075cf8baad76a59d2
bin=~/.local/opt/mediamtx/mediamtx
if [ "$(cat ~/.local/opt/mediamtx/VERSION 2>/dev/null)" != "$ver" ]; then
  tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
  curl -sSfL -o "$tmp/m.tgz" "https://github.com/bluenviron/mediamtx/releases/download/$ver/mediamtx_${ver}_linux_amd64.tar.gz"
  echo "$sha  $tmp/m.tgz" | sha256sum -c --quiet
  tar -xzf "$tmp/m.tgz" -C "$tmp" mediamtx
  install -m 755 "$tmp/mediamtx" "$bin"
  echo "$ver" > ~/.local/opt/mediamtx/VERSION
fi
if [ ! -s "$conf/publish.pass" ]; then
  (umask 077; openssl rand -hex 12 > "$conf/publish.pass")
  echo "Created $conf/publish.pass (camera publish password)"
fi
pass=$(<"$conf/publish.pass")
[[ $pass =~ ^[0-9a-f]{24}$ ]] || { echo "$conf/publish.pass must hold 24 hex characters" >&2; exit 1; }
# Builtins only (no sed/awk), so the password never appears in a process command line;
# write a 0600 temp file and rename, so a failure never leaves a truncated config behind.
tpl=$(<"$here/mediamtx.yml")
out=$(mktemp "$conf/.mediamtx.yml.XXXXXX")
printf '%s\n' "${tpl//__PUBLISH_PASS__/$pass}" > "$out"
mv -f "$out" "$conf/mediamtx.yml"
install -m 644 "$here/mediamtx.service" ~/.config/systemd/user/mediamtx.service
systemctl --user daemon-reload
systemctl --user enable mediamtx >/dev/null 2>&1
systemctl --user restart mediamtx
systemctl --user is-active mediamtx
echo "Firewall (once, needs sudo): sudo firewall-cmd --permanent --add-port={1935/tcp,8889/tcp,8189/udp,9997/tcp} && sudo firewall-cmd --reload"

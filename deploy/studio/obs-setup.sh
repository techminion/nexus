#!/usr/bin/env bash
# Set up OBS Studio (user Flatpak) on crashmetheus for Nexus: obs-websocket on :4455 with a generated
# password, and OBS started with the desktop session. No root needed. Safe to re-run.
set -euo pipefail
app=com.obsproject.Studio
conf=~/.config/nexus-studio
install -d -m 700 "$conf"
flatpak info --user "$app" >/dev/null 2>&1 || flatpak install --user -y --noninteractive flathub "$app"

if [ ! -s "$conf/obs.pass" ]; then
  (umask 077; openssl rand -hex 16 > "$conf/obs.pass")
  echo "Created $conf/obs.pass (OBS websocket password)"
fi
pass=$(<"$conf/obs.pass")
[[ $pass =~ ^[0-9a-f]{32}$ ]] || { echo "$conf/obs.pass must hold 32 hex characters" >&2; exit 1; }

# obs-websocket reads this at startup; first_load=false stops it generating its own password.
ws=~/.var/app/$app/config/obs-studio/plugin_config/obs-websocket
install -d -m 700 "$ws"
out=$(mktemp "$ws/.config.json.XXXXXX")
printf '{"alerts_enabled":false,"auth_required":true,"first_load":false,"server_enabled":true,"server_password":"%s","server_port":4455}\n' "$pass" > "$out"
mv -f "$out" "$ws/config.json"

install -d ~/.config/autostart
cat > ~/.config/autostart/nexus-obs.desktop <<EOF
[Desktop Entry]
Type=Application
Name=OBS Studio (Nexus)
Exec=flatpak run $app --disable-shutdown-check
X-GNOME-Autostart-enabled=true
EOF
echo "OBS websocket: ws://$(hostname -I | awk '{print $1}'):4455 (restart OBS if it was already open)"
echo "Firewall (once, needs sudo), Pi only: sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.31.128 port port=4455 protocol=tcp accept' && sudo firewall-cmd --reload"

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

# Recordings go to ~/nexus/videos. OBS rewrites its profile on exit, so only edit it while OBS is closed;
# a fresh install has no profile until OBS's first start, so re-run this after that.
rec=~/nexus/videos
install -d "$rec"
profiles=(~/.var/app/$app/config/obs-studio/basic/profiles/*/basic.ini)
if [ ! -e "${profiles[0]}" ]; then
  echo "Recording path: start OBS once, close it, then re-run this to set $rec"
elif grep -qxF "RecFilePath=$rec" "${profiles[@]}" && grep -qxF "FilePath=$rec" "${profiles[@]}"; then
  echo "Recording path: $rec"
elif pgrep -x obs >/dev/null; then
  echo "Recording path: close OBS, then re-run this to set $rec"
else
  python3 - "$rec" "${profiles[@]}" <<'PY'
import configparser, sys
rec, *files = sys.argv[1:]
for f in files:
    c = configparser.RawConfigParser(strict=False); c.optionxform = str; c.read(f, encoding="utf-8-sig")
    for sec, key in (("SimpleOutput", "FilePath"), ("AdvOut", "RecFilePath")):
        c.has_section(sec) or c.add_section(sec); c.set(sec, key, rec)
    with open(f, "w", encoding="utf-8") as fh: c.write(fh, space_around_delimiters=False)
PY
  echo "Recording path: set to $rec"
fi

install -d ~/.config/autostart
cat > ~/.config/autostart/nexus-obs.desktop <<EOF
[Desktop Entry]
Type=Application
Name=OBS Studio (Nexus)
Exec=flatpak run $app --disable-shutdown-check
X-GNOME-Autostart-enabled=true
EOF
echo "OBS websocket: ws://$(hostname -I | awk '{print $1}'):4455 (restart OBS if it was already open)"
echo "Firewall (once, needs sudo), Pi only: sudo firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=<Pi IP> port port=4455 protocol=tcp accept' && sudo firewall-cmd --reload"

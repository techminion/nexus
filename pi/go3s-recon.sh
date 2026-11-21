#!/bin/bash
# Unattended test: wake the camera's Wi-Fi over Bluetooth, join it, look around, return to the home Wi-Fi.
# The Pi is unreachable over Wi-Fi while this runs. Result: logs/go3s-recon.log
cd ~/actionlab2 || exit 1
HOME_CON="Dr.HeinzDoofenshmirtz"
exec > logs/go3s-recon.log 2>&1
back() { echo "== returning to home Wi-Fi"; sudo nmcli connection up "$HOME_CON" || { sleep 5; sudo nmcli connection up "$HOME_CON"; }; }
trap back EXIT
ssid=$(sed -n 's/^ssid=//p' go3s-wifi.conf); psk=$(sed -n 's/^password=//p' go3s-wifi.conf)
sudo nmcli connection delete go3s >/dev/null 2>&1
sudo nmcli connection add type wifi con-name go3s ifname wlan0 ssid "$ssid" \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" connection.autoconnect no >/dev/null
.venv/bin/python go3s.py listen --seconds 70 > logs/go3s-recon-ble.log 2>&1 &
sleep 12
sudo nmcli device wifi rescan 2>/dev/null; sleep 3
echo "== joining $ssid"; timeout 30 sudo nmcli connection up go3s || exit 1
ip -br addr show wlan0; ip route
gw=$(ip route | awk '/default.*wlan0/{print $3; exit}'); echo "gateway: $gw"
for host in $gw 192.168.42.1; do
  [ -n "$host" ] || continue
  ping -c 2 -W 1 $host | tail -2
  for port in 6666 80 8080 554 1935 9099 6667; do
    timeout 2 bash -c "echo > /dev/tcp/$host/$port" 2>/dev/null && echo "$host:$port OPEN" || echo "$host:$port closed"
  done
done
[ -x ./go3s-wifi-test.sh ] && timeout 45 ./go3s-wifi-test.sh "$gw"
echo "== done"

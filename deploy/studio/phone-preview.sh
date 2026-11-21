#!/usr/bin/env bash
# MediaMTX runOnDemand for a phone: mirrors its screen (the Camera app's viewfinder) at low resolution as a
# Studio preview. The phone records full quality in its own Camera app; this never opens the camera.
# Needs the phone paired once over adb wireless debugging, and wireless debugging switched on before each preview;
# it is switched off again when the preview stops. Usage: phone-preview.sh <phone-host-or-ip>
set -euo pipefail
ip=$(getent ahostsv4 "$1" | awk 'NR == 1 { print $1 }')
[[ $ip =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "cannot resolve phone: $1" >&2; exit 2; }
adb=~/.local/opt/platform-tools/adb
ver=5.0.1
jar=~/.local/opt/scrcpy/scrcpy-server-v$ver

dev=$("$adb" devices | awk -v ip="$ip" 'index($1, ip ":") == 1 && $2 == "device" { print $1; exit }')
if [ -z "$dev" ]; then
  # Wireless debugging listens on a new random port after every reboot or Wi-Fi reconnect.
  for port in $(nmap -Pn -T4 -p 30000-49999 --open -oG - "$ip" | grep -oE '[0-9]+/open' | cut -d/ -f1); do
    "$adb" connect "$ip:$port" | grep -q '^connected' && { dev=$ip:$port; break; }
  done
fi
[ -n "$dev" ] || { echo "phone $ip: no adb connection (is wireless debugging on?)" >&2; exit 1; }

"$adb" -s "$dev" push "$jar" /data/local/tmp/scrcpy-server.jar >/dev/null
scid=$(printf '%08x' $(( (RANDOM << 15 | RANDOM) & 0x7fffffff )))
lport=$("$adb" -s "$dev" forward tcp:0 "localabstract:scrcpy_$scid")
pids=()
cleanup() {
  kill "${pids[@]}" 2>/dev/null || true; "$adb" -s "$dev" forward --remove "tcp:$lport" 2>/dev/null || true
  # Close the phone's debug port once nobody is previewing; the pairing survives, so re-enabling it is one tap.
  timeout 5 "$adb" -s "$dev" shell settings put global adb_wifi_enabled 0 2>/dev/null || true
  "$adb" disconnect "$dev" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

"$adb" -s "$dev" shell CLASSPATH=/data/local/tmp/scrcpy-server.jar app_process / com.genymobile.scrcpy.Server "$ver" \
  "scid=$scid" tunnel_forward=true audio=false control=false raw_stream=true \
  video_source=display max_size=1280 video_bit_rate=2000000 max_fps=30 \
  video_codec_options=i-frame-interval:int=2 >/dev/null 2>&1 &
pids+=($!)
sleep 2 # let the server open its socket; connecting earlier gets an immediate EOF

# Screen frames come only when something changes, so stamp them with arrival time.
ffmpeg -hide_banner -loglevel error -fflags nobuffer -use_wallclock_as_timestamps 1 -f h264 -i "tcp://127.0.0.1:$lport" \
  -c copy -f rtsp -rtsp_transport tcp "rtsp://127.0.0.1:${RTSP_PORT:-8554}/$MTX_PATH" &
pids+=($!)
wait -n

#!/usr/bin/env bash
# MediaMTX runOnDemand for the DJI Action 2: asks the Pi (in Bluetooth range of the camera) to start the
# camera's RTMP livestream into this path, as a Studio preview. The camera records full quality to its own card.
# The stream runs as a systemd user unit on the Pi; stopping it makes action2.py tell the camera to stop.
# Usage: dji-preview.sh <ssh-target>   (needs ~/.config/nexus-studio/dji.url on the Pi, see install.sh)
set -euo pipefail
pi=$1
ssh=(ssh -o BatchMode=yes -o ConnectTimeout=5 "$pi")
unit=nexus-dji
stop() { "${ssh[@]}" "systemctl --user stop $unit" 2>/dev/null || true; }
trap stop EXIT
trap 'exit 0' INT TERM

"${ssh[@]}" "systemctl --user stop $unit 2>/dev/null; systemctl --user reset-failed $unit 2>/dev/null
  d=\$HOME/actionlab2; systemd-run --user --quiet --unit=$unit --collect --working-directory=\$d \
    \$d/.venv/bin/python -u \$d/action2.py stream --seconds 0 --kbps 2500 --url-file \$HOME/.config/nexus-studio/dji.url"
# Stay alive while the camera streams; MediaMTX stops us when nobody watches.
while "${ssh[@]}" "systemctl --user is-active -q $unit"; do sleep 10 & wait $!; done

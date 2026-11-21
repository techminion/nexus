#!/bin/bash
# Run by go3s-recon.sh while the Pi is on the camera's Wi-Fi.
cd ~/actionlab2
rm -f logs/go3s-preview*
echo "== attempt A: live-view announcement, then start with gyro"
.venv/bin/python go3s_wifi.py --seconds 9 --out logs/go3s-previewA --live-view --body 10013028381d4001 2>&1 | grep -vE "video 0 packets"
echo "== attempt B: start with gyro only"
.venv/bin/python go3s_wifi.py --seconds 7 --out logs/go3s-previewB --body 10013028381d4001 2>&1 | grep -vE "video 0 packets"
ls -la logs/ | grep go3s-preview

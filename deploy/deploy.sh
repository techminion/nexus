#!/usr/bin/env bash
# Sync source to the Pi, build the image there (arm64) and (re)start the Quadlet units.
set -euo pipefail
HOST=${HOST:-akhaire@epimetheus}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude enclosure \
  --exclude .claude-flow --exclude .rtk "$ROOT/" "$HOST:~/nexus/"
ssh "$HOST" 'set -e
  cd ~/nexus
  sudo podman build -t localhost/nexus:latest -f Containerfile .
  sudo install -d -m 700 /etc/nexus
  sudo install -m 644 deploy/Caddyfile /etc/nexus/Caddyfile
  sudo install -m 644 deploy/nexus.network deploy/nexus.container deploy/caddy.container deploy/homeassistant.container /etc/containers/systemd/
  sudo install -m 644 deploy/nexus-snapshot.service deploy/nexus-snapshot.timer /etc/systemd/system/
  sudo install -m 644 deploy/nexus-tmpfiles.conf /etc/tmpfiles.d/nexus.conf
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/nexus.conf
  if ! sudo test -f /etc/nexus/nexus.env; then
    printf "NEXUS_PASSWORD=%s\nSESSION_SECRET=%s\nPUBLIC_URL=https://192.168.31.128\nSPOTIFY_CLIENT_ID=\n" \
      "$(openssl rand -base64 12 | tr -d /+=)" "$(openssl rand -hex 32)" | sudo tee /etc/nexus/nexus.env >/dev/null
    sudo chmod 600 /etc/nexus/nexus.env
    echo "Created /etc/nexus/nexus.env (edit SPOTIFY_CLIENT_ID, then: sudo systemctl restart nexus)"
  fi
  sudo systemctl daemon-reload
  sudo systemctl start nexus-network  # start, not restart: the network must outlive the containers on it
  sudo systemctl enable --now nexus-snapshot.timer
  sudo systemctl start nexus-snapshot.service
  sudo systemctl start homeassistant || echo "WARN: Home Assistant failed to start; continuing with Nexus rollout"
  sudo systemctl restart nexus caddy
  sudo podman image prune -f >/dev/null'

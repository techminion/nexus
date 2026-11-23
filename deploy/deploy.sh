#!/usr/bin/env bash
# Sync source to the Pi, build the image there and (re)start the Quadlet units. Settings come from
# deploy/site.env (run ./install.sh once to create it); HOST=<user>@<pi> overrides its PI_SSH.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
. "$ROOT/deploy/site.sh"
site_load
HOST=${HOST:-$PI_SSH}
[ -n "$HOST" ] || { echo "usage: HOST=<user>@<pi> deploy/deploy.sh (or set PI_SSH in deploy/site.env)" >&2; exit 1; }
site_ssh "$HOST" || { echo "HOST must look like user@host" >&2; exit 1; }

caddy=$(<"$ROOT/deploy/Caddyfile")
caddy=${caddy//__PI_IP__/$PI_IP}; caddy=${caddy//__SITES__/$SITES}; caddy=${caddy//__HA_SITES__/$HA_SITES}
# No Studio host: point the camera proxy at nothing (requests fail with 502, the rest works).
caddy=${caddy//__STUDIO_IP__/${STUDIO_IP:-127.0.0.1}}
site_list d "$BUILD_DNS"; dns=(); for x in ${d[@]+"${d[@]}"}; do dns+=("--dns=$x"); done

rsync -az --delete --exclude node_modules --exclude dist --exclude data --exclude enclosure \
  --exclude .claude-flow --exclude .rtk --exclude '*.env' --exclude '.env*' "$ROOT/" "$HOST:~/nexus/"
printf '%s\n' "$caddy" | ssh -- "$HOST" 'cat > ~/nexus/deploy/Caddyfile.rendered'
# bash -s: the same script whatever the Pi user's login shell is. Arguments were validated by site_load.
# ${dns[@]+...}: an empty array is "unbound" under set -u in bash 3.2 (macOS).
ssh -- "$HOST" bash -s -- "$PUBLIC_URL" ${dns[@]+"${dns[@]}"} <<'REMOTE'
  set -e
  public_url=$1; shift
  cd ~/nexus
  sudo podman build "$@" -t localhost/nexus:latest -f Containerfile .
  sudo install -d -m 700 /etc/nexus /etc/nexus/mac /etc/nexus/vps  # mac/, vps/: companion keys (may stay empty)
  sudo install -m 644 deploy/Caddyfile.rendered /etc/nexus/Caddyfile
  sudo install -m 644 deploy/nexus.network deploy/nexus.container deploy/caddy.container deploy/homeassistant.container /etc/containers/systemd/
  sudo install -m 644 deploy/nexus-snapshot.service deploy/nexus-snapshot.timer /etc/systemd/system/
  # Backups: installed always, switched on once by deploy/backup/setup-pi.sh.
  sudo install -m 755 deploy/backup/nexus-backup.sh /usr/local/libexec/nexus-backup.sh
  sudo install -m 644 deploy/backup/lib.sh /usr/local/libexec/nexus-backup-lib.sh
  sudo install -m 644 deploy/backup/nexus-backup.service deploy/backup/nexus-backup.timer /etc/systemd/system/
  sudo install -m 644 deploy/nexus-tmpfiles.conf /etc/tmpfiles.d/nexus.conf
  sudo systemd-tmpfiles --create /etc/tmpfiles.d/nexus.conf
  if ! sudo test -f /etc/nexus/nexus.env; then
    printf "NEXUS_PASSWORD=%s\nSESSION_SECRET=%s\nPUBLIC_URL=%s\nSPOTIFY_CLIENT_ID=\n" \
      "$(openssl rand -base64 12 | tr -d /+=)" "$(openssl rand -hex 32)" "$public_url" | sudo tee /etc/nexus/nexus.env >/dev/null
    sudo chmod 600 /etc/nexus/nexus.env
    echo "Created /etc/nexus/nexus.env (login password: sudo grep NEXUS_PASSWORD /etc/nexus/nexus.env)"
  fi
  sudo systemctl daemon-reload
  sudo systemctl start nexus-network  # start, not restart: the network must outlive the containers on it
  sudo systemctl enable --now nexus-snapshot.timer
  sudo systemctl start homeassistant || echo "WARN: Home Assistant failed to start; continuing with Nexus rollout"
  sudo systemctl restart nexus caddy
  sudo systemctl start nexus-snapshot.service  # after the restart: --rm containers vanish while restarting
  sudo podman image prune -f >/dev/null
REMOTE

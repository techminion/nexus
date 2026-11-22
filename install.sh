#!/usr/bin/env bash
# First-time setup of Nexus on a Raspberry Pi (or any 64-bit Debian box with Podman), run from your computer:
#   ./install.sh
# Asks for the Pi's ssh login and network names, checks the Pi, writes deploy/site.env and runs deploy/deploy.sh.
# Re-running it is safe; for later updates just run deploy/deploy.sh. See installation_guide.md.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")" && pwd)
SITE=$ROOT/deploy/site.env
. "$ROOT/deploy/site.sh"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }
# End of input (Ctrl-D, a closed pipe) aborts: it never counts as an answer or as consent.
ask() { # ask VAR "question" default; an empty answer keeps the default, "-" clears it
  local a; read -r -p "$2${3:+ [$3]}: " a || die "no answer (input closed)"
  a=${a:-$3}; [ "$a" = - ] && a=""
  printf -v "$1" '%s' "$a"
}
confirm() { local a; read -r -p "$1 [Y/n]: " a || die "no answer (input closed)"; [[ ! $a =~ ^[Nn] ]]; }

# Deploys to PI_SSH (an exported HOST must not redirect it elsewhere), then waits for Nexus to answer.
deploy_and_check() {
  local code=""
  HOST="" "$ROOT/deploy/deploy.sh"
  if ! command -v curl >/dev/null; then
    say "Deployed. Not verified (no curl here): open https://$PI_IP/ to check."
  else
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      code=$(curl -sk -m 5 -o /dev/null -w '%{http_code}' "https://$PI_IP/api/health" || true)
      [ "$code" = 200 ] && break
      sleep 3
    done
    [ "$code" = 200 ] || die "Nexus did not answer on https://$PI_IP/ (check: ssh $PI_SSH sudo journalctl -u nexus -n 50)"
    say "Nexus is running."
  fi
  cat <<EOF
  Open:      https://$PI_IP/  ${PI_NAMES:+(or https://${PI_NAMES%% *}/)}
  Password:  ssh $PI_SSH sudo grep NEXUS_PASSWORD /etc/nexus/nexus.env
  Browsers warn about the certificate until you trust Caddy's root (installation_guide.md, "Trust the certificate").
  Integrations (Spotify, Alexa, Studio, Mac, VPS): installation_guide.md.
  Later updates: git pull && deploy/deploy.sh
EOF
}

for t in ssh rsync; do command -v "$t" >/dev/null || die "$t is needed on this computer"; done

if [ -f "$SITE" ] && site_load 2>/dev/null && [ -n "$PI_SSH" ]; then
  say "Existing settings in deploy/site.env:"
  grep -E '^[A-Z_]+=' "$SITE"
  if confirm "Keep them and deploy?"; then deploy_and_check; exit 0; fi
fi

say "1/4  The Pi"
echo "Nexus is deployed over ssh. Log in to the Pi with a key first (ssh-copy-id <user>@<pi>)."
while :; do
  ask PI_SSH "ssh login of the Pi (user@host)" "${PI_SSH:-}"
  site_ssh "$PI_SSH" || { echo "  Expected user@host, e.g. pi@raspberrypi.local"; continue; }
  ssh -n -o BatchMode=yes -o ConnectTimeout=8 -- "$PI_SSH" true 2>/dev/null && break
  echo "  Cannot log in as $PI_SSH without a password. Run: ssh-copy-id $PI_SSH  (then try again)"
done
# -n: never let ssh read the answers the user types (or pipes) to the questions
pi() { ssh -n -o BatchMode=yes -- "$PI_SSH" "$@"; }

say "2/4  Checking the Pi"
pi 'sudo -n true' 2>/dev/null || die "$PI_SSH needs passwordless sudo (Raspberry Pi OS has it for the first user).
  On the Pi: echo \"\$USER ALL=(ALL) NOPASSWD: ALL\" | sudo tee /etc/sudoers.d/nexus-deploy"
arch=$(pi 'uname -m'); os=$(pi '. /etc/os-release; echo "$PRETTY_NAME"')
echo "  $os, $arch"
[[ $arch == aarch64 || $arch == x86_64 ]] || die "a 64-bit OS is needed (found $arch)"
missing=$(pi 'for t in podman rsync openssl; do command -v $t >/dev/null || printf "%s " $t; done')
if [ -n "$missing" ]; then
  pi 'command -v apt-get >/dev/null' || die "install these on the Pi first: $missing"
  confirm "Install $missing on the Pi with apt?" || die "Nexus needs: $missing"
  pi "sudo apt-get update -q && sudo apt-get install -y -q $missing"
fi
ver=$(pi 'podman --version' | grep -oE '[0-9]+\.[0-9]+' | head -1)
major=${ver%%.*} minor=${ver#*.}
[ "${major:-0}" -gt 4 ] || { [ "${major:-0}" -eq 4 ] && [ "${minor:-0}" -ge 4 ]; } || die "Podman $ver is too old: 4.4 or newer is needed (Raspberry Pi OS or Debian 13 \"Trixie\", Ubuntu 24.04 or newer)"
echo "  Podman $ver, sudo ok"
# A listener is fine only if it is this deployment's Caddy (a re-install), matched by its conmon pid.
caddy_pid=$(pi 'sudo podman inspect nexus-caddy --format "{{.State.ConmonPid}}" 2>/dev/null' || true)
for p in 80 443 8443; do
  pids=$(pi "sudo ss -ltnpH 'sport = :$p'" | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u || true)
  for x in $pids; do
    [ "$x" = "${caddy_pid:-none}" ] || { echo "  Warning: port $p is already in use on the Pi (pid $x); Caddy needs it."; break; }
  done
done

say "3/4  Network names"
echo "Nexus is served over HTTPS at the Pi's IP and at any names that resolve to it on your network."
ask PI_IP "The Pi's LAN IPv4 address" "$(pi "hostname -I | awk '{print \$1}'")"
site_ip "$PI_IP" || die "\"$PI_IP\" is not an IPv4 address"
host=$(pi hostname)
ask PI_NAMES "Names for the Pi, space-separated" "$host $host.lan"
site_list l "$PI_NAMES"; for n in ${l[@]+"${l[@]}"}; do site_name "$n" || die "\"$n\" is not a host name"; done
echo "Optional: a Linux PC for the Studio cameras (MediaMTX). Leave empty to skip (\"-\" clears); you can add it later."
ask STUDIO_IP "Studio PC's LAN IPv4 address" "${STUDIO_IP:-}"
[ -z "$STUDIO_IP" ] || site_ip "$STUDIO_IP" || die "\"$STUDIO_IP\" is not an IPv4 address"
echo "Optional: DNS servers for the image build (only if builds fail to resolve names), e.g. \"192.168.1.1 1.1.1.1\"."
ask BUILD_DNS "Build DNS servers" "${BUILD_DNS:-}"
site_list l "$BUILD_DNS"; for n in ${l[@]+"${l[@]}"}; do site_ip "$n" || die "\"$n\" is not an IPv4 address"; done

[ ! -f "$SITE" ] || confirm "Replace the existing deploy/site.env?" || die "kept the existing deploy/site.env"
cat > "$SITE" <<EOF
# Nexus installation settings (written by ./install.sh; not committed). Edit, then run deploy/deploy.sh.
PI_SSH=$PI_SSH
PI_IP=$PI_IP
PI_NAMES="$PI_NAMES"
STUDIO_IP=$STUDIO_IP
BUILD_DNS="$BUILD_DNS"
EOF
site_load
echo "Wrote deploy/site.env"

say "4/4  Building and starting Nexus (the first build takes several minutes)"
deploy_and_check

# Per-installation settings, kept in deploy/site.env (gitignored, written by ./install.sh). Sourced (bash 3.2+) by
# install.sh, deploy/deploy.sh and deploy/studio/install.sh. The file is parsed, never executed.

site_ip() { [[ $1 =~ ^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$ ]]; }
site_name() { [[ $1 =~ ^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$ ]]; }
site_ssh() { [[ $1 =~ ^[a-z_][a-z0-9_.-]{0,31}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$ ]]; }
# Space-separated list -> array named $1, without glob expansion (read -a never globs).
site_list() { read -r -a "$1" <<<"$2"; }

# Sets PI_SSH PI_IP PI_NAMES STUDIO_IP BUILD_DNS from site.env, checks them, and derives SITES, HA_SITES,
# PI_ORIGINS and PUBLIC_URL. Returns 1 with a message when the file is missing or a line or value is invalid.
site_load() {
  local f line k v n seen=" " names dns
  f="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/site.env"
  [ -f "$f" ] || { echo "deploy/site.env is missing: run ./install.sh first" >&2; return 1; }
  PI_SSH="" PI_IP="" PI_NAMES="" STUDIO_IP="" BUILD_DNS=""
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
    [[ $line =~ ^[[:space:]]*([A-Z_]+)[[:space:]]*=[[:space:]]*(.*[^[:space:]])?[[:space:]]*$ ]] ||
      { echo "site.env: cannot read line: $line" >&2; return 1; }
    k=${BASH_REMATCH[1]} v=${BASH_REMATCH[2]}
    if [[ $v == \"*\" && ${#v} -ge 2 ]]; then v=${v:1:${#v}-2}; fi
    [[ $v == *\"* ]] && { echo "site.env: $k: unbalanced quotes" >&2; return 1; }
    case $k in
      PI_SSH|PI_IP|PI_NAMES|STUDIO_IP|BUILD_DNS)
        [[ $seen == *" $k "* ]] && { echo "site.env: $k is set twice" >&2; return 1; }
        seen+="$k "; printf -v "$k" '%s' "$v" ;;
      *) echo "site.env: unknown setting $k" >&2; return 1 ;;
    esac
  done < "$f"
  site_ip "$PI_IP" || { echo "site.env: PI_IP must be the Pi's IPv4 address" >&2; return 1; }
  [ -z "$PI_SSH" ] || site_ssh "$PI_SSH" || { echo "site.env: PI_SSH must look like user@host" >&2; return 1; }
  [ -z "$STUDIO_IP" ] || site_ip "$STUDIO_IP" || { echo "site.env: STUDIO_IP must be an IPv4 address or empty" >&2; return 1; }
  site_list names "$PI_NAMES"; site_list dns "$BUILD_DNS"
  for n in ${names[@]+"${names[@]}"}; do site_name "$n" || { echo "site.env: PI_NAMES: \"$n\" is not a host name" >&2; return 1; }; done
  for n in ${dns[@]+"${dns[@]}"}; do site_ip "$n" || { echo "site.env: BUILD_DNS: \"$n\" is not an IPv4 address" >&2; return 1; }; done
  SITES=$PI_IP HA_SITES="$PI_IP:8443" PI_ORIGINS="\"https://$PI_IP\"" PUBLIC_URL=""
  for n in ${names[@]+"${names[@]}"}; do SITES+=", $n"; HA_SITES+=", $n:8443"; PI_ORIGINS="\"https://$n\", $PI_ORIGINS"; done
  # Spotify redirect base: the first dotted name (e.g. nexus.lan), else the first name, else the IP.
  for n in ${names[@]+"${names[@]}"}; do [[ $n == *.* ]] && { PUBLIC_URL="https://$n"; break; }; done
  [ -n "$PUBLIC_URL" ] || PUBLIC_URL="https://${names[0]:-$PI_IP}"
}

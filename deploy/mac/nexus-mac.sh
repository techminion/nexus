#!/bin/bash
# Nexus Mac companion. The Pi's ssh key is pinned to this script (authorized_keys command=), so these
# verbs are all it can do. The request arrives in SSH_ORIGINAL_COMMAND as "<verb> [argument]" and is
# never evaluated by a shell. Apps and Shortcuts must be listed, one per line, in ~/.config/nexus-mac/.
# bash 3.2 (macOS /bin/bash) compatible.
set -u
conf=$HOME/.config/nexus-mac
req=${SSH_ORIGINAL_COMMAND:-status}
verb=${req%% *}
arg=""; [ "$verb" != "$req" ] && arg=${req#* }

fail() { echo "$1" >&2; exit 2; }
listed() { [ -n "$arg" ] && [ -f "$conf/$1" ] && grep -qxF -- "$arg" "$conf/$1"; }
# JSON string: escapes backslashes and quotes, drops control characters.
js() { printf '"%s"' "$(printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g')"; }
lines() { local f=$conf/$1 sep="" l; printf '['; [ -f "$f" ] && while IFS= read -r l || [ -n "$l" ]; do [ -n "$l" ] && { printf '%s%s' "$sep" "$(js "$l")"; sep=,; }; done < "$f"; printf ']'; }
# Spotify if it is running, else Music.
player() { if pgrep -xq Spotify; then echo Spotify; else echo Music; fi; }

case $verb in
  status)
    vol=$(osascript -e 'output volume of (get volume settings)' 2>/dev/null)
    muted=$(osascript -e 'output muted of (get volume settings)' 2>/dev/null)
    batt=$(pmset -g batt | grep -Eo '[0-9]+%' | head -1 | tr -d %)
    pmset -g batt | grep -q "AC Power" && ac=true || ac=false
    boot=$(sysctl -n kern.boottime | sed -E 's/^[{] sec = ([0-9]+).*/\1/')
    printf '{"volume":%s,"muted":%s,"battery":%s,"ac":%s,"uptime":%s,"apps":%s,"shortcuts":%s}\n' \
      "${vol:-null}" "${muted:-null}" "${batt:-null}" "$ac" "$(( $(date +%s) - ${boot:-$(date +%s)} ))" "$(lines apps)" "$(lines shortcuts)" ;;
  playpause|next|previous)
    [ -z "$arg" ] || fail "no argument expected"
    p=$(player); cmd=$verb; [ "$verb" = next ] && cmd="next track"; [ "$verb" = previous ] && cmd="previous track"
    osascript -e "tell application \"$p\" to $cmd" >/dev/null ;;
  volume)
    [[ $arg =~ ^[0-9]{1,3}$ ]] && [ "$arg" -le 100 ] || fail "volume must be 0-100"
    osascript -e "set volume output volume $arg without output muted" ;;
  mute|unmute)
    [ -z "$arg" ] || fail "no argument expected"
    [ "$verb" = mute ] && m=true || m=false
    osascript -e "set volume output muted $m" ;;
  lock)
    [ -z "$arg" ] || fail "no argument expected"
    pmset displaysleepnow ;;
  open)
    listed apps || fail "app not allowed: add it to $conf/apps"
    open -a "$arg" ;;
  shortcut)
    listed shortcuts || fail "shortcut not allowed: add it to $conf/shortcuts"
    shortcuts run "$arg" ;;
  *) fail "unknown command" ;;
esac

# Nexus

Desk dashboard on a Raspberry Pi: Spotify remote, clock and timers, shortcuts, Home Assistant (Alexa), homelab status,
and a camera Studio with OBS control. React + Vite web app served by a Fastify server (SQLite via `node:sqlite`, Node 22).
Built for one person's home LAN and a landscape tablet on the desk; it is a working personal project, not a product.

**What it does**

- **Music:** Spotify remote (now playing, queue, playlists, recently played, likes, shuffle and
  repeat, device switching). Needs Spotify Premium.
- **Clock and timers**, on a dashboard sized for a landscape tablet in kiosk mode.
- **Shortcuts:** five buttons, each one action or a chain of steps: open a page, switch the Spotify device, play a
  playlist, Alexa announcement, OBS scene or recording, Mac command.
- **Voice:** "Alexa, &lt;shortcut name&gt;" runs that shortcut, through Home Assistant's Alexa Devices integration.
- **Home Assistant:** room sensors and Alexa announcements.
- **Homelab:** Pi temperature, CPU, RAM and disk, container status, TCP checks of your hosts.
- **Studio:** live previews of USB webcams, Android phones (screen mirror), RTMP cameras and a DJI Action 2 (woken over
  Bluetooth by the Pi), via MediaMTX; OBS scene and recording control.
- **Mac companion:** media keys, volume, display sleep, allowlisted apps and Shortcuts, over a locked-down ssh key.

Every integration is optional: leave its variables unset and its page or card stays hidden or shows "not set up".

## Requirements

- Raspberry Pi 4 or 5 (64-bit Raspberry Pi OS / Debian 12+) with Podman 4.4+ (Quadlet). The image is built on the Pi.
- A browser to show it: any tablet or phone. The author uses an Android tablet with Fully Kiosk Browser.
- For development: Node 22 and pnpm (`corepack enable`).
- Optional: Spotify Premium, an Echo with Home Assistant, a Linux PC for the Studio (MediaMTX, OBS), a Mac.

The host names in this README and in `deploy/` are the author's: **epimetheus** is the Pi (192.168.31.128) and
**crashmetheus** the Linux desktop that runs the Studio (192.168.31.247). Replace them with yours (see Install).

## Architecture

![Nexus architecture](docs/architecture.png)

Interactive version: [docs/architecture.html](docs/architecture.html) (open it in a browser; the `⋯` menu exports PNG or PDF).

- **epimetheus (Pi)** runs Nexus, Caddy and Home Assistant as Podman Quadlet units, deployed with `deploy/deploy.sh`.
  Caddy terminates TLS and forwards camera signalling to MediaMTX only for logged-in sessions.
- **crashmetheus** runs the Studio: MediaMTX (`deploy/studio/install.sh`) and OBS (`deploy/studio/obs-setup.sh`).
  Camera paths start on demand when a tile opens and stop after the last viewer leaves. Previews only: phones record full quality
  themselves. The DJI Action 2 records at 1080p30 while it streams (camera limit), so frame with the preview, close
  the tile, then record in 4K on the camera.
- **Cameras:** USB webcams on crashmetheus, phones mirrored over adb (`phone-preview.sh`), anything that streams RTMP
  to `rtmp://crashmetheus/cam/<name>`, and the DJI Action 2, which the Pi starts over Bluetooth (`pi/action2.py`,
  driven by `dji-preview.sh`).
- **Mac:** Nexus controls it over ssh with a key that can only run `deploy/mac/nexus-mac.sh` (see Mac companion).

## Install on a Pi

1. **Adapt the deploy files to your network.** They name the author's hosts and LAN:
   - `deploy/Caddyfile`: the Pi's IP and host names (site address and `default_sni`), and the Studio host's IP in
     `reverse_proxy`.
   - `deploy/deploy.sh`: the DNS servers passed to `podman build` (`--dns=`) and `PUBLIC_URL` in the generated env file.
   - `deploy/caddy.container` publishes ports 80, 443 and 8443 (Home Assistant).
2. **Deploy** from your machine: `HOST=<user>@<pi> deploy/deploy.sh`. It syncs the repo to `~/nexus` on the Pi, builds
   the image there, installs the Quadlet units and restarts them. Re-run it after every change.
3. The first run creates `/etc/nexus/nexus.env` (mode 600) with a random `NEXUS_PASSWORD` and `SESSION_SECRET`. Read
   the password with `sudo grep NEXUS_PASSWORD /etc/nexus/nexus.env`, add the variables below for the integrations you
   want, then `sudo systemctl restart nexus`.
4. **Trust Caddy's certificate.** Caddy serves HTTPS with its own internal CA, so browsers warn until you install its
   root on each client: copy it out with `sudo podman cp nexus-caddy:/data/caddy/pki/authorities/local/root.crt .` and
   import it as a trusted CA. Or switch `tls internal` to a real certificate.
5. Open `https://<pi>/` and log in.

## Environment

Set in `/etc/nexus/nexus.env` on the Pi (an env file: no quotes, one `NAME=value` per line).

| Var | Required | Notes |
|---|---|---|
| `NEXUS_PASSWORD` | yes | Login password. Server refuses to start without it. |
| `SESSION_SECRET` | yes | Signs the session cookie (use 32+ random chars). |
| `SPOTIFY_CLIENT_ID` | for Spotify | PKCE, no client secret. |
| `PUBLIC_URL` | for Spotify | e.g. `https://epimetheus.lan`; redirect URI is `PUBLIC_URL/api/spotify/callback`. |
| `NEXUS_CONTAINERS_FILE` | no | `podman ps -a --format json` snapshot written by a host timer, default `/run/nexus/containers.json`. |
| `NEXUS_HOSTS` | no | Hosts to TCP-check: `name=host:port,...` e.g. `nas=192.168.31.10:22`. |
| `HA_URL` | for Alexa | Home Assistant base URL, e.g. `http://homeassistant:8123`. |
| `HA_TOKEN` | for Alexa | HA long-lived access token (secret, never returned by the API). |
| `HA_SENSORS` | no | Comma-separated allowlist of entity ids shown on Devices, e.g. `sensor.echo_dot_temperature,weather.home`. The dashboard shows the first `weather.*` entity and the first °C sensor as room temperature. |
| `HA_ANNOUNCE_ENTITY` | for announce | notify entity, e.g. `notify.living_room_echo_dot_announce` (Alexa Devices integration). |
| `HA_VOICE_ENTITY` | for voice | The Echo's voice event entity, e.g. `event.<echo>_voice_event` (Alexa Devices). "Alexa, <shortcut name>" then runs that shortcut. Add an Alexa routine with the same phrase (action: "Alexa says OK") so the Echo doesn't answer "I don't know that". |
| `STUDIO_API` | for Studio | MediaMTX API origin on the camera host, e.g. `http://192.168.31.247:9997`. |
| `STUDIO_CAMERAS` | no | Optional `Name=path` list: display names, and tiles kept visible while offline, e.g. `DJI Action 2=cam/dji`. Other cameras are discovered from MediaMTX. Unquoted (podman env-file). |
| `OBS_URL` | no | obs-websocket on crashmetheus, e.g. `ws://192.168.31.247:4455`. Set up with `deploy/studio/obs-setup.sh`. |
| `OBS_PASSWORD` | with OBS_URL | From `~/.config/nexus-studio/obs.pass` on crashmetheus. Never returned by the API. |
| `MAC_HOST` | for Mac | Hostname or IPv4 of the Mac companion, e.g. `macbook.lan`. See "Mac companion". |
| `MAC_USER` | for Mac | The Mac account the key logs in as. |
| `MAC_KEY_DIR` | no | Dir with `id_ed25519` and `known_hosts` for the Mac, default `/etc/nexus/mac`. |
| `VPS_HOST` | for VPS | Hostname of the VPS companion, e.g. `vps.example.com`. See "VPS companion". |
| `VPS_USER` | for VPS | The VPS account the key logs in as (`nexusmon`). |
| `VPS_KEY_DIR` | no | Dir with `id_ed25519` and `known_hosts` for the VPS, default `/etc/nexus/vps`. |
| `PORT` | no | default 3000 |
| `NEXUS_DATA_DIR` | no | SQLite location, default `./data` (`/data` in the image) |

## Local dev

```
pnpm install
NEXUS_PASSWORD=dev SESSION_SECRET=dev-secret-dev-secret-dev-secret pnpm dev   # web on :5173 (proxies /api to :3000), server on :3000
pnpm typecheck && pnpm test && pnpm build
```

Production: `pnpm build`, then `node apps/server/dist/index.js` (serves `apps/web/dist`). Container: `podman build -f Containerfile -t nexus .`, mount a volume at `/data`.
The server sets `Secure` cookies only when the request is HTTPS (`trustProxy` is on, so run it behind your reverse proxy).

## Spotify app setup

1. Create an app at https://developer.spotify.com/dashboard.
2. Add the redirect URI `PUBLIC_URL/api/spotify/callback`. Spotify requires HTTPS for non-loopback redirect URIs.
3. Put the Client ID in `SPOTIFY_CLIENT_ID`, then use Settings > Connect Spotify.
4. Playback control needs a Spotify Premium account.

## Home Assistant (Alexa bridge)

Runs as the `homeassistant` container on the Pi, reachable only over HTTPS at
`https://192.168.31.128:8443` (via Caddy; no plain-HTTP port is published).

One-time setup on a fresh volume: HA 2026.x keeps HTTP settings in
`/config/.storage/http` (YAML `http:` is ignored once migrated). With HA stopped, set
`"use_x_forwarded_for": true` and `"trusted_proxies": ["10.89.0.0/24"]` under
`data.stable`, then start it. Without this, requests through Caddy return 400.

Then: onboard in the HA UI, add the built-in Alexa Devices integration (log in to Amazon there),
create a long-lived token (Profile → Security), and set in `.env`:
`HA_URL=http://homeassistant:8123`, `HA_TOKEN`, `HA_ANNOUNCE_ENTITY` (e.g.
`notify.<echo>_announce`) and optionally `HA_SENSORS`.

## Voice commands

Say "Alexa, " and a shortcut's exact name (punctuation and case don't matter) to run that shortcut.

1. Set `HA_VOICE_ENTITY` to the Echo's voice event entity, e.g. `event.<echo>_voice_event`. It is created by Home
   Assistant's Alexa Devices integration.
2. In Nexus, give the shortcut a name you can say, e.g. "Studio mode".
3. In the Alexa app, add a routine for the same phrase whose action is "Alexa says: OK". Otherwise the Echo also answers
   "I don't know that".

Nexus holds one websocket subscription to Home Assistant and acts within a moment of the command. It acts only on
events under 30 s old, so a Home Assistant restart never replays an old command. Steps that open a page or a link can't
run from voice; they run when the shortcut is tapped on a screen. Commands that match no shortcut are not logged.

## Mac companion

Volume, media keys, display sleep (set "Require password immediately" to make it a lock), and allowlisted apps/Shortcuts on a Mac, over ssh with a key that is forced to run `nexus-mac.sh`.

1. On the Mac, turn on Remote Login (System Settings > General > Sharing).
2. Copy `deploy/mac/install.sh` and `deploy/mac/nexus-mac.sh` to the Mac and run `bash install.sh '<contents of /etc/nexus/mac/id_ed25519.pub on the Pi>' <Pi IP>`.
   On the Pi, create that key once as root: `sudo ssh-keygen -t ed25519 -N '' -C nexus-pi -f /etc/nexus/mac/id_ed25519`,
   and pin the Mac's host key: `ssh-keyscan -t ed25519 <mac> | sudo tee /etc/nexus/mac/known_hosts`.
3. List allowed apps and Shortcuts, one per line, in `~/.config/nexus-mac/apps` and `~/.config/nexus-mac/shortcuts`.
4. macOS asks once to let sshd-keygen-wrapper/osascript control Spotify/Music (Automation): allow it.

## VPS companion

CPU, memory, disk and every user's containers on a Linux VPS, on the Homelab page. Nexus logs in as a dedicated
`nexusmon` account (locked password, no sudo) whose ssh key is forced to `nexus-vps.sh`, which only prints status.
Rootless containers are only visible to their own user, so a root timer snapshots all lingering users' containers
every 30 s into a file only `nexusmon` can read.

1. On the Pi, once as root: `sudo ssh-keygen -t ed25519 -N '' -C nexus-pi -f /etc/nexus/vps/id_ed25519`, and pin
   the VPS host key: `echo "<vps> $(ssh <you>@<vps> cat /etc/ssh/ssh_host_ed25519_key.pub)" | sudo tee /etc/nexus/vps/known_hosts`.
2. Copy `deploy/vps/` to the VPS and run `sudo bash install.sh '<contents of /etc/nexus/vps/id_ed25519.pub>'`.
3. Set `VPS_HOST` and `VPS_USER=nexusmon` in `/etc/nexus/nexus.env` and restart Nexus.

## Studio: adding a camera

Every Studio tile is a MediaMTX path on crashmetheus. Nexus lists whatever MediaMTX has, so most cameras need no
Nexus change. Re-running `deploy/studio/install.sh` restarts MediaMTX, which briefly cuts any preview in progress.

- **USB webcam on crashmetheus:** plug it in and re-run `deploy/studio/install.sh`. Each webcam gets a path named
  after the device (e.g. `c270-hd-webcam`) that only runs while someone watches.
- **Android phone (preview by screen mirroring; the phone records full quality itself):**
  1. Give the phone a fixed DHCP lease so it resolves as e.g. `oneplus.lan`.
  2. Pair it once from crashmetheus over adb wireless debugging (`adb pair <ip>:<port>` with the pairing code).
  3. Add a line `oneplus oneplus.lan` to `~/.config/nexus-studio/phones` and re-run `install.sh`. The tile is `phone/oneplus`.
  4. Before each preview, turn on wireless debugging and open the Camera app. Wireless debugging is switched off
     again when the preview stops (the Developer options "Wireless debugging" quick tile makes this one tap).
- **Anything that streams RTMP or RTSP** (Larix, IP cameras, OBS elsewhere): publish to
  `rtmp://<crashmetheus>/cam/<name>?user=studio&pass=<publish password>`. The password is in
  `~/.config/nexus-studio/publish.pass` on crashmetheus. Use the two-part `cam/<name>` form; most apps require it.
  The tile appears while the camera is streaming.
- **A camera that has to be woken first** (like the DJI Action 2): add a `runOnDemand` script like
  `deploy/studio/dji-preview.sh` and a block for it in `install.sh`. For the DJI, put the Pi's ssh target
  (e.g. `user@epimetheus.lan`) in `~/.config/nexus-studio/dji` and the stream URL in `~/.config/nexus-studio/dji.url`
  (mode 600) on the Pi.
- **Optional, fixed name and a tile that stays visible while offline:** add `Name=path` to `STUDIO_CAMERAS` in
  `/etc/nexus/nexus.env` on the Pi (e.g. `Front Door=cam/front-door`), then `sudo systemctl restart nexus`.
- **In OBS:** add a Media Source with input `rtsp://127.0.0.1:8554/<path>`.

## Security model

- Meant for a trusted home LAN. Don't expose it to the internet as is.
- One password (`NEXUS_PASSWORD`) guards everything. Sessions are random ids kept on the server, so logging out revokes
  them, and changing the password ends every session.
- Secrets (passwords, the Home Assistant and OBS tokens, Spotify tokens) stay on the server: they live in
  `/etc/nexus/nexus.env` or SQLite and no API returns them.
- Caddy terminates TLS. Camera signalling to MediaMTX passes only for logged-in sessions (`forward_auth`). Publishing
  a camera needs the publish password.
- The Mac's ssh key is pinned to `nexus-mac.sh`. It runs only a fixed set of verbs, only from the Pi's address, with
  no shell, pty or forwarding; apps and Shortcuts must be on the Mac's own allowlists.
- Shortcut actions are validated strictly on the server (types, lengths, allowed values) before they are stored or run.

## Repository layout

| Path | What |
|---|---|
| `apps/server` | Fastify API: auth, settings, Spotify, Home Assistant, homelab, Studio, OBS, Mac. Tests: `pnpm test`. |
| `apps/web` | React + Vite + Tailwind UI. |
| `deploy/` | Containerfile units (Podman Quadlet), Caddyfile, `deploy.sh`; `studio/` for the camera host, `mac/` for the Mac. |
| `pi/` | Bluetooth LE tools run on the Pi: `action2.py` (DJI Action 2 wake, Wi-Fi and livestream) and experiments with an Insta360 GO 3S (`go3s*`). |
| `docs/` | Architecture diagram (HTML source and PNG). |
| `enclosure/` | Parametric 3D-printable enclosure (Python, STL output and a web viewer). |
| `PRD.md` | The original product requirements. |

## Notes

Not affiliated with or endorsed by Spotify, Amazon, DJI, Insta360, Apple, OBS or Home Assistant. The DJI and Insta360
Bluetooth protocols were reverse-engineered from public projects and observation; use them at your own risk.


## License

MIT, see [LICENSE](LICENSE).

# Nexus v0.1

Desk dashboard: Spotify remote, clock/timer, five shortcuts. React + Vite web app served by a Fastify server (SQLite via `node:sqlite`, Node 22).

## Environment

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
| `HA_ANNOUNCE_ENTITY` | for announce | notify entity, e.g. `notify.living_room_amey_s_echo_dot_announce` (Alexa Devices integration). |
| `STUDIO_API` | for Studio | MediaMTX API origin on the camera host, e.g. `http://192.168.31.247:9997`. |
| `STUDIO_CAMERAS` | no | Optional `Name=path` list: display names, and tiles kept visible while offline, e.g. `DJI Action 2=dji`. Other cameras are discovered from MediaMTX. Unquoted (podman env-file). |
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

# Nexus v0.1

Desk dashboard: Spotify remote, clock/timer, five shortcuts. React + Vite web app served by a Fastify server (SQLite via `node:sqlite`, Node 22).

## Environment

| Var | Required | Notes |
|---|---|---|
| `NEXUS_PASSWORD` | yes | Login password. Server refuses to start without it. |
| `SESSION_SECRET` | yes | Signs the session cookie (use 32+ random chars). |
| `SPOTIFY_CLIENT_ID` | for Spotify | PKCE, no client secret. |
| `PUBLIC_URL` | for Spotify | e.g. `https://192.168.31.128`; redirect URI is `PUBLIC_URL/api/spotify/callback`. |
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

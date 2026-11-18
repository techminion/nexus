import { createHash, randomBytes } from "node:crypto";
import type { Kv } from "./db.ts";

export class AppError extends Error {
  status: number;
  code: string;
  retryAfter?: number;
  constructor(status: number, code: string, message: string, retryAfter?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

interface Tokens { access: string; refresh: string; expires: number }
const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing";
const b64u = (b: Buffer) => b.toString("base64url");

export function createSpotify(kv: Kv, env: { clientId?: string; publicUrl?: string }) {
  const pending = new Map<string, { verifier: string; exp: number }>();
  let blockedUntil = 0; // set on 429
  let gen = 0; // bumped on disconnect so in-flight refreshes cannot resurrect tokens
  let refreshing: Promise<Tokens> | undefined;
  let cache: { at: number; value: unknown } | undefined;
  const redirectUri = () => `${env.publicUrl}/api/spotify/callback`;
  const tokens = () => kv.get<Tokens>("spotify");

  function login(): string {
    if (!env.clientId || !env.publicUrl) throw new AppError(503, "not_configured", "Spotify is not configured on the server (SPOTIFY_CLIENT_ID / PUBLIC_URL).");
    const now = Date.now();
    for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
    const verifier = b64u(randomBytes(64));
    const state = b64u(randomBytes(16));
    pending.set(state, { verifier, exp: now + 10 * 60_000 });
    const q = new URLSearchParams({
      client_id: env.clientId, response_type: "code", redirect_uri: redirectUri(), scope: SCOPES,
      state, code_challenge_method: "S256", code_challenge: b64u(createHash("sha256").update(verifier).digest()),
    });
    return `https://accounts.spotify.com/authorize?${q}`;
  }

  async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
    let r: Response;
    try {
      r = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...params, client_id: env.clientId! }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(502, "network", "Cannot reach Spotify.");
    }
    if (r.status === 429) throw rateLimited(r);
    if (!r.ok) {
      if (r.status === 400 || r.status === 401) throw new AppError(401, "auth", "Spotify authorization failed or expired. Reconnect Spotify.");
      throw new AppError(502, "spotify", `Spotify token endpoint returned ${r.status}.`);
    }
    const j = (await r.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return { access: j.access_token, refresh: j.refresh_token ?? tokens()?.refresh ?? "", expires: Date.now() + j.expires_in * 1000 - 30_000 };
  }

  async function callback(code: string, state: string): Promise<void> {
    const p = pending.get(state);
    pending.delete(state);
    if (!p || p.exp < Date.now()) throw new AppError(400, "bad_state", "Invalid or expired authorization state.");
    kv.set("spotify", await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: p.verifier }));
  }

  function rateLimited(r: Response) {
    const s = Math.max(Number(r.headers.get("retry-after")) || 5, 1);
    blockedUntil = Date.now() + s * 1000;
    return new AppError(429, "rate_limited", `Spotify is rate limiting requests. Retrying in ${s}s.`, s);
  }

  // Coalesced: Spotify may rotate the refresh token, so concurrent refreshes would invalidate each other.
  function refresh(): Promise<Tokens> {
    return (refreshing ??= doRefresh().finally(() => (refreshing = undefined)));
  }

  async function doRefresh(): Promise<Tokens> {
    const g = gen;
    const t = tokens();
    if (!t?.refresh) throw new AppError(401, "not_connected", "Spotify is not connected.");
    try {
      const n = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
      if (g !== gen) throw new AppError(401, "not_connected", "Spotify is not connected.");
      kv.set("spotify", n);
      return n;
    } catch (e) {
      if (e instanceof AppError && e.code === "auth" && g === gen) kv.del("spotify");
      throw e;
    }
  }

  async function api(method: string, path: string, opts: { query?: Record<string, string>; body?: unknown } = {}, retried = false): Promise<any> {
    let t = tokens();
    if (!t) throw new AppError(401, "not_connected", "Spotify is not connected.");
    if (Date.now() < blockedUntil) {
      const s = Math.ceil((blockedUntil - Date.now()) / 1000);
      throw new AppError(429, "rate_limited", `Spotify is rate limiting requests. Retrying in ${s}s.`, s);
    }
    if (t.expires < Date.now()) t = await refresh();
    const url = `https://api.spotify.com/v1${path}${opts.query ? "?" + new URLSearchParams(opts.query) : ""}`;
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${t.access}`, ...(opts.body ? { "content-type": "application/json" } : {}) },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new AppError(502, "network", "Cannot reach Spotify.");
    }
    if (r.status === 401 && !retried) {
      await refresh();
      return api(method, path, opts, true);
    }
    if (r.status === 429) throw rateLimited(r);
    if (r.status === 401) throw new AppError(401, "auth", "Spotify authorization expired. Reconnect Spotify.");
    if (r.status === 404) throw new AppError(404, "no_device", "No active Spotify device. Open Spotify on a device or pick one in Devices.");
    if (r.status === 403) throw new AppError(403, "premium", "Spotify refused this action (Premium is required for playback control).");
    if (!r.ok) throw new AppError(502, "spotify", `Spotify returned ${r.status}.`);
    if (r.status === 204 || r.status === 202) return null;
    return r.json();
  }

  function mapPlayback(j: any) {
    if (!j) return null;
    const it = j.item;
    return {
      track: it?.name ?? null,
      artists: (it?.artists ?? []).map((a: any) => a.name) as string[],
      album: it?.album?.name ?? it?.show?.name ?? null,
      art: it?.album?.images?.[0]?.url ?? it?.images?.[0]?.url ?? null,
      progress_ms: j.progress_ms ?? 0,
      duration_ms: it?.duration_ms ?? 0,
      is_playing: !!j.is_playing,
      shuffle: !!j.shuffle_state,
      repeat: (j.repeat_state ?? "off") as string,
      volume: j.device?.volume_percent ?? null,
      device: j.device?.name ?? null,
    };
  }

  async function state() {
    if (!tokens()) return { connected: false, error: null, playback: null };
    if (cache && Date.now() - cache.at < 1000) return cache.value;
    let value;
    try {
      value = { connected: true, error: null, playback: mapPlayback(await api("GET", "/me/player")) };
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
      value = { connected: !!tokens(), error: { code: e.code, message: e.message, retryAfter: e.retryAfter ?? null }, playback: null };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  async function devices() {
    const j = await api("GET", "/me/player/devices");
    return (j?.devices ?? []).map((d: any) => ({ id: d.id, name: d.name, type: d.type, active: !!d.is_active, volume: d.volume_percent ?? null }));
  }

  // Control commands invalidate the cache so the next poll sees fresh state.
  async function cmd(method: string, path: string, query?: Record<string, string>, body?: unknown) {
    cache = undefined;
    await api(method, path, { query, body });
  }

  async function transferByName(name: string) {
    const d = (await devices()).find((x: { name: string }) => x.name.toLowerCase() === name.toLowerCase());
    if (!d?.id) throw new AppError(404, "device_not_found", `Spotify device "${name}" not found.`);
    await cmd("PUT", "/me/player", undefined, { device_ids: [d.id], play: true });
  }

  return {
    login, callback, state, devices, cmd, transferByName,
    disconnect: () => { gen++; kv.del("spotify"); cache = undefined; },
  };
}

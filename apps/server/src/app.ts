import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { openKv } from "./db.ts";
import { AppError, createSpotify } from "./spotify.ts";
import { createHomelab, type HomelabCfg } from "./homelab.ts";
import { createHomeAssistant, type HaCfg } from "./homeassistant.ts";
import { createStudio, type StudioCfg } from "./studio.ts";
import { createObs, type ObsCfg } from "./obs.ts";
import { CONTEXT_RE, DEFAULT_SETTINGS, TRACK_RE, validateSettings, type Action, type Settings } from "./actions.ts";

export interface Config {
  password: string;
  secret: string;
  dataDir: string;
  clientId?: string;
  publicUrl?: string;
  webDist?: string;
  homelab?: Omit<HomelabCfg, "dataDir">;
  ha?: HaCfg;
  studio?: StudioCfg;
  obs?: ObsCfg;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const COOKIE = "nexus_session";
// Matched against the route pattern (post-decoding), so encoded paths cannot dodge the guard.
const OPEN = new Set(["/api/health", "/api/login", "/api/session"]);
const SESSION_TTL = 365 * 24 * 3600 * 1000;
const percent = { type: "object", required: ["percent"], additionalProperties: false, properties: { percent: { type: "integer", minimum: 0, maximum: 100 } } };
const uriProp = (re: RegExp) => ({ type: "string", pattern: re.source });
const body1 = (key: string, prop: object, extra: Record<string, object> = {}) => ({ type: "object", required: [key, ...Object.keys(extra)], additionalProperties: false, properties: { [key]: prop, ...extra } });
const stateBody = (e: string[]) => ({ type: "object", required: ["state"], additionalProperties: false, properties: { state: e.length ? { enum: e } : { type: "boolean" } } });

export async function buildApp(cfg: Config) {
  const app = Fastify({ trustProxy: true, logger: process.env.NODE_ENV !== "test" && {
    level: "info",
    // Query strings are dropped: the OAuth callback carries the authorization code.
    serializers: { req: (req: { method: string; url: string; ip: string }) => ({ method: req.method, url: req.url.split("?")[0], remoteAddress: req.ip }) },
  } });
  await app.register(cookie, { secret: cfg.secret });
  const kv = openKv(cfg.dataDir);
  const spotify = createSpotify(kv, { clientId: cfg.clientId, publicUrl: cfg.publicUrl });
  const warn = (m: string) => app.log.warn(m);
  const homelab = createHomelab({ dataDir: cfg.dataDir, ...cfg.homelab }, warn);
  const ha = createHomeAssistant(cfg.ha ?? {}, warn);
  const studio = createStudio(cfg.studio ?? {}, warn);
  const obs = createObs(cfg.obs ?? {}, warn);
  const settings = (): Settings => kv.get<Settings>("settings") ?? DEFAULT_SETTINGS;

  // Random session ids kept server-side so logout revokes them; sessions are tied to the current password.
  const pwTag = sha(cfg.password).toString("hex").slice(0, 16);
  const sessions = (): Record<string, { exp: number; pw: string }> => kv.get("sessions") ?? {};
  const sessionId = (req: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean; value: string | null } }) => {
    const c = req.cookies[COOKIE];
    const u = c ? req.unsignCookie(c) : undefined;
    return u?.valid ? u.value ?? undefined : undefined;
  };
  const authed = (req: Parameters<typeof sessionId>[0]) => {
    const id = sessionId(req);
    const s = id ? sessions()[id] : undefined;
    return !!s && s.exp > Date.now() && s.pw === pwTag;
  };

  app.addHook("onRequest", async (req, reply) => {
    const route = req.routeOptions.url;
    if (route?.startsWith("/api/") && !OPEN.has(route) && !authed(req)) return reply.code(401).send({ error: { code: "unauthorized", message: "Login required." } });
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof AppError) {
      if (err.retryAfter) reply.header("retry-after", err.retryAfter);
      return reply.code(err.status === 401 ? 409 : err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err.validation || err.statusCode < 500) return reply.code(err.statusCode ?? 400).send({ error: { code: "bad_request", message: err.message } });
    app.log.error({ err: err.message }, "unhandled");
    return reply.code(500).send({ error: { code: "internal", message: "Internal error." } });
  });

  app.get("/api/health", async () => ({ ok: true }));

  const attempts = new Map<string, { n: number; reset: number }>();
  app.post("/api/login", { schema: { body: { type: "object", required: ["password"], properties: { password: { type: "string", maxLength: 200 } } } } }, async (req, reply) => {
    const now = Date.now();
    const a = attempts.get(req.ip);
    const cur = a && a.reset > now ? a : { n: 0, reset: now + 60_000 };
    attempts.set(req.ip, cur);
    if (++cur.n > 10) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many attempts. Try again in a minute." } });
    if (!timingSafeEqual(sha((req.body as { password: string }).password), sha(cfg.password))) return reply.code(401).send({ error: { code: "bad_password", message: "Wrong password." } });
    attempts.delete(req.ip);
    const id = randomBytes(24).toString("base64url");
    const now2 = Date.now();
    const live = Object.fromEntries(Object.entries(sessions()).filter(([, v]) => v.exp > now2 && v.pw === pwTag));
    kv.set("sessions", { ...live, [id]: { exp: now2 + SESSION_TTL, pw: pwTag } });
    reply.setCookie(COOKIE, id, { signed: true, httpOnly: true, sameSite: "lax", secure: req.protocol === "https", path: "/", maxAge: SESSION_TTL / 1000 });
    return { ok: true };
  });
  app.post("/api/logout", async (req, reply) => {
    const id = sessionId(req);
    if (id) { const s = sessions(); delete s[id]; kv.set("sessions", s); }
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });
  app.get("/api/session", async (req) => ({ authenticated: authed(req) }));

  app.get("/api/settings", async () => settings());
  app.put("/api/settings", { schema: { body: { type: "object" } } }, async (req, reply) => {
    const e = validateSettings(req.body);
    if (e) return reply.code(400).send({ error: { code: "invalid_settings", message: e } });
    kv.set("settings", req.body);
    return req.body;
  });

  app.post("/api/shortcuts/:index/run", async (req, reply) => {
    const i = Number((req.params as { index: string }).index);
    const sc = settings().shortcuts[i];
    if (!Number.isInteger(i) || !sc) return reply.code(404).send({ error: { code: "not_found", message: "No such shortcut." } });
    const steps: Action[] = sc.action.type === "scene" ? sc.action.steps : [sc.action];
    const results = [];
    for (const s of steps) {
      if (s.type !== "spotify-device" && s.type !== "announce" && s.type !== "spotify-play" && s.type !== "obs-scene" && s.type !== "obs-record") { results.push({ type: s.type, status: "client" }); continue; }
      try {
        if (s.type === "announce") await ha.announce(s.message);
        else if (s.type === "obs-scene") await obs.setScene(s.scene);
        else if (s.type === "obs-record") await obs.record(s.on);
        else if (s.type === "spotify-play") await spotify.playItem(s.uri);
        else await spotify.transferByName(s.deviceName);
        results.push({ type: s.type, status: "ok" });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ type: s.type, status: "error", message: e.message });
      }
    }
    return { results };
  });

  app.get("/api/homelab", async () => homelab.get());
  app.get("/api/ha/status", async () => ha.status());
  app.get("/api/studio", async () => studio.status());
  // Caddy forward_auth target for the /studio/ camera proxy: the auth guard above has already run.
  app.get("/api/obs", async () => obs.status());
  app.post("/api/obs/scene", { schema: { body: { type: "object", required: ["scene"], additionalProperties: false, properties: { scene: { type: "string", minLength: 1, maxLength: 100 } } } } }, async (req) => (await obs.setScene((req.body as { scene: string }).scene), { ok: true }));
  app.post("/api/obs/record", { schema: { body: { type: "object", required: ["on"], additionalProperties: false, properties: { on: { type: "boolean" } } } } }, async (req) => (await obs.record((req.body as { on: boolean }).on), { ok: true }));
  app.get("/api/studio/auth", async (_req, reply) => reply.code(204).send());
  app.post("/api/ha/announce", { schema: { body: { type: "object", required: ["message"], additionalProperties: false, properties: { message: { type: "string", minLength: 1, maxLength: 300 } } } } }, async (req) => (await ha.announce((req.body as { message: string }).message), { ok: true }));

  app.get("/api/spotify/login", async (_req, reply) => reply.redirect(spotify.login()));
  app.get("/api/spotify/callback", async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    if (q.error || !q.code || !q.state) return reply.redirect("/settings?spotify=denied");
    try {
      await spotify.callback(q.code, q.state);
    } catch {
      return reply.redirect("/settings?spotify=failed");
    }
    return reply.redirect("/settings?spotify=connected");
  });
  app.get("/api/spotify/state", async () => spotify.state());
  app.get("/api/spotify/devices", async () => ({ devices: await spotify.devices() }));
  app.post("/api/spotify/disconnect", async () => (spotify.disconnect(), { ok: true }));
  const ok = { ok: true };
  app.put("/api/spotify/play", async () => (await spotify.play(), ok));
  app.put("/api/spotify/pause", async () => (await spotify.cmd("PUT", "/me/player/pause"), ok));
  app.put("/api/spotify/next", async () => (await spotify.cmd("POST", "/me/player/next"), ok));
  app.put("/api/spotify/previous", async () => (await spotify.cmd("POST", "/me/player/previous"), ok));
  app.put("/api/spotify/volume", { schema: { body: percent } }, async (req) => (await spotify.cmd("PUT", "/me/player/volume", { volume_percent: String((req.body as { percent: number }).percent) }), ok));
  app.put("/api/spotify/shuffle", { schema: { body: stateBody([]) } }, async (req) => (await spotify.cmd("PUT", "/me/player/shuffle", { state: String((req.body as { state: boolean }).state) }), ok));
  app.put("/api/spotify/repeat", { schema: { body: stateBody(["off", "context", "track"]) } }, async (req) => (await spotify.cmd("PUT", "/me/player/repeat", { state: (req.body as { state: string }).state }), ok));
  app.put("/api/spotify/seek", { schema: { body: body1("positionMs", { type: "integer", minimum: 0, maximum: 86400000 }) } }, async (req) => (await spotify.cmd("PUT", "/me/player/seek", { position_ms: String((req.body as { positionMs: number }).positionMs) }), ok));
  app.get("/api/spotify/queue", async () => spotify.queue());
  app.post("/api/spotify/queue", { schema: { body: body1("uri", uriProp(/^spotify:(track|episode):[A-Za-z0-9]{22}$/)) } }, async (req) => (await spotify.cmd("POST", "/me/player/queue", { uri: (req.body as { uri: string }).uri }), ok));
  app.put("/api/spotify/like", { schema: { body: body1("uri", uriProp(TRACK_RE), { liked: { type: "boolean" } }) } }, async (req) => {
    const b = req.body as { uri: string; liked: boolean };
    await spotify.like(b.uri, b.liked);
    return ok;
  });
  app.get("/api/spotify/playlists", async () => ({ playlists: await spotify.playlists() }));
  app.get("/api/spotify/recent", async () => ({ tracks: await spotify.recent() }));
  app.put("/api/spotify/play-context", { schema: { body: body1("contextUri", uriProp(CONTEXT_RE)) } }, async (req) => (await spotify.playItem((req.body as { contextUri: string }).contextUri), ok));
  app.put("/api/spotify/play-uris", { schema: { body: { type: "object", required: ["uris"], additionalProperties: false, properties: { uris: { type: "array", minItems: 1, maxItems: 1, items: uriProp(TRACK_RE) } } } } }, async (req) => (await spotify.playItem((req.body as { uris: string[] }).uris[0]), ok));
  app.put("/api/spotify/transfer", { schema: { body: { type: "object", required: ["deviceId"], additionalProperties: false, properties: { deviceId: { type: "string", minLength: 1 }, play: { type: "boolean" } } } } }, async (req) => {
    const b = req.body as { deviceId: string; play?: boolean };
    await spotify.cmd("PUT", "/me/player", undefined, { device_ids: [b.deviceId], play: b.play ?? true });
    return ok;
  });

  if (cfg.webDist && existsSync(cfg.webDist)) {
    await app.register(fstatic, { root: cfg.webDist });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/") || req.method !== "GET" ? reply.code(404).send({ error: { code: "not_found", message: "Not found." } }) : reply.sendFile("index.html"));
  }
  return app;
}


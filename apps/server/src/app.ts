import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { openKv } from "./db.ts";
import { AppError, createSpotify } from "./spotify.ts";
import { DEFAULT_SETTINGS, validateSettings, type Action, type Settings } from "./actions.ts";

export interface Config {
  password: string;
  secret: string;
  dataDir: string;
  clientId?: string;
  publicUrl?: string;
  webDist?: string;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const COOKIE = "nexus_session";
const OPEN = new Set(["/api/health", "/api/login", "/api/session", "/api/spotify/callback"]);
const percent = { type: "object", required: ["percent"], additionalProperties: false, properties: { percent: { type: "integer", minimum: 0, maximum: 100 } } };
const stateBody = (e: string[]) => ({ type: "object", required: ["state"], additionalProperties: false, properties: { state: e.length ? { enum: e } : { type: "boolean" } } });

export async function buildApp(cfg: Config) {
  const app = Fastify({ trustProxy: true, logger: process.env.NODE_ENV !== "test" && { level: "info", redact: ["req.headers.cookie", "req.headers.authorization"] } });
  await app.register(cookie, { secret: cfg.secret });
  const kv = openKv(cfg.dataDir);
  const spotify = createSpotify(kv, { clientId: cfg.clientId, publicUrl: cfg.publicUrl });
  const settings = (): Settings => kv.get<Settings>("settings") ?? DEFAULT_SETTINGS;

  const authed = (req: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean } }) => {
    const c = req.cookies[COOKIE];
    return !!c && req.unsignCookie(c).valid;
  };

  app.addHook("onRequest", async (req, reply) => {
    const path = req.url.split("?")[0];
    if (path.startsWith("/api/") && !OPEN.has(path) && !authed(req)) return reply.code(401).send({ error: { code: "unauthorized", message: "Login required." } });
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
    reply.setCookie(COOKIE, "1", { signed: true, httpOnly: true, sameSite: "lax", secure: req.protocol === "https", path: "/", maxAge: 365 * 24 * 3600 });
    return { ok: true };
  });
  app.post("/api/logout", async (_req, reply) => {
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
      if (s.type !== "spotify-device") { results.push({ type: s.type, status: "client" }); continue; }
      try {
        await spotify.transferByName(s.deviceName);
        results.push({ type: s.type, status: "ok" });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        results.push({ type: s.type, status: "error", message: e.message });
      }
    }
    return { results };
  });

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
  app.put("/api/spotify/play", async () => (await spotify.cmd("PUT", "/me/player/play"), ok));
  app.put("/api/spotify/pause", async () => (await spotify.cmd("PUT", "/me/player/pause"), ok));
  app.put("/api/spotify/next", async () => (await spotify.cmd("POST", "/me/player/next"), ok));
  app.put("/api/spotify/previous", async () => (await spotify.cmd("POST", "/me/player/previous"), ok));
  app.put("/api/spotify/volume", { schema: { body: percent } }, async (req) => (await spotify.cmd("PUT", "/me/player/volume", { volume_percent: String((req.body as { percent: number }).percent) }), ok));
  app.put("/api/spotify/shuffle", { schema: { body: stateBody([]) } }, async (req) => (await spotify.cmd("PUT", "/me/player/shuffle", { state: String((req.body as { state: boolean }).state) }), ok));
  app.put("/api/spotify/repeat", { schema: { body: stateBody(["off", "context", "track"]) } }, async (req) => (await spotify.cmd("PUT", "/me/player/repeat", { state: (req.body as { state: string }).state }), ok));
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


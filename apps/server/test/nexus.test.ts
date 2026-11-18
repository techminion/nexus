import { createSpotify } from "../src/spotify.ts";
import { openKv } from "../src/db.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, validateSettings, DEFAULT_SETTINGS } from "../src/actions.ts";
import { buildApp } from "../src/app.ts";

test("action validation", () => {
  assert.equal(validateAction({ type: "url", url: "https://a.b/c" }), null);
  assert.equal(validateAction({ type: "module", module: "music" }), null);
  assert.equal(validateAction({ type: "none" }), null);
  assert.equal(validateAction({ type: "scene", steps: [{ type: "spotify-device", deviceName: "Kitchen" }] }), null);
  assert.ok(validateAction({ type: "url", url: "javascript:alert(1)" }));
  assert.ok(validateAction({ type: "url", url: "file:///etc/passwd" }));
  assert.ok(validateAction({ type: "shell", cmd: "ls" }));
  assert.ok(validateAction({ type: "module", module: "admin" }));
  assert.ok(validateAction({ type: "none", extra: 1 }));
  assert.ok(validateAction({ type: "scene", steps: [{ type: "scene", steps: [] }] }));
  assert.ok(validateAction({ type: "scene", steps: Array(11).fill({ type: "none" }) }));
  assert.equal(validateAction({ type: "scene", steps: Array(10).fill({ type: "none" }) }), null);
  assert.equal(validateSettings(DEFAULT_SETTINGS), null);
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, shortcuts: [] }));
});

test("auth guard and settings", async () => {
  const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:" });
  assert.equal((await app.inject("/api/health")).statusCode, 200);
  assert.equal((await app.inject("/api/settings")).statusCode, 401);
  assert.equal((await app.inject("/api/spotify/state")).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/login", payload: { password: "bad" } })).statusCode, 401);
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  assert.equal(r.statusCode, 200);
  const c = r.cookies[0];
  assert.ok(c.httpOnly);
  const cookies = { [c.name]: c.value };
  assert.deepEqual((await app.inject({ url: "/api/session", cookies })).json(), { authenticated: true });
  assert.deepEqual((await app.inject("/api/session")).json(), { authenticated: false });
  const s = await app.inject({ url: "/api/settings", cookies });
  assert.equal(s.statusCode, 200);
  assert.doesNotMatch(s.body, /token|access|refresh|secret/i);
  const bad = await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { ...DEFAULT_SETTINGS, shortcuts: DEFAULT_SETTINGS.shortcuts.map(() => ({ label: "x", action: { type: "url", url: "javascript:1" } })) } });
  assert.equal(bad.statusCode, 400);
  const st = await app.inject({ url: "/api/spotify/state", cookies });
  assert.equal(st.json().connected, false);
  // Encoded paths route to /api/* after decoding; the guard must still apply.
  assert.equal((await app.inject("/%61pi/settings")).statusCode, 401);
  assert.equal((await app.inject("/api/%73ettings")).statusCode, 401);
  assert.equal((await app.inject("/api/spotify/callback?code=x&state=y")).statusCode, 401);
  // A forged unsigned cookie is rejected; logout revokes the session server-side.
  assert.equal((await app.inject({ url: "/api/settings", cookies: { [c.name]: "1" } })).statusCode, 401);
  await app.inject({ method: "POST", url: "/api/logout", cookies });
  assert.equal((await app.inject({ url: "/api/settings", cookies })).statusCode, 401);
  await app.close();
});

test("spotify control tolerates non-JSON 200 bodies", async () => {
  const kv = openKv(":memory:");
  kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("Pz5TQ6-KLF", { status: 200, headers: { "content-type": "text/plain" } });
  try {
    await createSpotify(kv, { clientId: "c", publicUrl: "https://x" }).cmd("POST", "/me/player/next");
  } finally {
    globalThis.fetch = realFetch;
  }
});

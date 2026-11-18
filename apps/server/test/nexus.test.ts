import { createHomeAssistant } from "../src/homeassistant.ts";
import { parseHosts } from "../src/homelab.ts";
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

test("announce action validation", () => {
  assert.equal(validateAction({ type: "announce", message: "Dinner" }), null);
  assert.equal(validateAction({ type: "scene", steps: [{ type: "announce", message: "Hi" }] }), null);
  assert.ok(validateAction({ type: "announce", message: "" }));
  assert.ok(validateAction({ type: "announce", message: "x".repeat(301) }));
  assert.ok(validateAction({ type: "announce", message: 5 }));
  assert.ok(validateAction({ type: "announce", message: "x", extra: 1 }));
  assert.ok(validateAction({ type: "scene", steps: [{ type: "announce", message: 5 }] }));
});

test("hosts parser", () => {
  const warns: string[] = [];
  const h = parseHosts("nas=192.168.31.10:22, mac=m.local:80,bad,x=y:99999,=a:1", (m) => warns.push(m));
  assert.deepEqual(h, [{ name: "nas", host: "192.168.31.10", port: 22 }, { name: "mac", host: "m.local", port: 80 }]);
  assert.equal(warns.length, 3);
  assert.deepEqual(parseHosts(undefined), []);
});

test("homelab and ha status: auth, graceful absence, no token leak; announce call", async () => {
  const token = "SENTINEL-TOKEN-123";
  const app = await buildApp({
    password: "pw", secret: "s".repeat(32), dataDir: ":memory:",
    homelab: { containersFile: "/nonexistent/containers.json", hosts: "local=127.0.0.1:1" },
    ha: { url: "http://ha.test:8123", token, sensors: "sensor.echo_temp", announceService: "notify.alexa_media_echo" },
  });
  assert.equal((await app.inject("/api/homelab")).statusCode, 401);
  assert.equal((await app.inject("/api/ha/status")).statusCode, 401);
  assert.equal((await app.inject({ method: "POST", url: "/api/ha/announce", payload: { message: "x" } })).statusCode, 401);
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookies = { [r.cookies[0].name]: r.cookies[0].value };
  const hl = await app.inject({ url: "/api/homelab", cookies });
  assert.equal(hl.statusCode, 200);
  assert.equal(hl.json().containers, null);
  assert.ok(hl.json().error);
  assert.deepEqual(hl.json().hosts.map((h: { up: boolean }) => h.up), [false]);

  const calls: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u: any, init: any) => {
    calls.push({ url: String(u), init });
    if (String(u).includes("/api/states/")) return Response.json({ state: "21.5", attributes: { friendly_name: "Echo temp", unit_of_measurement: "C" } });
    return Response.json([]);
  };
  try {
    const st = await app.inject({ url: "/api/ha/status", cookies });
    assert.equal(st.statusCode, 200);
    assert.deepEqual(st.json().sensors, [{ id: "sensor.echo_temp", name: "Echo temp", state: "21.5", unit: "C" }]);
    assert.ok(!st.body.includes(token));
    calls.length = 0;
    const a = await app.inject({ method: "POST", url: "/api/ha/announce", cookies, payload: { message: "Dinner" } });
    assert.equal(a.statusCode, 200);
    assert.equal(calls[0].url, "http://ha.test:8123/api/services/notify/alexa_media_echo");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { message: "Dinner", data: { type: "announce" } });
    assert.equal((await app.inject({ method: "POST", url: "/api/ha/announce", cookies, payload: { message: "" } })).statusCode, 400);
    // announce as a shortcut action runs server-side
    const settings = { ...DEFAULT_SETTINGS, shortcuts: DEFAULT_SETTINGS.shortcuts.map((s, i) => (i === 0 ? { label: "A", action: { type: "announce", message: "Hi" } } : s)) };
    assert.equal((await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: settings })).statusCode, 200);
    calls.length = 0;
    const run = await app.inject({ method: "POST", url: "/api/shortcuts/0/run", cookies });
    assert.deepEqual(run.json().results, [{ type: "announce", status: "ok" }]);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
  await app.close();

  const bare = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:" });
  const r2 = await bare.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const c2 = { [r2.cookies[0].name]: r2.cookies[0].value };
  assert.equal((await bare.inject({ url: "/api/ha/status", cookies: c2 })).json().configured, false);
  assert.equal((await bare.inject({ method: "POST", url: "/api/ha/announce", cookies: c2, payload: { message: "x" } })).statusCode, 503);
  await bare.close();
});

test("HA adapter: origin-only URL, no redirects, real reachability without sensors", async () => {
  assert.equal((await createHomeAssistant({ url: "http://ha:8123/x?y", token: "t" }).status() as { configured: boolean }).configured, false);
  const realFetch = globalThis.fetch;
  const seen: RequestInit[] = [];
  globalThis.fetch = async (_u, init) => { seen.push(init!); throw new TypeError("down"); };
  try {
    const s = (await createHomeAssistant({ url: "http://ha:8123/", token: "t" }).status()) as { reachable: boolean };
    assert.equal(s.reachable, false);
    assert.equal(seen[0].redirect, "error");
  } finally {
    globalThis.fetch = realFetch;
  }
});

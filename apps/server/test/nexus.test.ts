import { createHomeAssistant } from "../src/homeassistant.ts";
import { cameraName, parseCameras } from "../src/studio.ts";
import { parseHosts } from "../src/homelab.ts";
import { createMac } from "../src/mac.ts";
import { createVps, parseVps } from "../src/vps.ts";
import { createAlerts, issuesFrom } from "../src/alerts.ts";
import { createObs } from "../src/obs.ts";
import { createSpotify } from "../src/spotify.ts";
import { openKv } from "../src/db.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, validateSettings, voiceShortcut, DEFAULT_SETTINGS } from "../src/actions.ts";
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
  // theme: optional (older saved settings lack it), one of three values, nothing else allowed
  const { theme: _t, ...legacy } = DEFAULT_SETTINGS;
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: legacy })).statusCode, 200);
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { ...DEFAULT_SETTINGS, theme: "light" } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/settings", cookies })).json().theme, "light");
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { ...DEFAULT_SETTINGS, theme: "pink" } })).statusCode, 400);
  assert.equal((await app.inject({ method: "PUT", url: "/api/settings", cookies, payload: { ...DEFAULT_SETTINGS, extra: 1 } })).statusCode, 400);
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
    ha: { url: "http://ha.test:8123", token, sensors: "sensor.echo_temp,weather.home", announceEntity: "notify.echo_announce" },
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
    if (String(u).includes("/api/services/weather/get_forecasts")) return Response.json({ service_response: { "weather.home": { forecast: [{ datetime: "2026-11-24T06:30:00+00:00", condition: "rainy", temperature: 33.4, templow: 25.4, precipitation: 3.5 }, { datetime: "bad" }] } } });
    if (String(u).includes("/api/states/weather.home")) return Response.json({ state: "sunny", attributes: { friendly_name: "Home", temperature: 32.5, temperature_unit: "°C" } });
    if (String(u).includes("/api/states/")) return Response.json({ state: "21.5", attributes: { friendly_name: "Echo temp", unit_of_measurement: "C" } });
    return Response.json([]);
  };
  try {
    const st = await app.inject({ url: "/api/ha/status", cookies });
    assert.equal(st.statusCode, 200);
    assert.deepEqual(st.json().sensors, [{ id: "sensor.echo_temp", name: "Echo temp", state: "21.5", unit: "C" }, { id: "weather.home", name: "Home", state: "32.5", unit: "°C", condition: "sunny", forecast: [{ date: "2026-11-24T06:30:00+00:00", condition: "rainy", high: 33.4, low: 25.4, rain: 3.5 }] }]);
    assert.ok(!st.body.includes(token));
    calls.length = 0;
    const a = await app.inject({ method: "POST", url: "/api/ha/announce", cookies, payload: { message: "Dinner" } });
    assert.equal(a.statusCode, 200);
    assert.equal(calls[0].url, "http://ha.test:8123/api/services/notify/send_message");
    assert.equal((calls[0].init.headers as Record<string, string>).authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(calls[0].init.body as string), { entity_id: "notify.echo_announce", message: "Dinner" });
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

const TID = "4iV5W9uYEdYUVa79Axb7Rh";
const PID = "37i9dQZF1DXcBWIGoYBM5M";

test("spotify-play action validation", () => {
  assert.equal(validateAction({ type: "spotify-play", uri: `spotify:playlist:${PID}` }), null);
  assert.equal(validateAction({ type: "spotify-play", uri: `spotify:track:${TID}`, label: "x" }), null);
  assert.equal(validateAction({ type: "scene", steps: [{ type: "spotify-play", uri: `spotify:album:${TID}` }] }), null);
  assert.ok(validateAction({ type: "spotify-play", uri: `https://open.spotify.com/playlist/${PID}` }));
  assert.ok(validateAction({ type: "spotify-play", uri: "spotify:playlist:short" }));
  assert.ok(validateAction({ type: "spotify-play", uri: `spotify:episode:${TID}` }));
  assert.ok(validateAction({ type: "spotify-play", uri: `spotify:playlist:${PID}`, extra: 1 }));
  assert.ok(validateAction({ type: "spotify-play" }));
  assert.ok(validateAction({ type: "spotify-play", uri: `spotify:track:${TID}`, label: "" }));
});

test("spotify new routes: schemas, Spotify calls, reauth, shortcut run", async () => {
  const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:" });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookies = { [r.cookies[0].name]: r.cookies[0].value };
  const put = (url: string, payload: unknown, method = "PUT") => app.inject({ method: method as "PUT", url, cookies, payload: payload as object });
  for (const [m, u, p] of [
    ["PUT", "/api/spotify/seek", { positionMs: -1 }], ["PUT", "/api/spotify/seek", { positionMs: 1.5 }], ["PUT", "/api/spotify/seek", {}], ["PUT", "/api/spotify/seek", { positionMs: 86400001 }],
    ["POST", "/api/spotify/queue", { uri: `spotify:playlist:${PID}` }], ["POST", "/api/spotify/queue", { uri: "spotify:track:bad" }],
    ["PUT", "/api/spotify/like", { uri: `spotify:episode:${TID}`, liked: true }], ["PUT", "/api/spotify/like", { uri: `spotify:track:${TID}` }],
    ["PUT", "/api/spotify/play-context", { contextUri: `spotify:track:${TID}` }], ["PUT", "/api/spotify/play-context", { contextUri: `http://x/${PID}` }],
    ["PUT", "/api/spotify/play-uris", { uris: [] }], ["PUT", "/api/spotify/play-uris", { uris: [`spotify:playlist:${PID}`] }],
  ] as const) assert.equal((await put(u, p, m)).statusCode, 400, `${m} ${u} ${JSON.stringify(p)}`);
  assert.equal((await app.inject({ method: "PUT", url: "/api/spotify/seek", payload: { positionMs: 1 } })).statusCode, 401);

  // seed tokens with an old (base-scope only) grant by logging nothing: write via settings-free kv path is private, so use the API with a stub token endpoint
  const calls: { url: string; method: string; body?: string }[] = [];
  const realFetch = globalThis.fetch;
  let scopeFail = false;
  globalThis.fetch = async (u: any, init: any) => {
    const url = String(u);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (url.includes("/me/player/play") || url.includes("/me/player/seek") || url.includes("/me/player/queue") && init?.method === "POST") return new Response(null, { status: 204 });
    if (url.includes("/me/library") && init?.method !== "GET" && !init?.method) return Response.json([true]);
    if (url.includes("/me/library")) return scopeFail ? Response.json({ error: { status: 403, message: "Insufficient client scope" } }, { status: 403 }) : init.method === "GET" ? Response.json([true]) : new Response(null, { status: 200 });
    if (url.endsWith("/me/player")) return Response.json({ is_playing: true, progress_ms: 5, item: { uri: `spotify:track:${TID}`, name: "T", duration_ms: 100, artists: [{ name: "A" }], album: { name: "Al", images: [{ url: "http://insecure/x.jpg" }] } } });
    if (url.includes("/me/playlists")) return scopeFail ? Response.json({ error: { status: 403, message: "Insufficient client scope" } }, { status: 403 }) : Response.json({ items: [{ id: PID, uri: `spotify:playlist:${PID}`, name: "P", images: [{ url: "https://i/x.jpg" }], owner: { display_name: "me" }, items: { total: 3 } }], next: null });
    return new Response("{}", { status: 404 });
  };
  try {
    // Connect via the real token path: stub the token endpoint is not wired for callback; seed through createSpotify on a shared kv instead.
    const kv = openKv(":memory:");
    kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, scope: "user-read-playback-state" });
    const sp = createSpotify(kv, { clientId: "c", publicUrl: "https://x" });
    const st1 = (await sp.state()) as any;
    assert.equal(st1.scopesOk, false);
    assert.equal(st1.playback.art, null); // non-https art dropped
    assert.equal(st1.playback.liked, true);
    scopeFail = true;
    await assert.rejects(sp.playlists(), (e: any) => e.code === "reauth" && /Reconnect Spotify in Settings/.test(e.message));
    await assert.rejects(sp.like(`spotify:track:${TID}`, true), (e: any) => e.code === "reauth");
    const kv2 = openKv(":memory:");
    kv2.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, scope: "user-read-playback-state" });
    const sp2 = createSpotify(kv2, { clientId: "c", publicUrl: "https://x" });
    const st2 = (await sp2.state()) as any;
    assert.equal(st2.connected, true);
    assert.equal(st2.error, null);
    assert.equal(st2.playback.liked, null); // core playback still works
    scopeFail = false;

    calls.length = 0;
    await sp.cmd("PUT", "/me/player/seek", { position_ms: "1234" });
    await sp.cmd("POST", "/me/player/queue", { uri: `spotify:track:${TID}` });
    await sp.like(`spotify:track:${TID}`, true);
    await sp.like(`spotify:track:${TID}`, false);
    await sp.playItem(`spotify:playlist:${PID}`);
    await sp.playItem(`spotify:track:${TID}`);
    const enc = encodeURIComponent(`spotify:track:${TID}`);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace("https://api.spotify.com/v1", "")}`), [
      "PUT /me/player/seek?position_ms=1234",
      `POST /me/player/queue?uri=${enc}`,
      `PUT /me/library?uris=${enc}`,
      `DELETE /me/library?uris=${enc}`,
      "PUT /me/player/play", "PUT /me/player/play",
    ]);
    assert.deepEqual(JSON.parse(calls[4].body!), { context_uri: `spotify:playlist:${PID}` });
    assert.deepEqual(JSON.parse(calls[5].body!), { uris: [`spotify:track:${TID}`] });
    assert.deepEqual(await sp.playlists(), [{ id: PID, uri: `spotify:playlist:${PID}`, name: "P", art: "https://i/x.jpg", owner: "me", count: 3 }]);
    assert.ok(calls.some((c) => c.url.endsWith("/me/playlists?limit=50&offset=0")));

    // spotify-play shortcut runs server-side (app has no tokens, so the result is a clean error, not "client")
    const settings = { ...DEFAULT_SETTINGS, shortcuts: DEFAULT_SETTINGS.shortcuts.map((s, i) => (i === 0 ? { label: "P", action: { type: "spotify-play", uri: `spotify:playlist:${PID}` } } : s)) };
    assert.equal((await put("/api/settings", settings)).statusCode, 200);
    const run = await app.inject({ method: "POST", url: "/api/shortcuts/0/run", cookies });
    assert.deepEqual(run.json().results.map((x: any) => [x.type, x.status]), [["spotify-play", "error"]]);
  } finally {
    globalThis.fetch = realFetch;
  }
  await app.close();
});

test("spotify caches: reconnect clears, liked race guard, null entries, pagination", async () => {
  const kv = openKv(":memory:");
  kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, scope: "x" });
  const sp = createSpotify(kv, { clientId: "c", publicUrl: "https://x" });
  const realFetch = globalThis.fetch;
  const pl = (n: number, next: boolean) => Response.json({ items: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, uri: `spotify:playlist:${PID}`, name: "P" })), next: next ? "more" : null });
  let release: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let pages = 0, library = true;
  globalThis.fetch = async (u: any, init: any) => {
    const url = String(u);
    if (url.includes("/me/playlists")) { pages++; if (gate) await gate; return pl(50, pages < 12); }
    if (url.includes("/recently-played")) return Response.json({ items: [null, { track: null }, { track: { uri: "spotify:local:a:b:c:1", name: "L", artists: [] }, played_at: "t" }, { track: { uri: `spotify:track:${TID}`, name: "T", artists: [{ name: "A" }] }, played_at: "t2" }] });
    if (url.includes("/me/player/queue")) return Response.json({ currently_playing: null, queue: [null, ...Array.from({ length: 25 }, () => ({ uri: `spotify:track:${TID}`, name: "Q" }))] });
    if (url.includes("/me/library") && init?.method === "GET") { if (gate) await gate; return Response.json([library]); }
    if (url.endsWith("/me/player")) return Response.json({ is_playing: true, item: { uri: `spotify:track:${TID}`, name: "T", duration_ms: 1, artists: [] } });
    return new Response(null, { status: 200 });
  };
  try {
    assert.equal(((await sp.playlists()) as unknown[]).length, 500); // paginates past 100, capped at 500
    const rc = (await sp.recent()) as { playable: boolean; name: string }[];
    assert.deepEqual(rc.map((x) => [x.name, x.playable]), [["L", false], ["T", true]]);
    const q = (await sp.queue()) as { queue: unknown[] };
    assert.equal(q.queue.length, 20);

    // in-flight playlists fetch started before a disconnect must not repopulate the cache
    pages = 0;
    sp.disconnect();
    kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, scope: "x" });
    gate = new Promise((r) => (release = r));
    const inflight = sp.playlists();
    sp.disconnect();
    kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000, scope: "x" });
    release!(); gate = undefined;
    await inflight;
    const before = pages;
    await sp.playlists();
    assert.ok(pages > before, "stale in-flight result must not be cached across reconnect");

    // liked lookup in flight while a like is written: the write wins
    library = false;
    gate = new Promise((r) => (release = r));
    const st = sp.state();
    await new Promise((r) => setTimeout(r, 20));
    const liking = sp.like(`spotify:track:${TID}`, true);
    release!(); gate = undefined;
    await Promise.all([st, liking]);
    assert.equal(((await sp.state()) as any).playback.liked, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("spotify keeps last track when Spotify briefly reports no player; play targets that device", async () => {
  const kv = openKv(":memory:");
  kv.set("spotify", { access: "a", refresh: "r", expires: Date.now() + 3_600_000 });
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let player: object | null = { is_playing: true, progress_ms: 1, device: { id: "dev1", name: "Echo" }, item: { name: "Song", uri: "spotify:episode:0000000000000000000000", artists: [], duration_ms: 9 } };
  globalThis.fetch = async (u) => {
    calls.push(String(u));
    if (String(u).endsWith("/me/player")) return player ? new Response(JSON.stringify(player), { headers: { "content-type": "application/json" } }) : new Response(null, { status: 204 });
    return new Response(null, { status: 204 });
  };
  try {
    const sp = createSpotify(kv, { clientId: "c", publicUrl: "https://x" });
    assert.equal((await sp.state() as any).playback.is_playing, true);
    player = null; // Spotify's 204 right after a pause
    await new Promise((r) => setTimeout(r, 1100)); // past the 1s state cache
    const s = (await sp.state()) as any;
    assert.equal(s.playback.track, "Song");
    assert.equal(s.playback.is_playing, false);
    await sp.play();
    assert.match(calls.at(-1)!, /\/me\/player\/play\?device_id=dev1$/);
    // A restart while the player is idle still shows the last track (persisted in kv).
    const restarted = (await createSpotify(kv, { clientId: "c", publicUrl: "https://x" }).state()) as any;
    assert.equal(restarted.playback.track, "Song");
    assert.equal(restarted.playback.is_playing, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("studio: camera list parsing, auth-guarded status and proxy check, offline handling", async () => {
  const warned: string[] = [];
  assert.deepEqual(parseCameras("Webcam=webcam, DJI Action 2=dji,bad=../x,=nope,Phone=phone1", (m) => warned.push(m)), [
    { name: "Webcam", path: "webcam" }, { name: "DJI Action 2", path: "dji" }, { name: "Phone", path: "phone1" },
  ]);
  assert.equal(warned.length, 2);
  assert.equal(cameraName("c270-hd-webcam"), "C270 HD Webcam");
  assert.equal(cameraName("kitchen_phone"), "Kitchen Phone");
  assert.equal(cameraName("phone/redmi"), "Redmi");
  assert.deepEqual(parseCameras("Redmi=phone/redmi,x=a/b/c"), [{ name: "Redmi", path: "phone/redmi" }]);

  const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:", studio: { api: "http://cams.test:9997", cameras: "DJI Action 2=dji" } });
  assert.equal((await app.inject("/api/studio")).statusCode, 401);
  assert.equal((await app.inject("/api/studio/auth")).statusCode, 401);
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookies = { [r.cookies[0].name]: r.cookies[0].value };
  assert.equal((await app.inject({ url: "/api/studio/auth", cookies })).statusCode, 204);

  const realFetch = globalThis.fetch;
  let up = true;
  globalThis.fetch = async (u: any) => {
    if (!up) throw new TypeError("fetch failed");
    if (String(u).includes("/v3/config/paths/list")) return Response.json({ items: [{ name: "webcam", runOnDemand: "ffmpeg ..." }, { name: "~^[a-z0-9]+$", runOnDemand: "" }, { name: "all_others" }] });
    // a live phone appears without any config; a path that exists but isn't ready (no publisher) does not
    return Response.json({ items: [{ name: "phone", ready: true, readers: [{}, {}] }, { name: "webcam", ready: false, readers: [] }, { name: "stale", ready: false }] });
  };
  try {
    const st = (await app.inject({ url: "/api/studio", cookies })).json();
    assert.equal(st.reachable, true);
    assert.equal(st.publishUrl, "rtmp://cams.test/<name>");
    assert.deepEqual(st.cameras, [
      { name: "DJI Action 2", path: "dji", live: false, onDemand: false, viewers: 0 }, // named in STUDIO_CAMERAS: shown while offline
      { name: "Webcam", path: "webcam", live: false, onDemand: true, viewers: 0 }, // configured (USB webcam)
      { name: "Phone", path: "phone", live: true, onDemand: false, viewers: 2 }, // discovered while live
    ]);
    up = false;
    await new Promise((res) => setTimeout(res, 3100)); // past the 3 s cache
    const down = (await app.inject({ url: "/api/studio", cookies })).json();
    assert.equal(down.reachable, false);
    assert.match(down.error, /crashmetheus/);
    assert.deepEqual(down.cameras.map((c: { path: string; live: boolean }) => [c.path, c.live]), [["dji", false]]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("obs actions and status", async () => {
  assert.equal(validateAction({ type: "obs-scene", scene: "Desk" }), null);
  assert.equal(validateAction({ type: "obs-record", on: true }), null);
  assert.equal(validateAction({ type: "scene", steps: [{ type: "obs-scene", scene: "Desk" }, { type: "obs-record", on: false }] }), null);
  assert.ok(validateAction({ type: "obs-scene", scene: "" }));
  assert.ok(validateAction({ type: "obs-record", on: "yes" }));
  assert.ok(validateAction({ type: "obs-record", on: true, extra: 1 }));
  assert.deepEqual(await createObs({}).status(), { configured: false });
  const warned: string[] = [];
  assert.deepEqual(await createObs({ url: "http://x/" }, (m) => warned.push(m)).status(), { configured: false });
  assert.equal(warned.length, 1);
  // Nothing listens on port 9 locally: reported as unreachable, not thrown.
  const s = (await createObs({ url: "ws://127.0.0.1:9" }).status()) as { reachable: boolean };
  assert.equal(s.reachable, false);
  await assert.rejects(createObs({ url: "ws://127.0.0.1:9" }).record(true), /reach OBS|closed the connection/);
});

test("obs rejects malformed urls without throwing", async () => {
  for (const url of ["ws://x:65536", "ws://x/path", "ws://x?q=1", "http://x:4455"]) {
    const warned: string[] = [];
    assert.deepEqual(await createObs({ url }, (m) => warned.push(m)).status(), { configured: false }, url);
    assert.equal(warned.length, 1, url);
  }
});

test("voice commands: phrase matching and the HA live voice event", async () => {
  const sc = [
    { label: "Studio mode", action: { type: "obs-record", on: true } as const },
    { label: "Unused", action: { type: "none" } as const },
    { label: "Focus!", action: { type: "announce", message: "x" } as const },
  ];
  assert.equal(voiceShortcut("alexa studio mode", sc), 0);
  assert.equal(voiceShortcut("Alexa, Studio-Mode.", sc), 0);
  assert.equal(voiceShortcut("alexa focus", sc), 2);
  assert.equal(voiceShortcut("alexa unused", sc), -1, "empty slots never match");
  assert.equal(voiceShortcut("alexa start studio mode", sc), -1, "whole phrase only");
  assert.equal(voiceShortcut("alexa", sc), -1);

  const warned: string[] = [];
  assert.equal(createHomeAssistant({ url: "http://ha:8123", token: "t", voiceEntity: "sensor.x" }, (m) => warned.push(m)).voiceConfigured, false);
  assert.equal(warned.length, 1);
  const ha = createHomeAssistant({ url: "http://ha:8123", token: "t", voiceEntity: "event.echo_voice_event" });
  // A fake HA websocket: checks the auth + subscription handshake, then pushes state_changed events.
  const RealWS = globalThis.WebSocket;
  const socks: any[] = [];
  globalThis.WebSocket = class {
    sent: any[] = []; closed = false; onmessage: any; onclose: any; onerror: any;
    url: string;
    constructor(url: string) { this.url = url; socks.push(this); }
    send(m: string) { this.sent.push(JSON.parse(m)); }
    close() { this.closed = true; }
    emit(d: unknown) { this.onmessage({ data: JSON.stringify(d) }); }
  } as any;
  try {
    const heard: string[] = [];
    const stop = ha.watchVoice((t) => heard.push(t));
    const s = socks[0];
    assert.equal(s.url, "ws://ha:8123/api/websocket");
    s.emit({ type: "auth_required" });
    assert.deepEqual(s.sent[0], { type: "auth", access_token: "t" });
    s.emit({ type: "auth_ok" });
    assert.deepEqual(s.sent[1], { id: 1, type: "subscribe_events", event_type: "state_changed" });
    s.emit({ id: 1, type: "result", success: true });
    const ev = (entity_id: string, state: string, text: string) =>
      s.emit({ id: 1, type: "event", event: { event_type: "state_changed", data: { entity_id, new_state: { state, attributes: { voice_command: text } } } } });
    ev("event.echo_voice_event", new Date().toISOString(), "alexa studio mode");
    ev("event.other", new Date().toISOString(), "alexa focus");
    ev("event.echo_voice_event", "2026-11-21T11:47:39.290+00:00", "alexa old command"); // restored state after an HA restart
    ev("event.echo_voice_event", "unavailable", "alexa focus");
    assert.deepEqual(heard, ["alexa studio mode"]);
    stop();
    assert.ok(s.closed);
    s.onclose();
    assert.equal(socks.length, 1, "no reconnect after stop");
  } finally { globalThis.WebSocket = RealWS; }
});

test("mac actions, status and route", async () => {
  assert.equal(validateAction({ type: "mac", command: "volume", arg: "50" }), null);
  assert.equal(validateAction({ type: "mac", command: "lock" }), null);
  assert.equal(validateAction({ type: "mac", command: "open", arg: "Spotify" }), null);
  assert.ok(validateAction({ type: "mac", command: "volume", arg: "101" }));
  assert.ok(validateAction({ type: "mac", command: "lock", arg: "x" }));
  assert.ok(validateAction({ type: "mac", command: "reboot" }));
  assert.ok(validateAction({ type: "mac", command: "open", arg: "a\nb" }));
  assert.deepEqual(await createMac({}).status(), { configured: false });
  const warned: string[] = [];
  assert.equal(createMac({ host: "a b", user: "me" }, (m) => warned.push(m)).configured, false);
  assert.equal(warned.length, 1);
  await assert.rejects(createMac({}).run("lock"), /not configured/);
  const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:" });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/mac", headers: { cookie } })).json(), { configured: false });
  assert.equal((await app.inject({ method: "POST", url: "/api/mac", headers: { cookie }, payload: { command: "reboot" } })).statusCode, 400);
  await app.close();
});

test("vps companion output, status and route", async () => {
  // Bare or short records (cpu, uptime, mem, snapshot) are ignored; a second snapshot line cannot reset the list.
  const v = parseVps("cpu\nuptime\nmem\t1\ncpu\t12.34\nmem\t2048000\t1024000\ndisk\t10000000\t2500000\nload\t0.5\t1\tx\nuptime\t99.9\njunk\nsnapshot\t12\nc\talice\tdb\tpostgres:17\trunning\tUp 4 weeks (healthy)\nc\tshort\nsnapshot\nsnapshot\t1\ne\tbob\n");
  assert.deepEqual(v, {
    cpuPercent: 12.3, mem: { totalMb: 2000, usedMb: 1000 }, disk: { totalGb: 10.2, usedGb: 2.6 }, load: null, uptimeSec: 99, snapshotAge: 12,
    containers: [{ owner: "alice", name: "db", image: "postgres:17", state: "running", status: "Up 4 weeks (healthy)" }], incomplete: ["bob"],
  });
  // No snapshot line: containers unknown (null), not "none".
  assert.equal(parseVps("cpu\t1\n").containers, null);
  assert.deepEqual(await createVps({}).status(), { configured: false });
  const warned: string[] = [];
  createVps({ host: "vps", user: "bad user" }, (m) => warned.push(m));
  assert.equal(warned.length, 1);
  const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:" });
  assert.equal((await app.inject({ method: "GET", url: "/api/vps" })).statusCode, 401);
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { password: "pw" } });
  const cookie = String(login.headers["set-cookie"]).split(";")[0];
  assert.deepEqual((await app.inject({ method: "GET", url: "/api/vps", headers: { cookie } })).json(), { configured: false });
  await app.close();
});

test("alerts: issues, debounce, resolve, restart, failed sends", async () => {
  const o = issuesFrom(
    { pi: { tempC: 76 }, containers: [{ name: "caddy", state: "running" }, { name: "ha", state: "exited" }], snapshotAge: 10, hosts: [{ name: "nas", up: false }] },
    { configured: true, reachable: true, snapshotAge: 5, containers: [{ owner: "alice", name: "db", state: "exited" }], incomplete: ["bob"] },
    { configured: true, reachable: true, sensors: [{ id: "sensor.t", name: "Echo temperature", state: "unavailable" }, { id: "sensor.l", name: "Light", state: "3" }] });
  assert.deepEqual(o.issues.map((i) => i.key), ["pi-hot", "pi-container:ha", "host:nas", "vps-container:alice/db", "vps-incomplete:bob", "ha-sensor:sensor.t"]);
  assert.deepEqual(o.unknown, ["vps-container:bob/"]);
  const down = issuesFrom(null, { configured: true, reachable: false, error: "x" }, { configured: true, reachable: false, sensors: [] });
  assert.deepEqual(down.issues.map((i) => i.key), ["homelab", "vps", "ha"]);
  assert.deepEqual(down.unknown, ["pi-", "host:", "vps-", "ha-"]);
  assert.deepEqual(issuesFrom({ pi: { tempC: 50 }, containers: [], snapshotAge: 900, hosts: [] }, null, null).issues.map((i) => i.key), ["pi-containers"]);
  assert.deepEqual(issuesFrom({ pi: { tempC: 74 }, containers: [], snapshotAge: 1, hosts: [] }, { configured: false }, null).issues, []);

  for (const bad of ["https://user:pw@ntfy.sh/x", "https://ntfy.sh:bogus/x", "https://ntfy.sh?x=/topic", "https://ntfy.sh/a/b", "ftp://ntfy.sh/x"]) {
    const warned: string[] = [];
    assert.equal(createAlerts({ url: bad }, openKv(":memory:"), async () => ({ issues: [], unknown: [] }), (m) => warned.push(m)).configured, false, bad);
    assert.equal(warned.length, 1);
  }
  assert.equal(createAlerts({ url: "http://lan-ntfy/x", token: "tk" }, openKv(":memory:"), async () => ({ issues: [], unknown: [] })).configured, false);
  assert.equal(createAlerts({ url: "http://lan-ntfy/x" }, openKv(":memory:"), async () => ({ issues: [], unknown: [] })).configured, true);
  await assert.rejects(createAlerts({}, openKv(":memory:"), async () => ({ issues: [], unknown: [] })).test(), /not configured/);

  const sent: { title: string; body: string; auth: string | null }[] = [];
  let failOn = "";
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    if (failOn && String(init.body).includes(failOn)) throw new Error("down");
    const h = new Headers(init.headers);
    sent.push({ title: h.get("title")!, body: String(init.body), auth: h.get("authorization") });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const kv = openKv(":memory:");
    let obs = { issues: [{ key: "host:nas", msg: "Host nas is down" }], unknown: [] as string[] };
    const make = () => createAlerts({ url: "https://ntfy.sh/nexus-test", token: "tk_x" }, kv, async () => obs);
    let a = make();
    await a.tick(); // first sighting: no alert yet
    assert.equal(sent.length, 0);
    await a.tick(); // second in a row: alert
    assert.deepEqual(sent, [{ title: "Nexus: problem", body: "Host nas is down", auth: "Bearer tk_x" }]);
    await a.tick(); // still down: nothing new
    a = make(); // restart (deploy): already alerted, not re-sent
    await a.tick();
    assert.equal(sent.length, 1);
    obs = { issues: [], unknown: ["host:"] }; // hosts not observable: not a recovery
    await a.tick();
    assert.equal(sent.length, 1);
    obs = { issues: [], unknown: [] };
    await a.tick(); // observed healthy: resolved
    assert.deepEqual(sent[1], { title: "Nexus: resolved", body: "Cleared: Host nas is down", auth: "Bearer tk_x" });
    // A blip (one check) never alerts; an unknown sample breaks a streak.
    obs = { issues: [{ key: "ha", msg: "Home Assistant unreachable" }], unknown: [] }; await a.tick();
    obs = { issues: [], unknown: [] }; await a.tick();
    obs = { issues: [{ key: "pi-container:x", msg: "Container x is exited" }], unknown: [] }; await a.tick();
    obs = { issues: [], unknown: ["pi-container:"] }; await a.tick();
    obs = { issues: [{ key: "pi-container:x", msg: "Container x is exited" }], unknown: [] }; await a.tick();
    assert.equal(sent.length, 2);
    // One failing send does not hold back the others, and is retried next time.
    obs = { issues: [{ key: "a", msg: "A down" }, { key: "b", msg: "B down" }], unknown: [] }; await a.tick();
    failOn = "A down"; await a.tick();
    assert.deepEqual(sent.slice(2).map((x) => x.body), ["B down"]);
    failOn = ""; await a.tick();
    assert.deepEqual(sent.slice(2).map((x) => x.body), ["B down", "A down"]);
    // Overlapping ticks run once.
    const n = sent.length;
    obs = { issues: [], unknown: [] };
    await Promise.all([a.tick(), a.tick()]);
    assert.equal(sent.length, n + 2); // A and B resolved once each
    await a.idle();
    await a.test();
    assert.equal(sent.at(-1)!.title, "Nexus");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("web build id header changes with the build", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const id = async (html: string) => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-web-"));
    writeFileSync(join(dir, "index.html"), html);
    const app = await buildApp({ password: "pw", secret: "s".repeat(32), dataDir: ":memory:", webDist: dir });
    try {
      const [a, b] = [await app.inject({ url: "/api/session" }), await app.inject({ url: "/" })];
      assert.equal(a.headers["x-nexus-build"], b.headers["x-nexus-build"]);
      return a.headers["x-nexus-build"];
    } finally { await app.close(); }
  };
  const one = await id('<script src="/assets/index-aaa.js"></script>');
  assert.match(String(one), /^[0-9a-f]{12}$/);
  assert.equal(await id('<script src="/assets/index-aaa.js"></script>'), one);
  assert.notEqual(await id('<script src="/assets/index-bbb.js"></script>'), one);
});

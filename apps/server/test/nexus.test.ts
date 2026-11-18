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
    ha: { url: "http://ha.test:8123", token, sensors: "sensor.echo_temp", announceEntity: "notify.echo_announce" },
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
  } finally {
    globalThis.fetch = realFetch;
  }
});

import { AppError } from "./spotify.ts";

// Camera hub backed by MediaMTX on another host (crashmetheus). Nexus only reads its API;
// video goes from MediaMTX straight to the browser over WebRTC (via Caddy's authenticated /studio/ proxy).
export interface StudioCfg { api?: string; cameras?: string }
export interface Camera { name: string; path: string }
const PATH = /^[a-z0-9_-]{1,64}$/;

/** "Webcam=webcam,DJI Action 2=dji" -> [{ name: "Webcam", path: "webcam" }, ...] */
export function parseCameras(s: string | undefined, warn: (m: string) => void = () => {}): Camera[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean).flatMap((x) => {
    const i = x.lastIndexOf("=");
    const name = x.slice(0, i).trim(), path = x.slice(i + 1).trim();
    if (i < 1 || !name || name.length > 40 || !PATH.test(path)) return (warn(`STUDIO_CAMERAS: ignoring "${x}"`), []);
    return [{ name, path }];
  });
}

export function createStudio(cfg: StudioCfg, warn: (m: string) => void = () => {}) {
  const raw = cfg.api?.replace(/\/$/, "") ?? "";
  const api = /^https?:\/\/[^/?#]+$/.test(raw) ? raw : (cfg.api && warn("STUDIO_API: must be an http(s) origin, Studio disabled"), undefined);
  const cameras = parseCameras(cfg.cameras, warn);
  let cache: { at: number; value: unknown } | undefined;
  let polling: Promise<unknown> | undefined;

  const get = async (path: string) => {
    let r: Response;
    try {
      r = await fetch(`${api}${path}`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    } catch {
      throw new AppError(502, "network", "Cannot reach the camera server (is crashmetheus on?).");
    }
    if (!r.ok) throw new AppError(502, "studio", `Camera server returned ${r.status}.`);
    return (await r.json()) as { items?: Record<string, unknown>[] };
  };

  async function poll() {
    let value;
    try {
      const [live, conf] = await Promise.all([get("/v3/paths/list?itemsPerPage=1000"), get("/v3/config/paths/list?itemsPerPage=1000")]);
      const byName = (j: { items?: Record<string, unknown>[] }) => new Map((j.items ?? []).map((x) => [String(x.name), x]));
      const l = byName(live), c = byName(conf);
      value = {
        configured: true, reachable: true, error: null,
        cameras: cameras.map(({ name, path }) => {
          const p = l.get(path), k = c.get(path);
          return { name, path, live: p?.ready === true, onDemand: typeof k?.runOnDemand === "string" && k.runOnDemand !== "", viewers: Array.isArray(p?.readers) ? p.readers.length : 0 };
        }),
      };
    } catch (e) {
      value = { configured: true, reachable: false, error: e instanceof AppError ? e.message : "Camera server returned an unexpected response.", cameras: cameras.map(({ name, path }) => ({ name, path, live: false, onDemand: false, viewers: 0 })) };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  return {
    async status() {
      if (!api || !cameras.length) return { configured: false, reachable: false, error: null, cameras: [] };
      if (cache && Date.now() - cache.at < 3000) return cache.value;
      return (polling ??= poll().finally(() => (polling = undefined)));
    },
  };
}

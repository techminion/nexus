import { AppError } from "./spotify.ts";

// Camera hub backed by MediaMTX on another host (crashmetheus). Nexus only reads its API;
// video goes from MediaMTX straight to the browser over WebRTC (via Caddy's authenticated /studio/ proxy).
// Cameras are discovered from MediaMTX: configured paths (USB webcams) plus anything currently publishing.
// STUDIO_CAMERAS is optional: "Name=path" entries give nicer names and keep those tiles shown while offline.
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

/** "c270-hd-webcam" -> "C270 HD Webcam", "dji" -> "DJI". */
export const cameraName = (path: string) =>
  path.split(/[-_]+/).filter(Boolean).map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1))).join(" ");

export function createStudio(cfg: StudioCfg, warn: (m: string) => void = () => {}) {
  const raw = cfg.api?.replace(/\/$/, "") ?? "";
  const api = /^https?:\/\/[^/?#]+$/.test(raw) ? raw : (cfg.api && warn("STUDIO_API: must be an http(s) origin, Studio disabled"), undefined);
  const pinned = parseCameras(cfg.cameras, warn);
  const names = new Map(pinned.map((c) => [c.path, c.name]));
  const publishUrl = api ? `rtmp://${new URL(api).hostname}/<name>` : null;
  const camera = (path: string, p?: Record<string, unknown>, k?: Record<string, unknown>) => ({
    name: names.get(path) ?? cameraName(path), path,
    live: p?.ready === true,
    onDemand: typeof k?.runOnDemand === "string" && k.runOnDemand !== "",
    viewers: Array.isArray(p?.readers) ? p.readers.length : 0,
  });
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
    const j = (await r.json().catch(() => null)) as { items?: unknown } | null;
    if (!j || !Array.isArray(j.items)) throw new AppError(502, "studio", "Camera server returned an unexpected response.");
    return j as { items: Record<string, unknown>[] };
  };

  async function poll() {
    let value;
    try {
      const [live, conf] = await Promise.all([get("/v3/paths/list?itemsPerPage=1000"), get("/v3/config/paths/list?itemsPerPage=1000")]);
      // Only plain path names; skips MediaMTX's regex entries ("~^...") and all_others.
      const byName = (j: { items: Record<string, unknown>[] }) => new Map(j.items.filter((x) => PATH.test(String(x.name)) && x.name !== "all_others").map((x) => [String(x.name), x]));
      const l = byName(live), c = byName(conf);
      const sorted = (m: Map<string, unknown>) => [...m.keys()].sort();
      const paths = [...new Set([...pinned.map((x) => x.path), ...sorted(c), ...sorted(l).filter((n) => l.get(n)?.ready === true)])];
      value = { configured: true, reachable: true, error: null, publishUrl, cameras: paths.map((n) => camera(n, l.get(n), c.get(n))) };
    } catch (e) {
      value = { configured: true, reachable: false, error: e instanceof AppError ? e.message : "Camera server returned an unexpected response.", publishUrl, cameras: pinned.map((x) => camera(x.path)) };
    }
    cache = { at: Date.now(), value };
    return value;
  }

  return {
    async status() {
      if (!api) return { configured: false, reachable: false, error: null, publishUrl: null, cameras: [] };
      if (cache && Date.now() - cache.at < 3000) return cache.value;
      return (polling ??= poll().finally(() => (polling = undefined)));
    },
  };
}

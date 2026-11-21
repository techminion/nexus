import { useQuery } from "@tanstack/react-query";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, "network", "Nexus server unreachable.");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, j?.error?.code ?? "error", j?.error?.message ?? `Request failed (${r.status})`);
  return j as T;
}

export type Module = "dashboard" | "music" | "devices" | "timer" | "homelab" | "studio" | "settings";
export type Action =
  | { type: "url"; url: string }
  | { type: "module"; module: Module }
  | { type: "spotify-device"; deviceName: string }
  | { type: "announce"; message: string }
  | { type: "spotify-play"; uri: string; label?: string }
  | { type: "obs-scene"; scene: string }
  | { type: "obs-record"; on: boolean }
  | { type: "scene"; steps: Action[] }
  | { type: "none" };
export interface Shortcut { label: string; action: Action }
export type Theme = "dark" | "light" | "system";
export interface Settings { clock24h: boolean; theme?: Theme; shortcuts: Shortcut[] }
export interface Playback {
  track: string | null; artists: string[]; album: string | null; art: string | null;
  progress_ms: number; duration_ms: number; is_playing: boolean; shuffle: boolean;
  repeat: "off" | "context" | "track"; volume: number | null; device: string | null;
  uri: string | null; liked: boolean | null;
}
export interface SpotifyState {
  connected: boolean;
  scopesOk: boolean;
  error: { code: string; message: string; retryAfter: number | null } | null;
  playback: Playback | null;
}
export interface Item { uri: string; name: string; artists: string[]; art: string | null }
export interface PlaylistInfo { id: string; uri: string; name: string; art: string | null; owner: string; count: number }
export interface RecentTrack extends Item { playedAt: string; playable: boolean }
export interface Device { id: string; name: string; type: string; active: boolean; volume: number | null }

export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api<Settings>("GET", "/api/settings") });

// Poll faster while playing; back off on network errors and rate limits; pause when hidden.
export const useSpotify = () =>
  useQuery({
    queryKey: ["spotify"],
    queryFn: () => api<SpotifyState>("GET", "/api/spotify/state"),
    refetchInterval: (q) => {
      if (document.hidden) return false;
      if (q.state.status === "error") return Math.min(30_000, 5_000 * 2 ** Math.min(q.state.errorUpdateCount, 3));
      const d = q.state.data;
      if (d?.error?.retryAfter) return d.error.retryAfter * 1000 + 500;
      return d?.playback?.is_playing ? 2_000 : 10_000;
    },
  });

export interface Homelab {
  pi: {
    cpuPercent: number | null; mem: { totalMb: number; usedMb: number } | null; disk: { totalGb: number; usedGb: number } | null;
    tempC: number | null; uptimeSec: number | null; load: number[] | null;
  };
  containers: { name: string; image: string; state: string; status: string }[] | null;
  snapshotAge: number | null;
  error: string | null;
  hosts: { name: string; target: string; up: boolean; latencyMs: number | null }[];
}
export interface HaStatus { configured: boolean; reachable: boolean; error: string | null; sensors: { id: string; name: string; state: string; unit: string | null; condition?: string }[] }

export interface StudioCamera { name: string; path: string; live: boolean; onDemand: boolean; viewers: number }
export interface StudioStatus { configured: boolean; reachable: boolean; error: string | null; publishUrl: string | null; cameras: StudioCamera[] }
export type ObsStatus =
  | { configured: false }
  | { configured: true; reachable: false; error: string }
  | { configured: true; reachable: true; scenes: string[]; scene: string | null; recording: boolean; recordTime: string | null; streaming: boolean };
export const useObs = () =>
  useQuery({ queryKey: ["obs"], queryFn: () => api<ObsStatus>("GET", "/api/obs"), refetchInterval: () => (document.hidden ? false : 3000) });
export const useStudio = () =>
  useQuery({ queryKey: ["studio"], queryFn: () => api<StudioStatus>("GET", "/api/studio"), refetchInterval: () => (document.hidden ? false : 5000) });

// Shared query keys: the header and the pages poll the same cache; the fastest interval wins.
export const useHomelab = (ms = 30_000) =>
  useQuery({ queryKey: ["homelab"], queryFn: () => api<Homelab>("GET", "/api/homelab"), refetchInterval: () => (document.hidden ? false : ms) });
export const useHa = (ms = 30_000) =>
  useQuery({ queryKey: ["ha"], queryFn: () => api<HaStatus>("GET", "/api/ha/status"), refetchInterval: () => (document.hidden ? false : ms) });

/** Human-readable problems; empty means healthy. */
export function homelabIssues(d: Homelab): string[] {
  const out: string[] = [];
  if (d.pi.tempC !== null && d.pi.tempC >= 70) out.push(`Pi is hot (${d.pi.tempC.toFixed(1)}°C)`);
  if (d.containers === null) out.push("Container status unavailable");
  else for (const c of d.containers) if (c.state !== "running") out.push(`Container ${c.name} is ${c.state}`);
  for (const h of d.hosts) if (!h.up) out.push(`Host ${h.name} is down`);
  return out;
}

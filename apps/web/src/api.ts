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

export type Module = "dashboard" | "music" | "devices" | "timer" | "settings";
export type Action =
  | { type: "url"; url: string }
  | { type: "module"; module: Module }
  | { type: "spotify-device"; deviceName: string }
  | { type: "scene"; steps: Action[] }
  | { type: "none" };
export interface Shortcut { label: string; action: Action }
export interface Settings { clock24h: boolean; shortcuts: Shortcut[] }
export interface Playback {
  track: string | null; artists: string[]; album: string | null; art: string | null;
  progress_ms: number; duration_ms: number; is_playing: boolean; shuffle: boolean;
  repeat: "off" | "context" | "track"; volume: number | null; device: string | null;
}
export interface SpotifyState {
  connected: boolean;
  error: { code: string; message: string; retryAfter: number | null } | null;
  playback: Playback | null;
}
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

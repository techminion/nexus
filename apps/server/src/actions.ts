export const MODULES = ["dashboard", "music", "devices", "timer", "settings"] as const;
export type Action =
  | { type: "url"; url: string }
  | { type: "module"; module: (typeof MODULES)[number] }
  | { type: "spotify-device"; deviceName: string }
  | { type: "scene"; steps: Action[] }
  | { type: "none" };
export interface Shortcut { label: string; action: Action }
export interface Settings { clock24h: boolean; shortcuts: Shortcut[] }

export const DEFAULT_SETTINGS: Settings = {
  clock24h: true,
  shortcuts: [
    { label: "Dashboard", action: { type: "module", module: "dashboard" } },
    { label: "Devices", action: { type: "module", module: "devices" } },
    { label: "Spotify", action: { type: "url", url: "https://open.spotify.com" } },
    { label: "Shortcut 4", action: { type: "none" } },
    { label: "Shortcut 5", action: { type: "none" } },
  ],
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

// Strict: unknown keys and types are rejected. Returns an error string or null.
export function validateAction(a: unknown, nested = false): string | null {
  if (!isObj(a)) return "action must be an object";
  const keys = Object.keys(a).sort().join();
  switch (a.type) {
    case "none":
      return keys === "type" ? null : "unexpected fields";
    case "url": {
      if (keys !== "type,url" || !str(a.url, 2048)) return "invalid url action";
      try {
        const p = new URL(a.url as string).protocol;
        return p === "http:" || p === "https:" ? null : "only http/https URLs allowed";
      } catch {
        return "invalid URL";
      }
    }
    case "module":
      return keys === "module,type" && (MODULES as readonly unknown[]).includes(a.module) ? null : "invalid module";
    case "spotify-device":
      return keys === "deviceName,type" && str(a.deviceName, 200) ? null : "invalid device name";
    case "scene": {
      if (nested) return "scenes cannot be nested";
      if (keys !== "steps,type" || !Array.isArray(a.steps) || a.steps.length > 10) return "scene needs at most 10 steps";
      for (const s of a.steps) {
        const e = validateAction(s, true);
        if (e) return e;
      }
      return null;
    }
    default:
      return "unknown action type";
  }
}

export function validateSettings(s: unknown): string | null {
  if (!isObj(s) || typeof s.clock24h !== "boolean" || !Array.isArray(s.shortcuts) || s.shortcuts.length !== 5) return "invalid settings";
  if (Object.keys(s).length !== 2) return "unexpected fields";
  for (const sc of s.shortcuts) {
    if (!isObj(sc) || Object.keys(sc).length !== 2 || typeof sc.label !== "string" || sc.label.length > 40) return "invalid shortcut";
    const e = validateAction(sc.action);
    if (e) return e;
  }
  return null;
}

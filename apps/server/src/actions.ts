export const MODULES = ["dashboard", "music", "devices", "timer", "homelab", "studio", "settings"] as const;
export const TRACK_RE = /^spotify:track:[A-Za-z0-9]{22}$/;
export const CONTEXT_RE = /^spotify:(playlist|album|artist|show):[A-Za-z0-9]{22}$/;
export const MAC_COMMANDS = ["playpause", "next", "previous", "volume", "mute", "unmute", "lock", "open", "shortcut"] as const;
/** Arg rules shared by run() and validateAction: volume 0-100, open/shortcut a short plain string, others none. Returns an error or null. */
export const macArgError = (command: string, arg: unknown): string | null =>
  command === "volume" ? (typeof arg === "number" || (typeof arg === "string" && /^\d{1,3}$/.test(arg))) && Number.isInteger(+arg) && +arg >= 0 && +arg <= 100 ? null : "volume must be 0-100"
  : command === "open" || command === "shortcut" ? (typeof arg === "string" && arg.length >= 1 && arg.length <= 100 && !/[\x00-\x1f\x7f]/.test(arg) ? null : `${command} needs a name (1-100 characters)`)
  : arg === undefined ? null : `${command} takes no argument`;

export type Action =
  | { type: "url"; url: string }
  | { type: "module"; module: (typeof MODULES)[number] }
  | { type: "spotify-device"; deviceName: string }
  | { type: "announce"; message: string }
  | { type: "spotify-play"; uri: string; label?: string }
  | { type: "obs-scene"; scene: string }
  | { type: "obs-record"; on: boolean }
  | { type: "mac"; command: (typeof MAC_COMMANDS)[number]; arg?: string }
  | { type: "scene"; steps: Action[] }
  | { type: "none" };
export interface Shortcut { label: string; action: Action }
/** "Alexa, Studio mode!" -> "studio mode": lowercase words, leading wake word dropped. */
export const voicePhrase = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/^(alexa|echo|computer|amazon|ziggy) /, "");
/** Index of the shortcut whose label is exactly what was said (after voicePhrase), or -1. */
export const voiceShortcut = (said: string, shortcuts: Shortcut[]) => {
  const p = voicePhrase(said);
  return p ? shortcuts.findIndex((s) => s.action.type !== "none" && voicePhrase(s.label) === p) : -1;
};
export const THEMES = ["dark", "light", "system"] as const;
/** The look: neobrutalism (outlines, hard shadows) or neumorphism ("soft"). Independent of light/dark. */
export const SKINS = ["brutal", "soft"] as const;
export interface Settings { clock24h: boolean; theme?: (typeof THEMES)[number]; skin?: (typeof SKINS)[number]; shortcuts: Shortcut[] }

export const DEFAULT_SETTINGS: Settings = {
  clock24h: true,
  theme: "dark",
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
    case "announce":
      return keys === "message,type" && str(a.message, 300) ? null : "invalid announce message";
    case "spotify-play":
      return (keys === "type,uri" || (keys === "label,type,uri" && str(a.label, 40))) && typeof a.uri === "string" && (TRACK_RE.test(a.uri) || CONTEXT_RE.test(a.uri)) ? null : "invalid spotify-play action";
    case "obs-scene":
      return keys === "scene,type" && str(a.scene, 100) ? null : "invalid OBS scene";
    case "obs-record":
      return keys === "on,type" && typeof a.on === "boolean" ? null : "invalid OBS record action";
    case "mac":
      return (keys === "command,type" || keys === "arg,command,type") && (MAC_COMMANDS as readonly unknown[]).includes(a.command) ? macArgError(a.command as string, a.arg) && "invalid Mac action" : "invalid Mac action";
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
  if (s.theme !== undefined && !(THEMES as readonly unknown[]).includes(s.theme)) return "invalid theme";
  if (s.skin !== undefined && !(SKINS as readonly unknown[]).includes(s.skin)) return "invalid skin";
  if (Object.keys(s).some((k) => !["clock24h", "theme", "skin", "shortcuts"].includes(k))) return "unexpected fields";
  for (const sc of s.shortcuts) {
    if (!isObj(sc) || Object.keys(sc).length !== 2 || typeof sc.label !== "string" || sc.label.length > 40) return "invalid shortcut";
    const e = validateAction(sc.action);
    if (e) return e;
  }
  return null;
}

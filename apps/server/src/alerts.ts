import type { Kv } from "./db.ts";
import { AppError } from "./spotify.ts";

// Phone alerts through ntfy (any server: ntfy.sh or self-hosted). Configured by NTFY_URL (the topic URL)
// and, for a protected topic, NTFY_TOKEN.
export interface AlertsCfg { url?: string; token?: string }
export interface Issue { key: string; msg: string }
/** issues: current problems. unknown: key prefixes that could not be observed this time (never resolved from them). */
export interface Observation { issues: Issue[]; unknown: string[] }

type Homelab = { pi?: { tempC: number | null }; containers?: { name: string; state: string }[] | null; snapshotAge?: number | null; hosts?: { name: string; up: boolean }[] };
type Vps = { configured: boolean; reachable?: boolean; error?: string; containers?: { owner: string; name: string; state: string }[] | null; snapshotAge?: number | null; incomplete?: string[] };
type Ha = { configured: boolean; reachable: boolean; sensors: { id: string; name: string; state: string }[] };

const STALE = 300; // s: both snapshot timers run every 30 s

/** Current problems from the status the pages already show. Keys stay stable while a problem lasts. */
export function issuesFrom(h: Homelab | null, v: Vps | null, ha: Ha | null): Observation {
  const issues: Issue[] = [], unknown: string[] = [];
  const add = (key: string, msg: string) => issues.push({ key, msg });
  if (!h) { add("homelab", "Homelab status unavailable"); unknown.push("pi-", "host:"); }
  else {
    // 75 °C, not the page's 70: a short load spike should not page anyone.
    if (h.pi?.tempC == null) unknown.push("pi-hot");
    else if (h.pi.tempC >= 75) add("pi-hot", `Pi is hot (${h.pi.tempC.toFixed(0)}°C)`);
    if (!h.containers) { add("pi-containers", "Pi container status unavailable"); unknown.push("pi-container:"); }
    else if ((h.snapshotAge ?? 0) > STALE) { add("pi-containers", `Pi container snapshot is ${h.snapshotAge}s old`); unknown.push("pi-container:"); }
    else for (const c of h.containers) if (c.state !== "running") add(`pi-container:${c.name}`, `Container ${c.name} is ${c.state}`);
    for (const x of h.hosts ?? []) if (!x.up) add(`host:${x.name}`, `Host ${x.name} is down`);
  }
  if (!v) unknown.push("vps");
  else if (v.configured) {
    if (!v.reachable) { add("vps", `VPS unreachable${v.error ? `: ${v.error}` : ""}`); unknown.push("vps-"); }
    else if (!v.containers || (v.snapshotAge ?? 0) > STALE) {
      add("vps-snapshot", v.containers ? `VPS container snapshot is ${v.snapshotAge}s old` : "VPS container snapshot missing");
      unknown.push("vps-container:", "vps-incomplete:");
    } else {
      for (const c of v.containers) if (c.state !== "running") add(`vps-container:${c.owner}/${c.name}`, `VPS container ${c.name} (${c.owner}) is ${c.state}`);
      for (const o of v.incomplete ?? []) { add(`vps-incomplete:${o}`, `VPS: cannot list ${o}'s containers`); unknown.push(`vps-container:${o}/`); }
    }
  }
  if (!ha) unknown.push("ha");
  else if (ha.configured) {
    if (!ha.reachable) { add("ha", "Home Assistant unreachable"); unknown.push("ha-"); }
    else for (const s of ha.sensors) if (s.state === "unavailable") add(`ha-sensor:${s.id}`, `${s.name} is unavailable`);
  }
  return { issues, unknown };
}

/** NTFY_URL must be http(s)://host/topic, nothing else; with a token, https only (it is a bearer secret). */
function topicUrl(cfg: AlertsCfg): string | null {
  try {
    const u = new URL(cfg.url ?? "");
    const ok = (u.protocol === "https:" || (u.protocol === "http:" && !cfg.token)) && !u.username && !u.password &&
      !u.search && !u.hash && /^\/[A-Za-z0-9_-]{1,64}$/.test(u.pathname) && cfg.url === u.href;
    return ok ? u.href : null;
  } catch { return null; }
}

export function createAlerts(cfg: AlertsCfg, kv: Kv, check: () => Promise<Observation>, warn: (m: string) => void = () => {}) {
  const url = topicUrl(cfg);
  if (cfg.url && !url) warn("NTFY_URL: must be http(s)://<server>/<topic> (https when NTFY_TOKEN is set), alerts disabled");
  let pending = new Set<string>(); // seen on the last check, not alerted yet
  let running: Promise<void> | undefined;
  let lastErr = "";

  async function send(title: string, msg: string, tags: string, priority: string) {
    let r: Response;
    try {
      r = await fetch(url!, {
        method: "POST", body: msg, redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Title: title, Tags: tags, Priority: priority, ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
      });
    } catch {
      throw new AppError(502, "ntfy", "Cannot reach the ntfy server.");
    }
    if (!r.ok) throw new AppError(502, "ntfy", `ntfy returned ${r.status}${r.status === 403 || r.status === 401 ? " (check NTFY_TOKEN)" : ""}.`);
  }

  async function run() {
    const { issues, unknown } = await check();
    const isUnknown = (k: string) => unknown.some((p) => k.startsWith(p));
    const active: Record<string, string> = kv.get("alerts") ?? {}; // alerted and not resolved; survives restarts
    const seen = new Set(issues.map((i) => i.key));
    // Each notification on its own: one failing send must not hold back the others. State is saved after each
    // delivered one, so a restart mid-batch never resends it. Delivery is at-least-once (a lost reply can repeat).
    const deliver = async (title: string, msg: string, tags: string, prio: string, apply: () => void) => {
      try { await send(title, msg, tags, prio); apply(); kv.set("alerts", active); lastErr = ""; }
      catch (e) { const m = e instanceof Error ? e.message : String(e); if (m !== lastErr) warn(`alerts: ${m}`); lastErr = m; }
    };
    for (const i of issues)
      if (!active[i.key] && pending.has(i.key)) await deliver("Nexus: problem", i.msg, "warning", "high", () => { active[i.key] = i.msg; });
    for (const [k, msg] of Object.entries(active))
      if (!seen.has(k) && !isUnknown(k)) await deliver("Nexus: resolved", `Cleared: ${msg}`, "white_check_mark", "default", () => { delete active[k]; });
    // A streak needs consecutive observed checks: unknown samples break it.
    pending = new Set([...seen].filter((k) => !active[k] && !isUnknown(k)));
  }

  return {
    configured: !!url,
    test: async () => {
      if (!url) throw new AppError(503, "not_configured", "Alerts are not configured (NTFY_URL).");
      await send("Nexus", "Test alert: Nexus can reach your phone.", "bell", "default");
    },
    /** One check; a no-op while the previous one is still running (slow ssh or ntfy). */
    tick(): Promise<void> {
      if (!url || running) return running ?? Promise.resolve();
      running = run().finally(() => { running = undefined; });
      return running;
    },
    /** Resolves when no check is running (shutdown waits for it). */
    idle: () => running?.catch(() => {}) ?? Promise.resolve(),
  };
}

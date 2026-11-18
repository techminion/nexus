import { AppError } from "./spotify.ts";

export interface HaCfg { url?: string; token?: string; sensors?: string; announceEntity?: string }
const NOTIFY_ENTITY = /^notify\.[a-z0-9_]+$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

export function createHomeAssistant(cfg: HaCfg, warn: (m: string) => void = () => {}) {
  const url = /^https?:\/\/[^/?#]+$/.test(cfg.url?.replace(/\/$/, "") ?? "") ? cfg.url!.replace(/\/$/, "") : (cfg.url && warn("HA_URL: must be an http(s) origin, HA disabled"), undefined);
  const sensors = (cfg.sensors ?? "").split(",").map((s) => s.trim()).filter((s) => s && (ENTITY.test(s) || (warn(`HA_SENSORS: ignoring "${s}"`), false)));
  const entity = cfg.announceEntity && (NOTIFY_ENTITY.test(cfg.announceEntity) || (warn("HA_ANNOUNCE_ENTITY: must be notify.<name>, announce disabled"), false)) ? cfg.announceEntity : undefined;
  const configured = !!(url && cfg.token);
  let cache: { at: number; value: unknown } | undefined;
  let polling: Promise<unknown> | undefined;

  const call = async (method: string, path: string, body?: unknown) => {
    let r: Response;
    try {
      r = await fetch(`${url}${path}`, {
        method, signal: AbortSignal.timeout(5000), redirect: "error", // never forward the token or body elsewhere
        headers: { authorization: `Bearer ${cfg.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new AppError(502, "network", "Cannot reach Home Assistant.");
    }
    if (r.status === 401 || r.status === 403) throw new AppError(502, "ha_auth", "Home Assistant rejected the token (check HA_TOKEN).");
    return r;
  };

  return {
    announceConfigured: configured && !!entity,
    async status() {
      if (!configured) return { configured: false, reachable: false, error: null, sensors: [] };
      if (cache && Date.now() - cache.at < 10_000) return cache.value;
      return (polling ??= poll().finally(() => (polling = undefined)));
    },
    async announce(message: string) {
      if (!configured || !entity) throw new AppError(503, "not_configured", "Announcements are not configured on the server (HA_URL / HA_TOKEN / HA_ANNOUNCE_ENTITY).");
      // Entity-based notify (HA 2024.5+), as exposed by the built-in Alexa Devices integration.
      const r = await call("POST", "/api/services/notify/send_message", { entity_id: entity, message });
      if (!r.ok) throw new AppError(502, "ha", `Home Assistant returned ${r.status} for the announcement.`);
    },
  };

  // One shared, parallel poll; with no sensors configured, ping /api/ so "reachable" is real.
  async function poll() {
    let value;
    try {
      const ping = await call("GET", "/api/");
      if (!ping.ok) throw new AppError(502, "ha", `Home Assistant returned ${ping.status}.`);
      const got = await Promise.all(sensors.map(async (id) => {
        const r = await call("GET", `/api/states/${id}`);
        if (r.status === 404) return null;
        if (!r.ok) throw new AppError(502, "ha", `Home Assistant returned ${r.status}.`);
        const j = (await r.json()) as { state?: unknown; attributes?: { friendly_name?: unknown; unit_of_measurement?: unknown } };
        return { id, name: String(j.attributes?.friendly_name ?? id), state: String(j.state ?? ""), unit: j.attributes?.unit_of_measurement ? String(j.attributes.unit_of_measurement) : null };
      }));
      value = { configured: true, reachable: true, error: null, sensors: got.filter((x) => x) };
    } catch (e) {
      value = { configured: true, reachable: false, error: e instanceof AppError ? e.message : "Home Assistant returned an unexpected response.", sensors: [] };
    }
    cache = { at: Date.now(), value };
    return value;
  }
}

import { AppError } from "./spotify.ts";

export interface HaCfg { url?: string; token?: string; sensors?: string; announceService?: string }
const SERVICE = /^[a-z_]+\.[a-z0-9_]+$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;

export function createHomeAssistant(cfg: HaCfg, warn: (m: string) => void = () => {}) {
  const url = cfg.url?.replace(/\/$/, "");
  const sensors = (cfg.sensors ?? "").split(",").map((s) => s.trim()).filter((s) => s && (ENTITY.test(s) || (warn(`HA_SENSORS: ignoring "${s}"`), false)));
  const service = cfg.announceService && (SERVICE.test(cfg.announceService) || (warn("HA_ANNOUNCE_SERVICE: invalid format, announce disabled"), false)) ? cfg.announceService : undefined;
  const configured = !!(url && cfg.token);
  let cache: { at: number; value: unknown } | undefined;

  const call = async (method: string, path: string, body?: unknown) => {
    let r: Response;
    try {
      r = await fetch(`${url}${path}`, {
        method, signal: AbortSignal.timeout(5000),
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
    announceConfigured: configured && !!service,
    async status() {
      if (!configured) return { configured: false, reachable: false, error: null, sensors: [] };
      if (cache && Date.now() - cache.at < 10_000) return cache.value;
      let value;
      try {
        const out = [];
        for (const id of sensors) {
          const r = await call("GET", `/api/states/${id}`);
          if (r.status === 404) continue;
          if (!r.ok) throw new AppError(502, "ha", `Home Assistant returned ${r.status}.`);
          const j = (await r.json()) as { state?: unknown; attributes?: { friendly_name?: unknown; unit_of_measurement?: unknown } };
          out.push({ id, name: String(j.attributes?.friendly_name ?? id), state: String(j.state ?? ""), unit: j.attributes?.unit_of_measurement ? String(j.attributes.unit_of_measurement) : null });
        }
        value = { configured: true, reachable: true, error: null, sensors: out };
      } catch (e) {
        value = { configured: true, reachable: false, error: e instanceof AppError ? e.message : "Home Assistant returned an unexpected response.", sensors: [] };
      }
      cache = { at: Date.now(), value };
      return value;
    },
    async announce(message: string) {
      if (!configured || !service) throw new AppError(503, "not_configured", "Announcements are not configured on the server (HA_URL / HA_TOKEN / HA_ANNOUNCE_SERVICE).");
      const [domain, name] = service.split(".");
      const r = await call("POST", `/api/services/${domain}/${name}`, { message, data: { type: "announce" } });
      if (!r.ok) throw new AppError(502, "ha", `Home Assistant returned ${r.status} for the announcement.`);
    },
  };
}

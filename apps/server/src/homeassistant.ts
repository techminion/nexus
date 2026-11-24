import { AppError } from "./spotify.ts";

export interface HaCfg { url?: string; token?: string; sensors?: string; announceEntity?: string; voiceEntity?: string }
const NOTIFY_ENTITY = /^notify\.[a-z0-9_]+$/;
const ENTITY = /^[a-z_]+\.[a-z0-9_]+$/;
type Day = { date: string; condition: string; high: number | null; low: number | null; rain: number | null };
const EVENT_ENTITY = /^event\.[a-z0-9_]+$/;

export function createHomeAssistant(cfg: HaCfg, warn: (m: string) => void = () => {}) {
  const url = /^https?:\/\/[^/?#]+$/.test(cfg.url?.replace(/\/$/, "") ?? "") ? cfg.url!.replace(/\/$/, "") : (cfg.url && warn("HA_URL: must be an http(s) origin, HA disabled"), undefined);
  const sensors = (cfg.sensors ?? "").split(",").map((s) => s.trim()).filter((s) => s && (ENTITY.test(s) || (warn(`HA_SENSORS: ignoring "${s}"`), false)));
  const entity = cfg.announceEntity && (NOTIFY_ENTITY.test(cfg.announceEntity) || (warn("HA_ANNOUNCE_ENTITY: must be notify.<name>, announce disabled"), false)) ? cfg.announceEntity : undefined;
  const voice = cfg.voiceEntity && (EVENT_ENTITY.test(cfg.voiceEntity) || (warn("HA_VOICE_ENTITY: must be event.<name>, voice commands disabled"), false)) ? cfg.voiceEntity : undefined;
  const configured = !!(url && cfg.token);
  let cache: { at: number; value: unknown } | undefined;
  let polling: Promise<unknown> | undefined;
  const forecasts = new Map<string, { at: number; days: Day[] }>();

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
    voiceConfigured: configured && !!voice,
    /**
     * Calls onCommand with each new Echo voice command, live over HA's websocket (state_changed of the voice event
     * entity). Reconnects with backoff; returns a function that stops it.
     */
    watchVoice(onCommand: (text: string) => void) {
      if (!configured || !voice) return () => {};
      let ws: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined, stopped = false, delay = 1000, lastErr = "";
      const fail = (m: string) => { if (m !== lastErr) warn(`voice commands: ${m}`); lastErr = m; };
      const open = () => {
        const sock = (ws = new WebSocket(`${url!.replace(/^http/, "ws")}/api/websocket`));
        sock.onmessage = (m) => {
          let d;
          try { d = JSON.parse(String(m.data)); } catch { return; }
          if (d?.type === "auth_required") sock.send(JSON.stringify({ type: "auth", access_token: cfg.token }));
          else if (d?.type === "auth_ok") sock.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
          else if (d?.type === "auth_invalid") fail("Home Assistant rejected the token (check HA_TOKEN).");
          else if (d?.type === "result" && d.id === 1) d.success ? ((delay = 1000), (lastErr = "")) : fail("Home Assistant refused the event subscription.");
          else if (d?.type === "event" && d.event?.data?.entity_id === voice) {
            const s = d.event.data.new_state;
            // An event entity's state is the time of its last event. Only act on fresh ones: HA restarts and
            // reconnects re-announce the restored old state, which must never replay a command.
            const at = Date.parse(s?.state);
            if (typeof s?.attributes?.voice_command === "string" && Math.abs(Date.now() - at) < 30_000) onCommand(s.attributes.voice_command);
          }
        };
        sock.onerror = () => {}; // onclose follows
        sock.onclose = () => {
          if (stopped) return;
          fail("lost the Home Assistant connection, reconnecting");
          retry = setTimeout(open, delay);
          delay = Math.min(delay * 2, 60_000);
        };
      };
      open();
      return () => { stopped = true; clearTimeout(retry); ws?.close(); };
    },
    async status() {
      if (!configured) return { configured: false, reachable: false, error: null, sensors: [], voice: false };
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

  // Daily forecast (HA 2024.3+ only gives it through a service call). Refreshed every 30 min; a failure keeps
  // the last one, so it never makes Home Assistant look down.
  async function forecast(id: string): Promise<Day[]> {
    const c = forecasts.get(id);
    if (c && Date.now() - c.at < 30 * 60_000) return c.days;
    try {
      const r = await call("POST", "/api/services/weather/get_forecasts?return_response", { entity_id: id, type: "daily" });
      if (!r.ok) throw new Error(String(r.status));
      const list = ((await r.json()) as { service_response?: Record<string, { forecast?: unknown }> }).service_response?.[id]?.forecast;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      const days = (Array.isArray(list) ? list : []).slice(0, 7).flatMap((f: Record<string, unknown>) =>
        typeof f?.datetime === "string" && !Number.isNaN(Date.parse(f.datetime))
          ? [{ date: f.datetime, condition: String(f.condition ?? ""), high: num(f.temperature), low: num(f.templow), rain: num(f.precipitation) }] : []);
      forecasts.set(id, { at: Date.now(), days });
      return days;
    } catch {
      forecasts.set(id, { at: Date.now() - 25 * 60_000, days: c?.days ?? [] }); // retry in 5 min
      return c?.days ?? [];
    }
  }

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
        const j = (await r.json()) as { state?: unknown; attributes?: { friendly_name?: unknown; unit_of_measurement?: unknown; temperature?: unknown; temperature_unit?: unknown } };
        const a = j.attributes ?? {};
        const name = String(a.friendly_name ?? id);
        // Weather entities keep the condition ("sunny") as state and the temperature as an attribute.
        if (id.startsWith("weather.")) return { id, name, state: String(a.temperature ?? ""), unit: a.temperature_unit ? String(a.temperature_unit) : null, condition: String(j.state ?? ""), forecast: await forecast(id) };
        return { id, name, state: String(j.state ?? ""), unit: a.unit_of_measurement ? String(a.unit_of_measurement) : null };
      }));
      value = { configured: true, reachable: true, error: null, sensors: got.filter((x) => x), voice: !!voice };
    } catch (e) {
      value = { configured: true, reachable: false, error: e instanceof AppError ? e.message : "Home Assistant returned an unexpected response.", sensors: [], voice: !!voice };
    }
    cache = { at: Date.now(), value };
    return value;
  }
}

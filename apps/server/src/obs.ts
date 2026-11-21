import { createHash } from "node:crypto";
import { AppError } from "./spotify.ts";

// OBS Studio on crashmetheus, over obs-websocket v5. Each call opens a short connection
// (hello -> identify -> requests -> close), so there is no long-lived socket to babysit.
export interface ObsCfg { url?: string; password?: string }
type Req = [type: string, data?: Record<string, unknown>];

const sha = (s: string) => createHash("sha256").update(s).digest("base64");
/** obs-websocket v5 auth string: base64(sha256(base64(sha256(password + salt)) + challenge)). */
export const obsAuth = (password: string, salt: string, challenge: string) => sha(sha(password + salt) + challenge);

export function createObs(cfg: ObsCfg, warn: (m: string) => void = () => {}) {
  const okUrl = (u: string) => { try { const x = new URL(u); return /^wss?:$/.test(x.protocol) && /^\/?$/.test(x.pathname) && !x.search && !x.hash; } catch { return false; } };
  const url = cfg.url && okUrl(cfg.url) ? cfg.url : (cfg.url && warn("OBS_URL: must be ws://host:port, OBS disabled"), undefined);

  function call(reqs: Req[], timeoutMs = 4000): Promise<Record<string, unknown>[]> {
    if (!url) return Promise.reject(new AppError(503, "obs_not_configured", "OBS is not configured."));
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { return reject(new AppError(502, "obs_unreachable", "Cannot reach OBS.")); }
      const out: Record<string, unknown>[] = [];
      let settled = false;
      const done = (e?: Error) => { if (settled) return; settled = true; clearTimeout(t); ws.close(); e ? reject(e) : resolve(out); };
      const t = setTimeout(() => done(new AppError(502, "obs_unreachable", "OBS did not answer.")), timeoutMs);
      ws.onerror = () => done(new AppError(502, "obs_unreachable", "Cannot reach OBS."));
      ws.onclose = (ev) => done(ev.code === 4009 ? new AppError(502, "obs_auth", "OBS rejected the password.") : new AppError(502, "obs_unreachable", "OBS closed the connection."));
      ws.onmessage = (ev) => {
        let m: { op: number; d: Record<string, any> };
        try { m = JSON.parse(String(ev.data)); } catch { m = { op: -1, d: {} }; }
        if (typeof m !== "object" || m === null || typeof m.d !== "object" || m.d === null) return done(new AppError(502, "obs_bad_reply", "Bad reply from OBS."));
        if (m.op === 0) {
          const a = m.d.authentication;
          if (a && !cfg.password) return done(new AppError(502, "obs_auth", "OBS needs a password (OBS_PASSWORD)."));
          ws.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, eventSubscriptions: 0, ...(a ? { authentication: obsAuth(cfg.password!, a.salt, a.challenge) } : {}) } }));
        } else if (m.op === 2) {
          reqs.forEach(([requestType, requestData], i) => ws.send(JSON.stringify({ op: 6, d: { requestType, requestId: String(i), requestData } })));
          if (!reqs.length) done();
        } else if (m.op === 7) {
          const i = Number(m.d.requestId);
          if (!Number.isInteger(i) || i < 0 || i >= reqs.length || out[i] || m.d.requestType !== reqs[i][0]) return done(new AppError(502, "obs_bad_reply", "Bad reply from OBS."));
          const st = m.d.requestStatus;
          if (!st?.result) return done(new AppError(400, "obs_request_failed", `OBS: ${String(st?.comment ?? m.d.requestType).slice(0, 200)}`));
          out[i] = typeof m.d.responseData === "object" && m.d.responseData !== null ? m.d.responseData : {};
          if (out.filter(Boolean).length === reqs.length) done();
        }
      };
    });
  }

  let cache: { at: number; value: unknown } | undefined;
  let gen = 0; // bumped by every change; a status read that overlapped one is not cached
  const change = async (reqs: Req[]) => { gen++; cache = undefined; try { await call(reqs); } finally { gen++; cache = undefined; } };
  return {
    async status() {
      if (!url) return { configured: false };
      if (cache && Date.now() - cache.at < 2000) return cache.value;
      const g = gen;
      let value;
      try {
        const [scenes, rec, stream] = await call([["GetSceneList"], ["GetRecordStatus"], ["GetStreamStatus"]]);
        const list = Array.isArray(scenes.scenes) ? (scenes.scenes as { sceneName?: unknown }[]) : [];
        value = {
          configured: true, reachable: true,
          // OBS lists scenes bottom-up; show them in the order the OBS window does.
          scenes: list.map((s) => s.sceneName).filter((n): n is string => typeof n === "string").reverse(),
          scene: typeof scenes.currentProgramSceneName === "string" ? scenes.currentProgramSceneName : null,
          recording: rec.outputActive === true, recordTime: typeof rec.outputTimecode === "string" ? rec.outputTimecode : null,
          streaming: stream.outputActive === true,
        };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        value = { configured: true, reachable: false, error: e.message };
      }
      if (g === gen) cache = { at: Date.now(), value };
      return value;
    },
    setScene: (scene: string) => change([["SetCurrentProgramScene", { sceneName: scene }]]),
    record: (on: boolean) => change([[on ? "StartRecord" : "StopRecord"]]),
  };
}

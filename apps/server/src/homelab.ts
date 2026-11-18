import { readFile, stat, statfs } from "node:fs/promises";
import { connect } from "node:net";

export interface HomelabCfg { dataDir: string; containersFile?: string; hosts?: string }
export interface Host { name: string; host: string; port: number }

// Entries are `name=host:port`; malformed ones are skipped and reported through warn.
export function parseHosts(raw: string | undefined, warn: (m: string) => void = () => {}): Host[] {
  const out: Host[] = [];
  for (const e of (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([\w.-]{1,40})=([\w.-]+):(\d{1,5})$/.exec(e);
    if (m && +m[3] >= 1 && +m[3] <= 65535) out.push({ name: m[1], host: m[2], port: +m[3] });
    else warn(`NEXUS_HOSTS: ignoring malformed entry "${e}"`);
  }
  return out;
}

const read = (p: string) => readFile(p, "utf8").catch(() => null);
const num = (v: number) => (Number.isFinite(v) ? v : null);
const cpuTimes = async () => {
  const f = (await read("/proc/stat"))?.split("\n")[0].split(/\s+/).slice(1, 9).map(Number); // first 8 only: guest time is already counted in user/nice
  return f && f.length > 4 ? { idle: f[3] + (f[4] || 0), total: f.reduce((a, b) => a + b, 0) } : null;
};

async function pi(dataDir: string) {
  const a = await cpuTimes();
  await new Promise((r) => setTimeout(r, 250));
  const b = await cpuTimes();
  const cpuPercent = a && b && b.total > a.total ? Math.round((1 - (b.idle - a.idle) / (b.total - a.total)) * 1000) / 10 : null;
  const mi = await read("/proc/meminfo");
  const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(mi ?? "")?.[1]);
  const total = kb("MemTotal"), avail = kb("MemAvailable");
  const mem = Number.isFinite(total) && Number.isFinite(avail) ? { totalMb: Math.round(total / 1024), usedMb: Math.round((total - avail) / 1024) } : null;
  const disk = await statfs(dataDir).then((s) => ({ totalGb: Math.round((s.blocks * s.bsize) / 1e8) / 10, usedGb: Math.round(((s.blocks - s.bfree) * s.bsize) / 1e8) / 10 })).catch(() => null);
  const t = await read("/sys/class/thermal/thermal_zone0/temp");
  const up = await read("/proc/uptime");
  const la = (await read("/proc/loadavg"))?.split(" ").slice(0, 3).map(Number);
  return {
    cpuPercent, mem, disk,
    tempC: t === null ? null : num(Math.round(Number(t) / 100) / 10),
    uptimeSec: up === null ? null : num(Math.floor(Number(up.split(" ")[0]))),
    load: la && la.length === 3 && la.every(Number.isFinite) ? la : null,
  };
}

async function containers(file: string) {
  try {
    const list = JSON.parse((await readFile(file, "utf8")) || "null");
    if (!Array.isArray(list)) throw new Error("not an array");
    const snapshotAge = Math.max(0, Math.round((Date.now() - (await stat(file)).mtimeMs) / 1000));
    // Allowlisted fields only: never forward labels, mounts or env.
    return { containers: list.map((c) => ({ name: String(c?.Names?.[0] ?? c?.Names ?? ""), image: String(c?.Image ?? ""), state: String(c?.State ?? ""), status: String(c?.Status ?? "") })), snapshotAge, error: null };
  } catch (e) {
    return { containers: null, snapshotAge: null, error: `Container snapshot unavailable (${(e as NodeJS.ErrnoException).code === "ENOENT" ? "file missing" : "unreadable"}).` };
  }
}

const probe = (h: Host) =>
  new Promise<{ name: string; target: string; up: boolean; latencyMs: number | null }>((resolve) => {
    const t0 = Date.now();
    const s = connect({ host: h.host, port: h.port, timeout: 2000 });
    const done = (up: boolean) => { s.destroy(); resolve({ name: h.name, target: `${h.host}:${h.port}`, up, latencyMs: up ? Date.now() - t0 : null }); };
    s.once("connect", () => done(true)).once("timeout", () => done(false)).once("error", () => done(false));
  });

export function createHomelab(cfg: HomelabCfg, warn: (m: string) => void) {
  const hosts = parseHosts(cfg.hosts, warn);
  const file = cfg.containersFile ?? "/run/nexus/containers.json";
  let cache: { at: number; value: Promise<unknown> } | undefined;
  return {
    get() {
      if (!cache || Date.now() - cache.at > 5000) {
        const value = Promise.all([pi(cfg.dataDir), containers(file), Promise.all(hosts.map(probe))])
          .then(([p, c, h]) => ({ pi: p, ...c, hosts: h }));
        cache = { at: Date.now(), value };
        value.catch(() => { cache = undefined; });
      }
      return cache.value;
    },
  };
}

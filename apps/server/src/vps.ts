import { sshRun, sshTargetOk, type SshCfg } from "./ssh.ts";

// The VPS, over ssh as a read-only account whose key is forced to deploy/vps/nexus-vps.sh (status only).
export type VpsCfg = SshCfg;

const num = (s: string | undefined) => (s !== undefined && s !== "" && Number.isFinite(Number(s)) ? Number(s) : null);
const txt = (s: string | undefined) => String(s ?? "").slice(0, 200);

/**
 * Parses nexus-vps.sh output: tab-separated `key value...` lines with exact field counts (others are ignored).
 * `c` lines are containers (owner name image state status); `e owner` means that owner's podman failed.
 */
export function parseVps(out: string) {
  const r = {
    cpuPercent: null as number | null, mem: null as { totalMb: number; usedMb: number } | null,
    disk: null as { totalGb: number; usedGb: number } | null, load: null as number[] | null, uptimeSec: null as number | null,
    snapshotAge: null as number | null, containers: null as { owner: string; name: string; image: string; state: string; status: string }[] | null,
    incomplete: [] as string[],
  };
  for (const line of out.split("\n")) {
    const [k, ...f] = line.split("\t");
    const n = f.map(num);
    const ok = (len: number) => f.length === len && n.every((x) => x !== null && x >= 0);
    if (k === "cpu" && ok(1)) r.cpuPercent = Math.min(100, Math.round(n[0]! * 10) / 10);
    else if (k === "mem" && ok(2) && n[0]! > 0) r.mem = { totalMb: Math.round(n[0]! / 1024), usedMb: Math.round((n[0]! - n[1]!) / 1024) }; // KiB -> MiB, as for the Pi
    else if (k === "disk" && ok(2) && n[0]! > 0) r.disk = { totalGb: Math.round((n[0]! * 1024) / 1e8) / 10, usedGb: Math.round((n[1]! * 1024) / 1e8) / 10 }; // KiB -> GB
    else if (k === "load" && ok(3)) r.load = n as number[];
    else if (k === "uptime" && ok(1)) r.uptimeSec = Math.floor(n[0]!);
    else if (k === "snapshot" && ok(1) && !r.containers) { r.snapshotAge = n[0]!; r.containers = []; }
    else if (k === "e" && f.length === 1 && r.containers) r.incomplete.push(txt(f[0]));
    // shortcut: shows the first 200 containers; paginate if a VPS ever runs more.
    else if (k === "c" && f.length === 5 && r.containers && r.containers.length < 200)
      r.containers.push({ owner: txt(f[0]), name: txt(f[1]), image: txt(f[2]), state: txt(f[3]), status: txt(f[4]) });
  }
  return r;
}

export function createVps(cfg: VpsCfg, warn: (m: string) => void = () => {}) {
  const configured = sshTargetOk(cfg);
  if ((cfg.host || cfg.user) && !configured) warn("VPS_HOST / VPS_USER: invalid, VPS companion disabled");
  const dir = cfg.keyDir || "/etc/nexus/vps";
  let cache: { at: number; value: Promise<unknown> } | undefined;
  return {
    async status() {
      if (!configured) return { configured: false };
      // Each read is one ssh login on the VPS; 20 s cache so several open screens share it.
      if (!cache || Date.now() - cache.at > 20_000) {
        const value = sshRun(cfg, dir, "status", "vps_failed", "Cannot reach the VPS.").then(
          (out) => ({ configured: true, reachable: true, ...parseVps(out) }),
          (e: Error) => ({ configured: true, reachable: false, error: e.message }),
        );
        cache = { at: Date.now(), value };
      }
      return cache.value;
    },
  };
}

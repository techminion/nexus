import { MAC_COMMANDS, macArgError } from "./actions.ts";
import { AppError } from "./spotify.ts";
import { sshRun, sshTargetOk, type SshCfg } from "./ssh.ts";

// The Mac, over ssh. Its key is forced to deploy/mac/nexus-mac.sh, so the "command" below is just a verb + arg.
export type MacCfg = SshCfg;
export { MAC_COMMANDS };

const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : []);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);

export function createMac(cfg: MacCfg, warn: (m: string) => void = () => {}) {
  const configured = sshTargetOk(cfg);
  if ((cfg.host || cfg.user) && !configured) warn("MAC_HOST / MAC_USER: invalid, Mac companion disabled");
  const dir = cfg.keyDir || "/etc/nexus/mac";

  const ssh = (cmd: string) => sshRun(cfg, dir, cmd, "mac_failed", "Cannot reach the Mac.");

  let cache: { at: number; value: Promise<unknown> } | undefined;
  const fetchStatus = async () => {
    try {
      const j = JSON.parse(await ssh("status"));
      return { configured: true, reachable: true, volume: num(j.volume), muted: bool(j.muted), battery: num(j.battery), ac: j.ac === true, uptime: num(j.uptime), apps: strs(j.apps), shortcuts: strs(j.shortcuts) };
    } catch { return { configured: true, reachable: false }; }
  };
  return {
    configured,
    async status() {
      if (!configured) return { configured: false };
      if (!cache || Date.now() - cache.at > 5000) {
        const value = fetchStatus();
        cache = { at: Date.now(), value };
        value.catch(() => { cache = undefined; });
      }
      return cache.value;
    },
    async run(command: string, arg?: unknown) {
      if (!(MAC_COMMANDS as readonly string[]).includes(command)) throw new AppError(400, "bad_mac_command", "Unknown Mac command.");
      const e = macArgError(command, arg);
      if (e) throw new AppError(400, "bad_mac_arg", e);
      if (!configured) throw new AppError(503, "mac_not_configured", "The Mac is not configured.");
      await ssh(arg === undefined ? command : `${command} ${arg}`);
      cache = undefined;
    },
  };
}

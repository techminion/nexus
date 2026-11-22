import { execFile } from "node:child_process";
import { AppError } from "./spotify.ts";

// A companion host over ssh: its authorized_keys forces our key to one script, so `cmd` is only a request to it.
export interface SshCfg { host?: string; user?: string; keyDir?: string }

export const sshTargetOk = (c: SshCfg) =>
  !!c.host && /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i.test(c.host) && !!c.user && /^[a-z_][a-z0-9_.-]{0,31}$/i.test(c.user);

/** One ssh call with only the key in keyDir and the host key pinned in keyDir/known_hosts; no user ssh config or agent. */
export function sshRun(c: SshCfg, keyDir: string, cmd: string, code: string, unreachable: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", ["-i", `${keyDir}/id_ed25519`, "-F", "/dev/null", "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "GlobalKnownHostsFile=/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${keyDir}/known_hosts`, "-o", "LogLevel=ERROR", "-T", `${c.user}@${c.host}`, "--", cmd],
      { timeout: 10_000, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const line = String(stderr).trim().split("\n")[0].trim().slice(0, 200);
        reject(new AppError(502, code, line || unreachable));
      });
  });
}

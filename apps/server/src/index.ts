import { fileURLToPath } from "node:url";
import { buildApp } from "./app.ts";

const { NEXUS_PASSWORD, SESSION_SECRET } = process.env;
if (!NEXUS_PASSWORD || !SESSION_SECRET) {
  console.error("NEXUS_PASSWORD and SESSION_SECRET are required.");
  process.exit(1);
}
const app = await buildApp({
  password: NEXUS_PASSWORD,
  secret: SESSION_SECRET,
  dataDir: process.env.NEXUS_DATA_DIR ?? "./data",
  clientId: process.env.SPOTIFY_CLIENT_ID,
  publicUrl: process.env.PUBLIC_URL?.replace(/\/$/, ""),
  homelab: { containersFile: process.env.NEXUS_CONTAINERS_FILE, hosts: process.env.NEXUS_HOSTS },
  studio: { api: process.env.STUDIO_API, cameras: process.env.STUDIO_CAMERAS },
  obs: { url: process.env.OBS_URL, password: process.env.OBS_PASSWORD },
  mac: { host: process.env.MAC_HOST, user: process.env.MAC_USER, keyDir: process.env.MAC_KEY_DIR },
  vps: { host: process.env.VPS_HOST, user: process.env.VPS_USER, keyDir: process.env.VPS_KEY_DIR },
  alerts: { url: process.env.NTFY_URL, token: process.env.NTFY_TOKEN },
  ha: { url: process.env.HA_URL, token: process.env.HA_TOKEN, sensors: process.env.HA_SENSORS, announceEntity: process.env.HA_ANNOUNCE_ENTITY, voiceEntity: process.env.HA_VOICE_ENTITY },
  // dev: ../../web/dist relative to src; prod image sets WEB_DIST
  webDist: process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

// As PID 1 in the container, Node ignores SIGTERM unless it handles it (podman then waits 10 s and kills it).
// Close cleanly instead (onClose stops the voice watcher and lets a running alert check finish); give up after 5 s.
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(1), 5000).unref();
  app.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

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
  ha: { url: process.env.HA_URL, token: process.env.HA_TOKEN, sensors: process.env.HA_SENSORS, announceService: process.env.HA_ANNOUNCE_SERVICE },
  // dev: ../../web/dist relative to src; prod image sets WEB_DIST
  webDist: process.env.WEB_DIST ?? fileURLToPath(new URL("../../web/dist", import.meta.url)),
});
await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });

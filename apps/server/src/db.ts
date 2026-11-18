import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Kv {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  del(key: string): void;
}

export function openKv(dir: string): Kv {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dir === ":memory:" ? dir : join(dir, "nexus.db"));
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const g = db.prepare("SELECT value FROM kv WHERE key = ?");
  const s = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const d = db.prepare("DELETE FROM kv WHERE key = ?");
  return {
    get: <T>(k: string) => {
      const r = g.get(k) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as T) : undefined;
    },
    set: (k, v) => void s.run(k, JSON.stringify(v)),
    del: (k) => void d.run(k),
  };
}

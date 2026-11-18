import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtTime, useNow } from "./App";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useSettings, useSpotify, type Action, type Device, type Module, type Playback, type Settings, type Shortcut, type SpotifyState } from "./api";

const Icon = ({ d, stroke }: { d: string; stroke?: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-6 w-6" fill={stroke ? "none" : "currentColor"} stroke={stroke ? "currentColor" : "none"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d={d} />
  </svg>
);
const I = {
  play: "M8 5v14l11-7z",
  pause: "M6 5h4v14H6zM14 5h4v14h-4z",
  prev: "M6 5h2v14H6zM20 5v14L9 12z",
  next: "M16 5h2v14h-2zM4 5v14l11-7z",
  shuffle: "M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5",
  repeat: "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3",
};

/** Control hook: optimistic patch of the cached playback, rollback + error message on failure. */
function useControl() {
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (v: { method: string; path: string; body?: unknown; patch?: Partial<Playback> }) => api(v.method, v.path, v.body),
    onMutate: async (v) => {
      await qc.cancelQueries({ queryKey: ["spotify"] });
      const prev = qc.getQueryData<SpotifyState>(["spotify"]);
      if (prev?.playback && v.patch) qc.setQueryData<SpotifyState>(["spotify"], { ...prev, playback: { ...prev.playback, ...v.patch } });
      return { prev };
    },
    onError: (_e, _v, c) => c?.prev && qc.setQueryData(["spotify"], c.prev),
    onSettled: () => void setTimeout(() => qc.invalidateQueries({ queryKey: ["spotify"] }), 500),
  });
  return { run: m.mutate, error: m.isError ? m.error.message : null };
}

function Notice({ children }: { children: ReactNode }) {
  return <div role="status" className="card text-dim">{children}</div>;
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Progress({ p, at }: { p: Playback; at: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!p.is_playing) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [p.is_playing]);
  const cur = Math.min(p.duration_ms, p.progress_ms + (p.is_playing ? Date.now() - at : 0));
  return (
    <div className="flex items-center gap-2 text-sm tabular-nums text-dim">
      <span>{mmss(cur)}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
        <div className="h-full bg-accent" style={{ width: `${p.duration_ms ? (cur / p.duration_ms) * 100 : 0}%` }} />
      </div>
      <span>{mmss(p.duration_ms)}</span>
    </div>
  );
}

function NowPlaying({ big }: { big?: boolean }) {
  const q = useSpotify();
  const ctl = useControl();
  const s = q.data;
  if (!s) return <Notice>{q.isError ? "Spotify status unavailable while the server is unreachable." : "Loading..."}</Notice>;
  if (!s.connected) return <Notice>Spotify is not connected. Connect it in Settings.</Notice>;
  if (s.error) return <Notice>{s.error.message}</Notice>;
  const p = s.playback;
  if (!p) return <Notice>Nothing playing. Start Spotify on a device, or pick one in Devices.</Notice>;
  const { run } = ctl;
  const next = { repeat: { off: "context", context: "track", track: "off" } as const }.repeat[p.repeat] ?? "off";
  return (
    <section className="card flex h-full min-h-0 gap-4" aria-label="Now playing">
      {p.art ? <img src={p.art} alt="" className="aspect-square h-auto w-[clamp(6rem,30vh,22rem)] shrink-0 self-center rounded-2xl object-cover" /> : <div className="aspect-square w-[clamp(6rem,30vh,22rem)] shrink-0 self-center rounded-2xl bg-raised" />}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-2">
        <div className="min-w-0">
          <p className={`truncate font-bold ${big ? "text-3xl" : "text-2xl"}`}>{p.track ?? "Unknown"}</p>
          <p className="truncate text-dim">{p.artists.join(", ")}{p.album && !big ? "" : ""}</p>
          {big && <p className="truncate text-sm text-dim">{p.album}{p.device ? ` - ${p.device}` : ""}</p>}
        </div>
        <Progress p={p} at={q.dataUpdatedAt} />
        <div className="flex items-center justify-center gap-3">
          {big && <button className={`btn ${p.shuffle ? "btn-accent" : ""}`} aria-label="Shuffle" aria-pressed={p.shuffle} onClick={() => run({ method: "PUT", path: "/api/spotify/shuffle", body: { state: !p.shuffle }, patch: { shuffle: !p.shuffle } })}><Icon d={I.shuffle} stroke /></button>}
          <button className="btn" aria-label="Previous" onClick={() => run({ method: "PUT", path: "/api/spotify/previous" })}><Icon d={I.prev} /></button>
          <button className="btn btn-accent min-h-14 min-w-16" aria-label={p.is_playing ? "Pause" : "Play"} onClick={() => run({ method: "PUT", path: p.is_playing ? "/api/spotify/pause" : "/api/spotify/play", patch: { is_playing: !p.is_playing } })}><Icon d={p.is_playing ? I.pause : I.play} /></button>
          <button className="btn" aria-label="Next" onClick={() => run({ method: "PUT", path: "/api/spotify/next" })}><Icon d={I.next} /></button>
          {big && <button className={`btn ${p.repeat !== "off" ? "btn-accent" : ""}`} aria-label={`Repeat ${p.repeat}`} onClick={() => run({ method: "PUT", path: "/api/spotify/repeat", body: { state: next }, patch: { repeat: next } })}><Icon d={I.repeat} stroke />{p.repeat === "track" && "1"}</button>}
        </div>
        {big && p.volume !== null && <VolumeSlider volume={p.volume} onSet={(v) => run({ method: "PUT", path: "/api/spotify/volume", body: { percent: v }, patch: { volume: v } })} />}
        {ctl.error && <p role="alert" className="text-sm text-red-400">{ctl.error}</p>}
      </div>
    </section>
  );
}

function VolumeSlider({ volume, onSet }: { volume: number; onSet: (v: number) => void }) {
  const [local, setLocal] = useState<number | null>(null);
  return (
    <label className="flex items-center gap-3 text-sm text-dim">
      Volume
      <input type="range" min={0} max={100} value={local ?? volume} onChange={(e) => setLocal(+e.target.value)} onPointerUp={() => local !== null && (onSet(local), setLocal(null))} onKeyUp={() => local !== null && (onSet(local), setLocal(null))} />
      <span className="w-8 tabular-nums">{local ?? volume}</span>
    </label>
  );
}

function runClient(a: Action, go: (p: string) => void): boolean {
  if (a.type === "url") window.open(a.url, "_blank", "noopener");
  else if (a.type === "module") go(a.module === "dashboard" ? "/" : "/" + a.module);
  else if (a.type === "scene") return a.steps.map((s) => runClient(s, go)).some(Boolean);
  return a.type === "spotify-device";
}

function Shortcuts({ go }: { go: (p: string) => void }) {
  const settings = useSettings().data;
  const [msg, setMsg] = useState("");
  const qc = useQueryClient();
  const run = useMutation({
    mutationFn: (i: number) => api<{ results: { status: string; message?: string }[] }>("POST", `/api/shortcuts/${i}/run`),
    onSuccess: (r) => {
      setMsg(r.results.find((x) => x.status === "error")?.message ?? "");
      qc.invalidateQueries({ queryKey: ["spotify"] });
    },
    onError: (e) => setMsg(e.message),
  });
  if (!settings) return null;
  return (
    <section aria-label="Shortcuts">
      <div className="grid grid-cols-2 gap-2 landscape:max-[1100px]:grid-cols-3 min-[1100px]:grid-cols-3">
        {settings.shortcuts.map((s, i) =>
          s.action.type === "none" ? null : (
            <button key={i} className="btn truncate" onClick={() => { if (runClient(s.action, go)) run.mutate(i); }}>{s.label || `Shortcut ${i + 1}`}</button>
          ),
        )}
      </div>
      {msg && <p role="alert" className="mt-1 text-sm text-red-400">{msg}</p>}
    </section>
  );
}

function ClockCalendar() {
  const now = useNow();
  const h24 = useSettings().data?.clock24h ?? true;
  const y = now.getFullYear(), m = now.getMonth(), today = now.getDate();
  const lead = (new Date(y, m, 1).getDay() + 6) % 7; // Monday-first grid
  const days = new Date(y, m + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  return (
    <section className="card flex flex-col gap-2" aria-label="Clock and calendar">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-4xl font-semibold tabular-nums">{fmtTime(now, h24)}</span>
        <span className="text-dim">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-sm tabular-nums" role="grid" aria-label={now.toLocaleDateString([], { month: "long", year: "numeric" })}>
        {["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].map((d) => <span key={d} className="text-dim">{d}</span>)}
        {cells.map((d, i) => (
          <span key={i} aria-current={d === today ? "date" : undefined} className={`rounded-md py-0.5 ${d === today ? "bg-accent font-bold text-black" : ""}`}>{d ?? ""}</span>
        ))}
      </div>
    </section>
  );
}

export function Timers() {
  const [mode, setMode] = useState<"stopwatch" | "timer">("stopwatch");
  const [running, setRunning] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ref = useRef({ start: 0, base: 0, target: 0 }); // stopwatch: elapsed = base + (now-start); timer: remaining = target - now
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [running]);
  const r = ref.current;
  const value = mode === "stopwatch" ? r.base + (running ? now - r.start : 0) : running ? Math.max(0, r.target - now) : r.base;
  useEffect(() => {
    if (mode === "timer" && running && value === 0) {
      setRunning(false);
      r.base = 0;
      navigator.vibrate?.([300, 150, 300]);
    }
  }, [mode, running, value, r]);
  const toggle = () => {
    const t = Date.now();
    setNow(t);
    if (!running) { r.start = t; r.target = t + r.base; }
    else r.base = mode === "stopwatch" ? r.base + t - r.start : Math.max(0, r.target - t);
    setRunning(!running);
  };
  const reset = () => { r.base = 0; setRunning(false); };
  const set = (m: "stopwatch" | "timer") => { reset(); setMode(m); };
  const addMin = (m: number) => { r.base += m * 60_000; if (running) r.target += m * 60_000; setNow(Date.now()); };
  const done = mode === "timer" && !running && value === 0;
  return (
    <section className="card flex h-full flex-col justify-center gap-6" aria-label="Timer and stopwatch">
      <div className="flex flex-col items-center gap-4">
        <span className={`text-[min(20vw,30vh)] font-light leading-none tabular-nums ${done ? "text-accent" : ""}`}>{mmss(value)}</span>
        <div className="flex gap-1">
          <button className={`btn px-3 text-sm ${mode === "stopwatch" ? "btn-accent" : ""}`} onClick={() => set("stopwatch")}>Stopwatch</button>
          <button className={`btn px-3 text-sm ${mode === "timer" ? "btn-accent" : ""}`} onClick={() => set("timer")}>Timer</button>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-2xl gap-2">
        <button className="btn btn-accent flex-1" onClick={toggle} disabled={mode === "timer" && !running && r.base === 0}>{running ? "Stop" : "Start"}</button>
        {mode === "timer" && [1, 5, 10].map((m) => <button key={m} className="btn px-3" onClick={() => addMin(m)}>+{m}m</button>)}
        <button className="btn" onClick={reset}>Reset</button>
      </div>
    </section>
  );
}

export function Dashboard({ go }: { go: (p: string) => void }) {
  return (
    <div className="grid h-full gap-2 landscape:grid-cols-[3fr_2fr] portrait:grid-rows-[auto_auto_auto]">
      <NowPlaying />
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
        <Shortcuts go={go} />
        <ClockCalendar />
      </div>
    </div>
  );
}

export const Music = () => <div className="h-full"><NowPlaying big /></div>;

export function Devices() {
  const q = useQuery({ queryKey: ["devices"], queryFn: () => api<{ devices: Device[] }>("GET", "/api/spotify/devices"), refetchInterval: 10_000 });
  const sp = useSpotify();
  const qc = useQueryClient();
  const t = useMutation({
    mutationFn: (id: string) => api("PUT", "/api/spotify/transfer", { deviceId: id, play: true }),
    onSettled: () => void setTimeout(() => { qc.invalidateQueries({ queryKey: ["devices"] }); qc.invalidateQueries({ queryKey: ["spotify"] }); }, 700),
  });
  if (sp.data && !sp.data.connected) return <Notice>Spotify is not connected. Connect it in Settings.</Notice>;
  if (q.isError) return <Notice>{q.error.message}</Notice>;
  if (!q.data) return <Notice>Loading...</Notice>;
  return (
    <div className="flex flex-col gap-2">
      {q.data.devices.length === 0 && <Notice>No Spotify Connect devices found. Open Spotify on a device.</Notice>}
      {q.data.devices.map((d) => (
        <button key={d.id} className={`btn justify-between ${d.active ? "border-2 border-accent" : ""}`} onClick={() => t.mutate(d.id)}>
          <span className="truncate">{d.name} <span className="text-dim">({d.type})</span></span>
          {d.active && <span className="text-accent">Active</span>}
        </button>
      ))}
      {t.isError && <p role="alert" className="text-red-400">{t.error.message}</p>}
    </div>
  );
}

const blank = (type: string): Action =>
  type === "url" ? { type, url: "https://" } : type === "module" ? { type, module: "dashboard" } : type === "spotify-device" ? { type, deviceName: "" } : type === "scene" ? { type, steps: [] } : { type: "none" };

function ActionEditor({ a, set, scene }: { a: Action; set: (a: Action) => void; scene: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <select className="input" value={a.type} aria-label="Action type" onChange={(e) => set(blank(e.target.value))}>
        <option value="none">None</option>
        <option value="url">Open URL</option>
        <option value="module">Go to module</option>
        <option value="spotify-device">Play on Spotify device</option>
        {scene && <option value="scene">Scene (several steps)</option>}
      </select>
      {a.type === "url" && <input className="input" aria-label="URL" value={a.url} onChange={(e) => set({ ...a, url: e.target.value })} />}
      {a.type === "module" && (
        <select className="input" aria-label="Module" value={a.module} onChange={(e) => set({ ...a, module: e.target.value as Module })}>
          {["dashboard", "music", "devices", "timer", "settings"].map((m) => <option key={m}>{m}</option>)}
        </select>
      )}
      {a.type === "spotify-device" && <input className="input" aria-label="Device name" placeholder="Device name" value={a.deviceName} onChange={(e) => set({ ...a, deviceName: e.target.value })} />}
      {a.type === "scene" && (
        <div className="flex flex-col gap-2 border-l-2 border-line pl-3">
          {a.steps.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-1"><ActionEditor a={s} scene={false} set={(n) => set({ ...a, steps: a.steps.map((x, j) => (j === i ? n : x)) })} /></div>
              <button className="btn" aria-label="Remove step" onClick={() => set({ ...a, steps: a.steps.filter((_, j) => j !== i) })}>X</button>
            </div>
          ))}
          {a.steps.length < 10 && <button className="btn" onClick={() => set({ ...a, steps: [...a.steps, { type: "none" }] })}>Add step</button>}
        </div>
      )}
    </div>
  );
}

function SettingsForm({ saved }: { saved: Settings }) {
  const qc = useQueryClient();
  const [sc, setSc] = useState<Shortcut[]>(saved.shortcuts);
  const save = useMutation({
    mutationFn: (s: Settings) => api<Settings>("PUT", "/api/settings", s),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Shortcuts</h2>
      {sc.map((s, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-2xl bg-bg p-3">
          <input className="input" aria-label={`Shortcut ${i + 1} label`} maxLength={40} value={s.label} onChange={(e) => setSc(sc.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <ActionEditor a={s.action} scene set={(action) => setSc(sc.map((x, j) => (j === i ? { ...x, action } : x)))} />
        </div>
      ))}
      <button className="btn btn-accent" onClick={() => save.mutate({ ...saved, shortcuts: sc })}>{save.isPending ? "Saving..." : "Save shortcuts"}</button>
      {save.isError && <p role="alert" className="text-red-400">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-accent">Saved.</p>}
    </section>
  );
}

export function SettingsScreen({ onClock }: { onClock: () => void }) {
  const qc = useQueryClient();
  const settings = useSettings();
  const sp = useSpotify();
  const clock = useMutation({ mutationFn: (s: Settings) => api<Settings>("PUT", "/api/settings", s), onSuccess: (s) => qc.setQueryData(["settings"], s) });
  const disc = useMutation({ mutationFn: () => api("POST", "/api/spotify/disconnect"), onSuccess: () => qc.invalidateQueries({ queryKey: ["spotify"] }) });
  const logout = async () => { await api("POST", "/api/logout"); qc.setQueryData(["session"], { authenticated: false }); qc.removeQueries({ predicate: (q) => q.queryKey[0] !== "session" }); };
  const s = sp.data;
  const status = !s ? "Unknown" : !s.connected ? "Not connected" : s.error ? `Connected, problem: ${s.error.message}` : "Connected";
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-2">
      <section className="card flex flex-col gap-3">
        <h2 className="text-lg font-semibold">General</h2>
        {settings.data && (
          <label className="flex min-h-12 items-center justify-between">
            24-hour clock
            <input type="checkbox" className="h-7 w-7 accent-[var(--color-accent)]" checked={settings.data.clock24h} onChange={(e) => clock.mutate({ ...settings.data!, clock24h: e.target.checked })} />
          </label>
        )}
        <button className="btn" onClick={onClock}>Fullscreen clock (tap to exit)</button>
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Spotify</h2>
        <p role="status" className="text-dim">{status}</p>
        {s?.connected ? <button className="btn" onClick={() => disc.mutate()}>Disconnect</button> : <a className="btn btn-accent" href="/api/spotify/login">Connect Spotify</a>}
        {new URLSearchParams(location.search).get("spotify") === "failed" && <p role="alert" className="text-red-400">Spotify authorization failed.</p>}
      </section>
      {settings.data && <SettingsForm saved={settings.data} />}
      <button className="btn" onClick={logout}>Log out</button>
    </div>
  );
}

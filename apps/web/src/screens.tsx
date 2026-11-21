import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtTime, useNow } from "./App";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, homelabIssues, useHa, useHomelab, useSettings, useSpotify, type Action, type Device, type Item, type Module, type PlaylistInfo, type RecentTrack, type Playback, type Settings, type Shortcut, type SpotifyState } from "./api";

export const Icon = ({ d, stroke }: { d: string; stroke?: boolean }) => (
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
  heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z",
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
    // Roll back only the fields this mutation changed, and only if nothing newer has overwritten them.
    onError: (_e, v, c) => {
      const cur = qc.getQueryData<SpotifyState>(["spotify"]);
      if (!cur?.playback || !c?.prev?.playback || !v.patch) return;
      const pb: Record<string, unknown> = { ...cur.playback };
      for (const k of Object.keys(v.patch) as (keyof Playback)[]) if (cur.playback[k] === v.patch[k]) pb[k] = c.prev.playback[k];
      qc.setQueryData<SpotifyState>(["spotify"], { ...cur, playback: pb as unknown as Playback });
    },
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

function Progress({ p, at, onSeek }: { p: Playback; at: number; onSeek: (ms: number) => void }) {
  const [drag, setDrag] = useState<{ id: number; uri: string | null; f: number } | null>(null);
  useEffect(() => setDrag(null), [p.uri]); // track changed mid-drag: abandon
  const frac = (e: React.PointerEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const [, tick] = useState(0);
  useEffect(() => {
    if (!p.is_playing) return;
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, [p.is_playing]);
  const cur = drag !== null ? drag.f * p.duration_ms : Math.min(p.duration_ms, p.progress_ms + (p.is_playing ? Date.now() - at : 0));
  return (
    <div className="flex items-center gap-2 text-sm tabular-nums text-dim">
      <span>{mmss(cur)}</span>
      <div
        className="flex h-11 flex-1 touch-none items-center" role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={p.duration_ms} aria-valuenow={Math.round(cur)}
        onPointerDown={(e) => { if (!p.duration_ms || drag) return; e.currentTarget.setPointerCapture(e.pointerId); setDrag({ id: e.pointerId, uri: p.uri, f: frac(e) }); }}
        onPointerMove={(e) => drag?.id === e.pointerId && setDrag({ ...drag, f: frac(e) })}
        onPointerUp={(e) => { if (drag?.id !== e.pointerId) return; if (drag.uri === p.uri) onSeek(Math.round(frac(e) * p.duration_ms)); setDrag(null); }}
        onPointerCancel={() => setDrag(null)}
        onLostPointerCapture={() => setDrag(null)}
      >
        <div className="h-3 w-full overflow-hidden rounded-full border-2 border-line bg-surface">
          <div className="h-full bg-accent" style={{ width: `${p.duration_ms ? (cur / p.duration_ms) * 100 : 0}%` }} />
        </div>
      </div>
      <span>{mmss(p.duration_ms)}</span>
    </div>
  );
}

function NowPlaying({ stack }: { stack?: boolean }) {
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
  const likeBtn = (p.uri && /^spotify:track:/.test(p.uri) ? <button className={`btn ${p.liked ? "btn-accent" : ""}`} aria-label={p.liked ? "Unlike" : "Like"} aria-pressed={!!p.liked} onClick={() => run({ method: "PUT", path: "/api/spotify/like", body: { uri: p.uri, liked: !p.liked }, patch: { liked: !p.liked } })}><svg viewBox="0 0 24 24" className="h-6 w-6" fill={p.liked ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden><path d={I.heart} /></svg></button> : null);
  const progress = <Progress p={p} at={q.dataUpdatedAt} onSeek={(ms) => run({ method: "PUT", path: "/api/spotify/seek", body: { positionMs: ms }, patch: { progress_ms: ms } })} />;
  const transport = (
    <>
      <button className="btn" aria-label="Previous" onClick={() => run({ method: "PUT", path: "/api/spotify/previous" })}><Icon d={I.prev} /></button>
      <button className="btn btn-accent min-h-14 min-w-16" aria-label={p.is_playing ? "Pause" : "Play"} onClick={() => run({ method: "PUT", path: p.is_playing ? "/api/spotify/pause" : "/api/spotify/play", patch: { is_playing: !p.is_playing } })}><Icon d={p.is_playing ? I.pause : I.play} /></button>
      <button className="btn" aria-label="Next" onClick={() => run({ method: "PUT", path: "/api/spotify/next" })}><Icon d={I.next} /></button>
    </>
  );
  const shuffleBtn = <button className={`btn ${p.shuffle ? "btn-accent" : ""}`} aria-label="Shuffle" aria-pressed={p.shuffle} onClick={() => run({ method: "PUT", path: "/api/spotify/shuffle", body: { state: !p.shuffle }, patch: { shuffle: !p.shuffle } })}><Icon d={I.shuffle} stroke /></button>;
  const repeatBtn = <button className={`btn ${p.repeat !== "off" ? "btn-accent" : ""}`} aria-label={`Repeat ${p.repeat}`} onClick={() => run({ method: "PUT", path: "/api/spotify/repeat", body: { state: next }, patch: { repeat: next } })}><Icon d={I.repeat} stroke />{p.repeat === "track" && "1"}</button>;
  const volume = p.volume !== null && <VolumeSlider volume={p.volume} onSet={(v) => run({ method: "PUT", path: "/api/spotify/volume", body: { percent: v }, patch: { volume: v } })} />;
  const err = ctl.error && <p role="alert" className="text-sm text-bad">{ctl.error}</p>;
  if (stack)
    return (
      <section className="card flex min-h-0 flex-col justify-center gap-2 overflow-y-auto" aria-label="Now playing">
        <div className="flex min-w-0 items-center gap-3">
          {p.art ? <img src={p.art} alt="" className="aspect-square w-[clamp(4.5rem,24vh,10rem)] shrink-0 rounded-lg frame object-cover" /> : <div className="aspect-square w-[clamp(4.5rem,24vh,10rem)] shrink-0 rounded-lg frame bg-raised" />}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xl font-bold">{p.track ?? "Unknown"}</p>
            <p className="truncate text-dim">{p.artists.join(", ")}</p>
            <p className="truncate text-sm text-dim">{p.album}{p.device ? ` - ${p.device}` : ""}</p>
          </div>
          {likeBtn}
        </div>
        {progress}
        <div className="flex items-center justify-center gap-2">{shuffleBtn}{transport}{repeatBtn}</div>
        {volume}
        {err}
      </section>
    );
  return (
    <section className="card flex min-w-0 flex-col gap-1" aria-label="Now playing">
      <div className="flex min-w-0 items-center gap-3">
        {p.art ? <img src={p.art} alt="" className="aspect-square w-[clamp(3.5rem,16vh,5.5rem)] shrink-0 rounded-lg frame object-cover" /> : <div className="aspect-square w-[clamp(3.5rem,16vh,5.5rem)] shrink-0 rounded-lg frame bg-raised" />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-lg font-bold">{p.track ?? "Unknown"}</p>
          <p className="truncate text-dim">{p.artists.join(", ")}</p>
          {p.device && <p className="truncate text-sm text-dim">on {p.device}</p>}
        </div>
      </div>
      {progress}
      <div className="flex items-center justify-center gap-2">{likeBtn}{transport}</div>
      {err}
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
  return a.type === "spotify-device" || a.type === "announce" || a.type === "spotify-play" || a.type === "obs-scene" || a.type === "obs-record";
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
  if (settings.shortcuts.every((s) => s.action.type === "none")) return null;
  return (
    <section aria-label="Shortcuts">
      <div className="grid grid-cols-2 gap-2 landscape:max-[1100px]:grid-cols-3 min-[1100px]:grid-cols-3">
        {settings.shortcuts.map((s, i) =>
          s.action.type === "none" ? null : (
            <button key={i} className="btn truncate" onClick={() => { if (runClient(s.action, go)) run.mutate(i); }}>{s.label || `Shortcut ${i + 1}`}</button>
          ),
        )}
      </div>
      {msg && <p role="alert" className="mt-1 text-sm text-bad">{msg}</p>}
    </section>
  );
}

// "25.0" -> "25", "107.46" -> "107.5"; non-numeric states ("off") pass through.
const fmtReading = (v: string) => (v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v).toLocaleString([], { maximumFractionDigits: 1 }) : v);
const CONDITION: Record<string, string> = { "clear-night": "Clear", partlycloudy: "Partly cloudy", "lightning-rainy": "Thunderstorm", lightning: "Lightning", pouring: "Heavy rain", "snowy-rainy": "Sleet", "windy-variant": "Windy", exceptional: "Extreme weather" };
const fmtCondition = (c: string) => CONDITION[c] ?? c.charAt(0).toUpperCase() + c.slice(1);

function Reading({ label, value, unit, note }: { label: string; value: string; unit: string | null; note?: string }) {
  return (
    <div className="min-w-0 rounded-lg border-[3px] border-line bg-raised px-3 py-2 shadow-[4px_4px_0_var(--color-line)]">
      <p className="truncate text-sm text-dim">{label}</p>
      <p className="truncate text-3xl font-black tabular-nums">{fmtReading(value)}{unit ? ` ${unit}` : ""}</p>
      {note && <p className="truncate text-sm font-bold">{note}</p>}
    </div>
  );
}

// Outside weather and room temperature from Home Assistant (first weather.* and first °C sensor in HA_SENSORS).
function HomeReadings() {
  const s = useHa().data;
  if (!s?.reachable) return null;
  const weather = s.sensors.find((x) => x.id.startsWith("weather."));
  const room = s.sensors.find((x) => !x.id.startsWith("weather.") && x.unit === "°C");
  if (!weather && !room) return null;
  return (
    <div className="grid grid-cols-2 gap-3" aria-label="Weather and room">
      {weather && <Reading label="Outside" value={weather.state} unit={weather.unit} note={weather.condition && fmtCondition(weather.condition)} />}
      {room && <Reading label="Room" value={room.state} unit={room.unit} />}
    </div>
  );
}

function ClockHero() {
  const now = useNow();
  const h24 = useSettings().data?.clock24h ?? true;
  return (
    <section className="card flex min-h-0 flex-col justify-center" aria-label="Clock">
      <span className="text-[clamp(4rem,min(15vw,34vh),12rem)] font-black leading-none tabular-nums">{fmtTime(now, h24)}</span>
      <span className="mt-2 text-[clamp(1.1rem,5vh,2rem)] font-bold text-dim">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
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
        <span className={`text-[min(20vw,30vh)] font-light leading-none tabular-nums ${done ? "text-ok" : ""}`}>{mmss(value)}</span>
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
    <div className="grid h-full gap-3 pr-2 pb-2 landscape:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] portrait:content-start">
      <ClockHero />
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-2 pb-2">
        <NowPlaying />
        <HomeReadings />
        <Shortcuts go={go} />
      </div>
    </div>
  );
}

const reconnectBanner = (s: SpotifyState | undefined) =>
  s?.connected && !s.scopesOk ? <p role="status" className="card bg-raised font-bold">Reconnect Spotify for new features. <a className="underline" href="/api/spotify/login">Reconnect</a></p> : null;

const Art = ({ src }: { src: string | null }) => (src ? <img src={src} alt="" className="h-12 w-12 shrink-0 rounded-md border-2 border-line object-cover" /> : <div className="h-12 w-12 shrink-0 rounded-md border-2 border-line bg-raised" />);

function useAddQueue() {
  return useMutation({ mutationFn: (uri: string) => api("POST", "/api/spotify/queue", { uri }) });
}

function UpNext({ bare }: { bare?: boolean }) {
  const sp = useSpotify();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["queue"], queryFn: () => api<{ queue: Item[] }>("GET", "/api/spotify/queue"), refetchInterval: () => (document.hidden ? false : 10_000), enabled: !!sp.data?.connected, retry: false });
  const trackUri = sp.data?.playback?.uri;
  useEffect(() => { void qc.invalidateQueries({ queryKey: ["queue"] }); }, [trackUri, qc]);
  return (
    <section className={bare ? "flex flex-col gap-2" : "card flex min-h-0 flex-col gap-2 overflow-y-auto"} aria-label="Up next">
      {!bare && <h2 className="text-lg font-semibold">Up next</h2>}
      {q.isError ? <p role="status" className="text-dim">{q.error.message}</p>
        : !q.data ? <p className="text-dim">Loading...</p>
        : q.data.queue.length === 0 ? <p className="text-dim">Queue is empty.</p>
        : q.data.queue.map((t, i) => (
          <div key={i} className="flex min-h-12 items-center gap-3">
            <Art src={t.art} />
            <div className="min-w-0"><p className="truncate">{t.name}</p><p className="truncate text-sm text-dim">{t.artists.join(", ")}</p></div>
          </div>
        ))}
    </section>
  );
}

export const Music = () => (
  <div className="grid h-full min-h-0 gap-2 landscape:grid-cols-[minmax(19rem,2fr)_minmax(0,3fr)] portrait:grid-rows-[auto_1fr]">
    <NowPlaying stack />
    <section className="card flex min-h-0 flex-col" aria-label="Browse"><LibraryPanel tabs={["queue", "playlists", "recent", "speakers"]} /></section>
  </div>
);

type Tab = "queue" | "playlists" | "recent" | "speakers";
const TAB_LABEL: Record<Tab, string> = { queue: "Up next", playlists: "Playlists", recent: "Recent", speakers: "Speakers" };

function LibraryPanel({ tabs }: { tabs: Tab[] }) {
  const sp = useSpotify();
  const qc = useQueryClient();
  const settings = useSettings().data;
  const [tab, setTab] = useState<Tab>(tabs[0]);
  const [msg, setMsg] = useState("");
  const on = !!sp.data?.connected;
  const pl = useQuery({ queryKey: ["playlists"], queryFn: () => api<{ playlists: PlaylistInfo[] }>("GET", "/api/spotify/playlists"), enabled: on && tab === "playlists", retry: false });
  const rc = useQuery({ queryKey: ["recent"], queryFn: () => api<{ tracks: RecentTrack[] }>("GET", "/api/spotify/recent"), enabled: on && tab === "recent", retry: false });
  const afterPlay = () => void setTimeout(() => qc.invalidateQueries({ queryKey: ["spotify"] }), 500);
  const play = useMutation({
    mutationFn: (v: { path: string; body: unknown }) => api("PUT", v.path, v.body),
    onMutate: () => setMsg(""),
    onSuccess: afterPlay,
    onError: (e) => setMsg(e.message),
  });
  const add = useAddQueue();
  const pin = useMutation({
    mutationFn: (s: Settings) => api<Settings>("PUT", "/api/settings", s),
    onSuccess: (s) => { qc.setQueryData(["settings"], s); setMsg("Pinned."); },
    onError: (e) => setMsg(e.message),
  });
  const doPin = (p: PlaylistInfo) => {
    const i = settings?.shortcuts.findIndex((s) => s.action.type === "none") ?? -1;
    if (!settings || i < 0) return setMsg("No free shortcut slot — edit one in Settings");
    pin.mutate({ ...settings, shortcuts: settings.shortcuts.map((s, j) => (j === i ? { label: p.name.slice(0, 40), action: { type: "spotify-play", uri: p.uri } } : s)) });
  };
  if (sp.data && !sp.data.connected) return <Notice>Spotify is not connected. Connect it in Settings.</Notice>;
  const err = tab === "playlists" ? pl.error : tab === "recent" ? rc.error : null;
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {reconnectBanner(sp.data)}
      <div className="flex shrink-0 gap-2" role="tablist">
        {tabs.map((t) => <button key={t} role="tab" className={`btn flex-1 px-2 text-sm ${tab === t ? "btn-accent" : ""}`} aria-selected={tab === t} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>)}
      </div>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-2 pb-2">
      {tab === "queue" && <UpNext bare />}
      {tab === "speakers" && <SpotifyDevices />}
      {msg && <p role="status" className="text-sm text-ok">{msg}</p>}
      {err && <Notice>{err.message}</Notice>}
      {tab === "playlists" && pl.data?.playlists.length === 0 && <Notice>No playlists.</Notice>}
      {tab === "playlists" && pl.data?.playlists.map((p) => (
        <div key={p.id} className="flex items-center gap-2">
          <button className="btn min-w-0 flex-1 justify-start gap-3 text-left" aria-label={`Play ${p.name}`} onClick={() => play.mutate({ path: "/api/spotify/play-context", body: { contextUri: p.uri } })}>
            <Art src={p.art} />
            <span className="min-w-0"><span className="block truncate">{p.name}</span><span className="block truncate text-sm text-dim">{p.owner} - {p.count} tracks</span></span>
          </button>
          <button className="btn px-3" aria-label={`Pin ${p.name} as shortcut`} onClick={() => doPin(p)}>Pin</button>
        </div>
      ))}
      {tab === "recent" && rc.data?.tracks.length === 0 && <Notice>Nothing played recently.</Notice>}
      {tab === "recent" && rc.data?.tracks.map((t) => (
        <div key={t.uri + t.playedAt} className="flex items-center gap-2">
          <button className="btn min-w-0 flex-1 justify-start gap-3 text-left" aria-label={`Play ${t.name}`} disabled={!t.playable} onClick={() => play.mutate({ path: "/api/spotify/play-uris", body: { uris: [t.uri] } })}>
            <Art src={t.art} />
            <span className="min-w-0"><span className="block truncate">{t.name}</span><span className="block truncate text-sm text-dim">{t.artists.join(", ")}</span></span>
          </button>
          {t.playable && <button className="btn px-3" aria-label={`Add ${t.name} to queue`} onClick={() => { setMsg(""); add.mutate(t.uri, { onSuccess: () => setMsg("Added to queue."), onError: (e) => setMsg(e.message) }); }}>+ Queue</button>}
        </div>
      ))}
      </div>
    </div>
  );
}



function SpotifyDevices() {
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
        <button key={d.id} className={`btn justify-between ${d.active ? "btn-accent" : ""}`} onClick={() => t.mutate(d.id)}>
          <span className="truncate">{d.name} <span className="text-dim">({d.type})</span></span>
          {d.active && <span className="rounded border-2 border-line bg-surface px-1.5 text-xs font-black">ACTIVE</span>}
        </button>
      ))}
      {t.isError && <p role="alert" className="text-bad">{t.error.message}</p>}
    </div>
  );
}

export function Devices() {
  return (
    <div className="flex flex-col gap-2">
      <SpotifyDevices />
      <AlexaCard />
    </div>
  );
}

function AlexaCard() {
  const q = useHa(15_000);
  const [msg, setMsg] = useState("");
  const send = useMutation({ mutationFn: (m: string) => api("POST", "/api/ha/announce", { message: m }), onSuccess: () => setMsg("") });
  const s = q.data;
  return (
    <section className="card flex flex-col gap-3" aria-label="Alexa and Home">
      <h2 className="text-lg font-semibold">Alexa / Home</h2>
      {q.isError ? <p role="status" className="text-dim">Unavailable: {q.error.message}</p>
        : !s ? <p className="text-dim">Loading...</p>
        : !s.configured ? <p role="status" className="text-dim">Home Assistant is not configured. Set HA_URL, HA_TOKEN, HA_SENSORS and HA_ANNOUNCE_ENTITY on the server.</p>
        : (
          <>
            <p role="status" className={s.reachable ? "text-ok" : "text-warn"}>{s.reachable ? "Home Assistant connected" : `Unavailable: ${s.error}`}</p>
            {s.sensors.map((x) => (
              <div key={x.id} className="flex justify-between gap-2"><span className="truncate text-dim">{x.name}</span><span className="tabular-nums">{x.state}{x.unit ? ` ${x.unit}` : ""}</span></div>
            ))}
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) send.mutate(msg.trim()); }}>
              <input className="input flex-1" aria-label="Announcement" placeholder="Announce on Echo..." maxLength={300} value={msg} onChange={(e) => setMsg(e.target.value)} />
              <button className="btn btn-accent" type="submit" disabled={send.isPending || !msg.trim()}>{send.isPending ? "Sending..." : "Send"}</button>
            </form>
            {send.isSuccess && <p role="status" className="text-ok">Announcement sent.</p>}
            {send.isError && <p role="alert" className="text-bad">{send.error.message}</p>}
          </>
        )}
    </section>
  );
}

const pct = (n: number) => Math.max(0, Math.min(100, n));
function Bar({ label, value, text }: { label: string; value: number | null; text: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-sm text-dim"><span>{label}</span><span className="tabular-nums">{value === null ? "n/a" : text}</span></div>
      <div className="h-3 overflow-hidden rounded-full border-2 border-line bg-surface"><div className="h-full bg-accent" style={{ width: `${value === null ? 0 : pct(value)}%` }} /></div>
    </div>
  );
}
const uptime = (s: number) => `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

export function Homelab() {
  const q = useHomelab(10_000);
  const ha = useHa(15_000).data;
  if (q.isError) return <Notice>Homelab unavailable: {q.error.message}</Notice>;
  const d = q.data;
  if (!d) return <Notice>Loading...</Notice>;
  const { pi } = d;
  const temp = pi.tempC === null ? "" : pi.tempC >= 80 ? "text-bad" : pi.tempC >= 70 ? "text-warn" : "";
  const issues = homelabIssues(d);
  const running = d.containers?.filter((c) => c.state === "running").length;
  const up = d.hosts.filter((h) => h.up).length;
  const echoTemp = ha?.sensors.find((s) => s.unit === "°C");
  const stat = (label: string, value: string, ok: boolean | null) => (
    <div className="flex flex-col">
      <span className="text-xs uppercase tracking-wide text-dim">{label}</span>
      <span className={`text-xl font-semibold tabular-nums ${ok === false ? "text-bad" : ""}`}>{value}</span>
    </div>
  );
  return (
    <div className="grid gap-2 landscape:grid-cols-2 min-[1500px]:grid-cols-3">
      <section className="card col-span-full flex flex-col gap-2" aria-label="Summary">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          {stat("Pi", `${pi.tempC === null ? "n/a" : `${pi.tempC.toFixed(0)}°C`} · ${pi.cpuPercent ?? "n/a"}% CPU`, pi.tempC === null ? null : pi.tempC < 70)}
          {stat("Containers", d.containers ? `${running}/${d.containers.length} running` : "n/a", d.containers ? running === d.containers.length : null)}
          {stat("Hosts", `${up}/${d.hosts.length} up`, d.hosts.length ? up === d.hosts.length : null)}
          {stat("Home Assistant", !ha?.configured ? "not set up" : ha.reachable ? `online${echoTemp ? ` · ${echoTemp.state}°C room` : ""}` : "offline", ha?.configured ? ha.reachable : null)}
        </div>
        <p role="status" className={issues.length ? "text-bad" : "text-dim"}>{issues.length ? issues.join(" · ") : "All systems normal."}</p>
      </section>
      <section className="card flex flex-col gap-3" aria-label="Raspberry Pi">
        <h2 className="text-lg font-semibold">Raspberry Pi</h2>
        <div className="flex items-baseline justify-between gap-2">
          <span className={`text-4xl font-light tabular-nums ${temp}`}>{pi.tempC === null ? "n/a" : `${pi.tempC.toFixed(1)}°C`}</span>
          <span className="text-sm text-dim">{pi.uptimeSec === null ? "uptime n/a" : `up ${uptime(pi.uptimeSec)}`}{pi.load ? ` - load ${pi.load.join(" ")}` : ""}</span>
        </div>
        <Bar label="CPU" value={pi.cpuPercent} text={`${pi.cpuPercent}%`} />
        <Bar label="RAM" value={pi.mem && (pi.mem.usedMb / pi.mem.totalMb) * 100} text={pi.mem ? `${pi.mem.usedMb} / ${pi.mem.totalMb} MB` : ""} />
        <Bar label="Disk" value={pi.disk && (pi.disk.usedGb / pi.disk.totalGb) * 100} text={pi.disk ? `${pi.disk.usedGb} / ${pi.disk.totalGb} GB` : ""} />
      </section>
      <section className="card flex flex-col gap-2" aria-label="Containers">
        <h2 className="text-lg font-semibold">Containers{d.snapshotAge !== null && <span className="ml-2 text-sm font-normal text-dim">snapshot {d.snapshotAge}s old</span>}</h2>
        {d.containers === null ? <p role="status" className="text-dim">Unavailable: {d.error}</p>
          : d.containers.length === 0 ? <p className="text-dim">No containers.</p>
          : d.containers.map((c) => (
            <div key={c.name} className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full border-2 border-line ${c.state === "running" ? "bg-accent" : "bg-bad"}`} />
              <span className="truncate">{c.name}</span>
              <span className="ml-auto truncate text-sm text-dim">{c.status}</span>
            </div>
          ))}
      </section>
      <section className="card flex flex-col gap-2" aria-label="Hosts">
        <h2 className="text-lg font-semibold">Hosts</h2>
        {d.hosts.length === 0 && <p className="text-dim">No hosts configured (NEXUS_HOSTS).</p>}
        {d.hosts.map((h) => (
          <div key={h.name} className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full border-2 border-line ${h.up ? "bg-accent" : "bg-bad"}`} />
            <span className="truncate">{h.name} <span className="text-sm text-dim">{h.target}</span></span>
            <span className="ml-auto text-sm tabular-nums text-dim">{h.up ? `${h.latencyMs} ms` : "down"}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

const blank = (type: string): Action =>
  type === "url" ? { type, url: "https://" } : type === "module" ? { type, module: "dashboard" } : type === "spotify-device" ? { type, deviceName: "" } : type === "announce" ? { type, message: "" } : type === "spotify-play" ? { type, uri: "spotify:playlist:" } : type === "obs-scene" ? { type, scene: "" } : type === "obs-record" ? { type, on: true } : type === "scene" ? { type, steps: [] } : { type: "none" };

function ActionEditor({ a, set, scene }: { a: Action; set: (a: Action) => void; scene: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <select className="input" value={a.type} aria-label="Action type" onChange={(e) => set(blank(e.target.value))}>
        <option value="none">None</option>
        <option value="url">Open URL</option>
        <option value="module">Go to module</option>
        <option value="spotify-device">Play on Spotify device</option>
        <option value="announce">Alexa announcement</option>
        <option value="spotify-play">Play Spotify item</option>
        <option value="obs-scene">OBS: switch scene</option>
        <option value="obs-record">OBS: start/stop recording</option>
        {scene && <option value="scene">Scene (several steps)</option>}
      </select>
      {a.type === "url" && <input className="input" aria-label="URL" value={a.url} onChange={(e) => set({ ...a, url: e.target.value })} />}
      {a.type === "module" && (
        <select className="input" aria-label="Module" value={a.module} onChange={(e) => set({ ...a, module: e.target.value as Module })}>
          {["dashboard", "music", "devices", "timer", "homelab", "studio", "settings"].map((m) => <option key={m}>{m}</option>)}
        </select>
      )}
      {a.type === "spotify-device" && <input className="input" aria-label="Device name" placeholder="Device name" value={a.deviceName} onChange={(e) => set({ ...a, deviceName: e.target.value })} />}
      {a.type === "spotify-play" && <input className="input" aria-label="Spotify URI" placeholder="spotify:playlist:..." value={a.uri} onChange={(e) => set({ ...a, uri: e.target.value.trim() })} />}
      {a.type === "obs-scene" && <input className="input" aria-label="OBS scene name" placeholder="Scene name (as in OBS)" maxLength={100} value={a.scene} onChange={(e) => set({ ...a, scene: e.target.value })} />}
      {a.type === "obs-record" && (
        <select className="input" aria-label="Recording" value={a.on ? "start" : "stop"} onChange={(e) => set({ ...a, on: e.target.value === "start" })}>
          <option value="start">Start recording</option>
          <option value="stop">Stop recording</option>
        </select>
      )}
      {a.type === "announce" && <input className="input" aria-label="Announcement message" placeholder="Message" maxLength={300} value={a.message} onChange={(e) => set({ ...a, message: e.target.value })} />}
      {a.type === "scene" && (
        <div className="flex flex-col gap-2 border-l-[3px] border-line pl-3">
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
  const voice = useHa().data?.voice;
  const save = useMutation({
    mutationFn: (s: Settings) => api<Settings>("PUT", "/api/settings", s),
    onSuccess: (s) => qc.setQueryData(["settings"], s),
  });
  return (
    <section className="card flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Shortcuts</h2>
      {voice && <p className="text-sm text-dim">Voice: say "Alexa, " and a shortcut's name to run it (page and link steps only run from the screen).</p>}
      {sc.map((s, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-lg border-[3px] border-line bg-bg p-3">
          <input className="input" aria-label={`Shortcut ${i + 1} label`} maxLength={40} value={s.label} onChange={(e) => setSc(sc.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
          <ActionEditor a={s.action} scene set={(action) => setSc(sc.map((x, j) => (j === i ? { ...x, action } : x)))} />
        </div>
      ))}
      <button className="btn btn-accent" onClick={() => save.mutate({ ...saved, shortcuts: sc })}>{save.isPending ? "Saving..." : "Save shortcuts"}</button>
      {save.isError && <p role="alert" className="text-bad">{save.error.message}</p>}
      {save.isSuccess && <p role="status" className="text-ok">Saved.</p>}
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
        {settings.data && (
          <div className="flex min-h-12 flex-wrap items-center justify-between gap-2" role="radiogroup" aria-label="Theme">
            Theme
            <div className="flex gap-2">
              {(["dark", "light", "system"] as const).map((t) => (
                <button key={t} role="radio" aria-checked={(settings.data!.theme ?? "dark") === t} className={`btn capitalize ${(settings.data!.theme ?? "dark") === t ? "btn-accent" : ""}`} onClick={() => clock.mutate({ ...settings.data!, theme: t })}>{t}</button>
              ))}
            </div>
          </div>
        )}
        <button className="btn" onClick={onClock}>Fullscreen clock (tap to exit)</button>
      </section>
      <section className="card flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Spotify</h2>
        <p role="status" className="text-dim">{status}</p>
        {reconnectBanner(s)}
        {s?.connected ? <button className="btn" onClick={() => disc.mutate()}>Disconnect</button> : <a className="btn btn-accent" href="/api/spotify/login">Connect Spotify</a>}
        {new URLSearchParams(location.search).get("spotify") === "failed" && <p role="alert" className="text-bad">Spotify authorization failed.</p>}
      </section>
      {settings.data && <SettingsForm saved={settings.data} />}
      <button className="btn" onClick={logout}>Log out</button>
    </div>
  );
}

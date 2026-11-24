import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, homelabIssues, useHa, useHomelab, useSettings, useSpotify, type Module } from "./api";
import { Dashboard, Devices, Homelab, Icon, Music, SettingsScreen, Timers } from "./screens";
import { Studio } from "./studio";

const NAV: { id: Module; label: string; path: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", path: "/", icon: "M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z" },
  { id: "music", label: "Music", path: "/music", icon: "M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" },
  { id: "devices", label: "Devices", path: "/devices", icon: "M4 4h16v11H4zM8 20h8M12 15v5" },
  { id: "timer", label: "Timer", path: "/timer", icon: "M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM12 9v4l2 2M10 2h4" },
  { id: "homelab", label: "Homelab", path: "/homelab", icon: "M3 4h18v6H3zM3 14h18v6H3zM7 7h.01M7 17h.01" },
  { id: "studio", label: "Studio", path: "/studio", icon: "M23 7l-7 5 7 5zM1 5h15v14H1z" },
  { id: "settings", label: "Settings", path: "/settings", icon: "M4 6h16M4 12h16M4 18h16M8 4v4M16 10v4M10 16v4" },
];
const moduleOf = (p: string): Module => NAV.find((n) => n.path === p)?.id ?? "dashboard";

export const useNow = () => {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
};

export const fmtTime = (d: Date, h24: boolean, seconds = false) =>
  d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds && { second: "2-digit" }), hour12: !h24 });

function Login() {
  const qc = useQueryClient();
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api("POST", "/api/login", { password: pw });
      qc.invalidateQueries();
    } catch (x) {
      setErr((x as Error).message);
    }
  };
  return (
    <form onSubmit={submit} className="mx-auto flex h-full max-w-sm flex-col justify-center gap-3 p-6">
      <h1 className="w-fit -rotate-2 border-[3px] border-line bg-accent px-3 py-1 text-3xl font-black text-black shadow-[4px_4px_0_var(--color-line)]">Nexus</h1>
      <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p role="alert" className="text-bad">{err}</p>}
      <button className="btn btn-accent" type="submit">Log in</button>
    </form>
  );
}

function Dot({ ok, label, big }: { ok: boolean | null; label: string; big?: boolean }) {
  return (
    <span className={`flex items-center gap-1.5 ${big ? "text-base font-bold text-fg" : "text-sm text-dim"}`} title={label}>
      <span className={`${big ? "h-4 w-4" : "h-3 w-3"} rounded-full border-2 border-line ${ok === null ? "bg-dim" : ok ? "bg-accent" : "bg-bad"}`} />
      {label}
    </span>
  );
}

function Shell({ path, go }: { path: string; go: (p: string) => void }) {
  const now = useNow();
  const settings = useSettings().data;
  const sp = useSpotify();
  const lab = useHomelab();
  const ha = useHa();
  const [ambient, setAmbient] = useState(false);
  const h24 = settings?.clock24h ?? true;
  const theme = settings?.theme ?? "dark";
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("theme", theme); } catch { /* storage blocked */ }
  }, [theme]);
  const offline = sp.isError;
  const lamps = [
    { ok: offline ? false : sp.data ? true : null, label: "Server" },
    { ok: sp.data ? sp.data.connected && !sp.data.error : null, label: "Spotify" },
    { ok: ha.data?.configured ? ha.data.reachable : null, label: "Home" },
    { ok: lab.data ? homelabIssues(lab.data).length === 0 : null, label: "Homelab" },
  ];
  const known = lamps.filter((l) => l.ok !== null);
  const problems = known.length ? known.filter((l) => !l.ok).length : null; // unknown lamps are not problems
  const failing = known.filter((l) => !l.ok);
  const PLAIN: Record<string, string> = { Server: "Server unreachable", Spotify: "Spotify down", Home: "Home offline", Homelab: "Homelab problem" };
  const summary = problems === null ? "Checking" : problems === 0 ? "All OK" : problems === 1 ? PLAIN[failing[0].label] : `${problems} problems`;
  const mod = moduleOf(path);

  const setFull = (on: boolean) => {
    setAmbient(on);
    try {
      if (on) void document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) void document.exitFullscreen();
    } catch { /* fullscreen is optional */ }
  };

  if (ambient)
    return (
      <button className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black text-white" onClick={() => setFull(false)} aria-label="Exit clock mode">
        <span className="text-[min(28vw,40vh)] font-light leading-none tabular-nums">{fmtTime(now, h24)}</span>
        <span className="mt-4 text-[min(5vw,6vh)] text-white/60">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
      </button>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-12 items-center justify-between gap-3 px-4 py-1">
        <span className="-rotate-2 border-[3px] border-line bg-accent px-2 text-xl font-black text-black shadow-[3px_3px_0_var(--color-line)]">Nexus</span>
        <button className="flex min-h-11 flex-wrap items-center justify-end gap-x-3 rounded-lg px-2 active:bg-black/10" onClick={() => go("/homelab")} aria-label={`System status: ${lamps.map((l) => `${l.label} ${l.ok === null ? "unknown" : l.ok ? "ok" : "problem"}`).join(", ")}. Open Homelab`}>
          <span className="flex flex-wrap items-center justify-end gap-x-3 short:hidden">
            {lamps.map((l) => <Dot key={l.label} {...l} />)}
          </span>
          <span className="hidden short:flex"><Dot ok={problems === null ? null : problems === 0} label={summary} big /></span>
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </header>
      {offline && <div role="alert" className="border-y-[3px] border-line bg-bad px-4 py-2 text-center font-bold text-white">Nexus server unreachable. Retrying...</div>}
      <div className="flex min-h-0 flex-1 portrait:flex-col-reverse">
        <nav className="flex gap-2 p-2 portrait:gap-1 portrait:p-1 landscape:flex-col landscape:justify-center landscape:gap-1 landscape:overflow-y-auto portrait:justify-around" aria-label="Main">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => go(n.path)} aria-current={mod === n.id} aria-label={n.label} title={n.label} className={`btn flex-col gap-0 ${mod === n.id ? "btn-accent shrink-0 px-1" : "px-3"} landscape:w-[4.5rem] landscape:px-1`}>
              <Icon d={n.icon} stroke />
              {mod === n.id && <span className="text-xs leading-none">{n.label}</span>}
            </button>
          ))}
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
          {mod === "dashboard" && <Dashboard go={go} />}
          {mod === "music" && <Music />}
          {mod === "devices" && <Devices />}
          {/* Kept mounted so a running timer survives navigation. */}
          <div className={mod === "timer" ? "h-full" : "hidden"}><Timers /></div>
          {mod === "homelab" && <Homelab />}
          {mod === "studio" && <Studio />}
          {mod === "settings" && <SettingsScreen onClock={() => setFull(true)} />}
        </main>
      </div>
    </div>
  );
}

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const f = () => setPath(location.pathname);
    addEventListener("popstate", f);
    return () => removeEventListener("popstate", f);
  }, []);
  const go = (p: string) => {
    history.pushState(null, "", p);
    setPath(p);
  };
  const session = useQuery({ queryKey: ["session"], queryFn: () => api<{ authenticated: boolean }>("GET", "/api/session") });
  if (session.isError) return <div role="alert" className="p-6 text-center">Nexus server unreachable. <button className="btn" onClick={() => session.refetch()}>Retry</button></div>;
  if (!session.data) return null;
  return session.data.authenticated ? <Shell path={path} go={go} /> : <Login />;
}

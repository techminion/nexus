import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useSettings, useSpotify, type Module } from "./api";
import { Dashboard, Devices, Music, SettingsScreen } from "./screens";

const NAV: { id: Module; label: string; path: string }[] = [
  { id: "dashboard", label: "Dashboard", path: "/" },
  { id: "music", label: "Music", path: "/music" },
  { id: "devices", label: "Devices", path: "/devices" },
  { id: "settings", label: "Settings", path: "/settings" },
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
      <h1 className="text-3xl font-bold text-accent">Nexus</h1>
      <input className="input" type="password" autoFocus placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} />
      {err && <p role="alert" className="text-red-400">{err}</p>}
      <button className="btn btn-accent" type="submit">Log in</button>
    </form>
  );
}

function Dot({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-sm text-dim" title={label}>
      <span className={`h-2.5 w-2.5 rounded-full ${ok === null ? "bg-dim" : ok ? "bg-accent" : "bg-red-500"}`} />
      {label}
    </span>
  );
}

function Shell({ path, go }: { path: string; go: (p: string) => void }) {
  const now = useNow();
  const settings = useSettings().data;
  const sp = useSpotify();
  const [ambient, setAmbient] = useState(false);
  const h24 = settings?.clock24h ?? true;
  const offline = sp.isError;
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
      <button className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black" onClick={() => setFull(false)} aria-label="Exit clock mode">
        <span className="text-[min(28vw,40vh)] font-light leading-none tabular-nums">{fmtTime(now, h24)}</span>
        <span className="mt-4 text-[min(5vw,6vh)] text-dim">{now.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}</span>
      </button>
    );

  return (
    <div className="flex h-full flex-col">
      <header className="flex min-h-12 items-center justify-between gap-3 px-4 py-1">
        <span className="text-xl font-bold text-accent">Nexus</span>
        <span className="flex gap-3">
          <Dot ok={!offline} label="Server" />
          <Dot ok={sp.data ? sp.data.connected && !sp.data.error : null} label="Spotify" />
        </span>
      </header>
      {offline && <div role="alert" className="bg-red-900/60 px-4 py-2 text-center">Nexus server unreachable. Retrying...</div>}
      <div className="flex min-h-0 flex-1 portrait:flex-col-reverse">
        <nav className="flex gap-2 p-2 landscape:flex-col landscape:justify-center portrait:justify-around" aria-label="Main">
          {NAV.map((n) => (
            <button key={n.id} onClick={() => go(n.path)} aria-current={mod === n.id} className={`btn px-3 text-sm landscape:min-w-24 ${mod === n.id ? "btn-accent" : ""}`}>
              {n.label}
            </button>
          ))}
        </nav>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto p-2">
          {mod === "dashboard" && <Dashboard go={go} />}
          {mod === "music" && <Music />}
          {mod === "devices" && <Devices />}
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

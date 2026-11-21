import { useEffect, useRef, useState } from "react";
import { useStudio, type StudioCamera } from "./api";

/**
 * Plays a MediaMTX path over WebRTC (WHEP) through Caddy's login-protected /studio/ proxy.
 * Non-trickle: wait for ICE gathering, POST the offer once, apply the answer. Retries every 3 s on failure.
 */
function useWhep(path: string, on: boolean) {
  const ref = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"idle" | "connecting" | "playing" | "error">("idle");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!on) return setState("idle");
    let stopped = false;
    let timer: number | undefined;
    const ac = new AbortController();
    const pc = new RTCPeerConnection();
    const stream = new MediaStream();
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => {
      stream.addTrack(e.track);
      if (ref.current) ref.current.srcObject = stream;
    };
    const fail = () => {
      if (stopped || timer) return;
      setState("error");
      timer = window.setTimeout(() => setRetry((n) => n + 1), 3000);
    };
    const deadline = window.setTimeout(fail, 15_000); // never sit on "Connecting..." forever
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") (clearTimeout(deadline), setState("playing"));
      else if (pc.connectionState === "failed" || pc.connectionState === "disconnected") fail();
    };
    setState("connecting");
    (async () => {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((done) => {
        if (pc.iceGatheringState === "complete") return done();
        const t = setTimeout(done, 1500);
        pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && (clearTimeout(t), done()));
      });
      if (stopped) return;
      const r = await fetch(`/studio/${path}/whep`, { method: "POST", headers: { "content-type": "application/sdp" }, body: pc.localDescription!.sdp, signal: ac.signal });
      if (!r.ok) throw new Error(`WHEP ${r.status}`);
      if (!stopped) await pc.setRemoteDescription({ type: "answer", sdp: await r.text() });
    })().catch(fail);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(deadline);
      ac.abort();
      pc.close();
      if (ref.current) ref.current.srcObject = null;
    };
  }, [path, on, retry]);
  return { ref, state };
}

function Player({ path, on }: { path: string; on: boolean }) {
  const { ref, state } = useWhep(path, on);
  return (
    <div className="relative h-full w-full bg-black">
      <video ref={ref} autoPlay muted playsInline className="h-full w-full object-contain" />
      {state !== "playing" && <p className="absolute inset-0 flex items-center justify-center text-sm font-bold text-white/80">{state === "error" ? "Reconnecting..." : "Connecting..."}</p>}
    </div>
  );
}

const statusOf = (c: StudioCamera) => (c.live ? "Live" : c.onDemand ? "Ready" : "Offline");

export function Studio() {
  const q = useStudio();
  const [full, setFull] = useState<string | null>(null);
  const [started, setStarted] = useState<string[]>([]); // on-demand cameras switched on by a tap
  const s = q.data;
  if (!s) return <section className="card text-dim">{q.isError ? `Studio unavailable: ${q.error.message}` : "Loading..."}</section>;
  if (!s.configured) return <section className="card text-dim">Studio is not set up. Set STUDIO_API on the server.</section>;
  // On-demand cameras (the webcam) play only after this viewer taps Start, even if someone else turned them on.
  const active = (c: StudioCamera) => s.reachable && (c.onDemand ? started.includes(c.path) : c.live);
  const open = s.cameras.find((c) => c.path === full && active(c));
  return (
    <div className="flex flex-col gap-3 pr-2 pb-2">
      {!s.reachable && <p role="status" className="card font-bold text-warn">{s.error}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {s.cameras.map((c) => (
          <section key={c.path} className="card flex flex-col gap-2 p-3" aria-label={c.name}>
            <div className="flex items-center gap-2">
              <span className={`h-3 w-3 rounded-full border-2 border-line ${c.live ? "bg-accent" : c.onDemand && s.reachable ? "bg-raised" : "bg-bad"}`} />
              <span className="min-w-0 flex-1 truncate font-bold">{c.name}</span>
              <span className="text-sm text-dim">{s.reachable ? statusOf(c) : "Offline"}{c.viewers > 0 ? ` · ${c.viewers} watching` : ""}</span>
            </div>
            <div className="aspect-video overflow-hidden rounded-lg border-[3px] border-line">
              {active(c) ? (
                <button className="h-full w-full" aria-label={`Open ${c.name} full screen`} onClick={() => setFull(c.path)}>
                  <Player path={c.path} on={full !== c.path} />
                </button>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 bg-raised p-3 text-center">
                  {c.onDemand && s.reachable ? (
                    <button className="btn btn-accent" onClick={() => setStarted([...started, c.path])}>Start camera</button>
                  ) : (
                    <p className="text-sm text-dim">Not streaming. Send RTMP to <span className="font-bold break-all">{s.publishUrl?.replace("<name>", c.path)}</span></p>
                  )}
                </div>
              )}
            </div>
            {c.onDemand && started.includes(c.path) && (
              <button className="btn" onClick={() => setStarted(started.filter((p) => p !== c.path))}>Stop camera</button>
            )}
          </section>
        ))}
      </div>
      <section className="card flex flex-col gap-1 text-sm" aria-label="Add a camera">
        <h2 className="text-base font-bold">Add a camera</h2>
        <p><span className="font-bold">Phone or DJI:</span> stream RTMP (Larix Broadcaster, DJI Mimo → Live → RTMP) to <span className="font-bold break-all">{s.publishUrl?.replace("<name>", "phone/<name>")}?user=studio&amp;pass=…</span> using any name (Larix needs the <span className="font-bold">phone/</span> part). It appears here while streaming.</p>
        <p><span className="font-bold">USB webcam:</span> plug it into crashmetheus and run <span className="font-bold">deploy/studio/install.sh</span>.</p>
        <p className="text-dim">The password is in ~/.config/nexus-studio/publish.pass on crashmetheus. Optional names: STUDIO_CAMERAS on the Pi.</p>
      </section>
      {open && (
        <button className="fixed inset-0 z-50 bg-black" aria-label={`Close ${open.name}`} onClick={() => setFull(null)}>
          <Player path={open.path} on />
          <span className="absolute top-3 left-3 rounded border-2 border-white bg-black/60 px-2 font-bold text-white">{open.name}</span>
        </button>
      )}
    </div>
  );
}

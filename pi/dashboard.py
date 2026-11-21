#!/usr/bin/env python3
"""Web dashboard: DJI Action 2 live preview + an Android phone's camera, side by side.

  dashboard.py [--http 8080] [--https 8443]

  Dashboard:  http://<this machine>:8080/
  Phone:      https://<this machine>:8443/phone   (open on the Android phone, in Chrome)

DJI: "Start" runs action2.py (Bluetooth: pair, join Wi-Fi, start streaming to this machine). ffmpeg
receives the camera's RTMP push and turns it into JPEG frames, which the page shows as MJPEG.
Phone: the phone page captures its camera in the browser and sends it peer-to-peer (WebRTC) to every
open dashboard; this server only relays the connection setup messages. Browsers allow camera access
only on https pages, hence the second port with a self-signed certificate (one warning to accept).
"""
import argparse
import asyncio
import json
import signal
import socket
import ssl
import subprocess
import sys
import time
import uuid
from collections import deque
from pathlib import Path

from aiohttp import web

HERE = Path(__file__).resolve().parent
WEB = HERE / "web"
CERTS = HERE / "certs"
RTMP_PORT = 1935


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))   # no packet is sent; just picks the default-route address
        return s.getsockname()[0]
    finally:
        s.close()


class Dji:
    """Owns the two helper processes for the DJI preview and the latest JPEG frame."""

    def __init__(self):
        self.state = "idle"            # idle | starting | streaming | stopping
        self.log = deque(maxlen=40)
        self.frame = None
        self.frame_no = 0
        self.frame_time = 0.0
        self.cond = asyncio.Condition()
        self.ffmpeg = None
        self.ble = None
        self.tasks = []

    def say(self, line):
        self.log.append(f"{time.strftime('%H:%M:%S')}  {line}")

    @property
    def live(self):
        return time.monotonic() - self.frame_time < 3

    async def start(self, kbps):
        if self.state != "idle":
            return
        self.state = "starting"
        self.log.clear()
        url = f"rtmp://{local_ip()}:{RTMP_PORT}/live/cam"
        self.say(f"Waiting for the camera's video on {url}")
        self.ffmpeg = await asyncio.create_subprocess_exec(
            "ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
            "-listen", "1", "-i", f"rtmp://0.0.0.0:{RTMP_PORT}/live/cam",
            "-an", "-vf", "fps=15,scale=960:-2:out_range=full,format=yuvj420p", "-q:v", "6", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        self.ble = await asyncio.create_subprocess_exec(
            sys.executable, "-u", str(HERE / "action2.py"), "stream", "--seconds", "0",
            "--url", url, "--kbps", str(kbps),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, cwd=HERE)
        self.tasks = [asyncio.create_task(self._frames()), asyncio.create_task(self._ble_log()),
                      asyncio.create_task(self._ffmpeg_log())]

    async def _frames(self):
        """Split ffmpeg's output into JPEG images (each ends FF D9 and the next begins FF D8)."""
        buf = bytearray()
        out = self.ffmpeg.stdout
        while True:
            chunk = await out.read(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                cut = buf.find(b"\xff\xd9\xff\xd8")
                if cut < 0:
                    break
                await self._publish(bytes(buf[:cut + 2]))
                del buf[:cut + 2]
        if self.state in ("starting", "streaming"):
            self.say("Video ended (the camera stopped sending).")
            asyncio.create_task(self.stop())

    async def _publish(self, jpeg):
        if self.frame_no == 0 or not self.live:
            self.say("Video is arriving.")
        async with self.cond:
            self.frame, self.frame_no, self.frame_time = jpeg, self.frame_no + 1, time.monotonic()
            self.cond.notify_all()

    async def _ble_log(self):
        async for raw in self.ble.stdout:
            line = raw.decode(errors="replace").rstrip()
            # keep the informative lines; drop the per-packet hex traffic
            if not line or " SEND " in line or " RECV " in line or "PUSH" in line:
                continue
            self.say(line.split("  ", 1)[-1] if line[:1].isdigit() or line[:1] == " " else line)
            if ">>> Camera should now be streaming" in line and self.state == "starting":
                self.state = "streaming"
        code = await self.ble.wait()
        if self.state in ("starting", "streaming"):
            self.say(f"Bluetooth control ended (exit {code}).")
            asyncio.create_task(self.stop())

    async def _ffmpeg_log(self):
        async for raw in self.ffmpeg.stderr:
            line = raw.decode(errors="replace").rstrip()
            if line and "deprecated pixel format" not in line:
                self.say(f"ffmpeg: {line[:160]}")

    async def stop(self):
        if self.state in ("idle", "stopping"):
            return
        self.state = "stopping"
        self.say("Stopping...")
        if self.ble and self.ble.returncode is None:
            self.ble.send_signal(signal.SIGINT)      # action2.py then tells the camera to stop
            try:
                await asyncio.wait_for(self.ble.wait(), 40)
            except asyncio.TimeoutError:
                self.ble.kill()
        if self.ffmpeg and self.ffmpeg.returncode is None:
            self.ffmpeg.terminate()
            try:
                await asyncio.wait_for(self.ffmpeg.wait(), 5)
            except asyncio.TimeoutError:
                self.ffmpeg.kill()
        self.frame_time = 0.0
        self.say("Stopped.")
        self.state = "idle"


class Phone:
    """Relays WebRTC setup messages between the one phone and any number of dashboards."""

    def __init__(self):
        self.ws = None
        self.viewers = {}

    @staticmethod
    async def send(ws, data):
        try:
            await ws.send_json(data)
        except Exception:  # noqa: BLE001 - the other side has gone; its own handler cleans up
            pass

    async def handle(self, request):
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        if request.query.get("role") == "phone":
            old, self.ws = self.ws, ws
            if old is not None:
                await old.close()
            for vid in self.viewers:
                await self.send(ws, {"type": "viewer", "id": vid})
            try:
                async for msg in ws:
                    if msg.type == web.WSMsgType.TEXT:
                        d = json.loads(msg.data)
                        v = self.viewers.get(d.get("to"))
                        if v is not None:
                            await self.send(v, d)
            finally:
                if self.ws is ws:
                    self.ws = None
                    for v in self.viewers.values():
                        await self.send(v, {"type": "phone-gone"})
        else:
            vid = uuid.uuid4().hex[:8]
            self.viewers[vid] = ws
            if self.ws is not None:
                await self.send(self.ws, {"type": "viewer", "id": vid})
            try:
                async for msg in ws:
                    if msg.type == web.WSMsgType.TEXT and self.ws is not None:
                        d = json.loads(msg.data)
                        d["id"] = vid
                        await self.send(self.ws, d)
            finally:
                self.viewers.pop(vid, None)
                if self.ws is not None:
                    await self.send(self.ws, {"type": "bye", "id": vid})
        return ws


def make_app(args):
    dji, phone = Dji(), Phone()
    phone_url = f"https://{local_ip()}:{args.https}/phone"
    try:
        import segno
        qr_svg = segno.make(phone_url, error="m").svg_inline(scale=5, border=2, dark="#111", light="#fff")
    except ImportError:
        qr_svg = ""

    async def page(name):
        return web.Response(text=(WEB / name).read_text(), content_type="text/html",
                            headers={"Cache-Control": "no-store"})

    async def status(_r):
        return web.json_response({
            "dji": {"state": dji.state, "live": dji.live, "frames": dji.frame_no, "log": list(dji.log)},
            "phone": {"connected": phone.ws is not None, "viewers": len(phone.viewers)},
            "phone_url": phone_url, "qr": qr_svg})

    async def dji_start(request):
        kbps = int(request.query.get("kbps", 4000))
        await dji.start(max(1000, min(kbps, 10000)))
        return web.json_response({"state": dji.state})

    async def dji_stop(_r):
        asyncio.create_task(dji.stop())
        return web.json_response({"state": "stopping"})

    async def dji_mjpg(request):
        resp = web.StreamResponse(headers={
            "Content-Type": "multipart/x-mixed-replace; boundary=frame", "Cache-Control": "no-store"})
        await resp.prepare(request)
        last = -1
        try:
            while True:
                async with dji.cond:
                    await dji.cond.wait_for(lambda: dji.frame_no != last)
                    last, frame = dji.frame_no, dji.frame
                await resp.write(b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n" % len(frame)
                                 + frame + b"\r\n")
        except (ConnectionError, asyncio.CancelledError):
            pass
        return resp

    async def on_shutdown(_app):
        await dji.stop()

    app = web.Application()
    app.add_routes([
        web.get("/", lambda r: page("index.html")), web.get("/phone", lambda r: page("phone.html")),
        web.get("/api/status", status), web.post("/api/dji/start", dji_start), web.post("/api/dji/stop", dji_stop),
        web.get("/dji.mjpg", dji_mjpg), web.get("/ws", phone.handle)])
    app.on_shutdown.append(on_shutdown)
    return app, phone_url


def certificate():
    """Self-signed certificate so the phone page can be served over https."""
    crt, key = CERTS / "dashboard.crt", CERTS / "dashboard.key"
    if not crt.exists():
        CERTS.mkdir(exist_ok=True)
        ip = local_ip()
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
                        "-keyout", str(key), "-out", str(crt), "-subj", "/CN=actionlab dashboard",
                        "-addext", f"subjectAltName=IP:{ip},DNS:{socket.gethostname()}.local"],
                       check=True, capture_output=True)
        key.chmod(0o600)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(crt, key)
    return ctx


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--http", type=int, default=8080)
    ap.add_argument("--https", type=int, default=8443)
    args = ap.parse_args()
    app, phone_url = make_app(args)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", args.http).start()
    await web.TCPSite(runner, "0.0.0.0", args.https, ssl_context=certificate()).start()
    print(f"Dashboard: http://{local_ip()}:{args.http}/   (or http://{socket.gethostname()}.local:{args.http}/)")
    print(f"Phone:     {phone_url}", flush=True)
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, stop.set)
    await stop.wait()
    await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(main())

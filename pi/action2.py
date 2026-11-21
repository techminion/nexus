#!/usr/bin/env python3
"""Control a DJI Action 2 over Bluetooth LE from Linux (Raspberry Pi).

Python port of the Swift tools in this project, using the `bleak` library.

  action2.py scan   [--seconds 10]     list nearby Bluetooth LE devices, flag DJI ones
  action2.py listen [--seconds 30]     connect and log every message the camera sends
  action2.py pair                      pair with the camera (approve on its screen if asked)
  action2.py stream [--seconds 120]    camera joins Wi-Fi and livestreams over RTMP
                    [--url rtmp://..]  where to stream; default is a recorder on this machine

The protocol is DJI's "DUML" framing over GATT service FFF0 (notify FFF4, write FFF5).
The command sequence was reverse-engineered for the Osmo Pocket 3 (djictl, lib-osmo-ble)
and confirmed to work on the Action 2 in this project.

Wi-Fi name/password for `stream` come from wifi.conf next to this script
(lines `ssid=...` and `password=...`). They are sent only to the camera, never logged.
"""
import argparse
import asyncio
import signal
import socket
import subprocess
import sys
import time
from collections import Counter, namedtuple
from pathlib import Path

from bleak import BleakClient, BleakScanner

HERE = Path(__file__).resolve().parent
LOG_DIR = HERE / "logs"
DJI_COMPANY_ID = 0x08AA
NOTIFY_UUID = "0000fff4-0000-1000-8000-00805f9b34fb"
WRITE_UUID = "0000fff5-0000-1000-8000-00805f9b34fb"

# Same client id as the Mac tool, so the camera treats both as one paired client.
CLIENT_ID = "actionlab2mac01"
PAIR_PIN = "5160"

RES_1080P, FPS_30 = 0x0A, 0x03  # 0x47=480p 0x04=720p 0x0A=1080p; 0x02=25fps 0x03=30fps


# ---------------------------------------------------------------- DUML framing
def crc8(data: bytes) -> int:
    crc = 0x77
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8C if crc & 1 else crc >> 1
    return crc


def crc16(data: bytes) -> int:
    crc = 0x3692
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc


def duml(dst: int, seq: int, type_: int, set_: int, id_: int, payload: bytes, src: int = 0x02) -> bytes:
    length = 13 + len(payload)
    head = bytes([0x55, length & 0xFF, (length >> 8) | 0x04])  # 0x04 = version 1 in the high bits
    body = head + bytes([crc8(head), src, dst, seq & 0xFF, seq >> 8, type_, set_, id_]) + payload
    return body + crc16(body).to_bytes(2, "little")


def pack_string(s: str) -> bytes:
    b = s.encode()
    return bytes([len(b)]) + b


def pack_url(s: str) -> bytes:
    b = s.encode()
    return len(b).to_bytes(2, "little") + b


def config_payload(url: str, kbps: int) -> bytes:
    return bytes([0x00, 0x32, 0x00, RES_1080P]) + kbps.to_bytes(2, "little") + bytes([0x02, 0x00, FPS_30, 0, 0, 0]) + pack_url(url)


Frame = namedtuple("Frame", "src dst seq type set id payload")


def hexs(b: bytes, limit: int = 48) -> str:
    return b[:limit].hex(" ") + (" ..." if len(b) > limit else "")


# ---------------------------------------------------------------- logging
class Log:
    def __init__(self, name: str):
        LOG_DIR.mkdir(exist_ok=True)
        self.path = LOG_DIR / f"{name}-{time.strftime('%Y%m%d-%H%M%S')}.log"
        self.file = self.path.open("w")
        self.t0 = time.monotonic()

    def __call__(self, msg: str):
        line = f"{time.monotonic() - self.t0:8.3f}  {msg}"
        print(line, flush=True)
        self.file.write(line + "\n")
        self.file.flush()


# ---------------------------------------------------------------- camera link
class Camera:
    def __init__(self, log: Log, verbose: bool = False):
        self.log = log
        self.verbose = verbose
        self.client: BleakClient | None = None
        self.rx = bytearray()
        self.seq = 0x3000
        self.waiters: dict[int, asyncio.Future] = {}
        self.push_handlers = []          # callables(Frame) -> True if handled (suppresses logging)
        self.kinds: Counter = Counter()
        self.disconnected = asyncio.Event()
        self.chunk = 20

    async def connect(self, timeout: float = 20.0):
        self.log("Looking for DJI camera...")

        def is_dji(dev, adv):
            name = (dev.name or adv.local_name or "").lower()
            return "dji" in name or "osmo" in name or DJI_COMPANY_ID in adv.manufacturer_data

        dev = await BleakScanner.find_device_by_filter(is_dji, timeout=timeout)
        if dev is None:
            raise RuntimeError("No DJI camera found. Is it on, awake and in range?")
        self.log(f"Found {dev.name} [{dev.address}]. Connecting...")
        self.rx.clear()
        self.waiters.clear()
        self.disconnected = event = asyncio.Event()
        self.client = BleakClient(dev, disconnected_callback=lambda _c: event.set())
        await self.client.connect()
        # On the Pi the first few connection attempts often fail and are retried inside
        # connect(); each failure fires the callback, so only trust it from here on.
        event.clear()
        try:  # BlueZ only learns the real MTU on request; without it writes are cut to 20 bytes.
            backend = self.client._backend
            if hasattr(backend, "_acquire_mtu"):
                await backend._acquire_mtu()
            self.chunk = max(20, self.client.mtu_size - 3)
        except Exception as e:  # noqa: BLE001
            self.log(f"(could not read MTU: {e}; using 20-byte writes)")
        await self.client.start_notify(NOTIFY_UUID, self._on_data)
        self.log(f"Connected. Write size {self.chunk} bytes.")

    async def close(self):
        if self.client and self.client.is_connected:
            await self.client.disconnect()

    # ---- receive
    def _on_data(self, _char, data: bytearray):
        self.rx += data
        while True:
            start = self.rx.find(0x55)
            if start < 0:
                self.rx.clear()
                return
            del self.rx[:start]
            if len(self.rx) < 4:
                return
            length = (self.rx[1] | self.rx[2] << 8) & 0x3FF
            if length < 13 or crc8(self.rx[:3]) != self.rx[3]:
                del self.rx[:1]
                continue
            if len(self.rx) < length:
                return
            f = bytes(self.rx[:length])
            del self.rx[:length]
            if crc16(f[:-2]) != int.from_bytes(f[-2:], "little"):
                self.log("bad checksum, frame dropped")
                continue
            self._on_frame(Frame(f[4], f[5], f[6] | f[7] << 8, f[8], f[9], f[10], f[11:-2]))

    def _on_frame(self, f: Frame):
        is_reply = bool(f.type & 0x80)
        waiter = self.waiters.pop(f.seq, None) if is_reply else None
        kind = f"0x{f.src:02x} {'reply' if waiter else 'push '} {f.set:02x}/{f.id:02x}"
        self.kinds[kind] += 1
        if waiter and not waiter.done():
            waiter.set_result(f)
        handled = False if waiter else any(h(f) for h in self.push_handlers)
        if waiter or self.verbose or (not handled and self.kinds[kind] <= 3):
            self.log(f"RECV {kind}  seq={f.seq}  {len(f.payload)}B  {hexs(f.payload)}")

    # ---- send
    async def send(self, dst, type_, set_, id_, payload=b"", seq=None, secret=False, label=""):
        if seq is None:
            self.seq = (self.seq + 1) & 0xFFFF
            seq = self.seq
        frame = duml(dst, seq, type_, set_, id_, bytes(payload))
        shown = f"({len(frame)}B, contents hidden)" if secret else hexs(frame, 80)
        self.log(f"SEND {label}  ->0x{dst:02x} cmd {set_:02x}/{id_:02x}  {shown}")
        for i in range(0, len(frame), self.chunk):
            await self.client.write_gatt_char(WRITE_UUID, frame[i:i + self.chunk], response=False)
        return seq

    async def request(self, label, dst, set_, id_, payload=b"", timeout=5.0, secret=False):
        """Send a request and wait for the reply with the same sequence number. None on timeout."""
        self.seq = (self.seq + 1) & 0xFFFF
        fut = asyncio.get_running_loop().create_future()
        self.waiters[self.seq] = fut
        await self.send(dst, 0x40, set_, id_, payload, seq=self.seq, secret=secret, label=label)
        try:
            return (await asyncio.wait_for(fut, timeout)).payload
        except asyncio.TimeoutError:
            self.waiters.pop(self.seq, None)
            self.log(f"    no reply to '{label}' in {timeout:g}s")
            return None

    def summary(self):
        self.log("---- messages from camera ----")
        for kind, n in sorted(self.kinds.items()):
            self.log(f"  {n:5d}x  {kind}")
        self.log(f"Log saved to {self.log.path}")


def quiet_announcements(cam: Camera):
    """The camera repeats a 00/32 'here I am' push every second; don't log each one."""
    cam.push_handlers.append(lambda f: f.set == 0x00 and f.id == 0x32 and cam.kinds["0x88 push  00/32"] > 1)


async def pair(cam: Camera) -> bool:
    log = cam.log
    approved = asyncio.Event()

    def on_approval(f: Frame):
        if f.set == 0x07 and f.id == 0x46:
            log(f"RECV pairing approval: {hexs(f.payload)}")
            asyncio.ensure_future(cam.send(f.src, 0xC0, 0x07, 0x46, b"\x00", seq=f.seq, label="ack approval"))
            if f.payload[:1] == b"\x01":
                approved.set()
            return True
        return False

    cam.push_handlers[:] = [h for h in cam.push_handlers if getattr(h, "__name__", "") != "on_approval"]
    cam.push_handlers.append(on_approval)
    await cam.request("hello", 0x88, 0x00, 0x32, b"11\x00\x00\x00", timeout=3)
    r = await cam.request("pairing PIN", 0x07, 0x07, 0x45, pack_string(CLIENT_ID) + pack_string(PAIR_PIN), timeout=8)
    if r is None:
        return False
    status = r[1] if len(r) >= 2 else r[0]
    if status == 0x01:
        log("    already paired.")
        return True
    if status == 0x02:
        log("    >>> APPROVE THE CONNECTION ON THE CAMERA SCREEN (waiting 30s)")
        try:
            await asyncio.wait_for(approved.wait(), 30)
            log("    paired (approved).")
            return True
        except asyncio.TimeoutError:
            log("    not approved in time.")
            return False
    log(f"    unexpected pairing status {hexs(r)}")
    return False


async def reconnect(cam: Camera, tries: int) -> bool:
    """Reconnect and redo the (already approved) pairing handshake so commands are accepted."""
    for attempt in range(tries):
        try:
            await cam.connect(timeout=8)
            if await pair(cam):
                return True
        except Exception as e:  # noqa: BLE001
            cam.log(f"    reconnect attempt {attempt + 1} failed: {e}")
        await asyncio.sleep(2)
    return False


# ---------------------------------------------------------------- commands
async def cmd_scan(args):
    print(f"Scanning {args.seconds:g}s...")
    found = await BleakScanner.discover(timeout=args.seconds, return_adv=True)
    for dev, adv in sorted(found.values(), key=lambda x: -x[1].rssi):
        name = dev.name or adv.local_name
        dji = DJI_COMPANY_ID in adv.manufacturer_data or (name and ("dji" in name.lower() or "osmo" in name.lower()))
        if name or dji:
            print(f"{'[DJI] ' if dji else '      '}{name or '(no name)':28s} {dev.address}  rssi={adv.rssi}")
    print(f"{len(found)} devices seen.")


async def cmd_listen(args):
    log = Log("listen")
    cam = Camera(log, verbose=True)
    await cam.connect()
    try:
        await asyncio.wait_for(cam.disconnected.wait(), args.seconds)
        log("Camera disconnected.")
    except asyncio.TimeoutError:
        log("Time up.")
    finally:
        await cam.close()
        cam.summary()


async def cmd_pair(args):
    log = Log("pair")
    cam = Camera(log)
    quiet_announcements(cam)
    await cam.connect()
    try:
        ok = await pair(cam)
        log("Pairing: " + ("PAIRED" if ok else "FAILED"))
    finally:
        await cam.close()
        cam.summary()
    return 0 if ok else 1


def read_wifi():
    path = HERE / "wifi.conf"
    if not path.exists():
        raise SystemExit(f"wifi.conf not found at {path}")
    kv = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            kv[k.strip()] = v.strip()
    ssid, psk = kv.get("ssid", ""), kv.get("password", "")
    if not ssid or not psk or ssid == "YOUR_WIFI_NAME":
        raise SystemExit("wifi.conf needs ssid= and password=")
    return ssid, psk


def local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))  # no packet is sent; just picks the default-route address
        return s.getsockname()[0]
    finally:
        s.close()


def start_recorder(port: int, stamp: str):
    """ffmpeg waits for the camera's RTMP push, saves it untouched, and keeps a fresh snapshot."""
    rec = LOG_DIR / f"stream-{stamp}.mkv"
    snap = LOG_DIR / "latest.jpg"
    snap.unlink(missing_ok=True)
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin", "-y",
           "-skip_frame", "nokey", "-listen", "1", "-i", f"rtmp://0.0.0.0:{port}/live/cam",
           "-map", "0", "-c", "copy", str(rec),
           "-map", "0:v", "-vf", "fps=1", "-q:v", "4", "-update", "1", str(snap)]
    proc = subprocess.Popen(cmd, stdout=(LOG_DIR / "ffmpeg.log").open("w"), stderr=subprocess.STDOUT)
    return proc, rec, snap


async def cmd_stream(args):
    ssid, psk = read_wifi()
    log = Log("stream")
    stamp = log.path.stem.split("-", 1)[1]
    recorder = rec = snap = None
    url = args.url or (Path(args.url_file).expanduser().read_text().strip() if args.url_file else None)
    if not url:
        url = f"rtmp://{local_ip()}:{args.port}/live/cam"
        recorder, rec, snap = start_recorder(args.port, stamp)
        log(f"Recorder waiting on {url} -> {rec.name}")
    log(f"Wi-Fi details loaded (hidden). Stream target: {url.split('?')[0]}")  # query may hold a password

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    cam = Camera(log)
    quiet_announcements(cam)
    last_status = [0.0]

    def on_status(f: Frame):  # 0xEE/03: camera status once a second while in livestream mode
        if f.set == 0xEE and f.id == 0x03 and len(f.payload) >= 8:
            if time.monotonic() - last_status[0] >= 10:
                last_status[0] = time.monotonic()
                p = f.payload
                log(f"camera status: state={p[0]:02x}/{p[1]:02x}  streaming {int.from_bytes(p[2:6], 'little')}s  "
                    f"{int.from_bytes(p[6:8], 'little')} kbps")
            return True
        return False

    cam.push_handlers.append(on_status)
    results, started = [], False
    try:
        await cam.connect()
        if not await pair(cam):
            raise RuntimeError("pairing failed")
        results.append("pairing: ok")

        steps = [
            ("prepare livestream 1", 0x08, 0x02, 0xE1, b"\x1a", 5, False, False),
            ("prepare livestream 2", 0x08, 0x02, 0x8E, b"\x00\x01\x1c\x00", 5, False, False),
            ("join Wi-Fi", 0x07, 0x07, 0x47, pack_string(ssid) + pack_string(psk), 40, True, True),
            (f"configure stream 1080p30 {args.kbps}kbps", 0x08, 0x08, 0x78, config_payload(url, args.kbps), 5, True, False),
            ("START streaming", 0x08, 0x02, 0x8E, b"\x01\x01\x1a\x00\x01\x01", 5, False, False),
        ]
        for name, dst, set_, id_, payload, timeout, secret, required in steps:
            r = await cam.request(name, dst, set_, id_, payload, timeout=timeout, secret=secret)
            ok = r is not None and r[:1] == b"\x00"
            results.append(f"{name}: " + ("NO REPLY" if r is None else f"{'ok' if ok else 'FAILED'}, reply {hexs(r, 16)}"))
            if required and not ok:
                raise RuntimeError(f"required step '{name}' failed")
            if name.startswith("START"):
                started = True
        log(f">>> Camera should now be streaming to {url.split('?')[0]}" + ("" if args.seconds else "  (Ctrl-C to stop)"))

        # The video travels over Wi-Fi, so it keeps going even if Bluetooth drops
        # (common on a Pi 4 on 2.4 GHz Wi-Fi, which shares a radio with Bluetooth).
        deadline = time.monotonic() + args.seconds if args.seconds else None
        drops = 0
        while not stop.is_set():
            remaining = deadline - time.monotonic() if deadline else None
            if remaining is not None and remaining <= 0:
                break
            if cam.disconnected.is_set():
                if recorder and recorder.poll() is not None:
                    log("Recorder ended: the camera stopped sending video.")
                    break
                drops += 1
                if drops == 1:
                    log("Bluetooth link dropped; video continues over Wi-Fi.")
                if drops <= 3 and await reconnect(cam, tries=1):
                    continue
                waits = [asyncio.ensure_future(stop.wait())]
                await asyncio.wait(waits, timeout=min(5, remaining) if remaining else 5)
                continue
            waits = [asyncio.ensure_future(stop.wait()), asyncio.ensure_future(cam.disconnected.wait())]
            _, pending = await asyncio.wait(waits, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            for p in pending:
                p.cancel()
        log("Stop requested." if stop.is_set() else "Finished.")
    except RuntimeError as e:
        log(f"ERROR: {e}")
    finally:
        if started:
            if cam.disconnected.is_set():
                log("Reconnecting over Bluetooth to stop the stream...")
                await reconnect(cam, tries=4)
            if not cam.disconnected.is_set():
                r = await cam.request("stop streaming", 0x08, 0x02, 0x8E, b"\x01\x01\x1a\x00\x01\x02", timeout=4)
                results.append("stop streaming: " + ("ok" if r is not None and r[:1] == b"\x00" else "no confirmation"))
            else:
                results.append("stop streaming: NOT SENT (could not reconnect; stop it on the camera)")
        await cam.close()
        if recorder:
            await asyncio.sleep(1)
            recorder.send_signal(signal.SIGINT)   # lets ffmpeg finish the file cleanly
            try:
                recorder.wait(timeout=10)
            except subprocess.TimeoutExpired:
                recorder.kill()
            size = rec.stat().st_size if rec.exists() else 0
            log(f"Recording: {rec} ({size / 1e6:.1f} MB)" if size else "Recording: nothing was received")
            if snap.exists():
                log(f"Last snapshot: {snap}")
        log("---- step results ----")
        for r in results:
            log("  " + r)
        cam.summary()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("scan"); p.add_argument("--seconds", type=float, default=10)
    p = sub.add_parser("listen"); p.add_argument("--seconds", type=float, default=30)
    sub.add_parser("pair")
    p = sub.add_parser("stream")
    p.add_argument("--seconds", type=float, default=120, help="how long to stream; 0 = until Ctrl-C")
    p.add_argument("--url", help="RTMP target; default: record on this machine")
    p.add_argument("--url-file", help="read the RTMP target from this file (keeps a password off the command line)")
    p.add_argument("--port", type=int, default=1935)
    p.add_argument("--kbps", type=int, default=4000)
    args = ap.parse_args()
    try:
        sys.exit(asyncio.run({"scan": cmd_scan, "listen": cmd_listen, "pair": cmd_pair, "stream": cmd_stream}[args.cmd](args)) or 0)
    except RuntimeError as e:
        sys.exit(f"ERROR: {e}")


if __name__ == "__main__":
    main()

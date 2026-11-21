#!/usr/bin/env python3
"""Live preview from an Insta360 GO 3S over the camera's own Wi-Fi (TCP 192.168.42.1:6666).

  go3s_wifi.py --seconds 15 --out logs/go3s-preview     save the raw video (.h264 / .h265 added)
  go3s_wifi.py --seconds 0 --serve 7000                 pass the video to whoever connects on port 7000

The machine running this must already be on the camera's Wi-Fi (see go3s-preview.sh).
Packets on the socket:  total_len u32 LE | kind 00 00 | ...
  kind 06 = sync ("syNceNdinS"), 05 = keepalive, 04 = message (same layout as over Bluetooth),
  kind 01 = stream: type byte (20 = video, 30 = gyro, 40 = sync) | timestamp u64 LE | data.
Video data is a raw H.264/H.265 bitstream with start codes.
"""
import argparse
import asyncio
import sys
import time

from go3s import CODES, message, protobuf

SYNC = b"\x06\x00\x00syNceNdinS"
KEEPALIVE = b"\x05\x00\x00"
T0 = time.monotonic()


def log(s):
    print(f"{time.monotonic() - T0:7.3f}  {s}", file=sys.stderr, flush=True)


def packet(payload: bytes) -> bytes:
    return (len(payload) + 4).to_bytes(4, "little") + payload


def sniff_codec(data: bytes):
    """Look at the first NAL unit after a start code: H.265 VPS/SPS/PPS are types 32-34, H.264 SPS is 7."""
    i = data.find(b"\x00\x00\x01")
    if i < 0 or i + 3 >= len(data):
        return None
    b = data[i + 3]
    if (b >> 1) & 0x3F in (32, 33, 34) and not b & 0x80:
        return "h265"
    if b & 0x1F in (7, 8, 5, 1, 6, 9):
        return "h264"
    return None


class Preview:
    def __init__(self, args):
        self.args = args
        self.seq = 0
        self.video_bytes = 0
        self.video_packets = 0
        self.other = {}
        self.codec = None
        self.file = None
        self.head = bytearray()      # parameter sets + first frames, replayed to late viewers
        self.viewers = set()
        self.replies = {}

    async def send_msg(self, code, body=b"", wait=3.0):
        self.seq += 1
        fut = self.replies[self.seq] = asyncio.get_running_loop().create_future()
        log(f"SEND 0x{code:02x} {CODES.get(code, '?')} seq={self.seq} body {body.hex(' ')}")
        self.w.write(packet(message(code, self.seq, body)[4:]))
        await self.w.drain()
        try:
            return await asyncio.wait_for(fut, wait)
        except asyncio.TimeoutError:
            log("    no answer")
            return None

    async def keepalive(self):
        while True:
            await asyncio.sleep(2)
            self.w.write(packet(KEEPALIVE))
            await self.w.drain()

    async def reader(self):
        buf = bytearray()
        while True:
            chunk = await self.r.read(131072)
            if not chunk:
                log("camera closed the connection")
                return
            buf += chunk
            while len(buf) >= 4:
                n = int.from_bytes(buf[:4], "little")
                if n < 7 or n > 8_000_000:
                    log(f"bad packet length {n}; first bytes {bytes(buf[:24]).hex(' ')}")
                    return
                if len(buf) < n:
                    break
                self.on_packet(bytes(buf[4:n]))
                del buf[:n]

    def on_packet(self, p):
        kind = p[0]
        if kind == 0x01:
            if len(p) >= 12 and p[3] == 0x20:
                self.on_video(p[12:])
            else:
                t = p[3] if len(p) > 3 else -1
                n = self.other[t] = self.other.get(t, 0) + 1
                if n <= 2:
                    log(f"RECV stream type 0x{t:02x} {len(p)}B  {p[:40].hex(' ')}")
        elif kind == 0x04 and len(p) >= 12:
            code, seq, body = int.from_bytes(p[3:5], "little"), int.from_bytes(p[6:9], "little"), p[12:]
            decoded = protobuf(body)
            log(f"RECV code 0x{code:04x} {CODES.get(code, '?')} seq={seq} body {len(body)}B: {body.hex(' ')[:200]}"
                + (f"   => {decoded[:300]}" if decoded else ""))
            fut = self.replies.pop(seq, None) if code < 0x2000 else None
            if fut and not fut.done():
                fut.set_result((code, body))
        elif kind == 0x06:
            log("RECV sync echo")
        elif kind != 0x05:
            log(f"RECV kind 0x{kind:02x} {len(p)}B  {p[:40].hex(' ')}")

    def on_video(self, data):
        if self.video_packets == 0:
            self.codec = sniff_codec(data) or "bin"
            log(f"FIRST VIDEO packet {len(data)}B, codec looks like {self.codec}; starts {data[:16].hex(' ')}")
            if self.args.out:
                self.file = open(f"{self.args.out}.{self.codec}", "wb")
        self.video_packets += 1
        self.video_bytes += len(data)
        if len(self.head) < 400_000:
            self.head += data
        if self.file:
            self.file.write(data)
        for v in list(self.viewers):
            try:
                v.write(data)
            except Exception:  # noqa: BLE001
                self.viewers.discard(v)

    async def on_viewer(self, _r, w):
        log(f"viewer connected from {w.get_extra_info('peername')}")
        w.write(bytes(self.head))
        self.viewers.add(w)

    async def run(self):
        a = self.args
        log(f"Connecting to {a.host}:{a.port}...")
        self.r, self.w = await asyncio.wait_for(asyncio.open_connection(a.host, a.port), 10)
        log("Connected.")
        self.w.write(packet(SYNC) + packet(KEEPALIVE))
        await self.w.drain()
        tasks = [asyncio.create_task(self.reader()), asyncio.create_task(self.keepalive())]
        server = await asyncio.start_server(self.on_viewer, "0.0.0.0", a.serve) if a.serve else None
        try:
            await asyncio.sleep(0.5)
            await self.send_msg(0x0F)                       # GET_CURRENT_CAPTURE_STATUS (read-only check)
            body = bytes.fromhex(a.body) if a.body is not None else b""
            if a.live_view:
                # SET_ACCESS_CAMERA_FILE_STATE, state = LIVE_VIEW: tells the camera an app is showing its preview
                await self.send_msg(0x76, b"\x08\x05")
            r = await self.send_msg(0x01, body)             # START_LIVE_STREAM
            log(f"start-live-stream: {'no answer' if r is None else hex(r[0])}")
            end = time.monotonic() + a.seconds if a.seconds else None
            last = 0
            while not tasks[0].done() and (end is None or time.monotonic() < end):
                await asyncio.sleep(2)
                log(f"video {self.video_packets} packets, {self.video_bytes / 1e6:.2f} MB "
                    f"({(self.video_bytes - last) * 8 / 2e6:.2f} Mbit/s), other streams {self.other}")
                last = self.video_bytes
        finally:
            if not tasks[0].done():
                await self.send_msg(0x02, wait=2)           # STOP_LIVE_STREAM
            for t in tasks:
                t.cancel()
            if server:
                server.close()
            if self.file:
                self.file.close()
            self.w.close()
        log(f"RESULT video packets={self.video_packets} bytes={self.video_bytes} codec={self.codec}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="192.168.42.1")
    ap.add_argument("--port", type=int, default=6666)
    ap.add_argument("--seconds", type=float, default=15, help="0 = until interrupted")
    ap.add_argument("--out", help="save video to this path (extension added)")
    ap.add_argument("--serve", type=int, help="relay the video to TCP clients on this port")
    ap.add_argument("--live-view", action="store_true", help="announce live view (command 118) before starting")
    ap.add_argument("--body", help="hex protobuf body for START_LIVE_STREAM (default: empty)")
    args = ap.parse_args()
    try:
        asyncio.run(Preview(args).run())
    except (OSError, asyncio.TimeoutError) as e:
        sys.exit(f"ERROR: {type(e).__name__} {e}")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

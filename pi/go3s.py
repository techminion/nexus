#!/usr/bin/env python3
"""Talk to an Insta360 GO 3S over Bluetooth LE (Linux / Raspberry Pi, uses `bleak`).

  go3s.py listen [--seconds 20]        connect and print everything the camera sends
  go3s.py probe                        send harmless read-only requests, show the answers
  go3s.py wifi                         read the camera's own Wi-Fi name/password into go3s-wifi.conf
  go3s.py send CODE [HEXBODY]          send one request (code in hex, optional protobuf body)

Framing, worked out in this project:
  outer (BLE only):  FF | 07 phone->camera / 06 camera->phone | type (40 = message, 41 = sync)
                     | len u16 LE | inner | CRC-16/MODBUS LE
  inner (same as Insta360's Wi-Fi protocol):
      total_len u32 LE | 04 00 00 | code u16 LE | 02 | seq u24 LE | flags (80 from host) | 00 00 | protobuf body
Requests go to characteristic BE81, answers and notifications arrive on BE82.
Response code 0x00C8 = OK (200), 0x0190 = bad request (400), 0x01F4/0x01F5 = error.
"""
import argparse
import asyncio
import sys
import time
from collections import namedtuple

from bleak import BleakClient, BleakScanner

WRITE_UUID = "0000be81-0000-1000-8000-00805f9b34fb"
NOTIFY_UUID = "0000be82-0000-1000-8000-00805f9b34fb"

CODES = {
    0x01: "START_LIVE_STREAM", 0x02: "STOP_LIVE_STREAM", 0x03: "TAKE_PICTURE", 0x04: "START_CAPTURE",
    0x05: "STOP_CAPTURE", 0x07: "SET_OPTIONS", 0x08: "GET_OPTIONS", 0x09: "SET_PHOTOGRAPHY_OPTIONS",
    0x0A: "GET_PHOTOGRAPHY_OPTIONS", 0x0D: "GET_FILE_LIST", 0x0F: "GET_CURRENT_CAPTURE_STATUS",
    0x21: "OPEN_CAMERA_WIFI", 0x22: "CLOSE_CAMERA_WIFI", 0x27: "CHECK_AUTHORIZATION",
    0x28: "CANCEL_AUTHORIZATION", 0x56: "REQUEST_AUTHORIZATION", 0x57: "CANCEL_REQUEST_AUTHORIZATION",
    0xC8: "OK", 0x190: "BAD_REQUEST", 0x1F4: "ERROR", 0x1F5: "NOT_IMPLEMENTED",
    0x2003: "BATTERY_UPDATE", 0x2011: "AUTHORIZATION_RESULT",
    0x2004: "BATTERY_LOW", 0x2006: "STORAGE_UPDATE", 0x2007: "STORAGE_FULL", 0x2009: "CAPTURE_STOPPED",
    0x2010: "CURRENT_CAPTURE_STATUS", 0x2017: "CAM_WIFI_START",
}


def crc16_modbus(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def wrap(inner: bytes, type_: int = 0x40) -> bytes:
    # Byte 1 is the direction: 07 = phone -> camera, 06 = camera -> phone.
    # (Frames sent with 06 are simply echoed back by the camera's Bluetooth chip.)
    head = bytes([0xFF, 0x07, type_]) + len(inner).to_bytes(2, "little") + inner
    return head + crc16_modbus(head).to_bytes(2, "little")


def message(code: int, seq: int, body: bytes = b"") -> bytes:
    rest = bytes([0x04, 0, 0]) + code.to_bytes(2, "little") + b"\x02" + seq.to_bytes(3, "little") + b"\x80\x00\x00" + body
    return (len(rest) + 4).to_bytes(4, "little") + rest


Msg = namedtuple("Msg", "kind code seq flags body raw")


def parse_inner(inner: bytes) -> Msg:
    if len(inner) >= 16 and inner[4] == 0x04:
        # byte 10 is the sequence number (1..254); bytes 11-12 are a fragment offset
        return Msg("message", int.from_bytes(inner[7:9], "little"), inner[10], inner[13], inner[16:], inner)
    kind = {0x05: "keepalive", 0x06: "sync"}.get(inner[4] if len(inner) > 4 else -1, "other")
    return Msg(kind, None, None, None, inner, inner)


def protobuf(b: bytes, depth: int = 0) -> str:
    """Best-effort schema-less protobuf dump: field numbers, varints, strings, nested messages."""
    out, i = [], 0
    try:
        while i < len(b):
            key, shift = 0, 0
            while True:
                c = b[i]; i += 1
                key |= (c & 0x7F) << shift; shift += 7
                if not c & 0x80:
                    break
            field, wt = key >> 3, key & 7
            if field == 0:
                raise ValueError
            if wt == 0:
                v, shift = 0, 0
                while True:
                    c = b[i]; i += 1
                    v |= (c & 0x7F) << shift; shift += 7
                    if not c & 0x80:
                        break
                out.append(f"{field}={v}")
            elif wt == 2:
                n, shift = 0, 0
                while True:
                    c = b[i]; i += 1
                    n |= (c & 0x7F) << shift; shift += 7
                    if not c & 0x80:
                        break
                chunk = b[i:i + n]
                if len(chunk) != n:
                    raise ValueError
                i += n
                if n and all(32 <= x < 127 for x in chunk):
                    out.append(f'{field}="{chunk.decode()}"')
                else:
                    nested = protobuf(chunk, depth + 1) if n and depth < 4 else None
                    out.append(f"{field}={{{nested}}}" if nested else f"{field}=<{chunk.hex(' ')}>")
            elif wt == 5:
                out.append(f"{field}=f32:{b[i:i + 4].hex()}"); i += 4
            elif wt == 1:
                out.append(f"{field}=f64:{b[i:i + 8].hex()}"); i += 8
            else:
                raise ValueError
    except (IndexError, ValueError):
        return ""
    return " ".join(out)


def fields(b: bytes):
    """Yield (field number, value) for the varint and length-delimited fields of a protobuf message."""
    i = 0

    def varint():
        nonlocal i
        v, shift = 0, 0
        while True:
            c = b[i]; i += 1
            v |= (c & 0x7F) << shift; shift += 7
            if not c & 0x80:
                return v
    while i < len(b):
        key = varint()
        wt = key & 7
        if wt == 0:
            yield key >> 3, varint()
        elif wt == 2:
            n = varint()
            yield key >> 3, b[i:i + n]; i += n
        elif wt == 5:
            i += 4
        elif wt == 1:
            i += 8
        else:
            return


class GO3S:
    def __init__(self, quiet_codes=()):
        self.client = None
        self.rx = bytearray()
        self.seq = 0
        self.waiters = {}
        self.t0 = time.monotonic()
        self.quiet = set(quiet_codes)
        self.seen = {}
        self.chunk = 20
        self.hide_seqs = set()   # replies whose body must not be printed (they hold a password)

    def log(self, s):
        print(f"{time.monotonic() - self.t0:7.3f}  {s}", flush=True)

    async def connect(self):
        self.log("Looking for GO 3S...")
        dev = await BleakScanner.find_device_by_filter(
            lambda d, adv: "GO 3" in (d.name or adv.local_name or ""), timeout=15)
        if dev is None:
            raise RuntimeError("GO 3S not found. Is it on and awake?")
        self.log(f"Found {dev.name} [{dev.address}]. Connecting...")
        self.client = BleakClient(dev)
        await self.client.connect()
        try:
            backend = self.client._backend
            if hasattr(backend, "_acquire_mtu"):
                await backend._acquire_mtu()
            self.chunk = max(20, self.client.mtu_size - 3)
        except Exception:  # noqa: BLE001
            pass
        self.synced = asyncio.Event()
        await self.client.start_notify(NOTIFY_UUID, self._on_data)
        self.log(f"Connected. Write size {self.chunk} bytes.")
        # Handshake: the camera sends a type-41 "AB BA" hello; the phone answers with seven zero bytes.
        try:
            await asyncio.wait_for(self.synced.wait(), 4)
        except asyncio.TimeoutError:
            self.log("(no hello from camera; sending sync anyway)")
        await self.write(wrap(bytes(7), 0x41), "sync reply")
        await asyncio.sleep(0.5)

    async def close(self):
        if self.client and self.client.is_connected:
            await self.client.disconnect()

    def _on_data(self, _c, data):
        self.rx += data
        while True:
            start = self.rx.find(b"\xff\x06")
            if start < 0:
                if self.rx:
                    self.log(f"RECV unframed {len(self.rx)}B  {bytes(self.rx).hex(' ')}")
                self.rx.clear()
                return
            if start:
                self.log(f"RECV unframed {start}B  {bytes(self.rx[:start]).hex(' ')}")
                del self.rx[:start]
            if len(self.rx) < 5:
                return
            n = int.from_bytes(self.rx[3:5], "little")
            if len(self.rx) < n + 7:
                return
            frame = bytes(self.rx[:n + 7])
            del self.rx[:n + 7]
            ok = crc16_modbus(frame[:-2]) == int.from_bytes(frame[-2:], "little")
            self._on_frame(frame[2], frame[5:-2], ok)

    def _on_frame(self, type_, inner, crc_ok):
        if type_ != 0x40:
            self.log(f"RECV type {type_:02x}  {inner.hex(' ')}{'' if crc_ok else '  (BAD CRC)'}")
            if type_ == 0x41 and inner.startswith(b"\xab\xba"):
                self.synced.set()   # camera's hello; connect() answers it
            return
        m = parse_inner(inner)
        if m.kind != "message":
            self.log(f"RECV {m.kind}  {inner.hex(' ')}")
            return
        waiter = self.waiters.pop(m.seq, None) if m.code < 0x2000 else None
        if waiter and not waiter.done():
            waiter.set_result(m)
        n = self.seen[m.code] = self.seen.get(m.code, 0) + 1
        if m.code in self.quiet and n > 2 and not waiter:
            return
        name = CODES.get(m.code, "?")
        if m.seq in self.hide_seqs and m.code < 0x2000:
            self.log(f"RECV code 0x{m.code:04x} {name:26s} seq={m.seq} body {len(m.body)}B (hidden)")
            return
        decoded = protobuf(m.body)
        self.log(f"RECV code 0x{m.code:04x} {name:26s} seq={m.seq} flags={m.flags:02x} hdr={inner[14:16].hex()} "
                 f"body {len(m.body)}B: {m.body.hex(' ')[:300]}" + (f"   => {decoded[:400]}" if decoded else "") +
                 ("" if crc_ok else "  (BAD CRC)"))

    async def write(self, frame: bytes, label: str):
        self.log(f"SEND {label}  {frame.hex(' ')}")
        for i in range(0, len(frame), self.chunk):
            await self.client.write_gatt_char(WRITE_UUID, frame[i:i + self.chunk], response=False)

    async def request(self, code: int, body: bytes = b"", timeout: float = 4.0, wrapped: bool = True,
                      hide: bool = False):
        self.seq = self.seq % 254 + 1
        if hide:
            self.hide_seqs.add(self.seq)
        fut = asyncio.get_running_loop().create_future()
        self.waiters[self.seq] = fut
        inner = message(code, self.seq, body)
        await self.write(wrap(inner) if wrapped else inner,
                         f"0x{code:02x} {CODES.get(code, '?')} seq={self.seq}{'' if wrapped else ' (bare)'}")
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            self.waiters.pop(self.seq, None)
            self.log(f"    no answer in {timeout:g}s")
            return None


async def cmd_listen(args):
    cam = GO3S()
    await cam.connect()
    try:
        await asyncio.sleep(args.seconds)
    finally:
        await cam.close()


async def cmd_probe(args):
    cam = GO3S(quiet_codes={0x2061})
    await cam.connect()
    try:
        await asyncio.sleep(1.5)
        r = await cam.request(0x0F)                       # GET_CURRENT_CAPTURE_STATUS, wrapped
        if r is None:
            cam.log("Trying the same request without the FF 06 wrapper...")
            r = await cam.request(0x0F, wrapped=False)
        cam.log("RESULT capture-status: " + ("no answer" if r is None else f"code 0x{r.code:04x} {CODES.get(r.code, '?')}"))
        await asyncio.sleep(1)
    finally:
        await cam.close()


async def cmd_send(args):
    cam = GO3S(quiet_codes={0x2061})
    await cam.connect()
    try:
        await asyncio.sleep(1)
        await cam.request(int(args.code, 16), bytes.fromhex(args.body or ""), timeout=args.wait)
        await asyncio.sleep(args.linger)
    finally:
        await cam.close()


WIFI_FILE = "go3s-wifi.conf"


async def cmd_wifi(args):
    """Ask the camera for its own Wi-Fi name and password; save them (password is never printed)."""
    import os
    cam = GO3S(quiet_codes={0x2061})
    await cam.connect()
    try:
        await asyncio.sleep(1)
        r = await cam.request(0x08, bytes([0x08, 36]), hide=True)      # GET_OPTIONS: WIFI_INFO
        if r is None or r.code != 0xC8:
            raise RuntimeError("camera did not return its Wi-Fi details")
        info = {}
        for f, v in fields(r.body):
            if f == 2:
                for f2, v2 in fields(v):
                    if f2 == 36:
                        info = dict(fields(v2))
        ssid = info.get(1, b"").decode(errors="replace")
        psk = info.get(2, b"").decode(errors="replace")
        fd = os.open(WIFI_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(f"ssid={ssid}\npassword={psk}\n")
        cam.log(f"RESULT wifi: ssid={ssid!r} password={'*' * len(psk)} ({len(psk)} chars) "
                f"channel={info.get(3)} other fields={sorted(k for k in info if k > 3)} -> saved to {WIFI_FILE}")
        await asyncio.sleep(args.linger)
    finally:
        await cam.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("listen"); p.add_argument("--seconds", type=float, default=20)
    sub.add_parser("probe")
    p = sub.add_parser("wifi"); p.add_argument("--linger", type=float, default=1)
    p = sub.add_parser("send"); p.add_argument("code"); p.add_argument("body", nargs="?")
    p.add_argument("--wait", type=float, default=5); p.add_argument("--linger", type=float, default=2)
    args = ap.parse_args()
    try:
        asyncio.run({"listen": cmd_listen, "probe": cmd_probe, "send": cmd_send, "wifi": cmd_wifi}[args.cmd](args))
    except RuntimeError as e:
        sys.exit(f"ERROR: {e}")


if __name__ == "__main__":
    main()

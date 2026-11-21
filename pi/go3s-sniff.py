#!/usr/bin/env python3
"""Diagnostics while on the camera's Wi-Fi: `sniff SECS` tallies traffic on wlan0 (needs root),
`scan HOST` finds open TCP ports."""
import asyncio, socket, struct, sys, time


def sniff(secs):
    s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(3))
    s.bind(("wlan0", 0)); s.settimeout(0.5)
    tally, end = {}, time.time() + secs
    while time.time() < end:
        try:
            f = s.recv(65535)
        except socket.timeout:
            continue
        if f[12:14] != b"\x08\x00":
            key = f"ethertype {f[12:14].hex()}"
        else:
            ihl = (f[14] & 15) * 4; proto = f[23]
            src, dst = socket.inet_ntoa(f[26:30]), socket.inet_ntoa(f[30:34])
            if proto in (6, 17):
                sp, dp = struct.unpack(">HH", f[14 + ihl:18 + ihl])
                key = f"{'tcp' if proto == 6 else 'udp'} {src}:{sp} -> {dst}:{dp}"
            else:
                key = f"proto {proto} {src} -> {dst}"
        c = tally.setdefault(key, [0, 0, f[42:74]]); c[0] += 1; c[1] += len(f)
    for k, (n, b, sample) in sorted(tally.items(), key=lambda kv: -kv[1][1]):
        print(f"SNIFF {n:6d} pkts {b:9d} B  {k}" + ("" if "6666" in k else f"   sample {sample.hex(' ')}"))


async def scan(host):
    sem, found = asyncio.Semaphore(400), []

    async def one(p):
        async with sem:
            try:
                _, w = await asyncio.wait_for(asyncio.open_connection(host, p), 1.5)
                found.append(p); w.close()
            except Exception:
                pass
    await asyncio.gather(*(one(p) for p in range(1, 65536)))
    print("SCAN open tcp ports:", sorted(found))


if sys.argv[1] == "sniff":
    sniff(float(sys.argv[2]))
else:
    asyncio.run(scan(sys.argv[2]))

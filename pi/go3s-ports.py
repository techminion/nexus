#!/usr/bin/env python3
"""Connect to each given camera port, stay 5 s, report what arrives (first bytes and volume)."""
import asyncio, sys


async def probe(host, port):
    try:
        r, w = await asyncio.wait_for(asyncio.open_connection(host, port), 3)
    except Exception as e:
        print(f"PORT {port}: connect failed {type(e).__name__}"); return
    total, first = 0, b""
    try:
        end = asyncio.get_running_loop().time() + 5
        while asyncio.get_running_loop().time() < end:
            try:
                d = await asyncio.wait_for(r.read(65536), 1)
            except asyncio.TimeoutError:
                continue
            if not d:
                print(f"PORT {port}: closed by camera"); break
            if len(first) < 96:
                first += d[:96 - len(first)]
            total += len(d)
    except Exception as e:
        print(f"PORT {port}: {type(e).__name__} {e}")
    print(f"PORT {port}: received {total} B; first bytes {first.hex(' ')}")
    if total > 100000:
        open(f"logs/go3s-port{port}.bin", "wb").write(first)
    w.close()


async def main():
    await asyncio.gather(*(probe(sys.argv[1], int(p)) for p in sys.argv[2:]))

asyncio.run(main())

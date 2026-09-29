import asyncio

LISTEN = ("127.0.0.1", 11500)
UPSTREAM = ("100.126.54.48", 11434)
HOST_HEADER = b"127.0.0.1:11434"
MAX_HEAD = 65536

async def read_head(r):
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = await r.read(4096)
        if not chunk or len(buf) > MAX_HEAD:
            return None, b""
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    return head, rest

def rewrite(head):
    lines = head.split(b"\r\n")
    out = [lines[0]]
    for line in lines[1:]:
        low = line.lower()
        if low.startswith((b"host:", b"connection:", b"keep-alive:")):
            continue
        out.append(line)
    out.append(b"Host: " + HOST_HEADER)
    out.append(b"Connection: close")
    return b"\r\n".join(out) + b"\r\n\r\n"

async def pipe(r, w):
    try:
        while (b := await r.read(65536)):
            w.write(b); await w.drain()
    except Exception:
        pass
    finally:
        try: w.close()
        except Exception: pass

async def handle(cr, cw):
    head, rest = await read_head(cr)
    if head is None:
        cw.close(); return
    try:
        sr, sw = await asyncio.open_connection(*UPSTREAM)
    except Exception:
        cw.close(); return
    sw.write(rewrite(head) + rest)
    await sw.drain()
    await asyncio.gather(pipe(cr, sw), pipe(sr, cw))

async def main():
    s = await asyncio.start_server(handle, *LISTEN)
    print(f"{LISTEN[0]}:{LISTEN[1]} -> {UPSTREAM[0]}:{UPSTREAM[1]}", flush=True)
    async with s:
        await s.serve_forever()

asyncio.run(main())

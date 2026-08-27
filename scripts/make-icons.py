#!/usr/bin/env python3
import os
import struct
import zlib

ROOT = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
os.makedirs(ROOT, exist_ok=True)


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path: str, size: int) -> None:
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        for x in range(size):
            r, g, b, a = pixel(x, y, size)
            raw.extend((r, g, b, a))
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(png)


def pixel(x: int, y: int, size: int):
    # Warm paper rounded square with a sage margin mark and a lemon highlight bar.
    nx = (x + 0.5) / size
    ny = (y + 0.5) / size
    paper = (244, 239, 230, 255)
    sage = (63, 107, 82, 255)
    lemon = (246, 226, 122, 255)
    ink = (28, 23, 18, 255)

    radius = 0.22
    in_x = radius <= nx <= 1 - radius or radius <= ny <= 1 - radius
    # rounded rect via corner distance
    cx = min(max(nx, radius), 1 - radius)
    cy = min(max(ny, radius), 1 - radius)
    if (nx - cx) ** 2 + (ny - cy) ** 2 > radius * radius and not (
        radius <= nx <= 1 - radius and radius <= ny <= 1 - radius
    ):
        return (0, 0, 0, 0)

    color = paper
    # margin line
    if 0.22 <= nx <= 0.30 and 0.18 <= ny <= 0.82:
        color = sage
    # highlight stroke
    if 0.38 <= nx <= 0.82 and 0.42 <= ny <= 0.58:
        color = lemon
    # small comment dot
    if (nx - 0.78) ** 2 + (ny - 0.28) ** 2 <= 0.045 ** 2:
        color = sage
    # ink tick
    if 0.38 <= nx <= 0.72 and 0.48 <= ny <= 0.52:
        color = ink
        return color
    return color


for size in (16, 32, 48, 128):
    write_png(os.path.join(ROOT, f"icon{size}.png"), size)
    print("wrote", size)

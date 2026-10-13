#!/usr/bin/env python3
"""Renders the extension icons (Figma-style comment pin with a plus) without dependencies.

Usage: python3 tools/make_icons.py
"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "extension", "icons")
SIZES = (16, 32, 48, 128)
BLUE = (13, 153, 255)
WHITE = (255, 255, 255)
SS = 8  # supersampling per axis


def in_pin(x, y):
    """Pin: rounded square, sharp-ish bottom-left corner (the pin tip). Unit coordinates."""
    x0, y0, x1, y1 = 0.06, 0.06, 0.94, 0.94
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    big = (x1 - x0) / 2
    tip = 0.07
    corners = (
        (x0 + big, y0 + big, big, x < x0 + big and y < y0 + big),  # top-left
        (x1 - big, y0 + big, big, x > x1 - big and y < y0 + big),  # top-right
        (x1 - big, y1 - big, big, x > x1 - big and y > y1 - big),  # bottom-right
        (x0 + tip, y1 - tip, tip, x < x0 + tip and y > y1 - tip),  # bottom-left
    )
    for cx, cy, r, inside_corner in corners:
        if inside_corner:
            return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    return True


def in_plus(x, y):
    c, half_len, half_w = 0.5, 0.21, 0.055
    return (abs(x - c) <= half_len and abs(y - c) <= half_w) or (abs(y - c) <= half_len and abs(x - c) <= half_w)


def render(size):
    rows = []
    for py in range(size):
        row = bytearray([0])  # filter type: none
        for px in range(size):
            pin = plus = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = (px + (sx + 0.5) / SS) / size
                    y = (py + (sy + 0.5) / SS) / size
                    if in_pin(x, y):
                        pin += 1
                        if in_plus(x, y):
                            plus += 1
            total = SS * SS
            alpha = pin / total
            if pin:
                t = plus / pin
                rgb = [round(BLUE[i] * (1 - t) + WHITE[i] * t) for i in range(3)]
            else:
                rgb = [0, 0, 0]
            row += bytes(rgb + [round(alpha * 255)])
        rows.append(bytes(row))
    return b"".join(rows)


def write_png(path, size, raw):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, f"icon{size}.png")
        write_png(path, size, render(size))
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()

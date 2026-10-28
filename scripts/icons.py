"""Writes the app icons (8-bit RGBA PNG) from pixel grids. Run: python3 scripts/icons.py"""
import struct, zlib

def png(path, grid, palette):
    rows = b"".join(b"\0" + b"".join(bytes(palette[c]) for c in row) for row in grid)
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    h, w = len(grid), len(grid[0])
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))

# A meeple, lit from the top left.
FRONT = [
    "...LL...",
    "..LOOO..",
    "..OOOD..",
    "LOOOOOOD",
    ".OOOOOD.",
    "..OOOD..",
    ".OOD.OD.",
    ".OD...D.",
]
png("src/appmeta/icon_front_8x8.png", FRONT, {
    ".": (0, 0, 0, 0), "O": (255, 140, 0, 255), "L": (255, 190, 90, 255), "D": (190, 90, 0, 255),
})

BACK = [
    "....###....",
    "...#####...",
    "...#####...",
    "..#######..",
    "###########",
    ".#########.",
    "...#####...",
    "..###.###..",
    "..##...##..",
    ".###...###.",
    ".###...###.",
]
png("src/appmeta/icon_back_11x11.png", BACK, {".": (0, 0, 0, 0), "#": (255, 255, 255, 255)})

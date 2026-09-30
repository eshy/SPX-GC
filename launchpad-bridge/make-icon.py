# Generates launchpad-bridge.ico (a small Launchpad grid in the bridge's colours).
# Pure Python, no dependencies:  python make-icon.py
import struct
import zlib

BODY = (24, 24, 28, 255)
OFF = (58, 58, 64, 255)
Y, G, R, B = (170, 140, 40, 255), (40, 200, 90, 255), (230, 50, 50, 255), (60, 110, 230, 255)
P, O, W = (150, 70, 200, 255), (235, 130, 30, 255), (220, 220, 220, 255)
_ = OFF

# 8x8 version of the real layout (large sizes)
GRID8 = [
    [Y, G, Y, Y, Y, Y, Y, Y],   # preview row
    [Y, Y, R, Y, Y, Y, Y, Y],   # program row
    [_, _, _, _, B, B, B, B],   # quick transitions
    [_, _, _, _, _, _, _, _],
    [_, _, _, _, _, _, _, _],
    [P, P, P, P, P, P, P, P],   # SPX items
    [P, P, P, P, P, P, P, P],
    [G, O, _, W, W, _, _, R],   # play, stop, prev, next, panic
]
# 4x4 simplification (small sizes)
GRID4 = [
    [Y, G, R, Y],
    [_, _, B, B],
    [P, P, P, P],
    [G, O, W, R],
]


def render(size):
    grid = GRID8 if size >= 48 else GRID4
    n = len(grid)
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    radius = size * 0.18
    for y in range(size):
        for x in range(size):
            # rounded-square body
            cx = min(max(x + 0.5, radius), size - radius)
            cy = min(max(y + 0.5, radius), size - radius)
            if (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= radius ** 2:
                px[y][x] = BODY
    margin = size * 0.12
    cell = (size - 2 * margin) / n
    gap = max(1.0, cell * 0.18)
    for r in range(n):
        for c in range(n):
            x0 = margin + c * cell + gap / 2
            y0 = margin + r * cell + gap / 2
            x1 = x0 + cell - gap
            y1 = y0 + cell - gap
            for y in range(int(y0), int(y1 + 0.999)):
                for x in range(int(x0), int(x1 + 0.999)):
                    if 0 <= x < size and 0 <= y < size and x + 0.5 >= x0 and x + 0.5 <= x1 + 0.5 and y + 0.5 >= y0 and y + 0.5 <= y1 + 0.5:
                        px[y][x] = grid[r][c]
    return px


def png(px):
    h, w = len(px), len(px[0])
    raw = b''.join(b'\x00' + b''.join(bytes(p) for p in row) for row in px)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


sizes = [16, 24, 32, 48, 64, 128, 256]
images = [png(render(s)) for s in sizes]
header = struct.pack('<HHH', 0, 1, len(sizes))
offset = 6 + 16 * len(sizes)
entries = b''
for s, img in zip(sizes, images):
    entries += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(img), offset)
    offset += len(img)
with open('launchpad-bridge.ico', 'wb') as f:
    f.write(header + entries + b''.join(images))
print('wrote launchpad-bridge.ico')

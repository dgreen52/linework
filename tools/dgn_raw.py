"""Minimal DGN v7 (ISFF) element encoder used ONLY to build synthetic test fixtures.

GDAL's OGR "DGN" driver creates the base file (TCB, seed elements, line strings,
shapes, complex chains, text). It cannot write arcs, ellipses, curves, text
nodes, cells, type-3 lines, colour tables or deleted elements, so this module
encodes those from the publicly documented ISFF element layout and appends them
before the end-of-design marker. Every fixture produced this way is read back
with OGR (an independent implementation) to build the test oracle, so the JS
reader is never only checked against this writer.
"""
import math
import struct

ELEM_EOD = b"\xff\xff"


def i32(v):
    """Signed 32-bit int in DGN 'middle-endian' order (high 16-bit word first, each word LE)."""
    v &= 0xFFFFFFFF
    return bytes([(v >> 16) & 0xFF, (v >> 24) & 0xFF, v & 0xFF, (v >> 8) & 0xFF])


def u16(v):
    return struct.pack("<H", v & 0xFFFF)


def vax_d(x):
    """IEEE double -> VAX D-float (the DGN v7 double format)."""
    if x == 0:
        return b"\x00" * 8
    sign = 1 if x < 0 else 0
    m, e = math.frexp(abs(x))  # abs(x) = m * 2**e with 0.5 <= m < 1 == VAX 0.1f form
    vexp = e + 128
    if not 0 < vexp < 256:
        raise ValueError("out of VAX range")
    frac = int(round((m * 2 - 1) * (1 << 55)))  # 55 fraction bits after the hidden bit
    frac = min(frac, (1 << 55) - 1)
    hi = (sign << 31) | (vexp << 23) | (frac >> 32)
    lo = frac & 0xFFFFFFFF
    words = [(hi >> 16) & 0xFFFF, hi & 0xFFFF, (lo >> 16) & 0xFFFF, lo & 0xFFFF]
    return b"".join(struct.pack("<H", w) for w in words)


def rad50(name):
    alpha = " ABCDEFGHIJKLMNOPQRSTUVWXYZ$.?0123456789"
    name = (name.upper() + "      ")[:6]
    out = b""
    for k in (0, 3):
        v = 0
        for ch in name[k:k + 3]:
            v = v * 40 + max(0, alpha.find(ch))
        out += u16(v)
    return out


class Ctx:
    """Master units -> UOR integers, honouring the global origin (raw = (x + origin) * uor)."""

    def __init__(self, uor_per_master, origin=(0.0, 0.0)):
        self.uor = uor_per_master
        self.ox, self.oy = origin

    def ix(self, x):
        return int(round((x + self.ox) * self.uor))

    def iy(self, y):
        return int(round((y + self.oy) * self.uor))

    def dx(self, x):
        return (x + self.ox) * self.uor

    def dy(self, y):
        return (y + self.oy) * self.uor


def _range_word(v):
    # range values are stored with the sign bit flipped (offset binary)
    return i32((v ^ 0x80000000) & 0xFFFFFFFF)


def header(etype, level, body_len, rng, color=0, weight=0, style=0, complex_=False, deleted=False, props=0):
    """36-byte element header. body_len = bytes after the header; rng = (xlo, ylo, xhi, yhi) in UOR."""
    size = 36 + body_len
    if size % 2:
        raise ValueError("odd element size")
    b = bytearray()
    b.append((level & 0x3F) | (0x80 if complex_ else 0))
    b.append((etype & 0x7F) | (0x80 if deleted else 0))
    b += u16((size - 4) // 2)
    xlo, ylo, xhi, yhi = rng
    for v in (xlo, ylo, 0, xhi, yhi, 0):
        b += _range_word(v)
    b += u16(0)                      # graphic group
    b += u16((size - 32) // 2)       # attribute index -> no attribute data
    b += u16(props)
    b.append((style & 7) | ((weight & 0x1F) << 3))
    b.append(color & 0xFF)
    assert len(b) == 36
    return bytes(b)


def _rng_pts(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys))


def line3(ctx, a, b, level=1, color=0, **kw):
    p = [(ctx.ix(a[0]), ctx.iy(a[1])), (ctx.ix(b[0]), ctx.iy(b[1]))]
    body = b"".join(i32(v) for q in p for v in q)
    return header(3, level, len(body), _rng_pts(p), color=color, **kw) + body


def multipoint(etype, ctx, pts, level=1, color=0, **kw):
    """Line string (4), shape (6) or curve (11)."""
    p = [(ctx.ix(x), ctx.iy(y)) for x, y in pts]
    body = u16(len(p)) + b"".join(i32(v) for q in p for v in q)
    return header(etype, level, len(body), _rng_pts(p), color=color, **kw) + body


def arc16(ctx, c, r1, r2, rot_deg, start_deg, sweep_deg, level=1, color=0, **kw):
    sweep = int(round(abs(sweep_deg) * 360000))
    sw = bytearray(i32(sweep))
    if sweep_deg < 0:
        sw[1] |= 0x80               # sign-magnitude: sign bit lives in the high byte of the first word
    body = (i32(int(round(start_deg * 360000))) + bytes(sw) + vax_d(r1 * ctx.uor) + vax_d(r2 * ctx.uor)
            + i32(int(round(rot_deg * 360000))) + vax_d(ctx.dx(c[0])) + vax_d(ctx.dy(c[1])))
    R = max(r1, r2)
    rng = (ctx.ix(c[0] - R), ctx.iy(c[1] - R), ctx.ix(c[0] + R), ctx.iy(c[1] + R))
    return header(16, level, len(body), rng, color=color, **kw) + body


def ellipse15(ctx, c, r1, r2, rot_deg, level=1, color=0, **kw):
    body = (vax_d(r1 * ctx.uor) + vax_d(r2 * ctx.uor) + i32(int(round(rot_deg * 360000)))
            + vax_d(ctx.dx(c[0])) + vax_d(ctx.dy(c[1])))
    R = max(r1, r2)
    rng = (ctx.ix(c[0] - R), ctx.iy(c[1] - R), ctx.ix(c[0] + R), ctx.iy(c[1] + R))
    return header(15, level, len(body), rng, color=color, **kw) + body


def text17(ctx, p, s, height, rot_deg=0.0, width=None, font=1, just=2, level=1, color=0, **kw):
    width = height if width is None else width
    raw = s.encode("ascii")
    hm = int(round(height * ctx.uor * 1000 / 6))
    lm = int(round(width * ctx.uor * 1000 / 6))
    body = (bytes([font, just]) + i32(lm) + i32(hm) + i32(int(round(rot_deg * 360000)))
            + i32(ctx.ix(p[0])) + i32(ctx.iy(p[1])) + bytes([len(raw), 0]) + raw)
    if len(body) % 2:
        body += b"\x00"
    L = len(s) * width
    rng = (ctx.ix(p[0]), ctx.iy(p[1]), ctx.ix(p[0] + L), ctx.iy(p[1] + height))
    return header(17, level, len(body), rng, color=color, **kw) + body


def complex_header(etype, level, components, color=0, **kw):
    """Complex chain (12) / complex shape (14). totlength = words after byte 38 incl. components."""
    after = u16(len(components)) + b"\x00" * 8     # numelems + attribute/padding words
    comp_words = sum(len(c) for c in components) // 2
    body = u16(comp_words + len(after) // 2) + after
    return header(etype, level, len(body), (0, 0, 0, 0), color=color, **kw) + body


def text_node7(ctx, p, components, height, rot_deg=0.0, line_spacing=0.0, just=2, node=1, level=1, color=0, **kw):
    hm = int(round(height * ctx.uor * 1000 / 6))
    after = (u16(len(components)) + u16(node) + bytes([255, 0, 1, just])
             + i32(int(round(line_spacing * ctx.uor))) + i32(hm) + i32(hm)
             + i32(int(round(rot_deg * 360000))) + i32(ctx.ix(p[0])) + i32(ctx.iy(p[1])))
    comp_words = sum(len(c) for c in components) // 2
    body = u16(comp_words + len(after) // 2) + after
    pt = (ctx.ix(p[0]), ctx.iy(p[1]))
    return header(7, level, len(body), pt + pt, color=color, **kw) + body


TRANS_SCALE = 214748.0  # cell transform entries are fixed point: 1.0 == 214748


def cell2(ctx, name, origin, components, xscale=1.0, yscale=1.0, rot_deg=0.0, rng=None, level=1, color=0, **kw):
    a = math.radians(rot_deg)
    trans = [xscale * math.cos(a), -yscale * math.sin(a), xscale * math.sin(a), yscale * math.cos(a)]
    rlo = (ctx.ix(rng[0]), ctx.iy(rng[1])) if rng else (0, 0)
    rhi = (ctx.ix(rng[2]), ctx.iy(rng[3])) if rng else (0, 0)
    after = (rad50(name) + u16(0) + b"\xff\xff" * 4
             + i32(rlo[0]) + i32(rlo[1]) + i32(rhi[0]) + i32(rhi[1])
             + b"".join(i32(int(round(t * TRANS_SCALE))) for t in trans)
             + i32(ctx.ix(origin[0])) + i32(ctx.iy(origin[1])))
    comp_words = sum(len(c) for c in components) // 2
    body = u16(comp_words + len(after) // 2) + after
    return header(2, level, len(body), (rlo[0], rlo[1], rhi[0], rhi[1]), color=color, **kw) + body


def color_table(colors, background=(0, 0, 0)):
    """Type 5 level 1 colour table. colors: up to 255 (r,g,b) for indices 0..254."""
    body = bytearray(u16(0))            # screen flag
    body += bytes(background)           # stored first; readers map it to index 255
    cols = list(colors) + [(0, 0, 0)] * (255 - len(colors))
    for c in cols[:255]:
        body += bytes(c)                # 2 + 3 + 765 = 770 bytes -> element of 806 bytes
    return header(5, 1, len(body), (0, 0, 0, 0)) + bytes(body)


def as_component(elem):
    """Set the complex (component) bit on a finished element."""
    b = bytearray(elem)
    b[0] |= 0x80
    return bytes(b)


def append_elements(path, elems):
    data = open(path, "rb").read()
    o = 0
    while o + 4 <= len(data):
        if data[o] == 0xFF and data[o + 1] == 0xFF:
            break
        wtf = struct.unpack("<H", data[o + 2:o + 4])[0]
        o += 4 + 2 * wtf
    with open(path, "wb") as fh:
        fh.write(data[:o] + b"".join(elems) + ELEM_EOD)


def insert_after_tcb_seed(path, elems, after_count=3):
    """Insert elements after the first `after_count` elements (e.g. a colour table after the TCB)."""
    data = open(path, "rb").read()
    o = 0
    for _ in range(after_count):
        wtf = struct.unpack("<H", data[o + 2:o + 4])[0]
        o += 4 + 2 * wtf
    with open(path, "wb") as fh:
        fh.write(data[:o] + b"".join(elems) + data[o:])

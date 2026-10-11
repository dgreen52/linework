"""Generate SYNTHETIC DGN v7 fixtures and their test oracles.

    python tools/make_dgn_fixtures.py

Base files are created with GDAL's OGR "DGN" driver; element types OGR cannot write (arcs,
ellipses, curves, cells, text nodes, a colour table, a deleted element) are appended with
tools/dgn_raw.py. Each file is then read back with OGR (an independent reader) and the result
is saved as <name>.ogr.json for the JavaScript unit tests. No real drawings are involved.
"""
import json
import math
import os
import struct
import sys

from osgeo import gdal, ogr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dgn_raw as R  # noqa: E402

gdal.UseExceptions()
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SAMPLES = os.path.join(ROOT, "samples")
FIX = os.path.join(ROOT, "tests", "fixtures")


def create(path, opts):
    # NOTE: always pass ORIGIN. The seed file's global origin is stored in UORs, so changing the
    # UOR resolution without resetting it overflows every coordinate.
    if os.path.exists(path):
        os.remove(path)
    ds = ogr.GetDriverByName("DGN").CreateDataSource(path, options=opts)
    lyr = ds.CreateLayer("elements")
    return ds, lyr


def add(lyr, wkt, style=None, **fields):
    f = ogr.Feature(lyr.GetLayerDefn())
    f.SetGeometry(ogr.CreateGeometryFromWkt(wkt))
    for k, v in fields.items():
        f.SetField(k, v)
    if style:
        f.SetStyleString(style)
    lyr.CreateFeature(f)


def wkt_line(pts):
    return "LINESTRING (%s)" % ", ".join("%r %r" % (x, y) for x, y in pts)


def wkt_poly(pts):
    pts = list(pts) + [pts[0]]
    return "POLYGON ((%s))" % ", ".join("%r %r" % (x, y) for x, y in pts)


def xf(pts, origin, sx, sy, rot_deg):
    a = math.radians(rot_deg)
    c, s = math.cos(a), math.sin(a)
    return [(origin[0] + c * x * sx - s * y * sy, origin[1] + s * x * sx + c * y * sy) for x, y in pts]


def oracle(path, extra):
    ds = ogr.Open(path)
    lyr = ds.GetLayer(0)
    feats = []
    for f in lyr:
        g = f.GetGeometryRef()
        env = g.GetEnvelope() if g else None  # (minx, maxx, miny, maxy)
        style = f.GetStyleString() or ""
        rgb = None
        pen = style.replace("fc:#", "")  # the outline colour (BRUSH fc = fill colour, reported apart)
        if "c:#" in pen:
            rgb = pen.split("c:#")[1][:6].lower()
        item = {
            "type": f.GetField("Type"),
            "level": f.GetField("Level"),
            "color": f.GetField("ColorIndex"),
            "rgb": rgb,
            "env": [env[0], env[2], env[1], env[3]] if env else None,
            "geom": g.GetGeometryName() if g else None,
        }
        if "fc:#" in style:
            item["fill"] = style.split("fc:#")[1][:6].lower()
        if f.GetField("Text"):
            item["text"] = f.GetField("Text")
            for part in style.split(","):
                if part.startswith("a:"):
                    item["angle"] = float(part[2:].rstrip(")"))
                if part.startswith("s:"):
                    item["size"] = float(part[2:].rstrip("g)"))
        if g and g.GetGeometryName() == "LINESTRING" and f.GetField("Type") in (3, 4, 12):
            item["points"] = [[g.GetX(i), g.GetY(i)] for i in range(g.GetPointCount())]
        feats.append(item)
    data = {"features": feats}
    data.update(extra)
    out = os.path.join(FIX, os.path.splitext(os.path.basename(path))[0] + ".ogr.json")
    with open(out, "w", newline="\n") as fh:
        json.dump(data, fh, indent=1)
    return feats


# --------------------------------------------------------------------------- site plan (2D)
def site_plan(path):
    # metres / millimetres, 10 UOR per mm, global origin far from 0 (UOR integers stay small)
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=-50,-40,0"])
    # level 1: property boundary (shape)
    add(lyr, wkt_poly([(0, 0), (80, 0), (86, 52), (4, 58)]), Level=1, ColorIndex=3)
    # level 2: buildings (shapes)
    add(lyr, wkt_poly([(15, 12), (45, 12), (45, 30), (15, 30)]), Level=2, ColorIndex=0)
    add(lyr, wkt_poly([(50, 20), (68, 20), (68, 38), (50, 38)]), Level=2, ColorIndex=0)
    # level 3: road centre line, 150 vertices -> OGR splits it into a complex chain
    road = [(-5 + i * 0.65, -6 + 3 * math.sin(i / 12.0)) for i in range(150)]
    add(lyr, wkt_line(road), Level=3, ColorIndex=4)
    # level 3: roundabout, 160 vertices -> complex shape
    rb = [(95 + 8 * math.cos(t * 2 * math.pi / 160), -6 + 8 * math.sin(t * 2 * math.pi / 160)) for t in range(160)]
    add(lyr, wkt_poly(rb), Level=3, ColorIndex=4)
    # level 4: fence (line string)
    add(lyr, wkt_line([(0, 0), (0, -2), (40, -2), (40, 0)]), Level=4, ColorIndex=6, Style=2)
    # level 6: labels (text)
    add(lyr, "POINT (20 20)", 'LABEL(t:"MAIN HALL",s:2g,a:0)', Level=6, ColorIndex=7)
    add(lyr, "POINT (55 28)", 'LABEL(t:"STORE",s:1.5g,a:90)', Level=6, ColorIndex=7)
    add(lyr, "POINT (30 -5)", 'LABEL(t:"ACCESS ROAD",s:1.2g,a:-4)', Level=6, ColorIndex=2)
    ds = None

    ctx = R.Ctx(10000, (-50, -40))
    els = []
    # level 5: survey lines (type 3)
    els.append(R.line3(ctx, (0, 0), (86, 52), level=5, color=1, style=3))
    els.append(R.line3(ctx, (80, 0), (4, 58), level=5, color=1, style=3))
    # level 7: cul-de-sac arc, a clockwise arc and a pond ellipse
    els.append(R.arc16(ctx, (40, 45), 6, 6, 0, 180, 180, level=7, color=4))
    els.append(R.arc16(ctx, (70, 47), 3, 3, 0, 90, -90, level=7, color=5))
    els.append(R.ellipse15(ctx, (72, 8), 6, 3, 25, level=7, color=1, weight=2))
    # level 8: a stream (curve)
    els.append(R.multipoint(11, ctx, [(-8, 30), (-4, 32), (0, 30), (4, 34), (8, 31), (12, 35), (16, 33), (20, 36)], level=8, color=1))
    # level 9: text node with two lines
    t1 = R.as_component(R.text17(ctx, (2, 50), "NOTE: SYNTHETIC SITE", 1.0, 0, level=9, color=2))
    t2 = R.as_component(R.text17(ctx, (2, 48.5), "NOT A REAL LOCATION", 1.0, 0, level=9, color=2))
    els += [R.text_node7(ctx, (2, 50), [t1, t2], 1.0, 0, 0.5, level=9, color=2), t1, t2]
    # level 10: tree cells. Components are stored ALREADY placed (as DGN does); the header
    # records the placement transform.
    cells = []
    tree = [(0, 0), (1.2, 0)]  # local geometry: crown radius 1.2, two cross lines
    for i, (ox, oy, s, rot) in enumerate([(8, 40, 1.0, 0), (12, 44, 1.5, 30), (75, 45, 0.8, 45), (30, 5, 1.0, 0)]):
        r = 1.2 * s
        comps = [
            R.as_component(R.ellipse15(ctx, (ox, oy), r, r, rot, level=10, color=2)),
            R.as_component(R.line3(ctx, *xf([(-1.2, 0), (1.2, 0)], (ox, oy), s, s, rot), level=10, color=2)),
            R.as_component(R.line3(ctx, *xf([(0, -1.2), (0, 1.2)], (ox, oy), s, s, rot), level=10, color=2)),
        ]
        els.append(R.cell2(ctx, "TREE", (ox, oy), comps, s, s, rot, rng=(ox - r, oy - r, ox + r, oy + r), level=10, color=2))
        els += comps
        cells.append({"name": "TREE", "origin": [ox, oy], "scale": s, "rotation": rot})
    # north arrow cell: non-uniform scale 1.5 x 1.0, rotated 30 degrees
    arrow = [(0, -3), (1.5, -2), (0, 3), (-1.5, -2)]
    placed = xf(arrow, (90, 50), 1.5, 1.0, 30)
    comps = [R.as_component(R.multipoint(6, ctx, placed + [placed[0]], level=11, color=0))]
    xs = [p[0] for p in placed]
    ys = [p[1] for p in placed]
    els.append(R.cell2(ctx, "NORTH", (90, 50), comps, 1.5, 1.0, 30, rng=(min(xs), min(ys), max(xs), max(ys)), level=11))
    els += comps
    cells.append({"name": "NORTH", "origin": [90, 50], "xscale": 1.5, "yscale": 1.0, "rotation": 30})
    # a deleted element (must not be shown)
    els.append(R.line3(ctx, (-100, -100), (200, 200), level=12, color=3, deleted=True))
    R.append_elements(path, els)

    # custom colour table (type 5, level 1) right after the TCB/seed elements
    palette = [(255, 255, 255), (40, 90, 255), (30, 190, 70), (230, 40, 40), (250, 210, 0), (200, 60, 200),
               (255, 140, 0), (0, 200, 220)]
    R.insert_after_tcb_seed(path, [R.color_table(palette, background=(0, 0, 0))])
    return {"cells": cells, "uor_per_master": 10000, "origin": [-50, -40], "master": "m", "sub": "mm",
            "palette": ["%02x%02x%02x" % c for c in palette],
            "raw": {"arcs": [{"c": [40, 45], "r": 6, "start": 180, "sweep": 180}, {"c": [70, 47], "r": 3, "start": 90, "sweep": -90}],
                    "ellipse": {"c": [72, 8], "r1": 6, "r2": 3, "rot": 25}, "deleted": 1, "textnode": 1,
                    "curve_points": 8}}


# --------------------------------------------------------------------------- default palette
def default_palette(path):
    ds, lyr = create(path, ["MASTER_UNIT_NAME=ft", "SUB_UNIT_NAME=in", "SUB_UNITS_PER_MASTER_UNIT=12",
                            "UOR_PER_SUB_UNIT=8000", "ORIGIN=0,0,0"])
    for c in range(16):
        add(lyr, wkt_line([(c, 0), (c, 10)]), Level=1 + (c % 4), ColorIndex=c)
    add(lyr, "POINT (0 12)", 'LABEL(t:"DEFAULT COLOURS",s:0.5g)', Level=5, ColorIndex=7)
    ds = None
    return {"uor_per_master": 96000, "master": "ft"}


# --------------------------------------------------------------------------- 3D design file
def three_d(path):
    ds, lyr = create(path, ["3D=YES", "MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=1", "ORIGIN=1000,2000,0"])
    add(lyr, "LINESTRING Z (0 0 0, 10 0 5, 10 10 10)", Level=1, ColorIndex=3)
    add(lyr, "POLYGON Z ((0 0 1, 5 0 1, 5 5 1, 0 5 1, 0 0 1))", Level=2, ColorIndex=2)
    add(lyr, "POINT Z (2 8 3)", 'LABEL(t:"3D TEXT",s:1g,a:0)', Level=3, ColorIndex=1)
    ds = None
    return {"dimension": 3}


# --------------------------------------------------------------------------- title block (text inside cells)
def title_block(path):
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, wkt_line([(0, 0), (90, 0), (90, 60), (0, 60), (0, 0)]), Level=1, ColorIndex=1)   # sheet border
    add(lyr, "POINT (5 55)", style='LABEL(t:"LOOSE NOTE",s:2g)', Level=3, ColorIndex=2)
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    # a TITLE cell at the bottom right: frame, a divider, three text fields (one carrying attribute data)
    # and a nested STAMP cell with its own text. Components are stored already placed.
    stamp = [R.as_component(R.ellipse15(ctx, (84, 12), 3, 3, 0, level=4, color=3)),
             R.as_component(R.text17(ctx, (82.5, 11.2), "OK", 1.6, level=4, color=3))]
    comps = [
        R.as_component(R.multipoint(6, ctx, [(50, 2), (89, 2), (89, 16), (50, 16), (50, 2)], level=4, color=1)),
        R.as_component(R.line3(ctx, (50, 9), (79, 9), level=4, color=1)),
        R.as_component(R.text17(ctx, (52, 11), "DRAWING TITLE", 2.0, level=4, color=2)),
        R.as_component(R.with_attributes(R.text17(ctx, (52, 4), "SHEET 1 OF 2", 1.5, level=4, color=2),
                                       b"\x03\x10\x34\x12\x01\x00\x02\x00")),  # a user data linkage of 8 bytes
        R.as_component(R.text17(ctx, (71, 4), "REV A", 1.5, just=14, level=4, color=2)),
        R.as_component(R.cell2(ctx, "STAMP", (84, 12), stamp, rng=(81, 9, 87, 15), level=4, color=3)),
    ] + stamp
    R.append_elements(path, [R.cell2(ctx, "TITLE", (50, 2), comps, rng=(50, 2, 89, 16), level=4, color=1)] + comps)
    return {"uor_per_master": 10000, "origin": [0, 0], "master": "m", "sub": "mm",
            "title": {"texts": ["DRAWING TITLE", "SHEET 1 OF 2", "REV A"], "stamp_text": "OK",
                      "attributes": "0310341201000200"}}


# --------------------------------------------------------------------------- fidelity (what editing must not lose)
DMRS = bytes([0x00, 0x00, 0x05, 0x00, 0x39, 0x30, 0x00, 0x00])  # a database linkage (entity 5, MSLINK 12345)


def fidelity(path):
    """A wiring-diagram-like sheet with everything a byte-level edit must keep: a title block cell with a
    text node, an empty text node, a point string, a blank text, a text with an enter-data field, a text
    with attribute data, a B-spline curve, a filled junction dot and a nested cell, the cell header carrying
    a database linkage; complex chains with clockwise and counter-clockwise arcs (and one elliptical arc),
    filled shapes, a top-level text node, a tag value, a reference attachment, a shared cell, a cell with a
    tag inside, a NUL-padded text, a complex chain whose word count claims the next element, and two colour
    tables (the second one counts)."""
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, wkt_line([(0, 0), (120, 0), (120, 80), (0, 80), (0, 0)]), Level=1, ColorIndex=1)  # sheet border
    add(lyr, "POINT (5 75)", style='LABEL(t:"WIRING DIAGRAM",s:2g)', Level=2, ColorIndex=2)
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    C = R.as_component
    els = []
    # ---- title block cell TBLOCK (level 4)
    t1 = C(R.text17(ctx, (52, 13), "LINE ONE", 1.0, level=4, color=2))
    t2 = C(R.text17(ctx, (52, 11.5), "LINE TWO", 1.0, level=4, color=2))
    node = C(R.text_node7(ctx, (52, 13), [t1, t2], 1.0, 0, 0.5, level=4, color=2))
    empty = C(R.text_node7(ctx, (80, 5), [], 1.0, 0, 0.5, level=4, color=2))
    pstr = C(R.point_string22(ctx, [(55, 3), (57, 3), (59, 3)], level=4, color=3))
    blank = C(R.text17(ctx, (52, 7), "   ", 1.0, level=4, color=2))
    title = C(R.with_graphic_group(R.text17(ctx, (52, 16), "PUMP STATION 3", 2.0, level=4, color=2), 7))
    dwg = C(R.text17(ctx, (52, 9), "DWG NO ____", 1.0, edf=bytes([8, 4]), level=4, color=2))  # one field: from character 8, 4 long
    rev = C(R.with_attributes(R.text17(ctx, (70, 9), "REV 0", 1.0, level=4, color=2), bytes([0x03, 0x10, 0x34, 0x12, 0x01, 0x00, 0x02, 0x00])))
    spl = [C(x) for x in R.bspline_curve(ctx, [(76, 4), (78, 8), (80, 4), (82, 8)], level=4, color=5)]
    dot = C(R.with_attributes(R.ellipse15(ctx, (60, 6), 0.4, 0.4, 0, level=4, color=1), R.fill_linkage(1)))
    stamp = [C(R.ellipse15(ctx, (85, 15), 2.5, 2.5, 0, level=4, color=3)), C(R.text17(ctx, (84, 14.5), "OK", 1.0, level=4, color=3))]
    stamp_cell = C(R.cell2(ctx, "STAMP", (85, 15), stamp, rng=(82.5, 12.5, 87.5, 17.5), level=4, color=3))
    frame = C(R.multipoint(6, ctx, [(50, 2), (90, 2), (90, 20), (50, 20), (50, 2)], level=4, color=1))
    comps = [frame, title, node, t1, t2, empty, pstr, blank, dwg, rev] + spl + [dot, stamp_cell] + stamp
    els += [R.with_attributes(R.cell2(ctx, "TBLOCK", (50, 2), comps, rng=(50, 2, 90, 20), level=4, color=1), DMRS)] + comps
    # ---- complex chain with a counter-clockwise and a clockwise arc (level 3)
    parts = [C(R.multipoint(4, ctx, [(10, 30), (20, 30)], level=3, color=4)),
             C(R.arc16(ctx, (20, 35), 5, 5, 0, -90, 180, level=3, color=4)),
             C(R.multipoint(4, ctx, [(20, 40), (10, 40)], level=3, color=4)),
             C(R.arc16(ctx, (10, 45), 5, 5, 0, -90, -180, level=3, color=4)),
             C(R.multipoint(4, ctx, [(10, 50), (25, 50)], level=3, color=4))]
    els += [R.complex_header(12, 3, parts, color=4)] + parts
    # a chain with an elliptical arc (shown, and written back, as points when reshaped)
    parts = [C(R.multipoint(4, ctx, [(30, 45), (36, 45)], level=3, color=4)),
             C(R.arc16(ctx, (36, 47), 4, 2, 90, -90, 180, level=3, color=4)),
             C(R.multipoint(4, ctx, [(36, 49), (30, 49)], level=3, color=4))]
    els += [R.complex_header(12, 3, parts, color=4)] + parts
    # ---- fills (level 6): a terminal (complex shape with an arc), an arrowhead (shape), a junction dot (circle)
    parts = [C(R.multipoint(4, ctx, [(30, 30), (40, 30)], level=6, color=1)),
             C(R.arc16(ctx, (40, 32.5), 2.5, 2.5, 0, -90, 180, level=6, color=1)),
             C(R.multipoint(4, ctx, [(40, 35), (30, 35), (30, 30)], level=6, color=1))]
    els += [R.with_attributes(R.complex_header(14, 6, parts, color=1), R.fill_linkage(3))] + parts
    els.append(R.with_attributes(R.multipoint(6, ctx, [(45, 30), (48, 31), (45, 32), (45, 30)], level=6, color=1), R.fill_linkage(1)))
    els.append(R.with_attributes(R.ellipse15(ctx, (50, 31), 0.5, 0.5, 0, level=6, color=1), R.fill_linkage(1)))
    # ---- top-level text node (level 7, colour 5: green in the second colour table)
    n1 = C(R.text17(ctx, (5, 60), "NOTE A", 1.0, level=7, color=5))
    n2 = C(R.text17(ctx, (5, 58.5), "NOTE B", 1.0, level=7, color=5))
    els += [R.text_node7(ctx, (5, 60), [n1, n2], 1.0, 0, 0.5, level=7, color=5), n1, n2]
    # a text stored with NUL padding (GDAL and C strings stop at the first NUL)
    els.append(R.text17(ctx, (5, 55), "PAD", 1.0, raw=b"PAD\x00\x00\x00", level=7, color=2))
    # ---- what is not shown: a tag value, a reference attachment, a shared cell (definition + instance), a B-spline curve
    els.append(R.tag_value37(ctx, (5, 65), "P-101"))
    els.append(R.reference_attachment("BORDER.DGN"))
    els += R.shared_cell_definition("SCDEF", [C(R.line3(ctx, (0, 0), (1, 1), level=1, color=1))])
    els.append(R.raw_element(35, 1, R.rad50("SCDEF") + bytes(40), (ctx.ix(100), ctx.iy(70), ctx.ix(101), ctx.iy(71))))
    els += R.bspline_curve(ctx, [(95, 40), (100, 45), (105, 40), (110, 45)], level=8, color=1)
    # ---- a cell holding a tag value (an element type that cannot be moved)
    bad = [C(R.line3(ctx, (95, 20), (105, 20), level=9, color=1)), C(R.tag_value37(ctx, (95, 21), "X", level=9))]
    els += [R.cell2(ctx, "TAGGED", (95, 20), bad, rng=(95, 20, 105, 21), level=9, color=1)] + bad
    # ---- a complex chain whose word count claims the line after it (as some writers leave it)
    parts = [C(R.multipoint(4, ctx, [(60, 60), (70, 60)], level=10, color=1)), C(R.multipoint(4, ctx, [(70, 60), (70, 70)], level=10, color=1))]
    after = R.line3(ctx, (75, 60), (85, 60), level=11, color=2)
    hdr = bytearray(R.complex_header(12, 10, parts, color=1))
    hdr[36:38] = R.u16(struct.unpack("<H", bytes(hdr[36:38]))[0] + len(after) // 2)
    els += [bytes(hdr)] + parts + [after]
    R.append_elements(path, els)
    # two colour tables after the TCB / seed elements: index 5 is red in the first, green in the second
    first = [(255, 255, 255), (40, 90, 255), (30, 190, 70), (230, 40, 40), (250, 210, 0), (255, 0, 0), (0, 200, 220)]
    second = [(255, 255, 255), (40, 90, 255), (30, 190, 70), (230, 40, 40), (250, 210, 0), (0, 200, 0), (0, 200, 220)]
    R.insert_after_tcb_seed(path, [R.color_table(first), R.color_table(second)])
    return {"uor_per_master": 10000, "origin": [0, 0], "master": "m", "sub": "mm",
            "palette5": "00c800", "ref": "BORDER.DGN", "edf": [8, 4],
            "chain": {"ccw": {"c": [20, 35], "r": 5, "start": -90, "sweep": 180}, "cw": {"c": [10, 45], "r": 5, "start": -90, "sweep": -180}}}


# --------------------------------------------------------------------------- 3D rotations written by GDAL
def three_d_rot(path):
    """3D file: texts rotated 30 and 90 degrees written by GDAL's own writer (its quaternion convention), a
    line string with a different Z at every vertex, and a 3D arc rotated 30 degrees (same convention)."""
    ds, lyr = create(path, ["3D=YES", "MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, "POINT Z (5 5 0)", 'LABEL(t:"ROT30",s:1g,a:30)', Level=1, ColorIndex=1)
    add(lyr, "POINT Z (5 15 0)", 'LABEL(t:"ROT90",s:1g,a:90)', Level=1, ColorIndex=1)
    add(lyr, "LINESTRING Z (0 0 0, 10 0 5, 10 10 10)", Level=2, ColorIndex=3)
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    R.append_elements(path, [R.arc16_3d(ctx, (20, 5), 2, 3, 0, 90, 30, level=3, color=2)])
    return {"uor_per_master": 10000, "texts": {"ROT30": 30, "ROT90": 90}, "arc": {"c": [20, 5], "z": 2, "r": 3, "start": 0, "sweep": 90, "rot": 30}}


# --------------------------------------------------------------------------- wiring schematic (find / replace, key-ins, attributes)
def wiring(path):
    """An invented control-panel wiring sheet: terminal cells with labels, wires on one level in two
    symbologies, wire labels (one lowercase, one a longer number that contains another), a label inside a
    marker cell, a note, a relay coil, a ground bus and a title block cell. Levels 1, 4, 5, 6, 10, 12, 20, 30."""
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, wkt_line([(0, 0), (200, 0), (200, 120), (0, 120), (0, 0)]), Level=1, ColorIndex=1)  # sheet border
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    C = R.as_component
    els = []
    # terminal block TB1: three TERM cells (level 12), a frame and a label each
    for n, y in enumerate([95, 85, 75], start=1):
        comps = [C(R.multipoint(6, ctx, [(20, y - 2.5), (30, y - 2.5), (30, y + 2.5), (20, y + 2.5), (20, y - 2.5)], level=12, color=1)),
                 C(R.text17(ctx, (21, y - 1), "TB1-%d" % n, 2.0, level=12, color=2))]
        els += [R.cell2(ctx, "TERM", (20, y - 2.5), comps, rng=(20, y - 2.5, 30, y + 2.5), level=12, color=1)] + comps
    # wires (level 5): three green weight 2, one blue weight 1, one green weight 2
    for y in (95, 85, 75):
        els.append(R.line3(ctx, (30, y), (120, y), level=5, color=2, weight=2))
    els.append(R.line3(ctx, (30, 65), (120, 65), level=5, color=1, weight=1))
    els.append(R.line3(ctx, (30, 55), (120, 55), level=5, color=2, weight=2))
    # wire labels (level 10)
    for s, y in (("W101", 96), ("W102", 86), ("W103", 76), ("W1010", 66), ("w104", 56)):
        els.append(R.text17(ctx, (60, y), s, 2.0, level=10, color=3))
    # a wire marker cell (level 12) holding the label W101 again
    comps = [C(R.multipoint(6, ctx, [(124, 98), (136, 98), (136, 102), (124, 102), (124, 98)], level=12, color=1)),
             C(R.text17(ctx, (125, 99), "W101", 2.0, level=12, color=3))]
    els += [R.cell2(ctx, "MARKER", (124, 98), comps, rng=(124, 98, 136, 102), level=12, color=1)] + comps
    # relay coil K1 (level 30)
    els.append(R.ellipse15(ctx, (150, 95), 5, 5, 0, level=30, color=4))
    els.append(R.text17(ctx, (148, 94), "K1", 2.0, level=30, color=4))
    # ground bus (level 6) and its labels (level 10)
    els.append(R.multipoint(4, ctx, [(10, 40), (100, 40), (190, 40)], level=6, color=5, weight=3))
    els.append(R.text17(ctx, (15, 41.5), "GND", 2.0, level=10, color=3))
    els.append(R.text17(ctx, (150, 41.5), "GND BUS", 2.0, level=10, color=3))
    # a note (level 20)
    els.append(R.text17(ctx, (10, 25), "NOTE: W101 FEEDS RELAY K1", 2.0, level=20, color=0))
    # title block cell (level 4)
    comps = [C(R.multipoint(6, ctx, [(140, 2), (198, 2), (198, 20), (140, 20), (140, 2)], level=4, color=1)),
             C(R.text17(ctx, (142, 14), "CONTROL PANEL WIRING", 2.5, level=4, color=0)),
             C(R.text17(ctx, (142, 8), "SHEET 1 OF 1", 1.5, level=4, color=0)),
             C(R.text17(ctx, (180, 8), "REV B", 1.5, just=14, level=4, color=0))]
    els += [R.cell2(ctx, "TBLOCK", (140, 2), comps, rng=(140, 2, 198, 20), level=4, color=1)] + comps
    R.append_elements(path, els)
    palette = [(255, 255, 255), (40, 90, 255), (30, 190, 70), (250, 210, 0), (230, 40, 40), (200, 60, 200)]
    R.insert_after_tcb_seed(path, [R.color_table(palette, background=(0, 0, 0))])
    return {"uor_per_master": 10000, "origin": [0, 0], "master": "m", "sub": "mm",
            "levels": [1, 4, 5, 6, 10, 12, 20, 30], "labels": ["W101", "W102", "W103", "W1010", "w104"]}


# --------------------------------------------------------------------------- wiring sheet for the Trace tool
def trace_sheet(path):
    """The invented sheet of tools/trace_sheet.json (the DXF twin is made by make_fixtures.mjs): connector
    cells J4 / P1 (frame, pin stubs, pin texts), a terminal strip cell with filled pin dots, wires as lines,
    line strings and a complex chain with a hop arc, filled junction dots, a relay coil, wire labels (two of
    them rotated), off-sheet notes and a title block. Levels: 1 border, 4 title, 5 wires, 10 labels,
    12 cells, 14 dots, 20 notes, 30 coil."""
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "trace_sheet.json"), encoding="utf8") as fh:
        J = json.load(fh)
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, wkt_line([tuple(p) for p in J["border"]]), Level=1, ColorIndex=1)
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    C = R.as_component

    def dot(d, level):
        return R.with_attributes(R.ellipse15(ctx, tuple(d["c"]), d["r"], d["r"], 0, level=level, color=2), R.fill_linkage(2))

    els = []
    for c in J["cells"]:
        lv = c["level"]
        comps = [C(R.multipoint(6, ctx, [tuple(p) for p in c["frame"]], level=lv, color=1))]
        comps += [C(R.line3(ctx, tuple(a), tuple(b), level=lv, color=1)) for a, b in c.get("lines", [])]
        comps += [C(dot(d, lv)) for d in c.get("dots", [])]
        comps += [C(R.text17(ctx, tuple(t["p"]), t["s"], t["h"], level=lv, color=3)) for t in c["texts"]]
        xs = [p[0] for p in c["frame"]] + [t["p"][0] for t in c["texts"]] + [q[0] for ln in c.get("lines", []) for q in ln]
        ys = [p[1] for p in c["frame"]] + [t["p"][1] + t["h"] for t in c["texts"]] + [t["p"][1] for t in c["texts"]]
        els += [R.cell2(ctx, c["name"], tuple(c["frame"][0]), comps, rng=(min(xs), min(ys), max(xs), max(ys)), level=lv, color=1)] + comps
    for w in J["wires"]:
        if "chain" in w:
            parts = []
            for p in w["chain"]:
                if "arc" in p:
                    a = p["arc"]
                    parts.append(C(R.arc16(ctx, tuple(a["c"]), a["r"], a["r"], 0, a["start"], a["sweep"], level=5, color=2, weight=1)))
                else:
                    parts.append(C(R.multipoint(4, ctx, [tuple(q) for q in p["pts"]], level=5, color=2, weight=1)))
            els += [R.complex_header(12, 5, parts, color=2, weight=1)] + parts
        elif len(w["pts"]) == 2:
            els.append(R.line3(ctx, tuple(w["pts"][0]), tuple(w["pts"][1]), level=5, color=2, weight=1))
        else:
            els.append(R.multipoint(4, ctx, [tuple(p) for p in w["pts"]], level=5, color=2, weight=1))
    els += [dot(d, 14) for d in J["dots"]]
    els += [R.ellipse15(ctx, tuple(c["c"]), c["r"], c["r"], 0, level=c["level"], color=4) for c in J["circles"]]
    for t in J["texts"]:
        els.append(R.text17(ctx, tuple(t["p"]), t["s"], t["h"], t.get("rot", 0), level=t.get("level", 10), color=3))
    R.append_elements(path, els)
    palette = [(255, 255, 255), (40, 90, 255), (30, 190, 70), (250, 210, 0), (230, 40, 40)]
    R.insert_after_tcb_seed(path, [R.color_table(palette, background=(0, 0, 0))])
    return {"uor_per_master": 10000, "origin": [0, 0], "master": "m", "sub": "mm"}


# --------------------------------------------------------------------------- sheet set (open a folder, find in all sheets, links)
# An invented five-sheet pump control panel set: PNL-01..03 here (DGN), PNL-04 and PNL-05 come from
# tools/make_fixtures.mjs (DXF). Wire numbers repeat across sheets; some texts refer to other sheets.
SHEET_TITLES = ["PUMP CONTROL POWER", "PUMP CONTROL RELAYS", "PUMP CONTROL TERMINALS"]
SHEET_WIRES = [["W201", "W202", "W210"], ["W201", "W203", "W220"], ["W202", "W203", "W230"]]
SHEET_REFS = [["CONT ON SHEET 2", "SEE DWG PNL-05"], ["FROM SH 1", "TO SHT. 3"], ["PNL-04", "SHEET 9"]]


def sheet(path, k):
    ds, lyr = create(path, ["MASTER_UNIT_NAME=m", "SUB_UNIT_NAME=mm", "SUB_UNITS_PER_MASTER_UNIT=1000",
                            "UOR_PER_SUB_UNIT=10", "ORIGIN=0,0,0"])
    add(lyr, wkt_line([(0, 0), (200, 0), (200, 120), (0, 120), (0, 0)]), Level=1, ColorIndex=1)  # sheet border
    ds = None
    ctx = R.Ctx(10000, (0, 0))
    C = R.as_component
    els = []
    # wires (level 5) with their numbers (level 10); the first wire's number again in a marker cell
    for n, w in enumerate(SHEET_WIRES[k - 1]):
        y = 95 - 15 * n
        els.append(R.line3(ctx, (30, y), (120, y), level=5, color=2, weight=2))
        els.append(R.text17(ctx, (60, y + 1), w, 2.0, level=10, color=3))
    w = SHEET_WIRES[k - 1][0]
    comps = [C(R.multipoint(6, ctx, [(124, 93), (136, 93), (136, 97), (124, 97), (124, 93)], level=12, color=1)),
             C(R.text17(ctx, (125, 94), w, 2.0, level=12, color=3))]
    els += [R.cell2(ctx, "MARKER", (124, 93), comps, rng=(124, 93, 136, 97), level=12, color=1)] + comps
    # references to other sheets (level 20), at the wire ends
    for n, s in enumerate(SHEET_REFS[k - 1]):
        els.append(R.text17(ctx, (150, 95 - 15 * n), s, 2.0, level=20, color=0))
    # title block cell (level 4): title, sheet number, drawing number, revision
    comps = [C(R.multipoint(6, ctx, [(140, 2), (198, 2), (198, 20), (140, 20), (140, 2)], level=4, color=1)),
             C(R.text17(ctx, (142, 14), SHEET_TITLES[k - 1], 2.5, level=4, color=0)),
             C(R.text17(ctx, (142, 8), "SHEET %d OF 5" % k, 1.5, level=4, color=0)),
             C(R.text17(ctx, (142, 4), "PNL-%02d" % k, 1.5, level=4, color=0)),
             C(R.text17(ctx, (180, 8), "REV A", 1.5, just=14, level=4, color=0))]
    els += [R.cell2(ctx, "TBLOCK", (140, 2), comps, rng=(140, 2, 198, 20), level=4, color=1)] + comps
    R.append_elements(path, els)


def sheet_set():
    out = os.path.join(FIX, "sheets")
    os.makedirs(out, exist_ok=True)
    for k in (1, 2, 3):
        path = os.path.join(out, "PNL-%02d.dgn" % k)
        sheet(path, k)
        print("wrote", os.path.relpath(path, ROOT), os.path.getsize(path), "bytes")


def main():
    os.makedirs(SAMPLES, exist_ok=True)
    os.makedirs(FIX, exist_ok=True)
    jobs = [(os.path.join(SAMPLES, "site-plan.dgn"), site_plan),
            (os.path.join(FIX, "dgn-default-palette.dgn"), default_palette),
            (os.path.join(FIX, "dgn-3d.dgn"), three_d),
            (os.path.join(FIX, "dgn-titleblock.dgn"), title_block),
            (os.path.join(FIX, "dgn-fidelity.dgn"), fidelity),
            (os.path.join(FIX, "dgn-3d-rot.dgn"), three_d_rot),
            (os.path.join(FIX, "dgn-wiring.dgn"), wiring),
            (os.path.join(FIX, "dgn-trace.dgn"), trace_sheet)]
    only = set(sys.argv[1:])  # e.g. `python tools/make_dgn_fixtures.py dgn-titleblock` rebuilds just that one
    for path, fn in jobs:
        if only and os.path.splitext(os.path.basename(path))[0] not in only:
            continue
        extra = fn(path)
        feats = oracle(path, extra)
        print("wrote", os.path.relpath(path, ROOT), os.path.getsize(path), "bytes,", len(feats), "OGR features")
    if not only or "sheets" in only:  # tests/fixtures/sheets/PNL-01..03.dgn (no oracles)
        sheet_set()


if __name__ == "__main__":
    main()

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
        if "c:#" in style:
            rgb = style.split("c:#")[1][:6].lower()
        item = {
            "type": f.GetField("Type"),
            "level": f.GetField("Level"),
            "color": f.GetField("ColorIndex"),
            "rgb": rgb,
            "env": [env[0], env[2], env[1], env[3]] if env else None,
            "geom": g.GetGeometryName() if g else None,
        }
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
def with_attributes(elem, data):
    """The element with attribute data appended (the header's attribute index already points past the body)."""
    b = bytearray(elem)
    b[32] |= 0x08                     # properties: attribute data present (0x0800)
    words = (len(b) + len(data) - 4) // 2
    b[2], b[3] = words & 0xFF, words >> 8
    return bytes(b) + bytes(data)


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
        R.as_component(with_attributes(R.text17(ctx, (52, 4), "SHEET 1 OF 2", 1.5, level=4, color=2),
                                       b"\x07\x10\x34\x12\x01\x00\x02\x00")),
        R.as_component(R.text17(ctx, (71, 4), "REV A", 1.5, just=14, level=4, color=2)),
        R.as_component(R.cell2(ctx, "STAMP", (84, 12), stamp, rng=(81, 9, 87, 15), level=4, color=3)),
    ] + stamp
    R.append_elements(path, [R.cell2(ctx, "TITLE", (50, 2), comps, rng=(50, 2, 89, 16), level=4, color=1)] + comps)
    return {"uor_per_master": 10000, "origin": [0, 0], "master": "m", "sub": "mm",
            "title": {"texts": ["DRAWING TITLE", "SHEET 1 OF 2", "REV A"], "stamp_text": "OK",
                      "attributes": "07103412010002 00".replace(" ", "")}}


def main():
    os.makedirs(SAMPLES, exist_ok=True)
    os.makedirs(FIX, exist_ok=True)
    jobs = [(os.path.join(SAMPLES, "site-plan.dgn"), site_plan),
            (os.path.join(FIX, "dgn-default-palette.dgn"), default_palette),
            (os.path.join(FIX, "dgn-3d.dgn"), three_d),
            (os.path.join(FIX, "dgn-titleblock.dgn"), title_block)]
    only = set(sys.argv[1:])  # e.g. `python tools/make_dgn_fixtures.py dgn-titleblock` rebuilds just that one
    for path, fn in jobs:
        if only and os.path.splitext(os.path.basename(path))[0] not in only:
            continue
        extra = fn(path)
        feats = oracle(path, extra)
        print("wrote", os.path.relpath(path, ROOT), os.path.getsize(path), "bytes,", len(feats), "OGR features")


if __name__ == "__main__":
    main()

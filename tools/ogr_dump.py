"""Read drawings with GDAL/OGR (an independent reader) and print what it saw as JSON.

    python tools/ogr_dump.py file1.dgn file2.dxf ...

Used by the unit tests to validate files written by the app (dgn-write.js, dxf-write.js).
"""
import json
import sys

from osgeo import gdal, ogr

gdal.UseExceptions()


def dump(path):
    ds = ogr.Open(path)
    feats = []
    for li in range(ds.GetLayerCount()):
        lyr = ds.GetLayer(li)
        defn = lyr.GetLayerDefn()
        names = [defn.GetFieldDefn(i).GetName() for i in range(defn.GetFieldCount())]
        for f in lyr:
            g = f.GetGeometryRef()
            env = g.GetEnvelope() if g else None
            item = {"geom": g.GetGeometryName() if g else None,
                    "env": [env[0], env[2], env[1], env[3]] if env else None}
            for k in ("Type", "Level", "ColorIndex", "Weight", "Layer", "Text", "SubClasses", "EntityHandle"):
                if k in names:
                    v = f.GetField(k)
                    if v is not None:
                        item[k] = v
            style = f.GetStyleString() or ""
            pen = style.replace("fc:#", "")  # BRUSH fc = the fill colour, reported as "fill"
            if "c:#" in pen:
                item["rgb"] = pen.split("c:#")[1][:6].lower()
            if "fc:#" in style:
                item["fill"] = style.split("fc:#")[1][:6].lower()
            if "w:" in style:
                item["w"] = style.split("w:")[1].split(",")[0].split(")")[0]
            if style:
                item["style"] = style
            if g and g.GetGeometryName() in ("LINESTRING", "POINT"):
                item["points"] = [[g.GetX(i), g.GetY(i)] for i in range(g.GetPointCount())]
                if g.GetCoordinateDimension() == 3:
                    item["z"] = [g.GetZ(i) for i in range(g.GetPointCount())]
            elif g and g.GetGeometryName() in ("MULTILINESTRING", "POLYGON"):
                item["parts"] = [[[p.GetX(i), p.GetY(i)] for i in range(p.GetPointCount())] for p in (g.GetGeometryRef(k) for k in range(g.GetGeometryCount()))]
            feats.append(item)
    return {"features": feats}


def main():
    out = {}
    for p in sys.argv[1:]:
        try:
            out[p] = dump(p)
        except Exception as exc:  # report, never crash the test run
            out[p] = {"error": str(exc)}
    sys.stdout.write(json.dumps(out, ensure_ascii=True))


if __name__ == "__main__":
    main()

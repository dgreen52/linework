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
            for k in ("Type", "Level", "ColorIndex", "Layer", "Text", "SubClasses", "EntityHandle"):
                if k in names:
                    v = f.GetField(k)
                    if v is not None:
                        item[k] = v
            style = f.GetStyleString() or ""
            if "c:#" in style:
                item["rgb"] = style.split("c:#")[1][:6].lower()
            if g and g.GetGeometryName() in ("LINESTRING", "POINT"):
                item["points"] = [[g.GetX(i), g.GetY(i)] for i in range(g.GetPointCount())]
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

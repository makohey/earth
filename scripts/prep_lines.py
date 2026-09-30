#!/usr/bin/env python3
"""
Natural Earth（パブリックドメイン）の geographic_lines から、国際日付変更線の形を取り出す（手元で一度だけ実行）。
赤道は計算で描けるので、ここでは日付変更線だけを持つ。日付変更線は 180° の直線ではなく、島国の都合で曲がっている。

使い方: python scripts/prep_lines.py <ne_50m_geographic_lines.geojson>
"""
import json, os, sys

d = json.load(open(sys.argv[1], encoding="utf-8"))
out = {"source": "Natural Earth 1:50m geographic lines（パブリックドメイン）", "dateline": []}
for f in d["features"]:
    if f["properties"].get("featurecla") != "Date line":
        continue
    g = f["geometry"]
    parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    for p in parts:
        out["dateline"].append([[round(x, 2), round(y, 2)] for x, y in p])
path = os.path.join(os.path.dirname(__file__), "..", "data", "map", "lines.json")
json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(path, [len(p) for p in out["dateline"]], [(p[0], p[-1]) for p in out["dateline"]])

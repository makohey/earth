#!/usr/bin/env python3
"""
世界の首都（Natural Earth 1:50m populated places、パブリックドメイン）を地球儀用に変換する（手元で一度だけ実行）。

国境と同じく「見方（POV）」を持つ：
  fact : Natural Earth 既定の FEATURECLA が "Admin-0 capital"
  jp   : 日本の見方 FCLASS_JP（空なら既定と同じ）
見方によって首都かどうかが変わるもの、首都の位置をめぐって国際的に見方が分かれるもの（エルサレム）は disputed として印を変える。

使い方: python scripts/prep_capitals.py <ne_50m_populated_places.geojson>
"""
import json, os, sys

DISPUTED_EXTRA = {"Jerusalem"}          # 首都とするかどうか、国によって見方が分かれる（日本は大使館をテルアビブに置いている）
d = json.load(open(sys.argv[1], encoding="utf-8"))
rows = []
for f in d["features"]:
    p = f["properties"]
    fact = p.get("FEATURECLA") == "Admin-0 capital"
    jp = (p.get("FCLASS_JP") or p.get("FEATURECLA")) == "Admin-0 capital"
    if not (fact or jp):
        continue
    views = {p[k] for k in p if k.startswith("FCLASS_") and p[k]} | {p.get("FEATURECLA")}
    disputed = len({v == "Admin-0 capital" for v in views}) > 1 or p.get("NAME") in DISPUTED_EXTRA
    rows.append([p.get("NAME_JA") or p.get("NAME"), round(p["LATITUDE"], 3), round(p["LONGITUDE"], 3), p.get("ADM0NAME"),
                 int(fact), int(jp), int(disputed), int(p.get("LABELRANK") or 5), int(p.get("POP_MAX") or 0)])
out = {"source": "Natural Earth 1:50m populated places（パブリックドメイン）", "fields": ["ja", "lat", "lon", "country", "fact", "jp", "disputed", "rank", "pop"], "rows": rows}
path = os.path.join(os.path.dirname(__file__), "..", "data", "map", "capitals.json")
json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(path, len(rows), "disputed:", [r[0] for r in rows if r[6]])

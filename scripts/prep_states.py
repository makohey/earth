#!/usr/bin/env python3
"""
県・州（Natural Earth 1:10m admin-1、パブリックドメイン）を「地名の地球儀」用に変換する（手元で一度だけ実行）。

・見方が分かれる地域を含む国（ロシア・ウクライナ・中国・インドなど）は入れない（保留。2026-10-02 まことの判断）
・県・州の数が多すぎる国（フランスの県・イタリアの県）もいったん入れない
・境目の線は間引いて軽くし、ブラウザは「地名」モードで拡大したときだけ読み込む

使い方: python scripts/prep_states.py <ne_10m_admin_1_states_provinces.geojson> <ne_10m_admin_1_states_provinces_lines.geojson>
"""
import json, os, sys

COUNTRIES = ["JPN", "AUS", "USA", "CAN", "BRA", "MEX", "DEU", "NZL", "ZAF"]
TOL = 0.03


def simplify(coords):
    out = []
    for lon, lat, *_ in coords:
        if out and abs(out[-2] - lon) < TOL and abs(out[-1] - lat) < TOL:
            continue
        out += [round(lon, 2), round(lat, 2)]
    if coords and (out[-2], out[-1]) != (round(coords[-1][0], 2), round(coords[-1][1], 2)):
        out += [round(coords[-1][0], 2), round(coords[-1][1], 2)]
    return out


polys, lines = json.load(open(sys.argv[1], encoding="utf-8")), json.load(open(sys.argv[2], encoding="utf-8"))
labels = []
for f in polys["features"]:
    p = f["properties"]
    if p["adm0_a3"] not in COUNTRIES or p.get("latitude") is None:
        continue
    labels.append([p.get("name_ja") or p.get("name"), round(p["latitude"], 2), round(p["longitude"], 2), int(p.get("labelrank") or 9), p["adm0_a3"]])
out_lines = []
for f in lines["features"]:
    p, g = f["properties"], f["geometry"]
    if not g or p["ADM0_A3"] not in COUNTRIES or p["FEATURECLA"] != "Admin-1 boundary":
        continue
    parts = g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]
    for part in parts:
        s = simplify(part)
        if len(s) >= 4:
            out_lines.append(s)
out = {"source": "Natural Earth 1:10m admin-1（パブリックドメイン）", "countries": COUNTRIES, "labels": labels, "lines": out_lines}
path = os.path.join(os.path.dirname(__file__), "..", "data", "map", "states.json")
json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(path, "labels", len(labels), "lines", len(out_lines), "points", sum(len(l) // 2 for l in out_lines), os.path.getsize(path) // 1024, "KB")

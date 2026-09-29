#!/usr/bin/env python3
"""
夜空（天体観測モード）用の星・星座のデータを作る（手元で一度だけ実行）。
元：d3-celestial（BSD-3-Clause, Olaf Frohn）の data/ — 星は XHIP（Hipparcos 拡張）、星座線・名前は IAU の星座をもとにしたもの
天の川はここでは作らない（輪郭データの利用条件が確かめられないため、ブラウザで銀河座標から計算する）

使い方: python scripts/prep_sky.py <d3-celestial の data フォルダ>
"""
import json, os, sys
SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "sky")
os.makedirs(OUT, exist_ok=True)
ra = lambda lon: round(lon % 360, 3)       # GeoJSON の経度（-180〜180）→ 赤経（0〜360°）
stars = []
for f in json.load(open(os.path.join(SRC, "stars.6.json")))["features"]:
    m = f["properties"]["mag"]
    if m is None or m > 5.0:
        continue
    lo, la = f["geometry"]["coordinates"]
    try: bv = float(f["properties"].get("bv") or 0.6)
    except ValueError: bv = 0.6
    stars.append([ra(lo), round(la, 3), round(m, 2), round(bv, 2)])
lines = []
for f in json.load(open(os.path.join(SRC, "constellations.lines.json")))["features"]:
    for ln in f["geometry"]["coordinates"]:
        lines.append([v for lo, la in ln for v in (ra(lo), round(la, 3))])
names = []
for f in json.load(open(os.path.join(SRC, "constellations.json")))["features"]:
    p = f["properties"]; lo, la = f["geometry"]["coordinates"]
    names.append([p.get("ja") or p["name"], ra(lo), round(la, 2), int(p.get("rank", 3))])
json.dump({"epoch": "J2000", "stars": stars, "lines": lines, "names": names},
          open(os.path.join(OUT, "sky.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print(len(stars), "stars", len(lines), "line strips", len(names), "names")

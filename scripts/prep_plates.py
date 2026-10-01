#!/usr/bin/env python3
"""
プレートの境目（Peter Bird 2003 の PB2002 モデル）を地球儀用に変換する（手元で一度だけ実行）。
元データ：fraxen/tectonicplates（ODC-By 1.0。出典：Hugo Ahlenius, Nordpil and Peter Bird）の original/PB2002_steps.dat.txt

一区間ごとに：始点・終点（経度緯度）、種類、相対の速さ（mm/年）、接するプレートの組
種類：0 広がる（海嶺・大陸の裂け目 OSR/CRB）／1 ずれる（トランスフォーム断層 OTF/CTF）／2 ぶつかる（OCB/CCB）／3 沈み込む（SUB）
使い方: python scripts/prep_plates.py <PB2002_steps.dat.txt>
"""
import json, os, re, sys

KIND = {"OSR": 0, "CRB": 0, "OTF": 1, "CTF": 1, "OCB": 2, "CCB": 2, "SUB": 3}
steps = []
for line in open(sys.argv[1], encoding="ascii"):
    r = line.split()
    if len(r) != 15:
        continue
    cls = r[14].lstrip(":").rstrip("*")
    pair = r[1].lstrip(":")
    steps.append([round(float(r[2]), 2), round(float(r[3]), 2), round(float(r[4]), 2), round(float(r[5]), 2), KIND[cls], round(float(r[8]), 1), pair])
out = {"source": "PB2002（Bird, 2003）／fraxen/tectonicplates（ODC-By 1.0）", "fields": ["lon1", "lat1", "lon2", "lat2", "kind", "mmPerYear", "pair"], "steps": steps}
path = os.path.join(os.path.dirname(__file__), "..", "data", "map", "plates.json")
json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(path, len(steps), os.path.getsize(path))

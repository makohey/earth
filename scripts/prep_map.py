#!/usr/bin/env python3
"""
Natural Earth（パブリックドメイン）から「ふつうの地球儀」用の国境線と国名を作る（手元で一度だけ実行）。

見方（POV）は二つを同じファイルに持たせる：
  jp   : 日本から見た境界（Natural Earth の FCLASS_JP）
  fact : 実際の管理の線（Natural Earth 既定の FEATURECLA）。主張が食い違う線は点線
線の種類：solid（国境）／ dashed（係争・主張・未確定・停戦ライン等）／ 出さない（Unrecognized）

使い方: python scripts/prep_map.py <natural-earth-vector の geojson フォルダ>
"""
import json, os, sys

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "map")
os.makedirs(OUT, exist_ok=True)

def style(cls):
    if not cls or cls == "Unrecognized":
        return None
    return "solid" if cls.startswith("International") else "dashed"

def lines_of(geom):
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []

out = []
for name in ["ne_50m_admin_0_boundary_lines_land", "ne_50m_admin_0_boundary_lines_disputed_areas"]:
    for f in json.load(open(os.path.join(SRC, name + ".geojson")))["features"]:
        p = f["properties"]
        fact = style(p.get("FEATURECLA"))
        if name.endswith("disputed_areas") and fact:
            fact = "dashed"                       # 既定の見方では、主張線はすべて点線
        jp = style(p.get("FCLASS_JP") or p.get("FEATURECLA"))
        if name.endswith("disputed_areas") and not p.get("FCLASS_JP") and jp:
            jp = "dashed"
        if not fact and not jp:
            continue
        for ln in lines_of(f["geometry"]):
            out.append({"fact": fact, "jp": jp, "c": [v for lo, la in ln for v in (round(lo, 2), round(la, 2))]})

# 日本語の地図でふつうに使う短い呼び名（元データの正式名が長いもの）
SHORT = {"Taiwan": "台湾", "South Korea": "韓国", "North Korea": "北朝鮮", "China": "中国",
         "United States of America": "アメリカ", "Thailand": "タイ", "Mongolia": "モンゴル", "Mali": "マリ",
         "South Africa": "南アフリカ", "Kosovo": "コソボ", "N. Cyprus": "北キプロス"}
labels = []
for f in json.load(open(os.path.join(SRC, "ne_50m_admin_0_countries.geojson")))["features"]:
    p = f["properties"]
    if p["NAME"] == "Siachen Glacier":
        continue
    labels.append({"ja": SHORT.get(p["NAME"], p["NAME_JA"]), "rank": p["LABELRANK"],
                   "lon": round(p["LABEL_X"], 2), "lat": round(p["LABEL_Y"], 2),
                   "jp": p.get("FCLASS_JP") != "Unrecognized"})

json.dump({"lines": out}, open(os.path.join(OUT, "boundaries.json"), "w"), ensure_ascii=False, separators=(",", ":"))
json.dump({"labels": labels}, open(os.path.join(OUT, "labels.json"), "w"), ensure_ascii=False, separators=(",", ":"))
print(len(out), "lines", len(labels), "labels")

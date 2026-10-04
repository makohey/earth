#!/usr/bin/env python3
"""
プレートの動き（研究モデル）を地球儀用に用意する（一度だけ・手元で実行）。

・プレートの形：PB2002（Bird 2003）のプレートの多角形（fraxen/tectonicplates、ODC-By 1.0）
・回り方（オイラー極と回転の速さ）：同じく PB2002_poles（太平洋プレートを止めたときの値。出典は表の各行の文献）
・基準：「地球全体として回っていない」（NNR：no-net-rotation）に直す。プレートごとの回転を面積で平均した分を全体から引く
・出力：data/map/platemotion.json（プレートごとの回転ベクトル）＋ data/map/platemotion.bin（1°ごとのプレート番号）

使い方: python scripts/prep_platemotion.py --src <tectonicplates のフォルダ>
"""
import argparse
import json
import math
import os

import numpy as np
import pandas as pd
from shapely.geometry import Point, shape
from shapely.prepared import prep


def xyz(lat, lon):
    """地球儀と同じ座標（toXYZ）：x=cos緯度 cos経度, y=sin緯度, z=-cos緯度 sin経度"""
    la, lo = math.radians(lat), math.radians(lon)
    return np.array([math.cos(la) * math.cos(lo), math.sin(la), -math.cos(la) * math.sin(lo)])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default="data/map")
    a = ap.parse_args()
    poles = pd.read_excel(os.path.join(a.src, "PB2002_poles.xls"), header=0, keep_default_na=False)
    poles = poles[poles.iloc[:, 1].astype(str).str.strip() != ""]
    W = {}
    for _, r in poles.iterrows():
        code = str(r.iloc[0]).strip(); name = str(r.iloc[1]).strip()
        if name == "North America":
            code = "NA"                                     # 表計算ソフトが "NA" を空欄扱いにするため
        try:
            lat, lon, rate = float(r.iloc[3]), float(r.iloc[4]), float(r.iloc[5])
        except ValueError:
            continue
        W[code] = xyz(lat, lon) * math.radians(rate)        # rad / 100万年（太平洋プレート固定）
    plates = json.load(open(os.path.join(a.src, "GeoJSON", "PB2002_plates.json")))
    geoms = [(f["properties"]["Code"], prep(shape(f["geometry"]))) for f in plates["features"]]
    codes = sorted({c for c, _ in geoms})
    idx = {c: i for i, c in enumerate(codes)}
    grid = np.full((180, 360), 255, dtype="uint8")
    for j in range(180):
        lat = 89.5 - j
        for i in range(360):
            lon = -179.5 + i
            p = Point(lon, lat)
            for c, g in geoms:
                if g.contains(p):
                    grid[j, i] = idx[c]; break
    # NNR：L = Σ r×(ω×r) dA、全体の回転 ω_net = 3L/(8π)
    L = np.zeros(3); dA0 = math.radians(1) ** 2
    for j in range(180):
        lat = 89.5 - j; dA = dA0 * math.cos(math.radians(lat))
        for i in range(360):
            c = codes[grid[j, i]] if grid[j, i] != 255 else None
            if c is None or c not in W:
                continue
            r = xyz(lat, -179.5 + i)
            L += np.cross(r, np.cross(W[c], r)) * dA
    wnet = 3 * L / (8 * math.pi)
    out = []
    for c in codes:
        w = (W.get(c, np.zeros(3)) - wnet) if c in W else None
        out.append({"code": c, "w": [round(float(x), 7) for x in w] if w is not None else None})
    missing = [c for c in codes if c not in W]
    os.makedirs(a.out, exist_ok=True)
    grid.tofile(os.path.join(a.out, "platemotion.bin"))
    json.dump({
        "source": "PB2002（Bird, 2003）のプレートの形と回転（fraxen/tectonicplates、ODC-By 1.0）。地球全体として回らない基準（NNR）に変換",
        "grid": {"nx": 360, "ny": 180, "lon0": -179.5, "lat0": 89.5, "dx": 1, "dy": 1, "none": 255},
        "units": "w = 回転ベクトル（rad / 100万年、地球儀の座標）。速さ＝ w × r × 6371 km/100万年＝mm/年",
        "plates": out,
    }, open(os.path.join(a.out, "platemotion.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    # 確かめ：いくつかの地点の速さ
    def vel(lat, lon):
        j, i = int(89.5 - lat + 0.5) if False else int(round(89.5 - lat)), int(round(lon + 179.5)) % 360
        c = codes[grid[j, i]]; w = W[c] - wnet; r = xyz(lat, lon); v = np.cross(w, r) * 6371  # mm/年
        e = np.array([-math.sin(math.radians(lon)), 0, -math.cos(math.radians(lon))]); n = np.cross(r, e) * -1
        return c, round(float(np.linalg.norm(v)), 1), round(math.degrees(math.atan2(float(v @ e), float(v @ (-np.cross(r, e))))), 0)
    print("NNR 補正:", np.round(wnet, 6), "足りない極:", missing)
    for p in [(30, 150), (0, -120), (20, 78), (40, -100), (50, 10), (-25, 135), (-10, -60)]:
        print(p, vel(*p))


if __name__ == "__main__":
    main()

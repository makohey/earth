#!/usr/bin/env python3
"""
海底の年齢（海の底の岩ができてから何百万年か）を、地球儀用の小さな格子に直す Adapter。

  外（GMT のデータ置き場が配る EarthByte の海底年齢 1°格子、元データ Seton et al. 2020）→ この Adapter → seaage.bin ＋ 目録の1項目

・動かないデータなので一度だけ取る（約73KB）。置き場（Actions のキャッシュ）にあれば二度と取りに行かない
・GMT のデータ置き場は世界に何か所かあるので、順に試す。断られたら（403／429）印を残し、人が見直すまで取りに行かない
・海嶺（生まれる所）が若く、海溝（沈む所）に近いほど古い。陸や大陸棚はデータなし

使い方: python scripts/fetch_seafloor_age.py --latest _site/data/latest --cache seaage_cache
"""
import argparse
import json
import os
import urllib.error
import urllib.request

import numpy as np

PATH = "server/earth/earth_age/earth_age_01d_g.grd"
MIRRORS = ["https://oceania.generic-mapping-tools.org/", "https://sdsc-opentopography.generic-mapping-tools.org/",
           "https://china.generic-mapping-tools.org/"]
UA = "globe-prototype/seafloor-age (+https://github.com/makohey/earth; GitHub Actions; one 73KB file, once)"
NONE = 255


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def fetch(cache):
    path = os.path.join(cache, "earth_age_01d_g.grd")
    if os.path.exists(path):
        return path, "キャッシュ"
    if os.path.exists(os.path.join(cache, "REFUSED")):
        return None, "断られた印あり"
    for m in MIRRORS:
        try:
            req = urllib.request.Request(m + PATH, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            open(path, "wb").write(body)
            return path, m
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                open(os.path.join(cache, "REFUSED"), "w").write(f"{e.code} {m}\n")
                note(f"海底の年齢：{m} に断られました（{e.code}）。取りに行くのをやめます", "warning")
                return None, "断られた"
            note(f"海底の年齢：{m} {e.code}", "warning")
        except Exception as e:
            note(f"海底の年齢：{m} {e}", "warning")
    return None, "取れなかった"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    os.makedirs(args.cache, exist_ok=True)
    path, src = fetch(args.cache)
    if not path:
        note(f"海底の年齢：今回はなし（{src}）", "warning")
        return
    import netCDF4
    ds = netCDF4.Dataset(path)
    names = list(ds.variables)
    zname = next(n for n in names if ds.variables[n].ndim == 2)
    lat = np.array(ds.variables[next(n for n in names if n.lower().startswith("lat") or n == "y")][:], dtype="float64")
    lon = np.array(ds.variables[next(n for n in names if n.lower().startswith("lon") or n == "x")][:], dtype="float64")
    z = np.ma.filled(np.ma.masked_invalid(ds.variables[zname][:].astype("float64")), np.nan)
    ds.close()
    # 1°の升目（緯度 89.5 → -89.5、経度 -179.5 → 179.5）に、一番近い格子点の値を置く
    out = np.full((180, 360), NONE, dtype="uint8")
    for j in range(180):
        la = 89.5 - j; jj = int(np.argmin(np.abs(lat - la)))
        for i in range(360):
            lo = -179.5 + i; d = np.abs(((lon - lo) + 180) % 360 - 180); ii = int(np.argmin(d))
            v = z[jj, ii]
            if not np.isnan(v):
                out[j, i] = int(np.clip(round(v), 0, 254))
    out.tofile(os.path.join(args.latest, "seaage.bin"))
    manifest = json.load(open(mpath, encoding="utf-8"))
    manifest["layers"]["seafloor-age"] = {
        "type": "grid", "file": "seaage.bin", "format": "uint8-myr", "lazy": True,
        "grid": {"nx": 360, "ny": 180, "lon0": -179.5, "lat0": 89.5, "dx": 1, "dy": 1, "none": NONE},
        "meta": {
            "title": "海底の年齢", "kind": "観測から作った研究モデル",
            "model": "EarthByte の海底年齢（Seton et al. 2020、G-cubed）を GMT のデータ置き場の 1°格子で",
            "units": "百万年（Ma）",
            "credit": "Seton, M., Müller, R. D., et al. (2020) A global dataset of present-day oceanic crustal age and seafloor spreading parameters, G-cubed, doi:10.1029/2020GC009214（GMT remote datasets 経由）",
            "caution": "海底の岩ができてからの年数の推定です（海底の磁気の縞模様などから）。陸と大陸棚はデータがありません",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ok = out[out != NONE]
    note(f"海底の年齢 付加: 海の升目 {ok.size}・いちばん古い {int(ok.max()) if ok.size else '-'} 百万年（{src}・変数 {zname}）")


if __name__ == "__main__":
    main()

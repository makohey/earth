#!/usr/bin/env python3
"""
海流（いつもの流れ）：NOAA AOML Global Drifter Program の「漂流ブイから作った海面の流れの月平均（平年）」を、
地球儀の流れの層に直す Adapter。

  外（NOAA AOML ERDDAP・米国政府の公開データ）→ この Adapter → currents.bin ＋ 目録の1項目

・中身は「何十年ぶんのブイの記録から作った、その月のいつもの流れ」。今日の海流ではない（画面にもそう書く）
・時計の月の1枚だけを、0.5° に間引いて取る。平年の値なので一度取った月は取り直さない（置き場＝Actions のキャッシュ）
・同じデータに入っている水温（同じくブイの月平均）で線に色を付ける
・断られたら（403／429 など）その回は取りに行かず、置き場の古い分を使う

使い方: python scripts/fetch_currents.py --latest _site/data/latest --cache currents_cache
"""
import argparse
import datetime as dt
import glob
import json
import os
import urllib.error
import urllib.parse
import urllib.request

import numpy as np

BASE = "https://erddap.aoml.noaa.gov/gdp/erddap/griddap/drifter_monthlymeans.nc"
UA = "globe-prototype/currents (+https://github.com/makohey/earth; GitHub Actions; one climatological month, cached)"
LON = "[(-179.875):2:(179.875)]"
LAT = "[(-72.875):2:(84.875)]"
MISSING = -32768


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def fetch(month_idx):
    """軸の順番（月・経度・緯度 か 月・緯度・経度）が分からないので、二通り試す。断られたら止める"""
    last = None
    for order in ((LON, LAT), (LAT, LON)):
        sub = f"[({month_idx})]" + "".join(order)
        q = ",".join(f"{v}{sub}" for v in ("U", "V", "SST"))
        url = BASE + "?" + urllib.parse.quote(q, safe="")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code in (403, 429, 503):
                raise RuntimeError(f"断られました（{e.code}）。今回は取りに行きません")
            last = e                                   # 400/404：軸の順番ちがい → もう一方で試す
    raise RuntimeError(f"取得できませんでした: {last}")


def to_grid(path):
    import netCDF4
    ds = netCDF4.Dataset(path)
    def arr(name):
        v = ds.variables[name]
        dims = [d.lower() for d in v.dimensions]
        a = np.ma.filled(np.ma.masked_invalid(v[:].astype("float64")), np.nan)
        a = np.squeeze(a, axis=dims.index(next(d for d in dims if "month" in d)))
        dims = [d for d in dims if "month" not in d]
        if dims[0].startswith("lon"):
            a = a.T                                    # → [緯度, 経度]
        return a
    lat = np.array(ds.variables["latitude"][:], dtype="float64")
    lon = np.array(ds.variables["longitude"][:], dtype="float64")
    U, V, T = arr("U"), arr("V"), arr("SST")
    ds.close()
    if lat[0] < lat[-1]:                               # 北から南の順に並べる
        lat, U, V, T = lat[::-1], U[::-1], V[::-1], T[::-1]
    return lat, lon, U, V, T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    os.makedirs(args.cache, exist_ok=True)
    manifest = json.load(open(mpath, encoding="utf-8"))
    clock = dt.datetime.fromisoformat(manifest["layers"]["wind-10m"]["meta"]["validTime"].replace("Z", "+00:00"))
    m = clock.month - 1                                # ClimatologicalMonth は 0＝1月
    path = os.path.join(args.cache, f"drifter_m{m:02d}.nc")
    src = "キャッシュ"
    if not os.path.exists(path):
        try:
            body = fetch(m)
            open(path, "wb").write(body)
            src = "取得"
        except Exception as e:
            note(f"海流（AOML）: {e}", "warning")
            old = sorted(glob.glob(os.path.join(args.cache, "drifter_m*.nc")))
            if not old:
                note("海流：使える一式がありません（今回は海流なし）", "warning")
                return
            path, src = old[-1], "前の月のキャッシュ"
    lat, lon, U, V, T = to_grid(path)
    ny, nx = U.shape
    dx = float(np.round(lon[1] - lon[0], 4)); dy = float(np.round(lat[0] - lat[1], 4))
    q = np.full((ny, nx, 3), MISSING, dtype="<i2")
    ok = ~(np.isnan(U) | np.isnan(V))
    q[..., 0] = np.where(ok, np.clip(np.round(U * 1000), -32000, 32000), MISSING)
    q[..., 1] = np.where(ok, np.clip(np.round(V * 1000), -32000, 32000), MISSING)
    q[..., 2] = np.where(np.isnan(T), MISSING, np.clip(np.round(T * 100), -500, 4000))
    with open(os.path.join(args.latest, "currents.bin"), "wb") as f:
        f.write(q.tobytes())
    sp = np.hypot(U, V)[ok]
    month_ja = f"{m + 1}月"
    manifest["layers"]["currents"] = {
        "type": "flow", "file": "currents.bin", "format": "int16-uvt", "lazy": True,
        "grid": {"nx": int(nx), "ny": int(ny), "lo1": float(lon[0]), "la1": float(lat[0]), "dx": dx, "dy": dy,
                 "scale": 1000, "scaleT": 100, "missing": MISSING},
        "meta": {
            "title": "海流（いつもの流れ）", "kind": "観測から作った平年（月平均）",
            "model": f"NOAA AOML 漂流ブイの記録から作った海面近く（約15m）の流れの{month_ja}の平均",
            "month": m + 1, "resolution": f"{dx:g}° 格子（{nx}×{ny}）", "units": "m/s",
            "credit": "NOAA AOML Global Drifter Program（Laurindo et al. 2017、漂流ブイの記録〜2023年2月）",
            "caution": "今日の海流ではなく、その月のいつもの流れです。線の色は同じブイの記録から作った水温（平年）。流れる速さは見やすさのための倍率です",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"海流 付加: {month_ja}の平均・{nx}×{ny}・海の格子 {int(ok.sum())}・速さの中央値 {np.median(sp):.2f} m/s・最大 {sp.max():.2f} m/s（{src}）")


if __name__ == "__main__":
    main()

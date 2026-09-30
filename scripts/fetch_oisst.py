#!/usr/bin/env python3
"""
海面水温の平年差（NOAA OISST v2.1 の日平均・anom）を、地球儀の「値の場（Scalar）」の共通形式に直す Adapter。

  外（NOAA NCEI・米国政府の公開データ）→ この Adapter → sstanom.bin ＋ 目録の1項目

・日ごとのデータなので、1日に1枚だけ取れば足りる。取った日のファイルは Actions のキャッシュに残し、
  同じ日の分は取り直さない（DATA_USE.md の「同じものを取り直さない」）
・時計の日付より前で一番新しい日（最新は1〜2日遅れで公開。速報版 preliminary を優先）
・エルニーニョ／ラニーニャは「いつもより温かい／冷たい」が本体なので、温度そのものではなく平年差を出す

使い方: python scripts/fetch_oisst.py --latest _site/data/latest --cache oisst_cache
"""
import argparse
import datetime as dt
import json
import os
import urllib.error
import urllib.request

import numpy as np

BASE = "https://www.ncei.noaa.gov/data/sea-surface-temperature-optimum-interpolation/v2.1/access/avhrr"
UA = "globe-prototype/sst (+https://github.com/makohey/earth; GitHub Actions; at most one file per day)"
LOOKBACK_DAYS = 6
AMIN, AMAX = -5.0, 5.0          # 保存する平年差の幅（℃）


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def candidates(day):
    ym, ymd = day.strftime("%Y%m"), day.strftime("%Y%m%d")
    return [f"{BASE}/{ym}/oisst-avhrr-v02r01.{ymd}_preliminary.nc", f"{BASE}/{ym}/oisst-avhrr-v02r01.{ymd}.nc"]


def get_file(day, cache):
    os.makedirs(cache, exist_ok=True)
    local = os.path.join(cache, f"oisst_{day:%Y%m%d}.nc")
    if os.path.exists(local):
        return local, "キャッシュ"
    for url in candidates(day):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
            with open(local, "wb") as f:
                f.write(body)
            return local, url.rsplit("/", 1)[-1]
        except urllib.error.HTTPError as e:
            if e.code in (429, 503):
                note(f"NCEI が混雑（{e.code}）。今回は取りに行かない", "warning")
                return None, "stop"                     # 取り返そうとして連打しない
            continue                                    # 404：まだ出ていない → 別名・前の日へ
        except Exception as e:
            note(f"OISST 取得に失敗: {e}", "warning")
            return None, "stop"
    return None, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    manifest = json.load(open(mpath, encoding="utf-8"))
    clock = dt.datetime.fromisoformat(manifest["layers"]["wind-10m"]["meta"]["validTime"].replace("Z", "+00:00"))
    path = src = day = None
    for back in range(1, LOOKBACK_DAYS + 1):           # 時計の日付より前の日から（未来は使わない）
        day = (clock - dt.timedelta(days=back)).date()
        path, src = get_file(day, args.cache)
        if path or src == "stop":
            break
    for name in os.listdir(args.cache):                # 古い日のファイルは消す（キャッシュを太らせない）
        if name.endswith(".nc") and name[6:14] < f"{clock - dt.timedelta(days=LOOKBACK_DAYS + 2):%Y%m%d}":
            os.remove(os.path.join(args.cache, name))
    if not path:
        note("海面水温の平年差：使える日が見つかりませんでした", "warning")
        return
    import netCDF4
    ds = netCDF4.Dataset(path)
    a = np.ma.filled(ds.variables["anom"][0, 0].astype("float64"), np.nan)   # (lat 南→北, lon 0→360)
    lat = ds.variables["lat"][:]
    ds.close()
    if lat[0] < lat[-1]:
        a = a[::-1]                                     # 北→南へ
    a = np.concatenate([a[:, 720:], a[:, :720]], axis=1)  # 経度 −180〜180 へ
    ny, nx = a.shape
    b = np.nanmean(a.reshape(ny // 2, 2, nx // 2, 2), axis=(1, 3))   # 0.25° → 0.5°（軽くする）
    q = np.where(np.isnan(b), 255, np.clip(np.round((b - AMIN) / (AMAX - AMIN) * 250), 0, 250)).astype("uint8")
    with open(os.path.join(args.latest, "sstanom.bin"), "wb") as f:
        f.write(q.tobytes())
    manifest["layers"]["sst-anom"] = {
        "type": "scalar", "file": "sstanom.bin", "format": "uint8",
        "grid": {"nx": b.shape[1], "ny": b.shape[0], "lon0": -180, "lat0": 90, "dx": 0.5, "dy": 0.5},
        "meta": {
            "title": "海面水温の平年差", "level": "海面", "kind": "観測の解析（衛星・船・ブイ）",
            "model": "NOAA OISST v2.1（日平均。平年＝1991〜2020年）",
            "validFrom": f"{day:%Y-%m-%d}T00:00:00Z", "validTo": f"{(day + dt.timedelta(days=1)):%Y-%m-%d}T00:00:00Z",
            "selection": {"policy": "latestBefore", "maxAgeMin": LOOKBACK_DAYS * 1440},
            "validTime": f"{day:%Y-%m-%d}T12:00:00Z",
            "usualIntervalH": 24, "delivery": "1日に1枚（同じ日の分は取り直さない）",
            "resolution": "0.5° 格子に整形（元は 0.25°）", "units": "℃", "coverage": "全球の海（海氷の下や陸はデータなし）",
            "credit": "NOAA NCEI Optimum Interpolation SST v2.1（米国政府の公開データ）",
            "caution": "いつもより何℃温かい（赤）か冷たい（青）か。エルニーニョは赤道の東太平洋が赤くなる。宣言や判定は気象庁の監視速報を",
            "encoding": {"type": "linearByte", "scale": (AMAX - AMIN) / 250, "offset": AMIN, "missing": 255},
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    box = lambda la0, la1, lo0, lo1: np.nanmean(b[int((90 - la1) / 0.5):int((90 - la0) / 0.5), int((lo0 + 180) / 0.5):int((lo1 + 180) / 0.5)])
    note(f"海面水温の平年差 付加: {day}（{src}）／ニーニョ3.4域の平年差 {box(-5, 5, -170, -120):+.2f}℃")


if __name__ == "__main__":
    main()

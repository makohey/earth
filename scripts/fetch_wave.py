#!/usr/bin/env python3
"""
波（NOAA の波のモデル GFS-Wave／WAVEWATCH III）の「波の高さ・向き・周期」を、地球儀の形に直す Adapter。

  外（NOAA NOMADS の切り出し）→ この Adapter → wave.bin ＋ 目録の1項目

・風や雨と同じ GFS の回・同じ時刻（初期時刻 +3時間）を1回だけもらう。回ごとに1回（1日4回）
・0.25°でもらい、0.5°に間引いて軽くする（約0.8MB）
・まだ出ていない／断られたときは、前の回の波をそのまま使い、外へは取りに行き直さない
・波の高さは「有義波高」（大きい方から3分の1の波の平均）。たまに来る一番大きい波は2倍近くになることがある
・この先の波（波浪予報）は扱わない。もう過ぎた時刻の計算として見せる

使い方: python scripts/fetch_wave.py --latest _site/data/latest --prev saved_latest
"""
import argparse
import datetime as dt
import json
import os
import shutil
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import eccodes

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfswave.pl"
FHOUR = 3
UA = "globe-prototype/wave (+https://github.com/makohey/earth; GitHub Actions; one request per GFS cycle)"
NONE = 255
# GRIB2 表 4.2-10-0（海の波）
PARAMS = {(10, 0, 3): "h", (10, 0, 10): "dir", (10, 0, 11): "per"}


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def url_for(cyc):
    d, h = cyc.strftime("%Y%m%d"), cyc.strftime("%H")
    q = {"dir": f"/gfs.{d}/{h}/wave/gridded", "file": f"gfswave.t{h}z.global.0p25.f{FHOUR:03d}.grib2",
         "var_HTSGW": "on", "var_DIRPW": "on", "var_PERPW": "on", "lev_surface": "on"}
    return NOMADS + "?" + urllib.parse.urlencode(q)


def download(url, tries=2):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                body = r.read()
            if body[:4] == b"GRIB":
                return body, None
            return None, "GRIB ではない応答（まだ出ていない可能性）"
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                return None, f"断られました（{e.code}）"
            if e.code == 404:
                return None, "まだ出ていない（404）"
            err = f"HTTP {e.code}"
        except Exception as e:
            err = str(e)
        time.sleep(8 * (k + 1))
    return None, err


def read(path):
    out, shape = {}, None
    with open(path, "rb") as f:
        while True:
            h = eccodes.codes_grib_new_from_file(f)
            if h is None:
                break
            try:
                key = (eccodes.codes_get(h, "discipline"), eccodes.codes_get(h, "parameterCategory"), eccodes.codes_get(h, "parameterNumber"))
                name = PARAMS.get(key)
                if not name:
                    continue
                ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
                v = np.array(eccodes.codes_get_values(h), dtype="float64")
                miss = eccodes.codes_get(h, "missingValue")
                v[v == miss] = np.nan
                a = v.reshape(nj, ni)
                la1, la2 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees"), eccodes.codes_get(h, "latitudeOfLastGridPointInDegrees")
                if la1 < la2:                    # 北から南の並びにそろえる
                    a = a[::-1]
                lo1 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
                out[name] = a
                shape = (nj, ni, max(la1, la2), lo1, eccodes.codes_get(h, "iDirectionIncrementInDegrees"))
            finally:
                eccodes.codes_release(h)
    return out, shape


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--prev", default=None, help="前の回の一式（波が取れなかったときに使う）")
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    man = json.load(open(mpath, encoding="utf-8"))
    w = man["layers"].get("wind-10m", {}).get("meta", {})
    if man.get("mode") != "live" or not w.get("issuedTime"):
        return
    cyc = dt.datetime.fromisoformat(w["issuedTime"].replace("Z", "+00:00"))

    def fallback(why):
        note(f"波：今回はもらえませんでした（{why}）。前の回の波があればそれを使います", "warning")
        if args.prev and os.path.exists(os.path.join(args.prev, "wave.bin")):
            pm = json.load(open(os.path.join(args.prev, "manifest.json"), encoding="utf-8"))
            if "wave" in pm.get("layers", {}):
                shutil.copy2(os.path.join(args.prev, "wave.bin"), os.path.join(args.latest, "wave.bin"))
                man["layers"]["wave"] = pm["layers"]["wave"]
                json.dump(man, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                note(f"波：前の回（{pm['layers']['wave']['meta'].get('validTime')}）を使います")

    body, why = download(url_for(cyc))
    if not body:
        return fallback(why)
    with tempfile.NamedTemporaryFile(suffix=".grib2", delete=False) as f:
        f.write(body)
        tmp = f.name
    try:
        F, shape = read(tmp)
    finally:
        os.remove(tmp)
    if "h" not in F or not shape:
        return fallback("波の高さが入っていませんでした")
    nj, ni, lat0, lon0, d = shape
    step = max(1, int(round(0.5 / d)))               # 0.5°に間引く
    sub = lambda a: a[::step, ::step]
    H = sub(F["h"]); D = sub(F.get("dir", np.full_like(F["h"], np.nan))); P = sub(F.get("per", np.full_like(F["h"], np.nan)))
    ny, nx = H.shape
    enc = lambda a, s, top: np.where(np.isnan(a), NONE, np.clip(np.round(a * s), 0, top)).astype("uint8")
    planes = [enc(H, 10, 254), enc(np.mod(D, 360), 254 / 360, 253), enc(P, 5, 254)]
    with open(os.path.join(args.latest, "wave.bin"), "wb") as f:
        for p in planes:
            f.write(p.tobytes())
    valid = cyc + dt.timedelta(hours=FHOUR)
    man["layers"]["wave"] = {
        "type": "grid", "file": "wave.bin", "format": "uint8-planes-h10-dir-per5", "lazy": True,
        "grid": {"nx": int(nx), "ny": int(ny), "lon0": float(lon0), "lat0": float(lat0), "dx": d * step, "dy": d * step, "none": NONE,
                 "planes": {"h": {"scale": 0.1, "units": "m"}, "dir": {"scale": 360 / 254, "units": "度（波が来る方向・北から時計回り）"}, "per": {"scale": 0.2, "units": "秒"}}},
        "meta": {
            "title": "波（高さ・向き・周期）", "kind": "モデル計算",
            "model": f"NOAA GFS-Wave（WAVEWATCH III）初期値 +{FHOUR}時間",
            "validTime": iso(valid), "issuedTime": iso(cyc), "resolution": f"{d * step:g}° 格子（{nx}×{ny}）",
            "credit": "NOAA / NCEP GFS-Wave（WAVEWATCH III、米国政府の著作物・パブリックドメイン）",
            "caution": "波の高さは有義波高（大きい方から3分の1の波の平均）。一番大きい波は2倍近くになることがあります。約50kmの格子なので、岸のすぐ近くや湾の中は合いません。この先の波は扱いません（気象庁の波浪予報へ）",
        },
    }
    json.dump(man, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    ok = ~np.isnan(H)
    note(f"波 付加: {nx}×{ny}・海の升目 {int(ok.sum())}・いちばん高い {np.nanmax(H):.1f} m（初期時刻 {iso(cyc)}）")


if __name__ == "__main__":
    main()

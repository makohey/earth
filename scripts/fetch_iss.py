#!/usr/bin/env python3
"""
ISS（国際宇宙ステーション）の軌道要素を CelesTrak から1回だけ取り、
「いまから先の約8時間＋直前の1.5時間」の位置を30秒ごとに計算して配る Adapter。

  外（CelesTrak の GP データ・無料公開）→ この Adapter（SGP4 で計算）→ iss.json ＋ 目録の1項目

・ブラウザは計算済みの位置を時刻で補間するだけ。見ている人のブラウザから CelesTrak へは取りに行かない
・取得は定時の更新で1回（1日4回）。CelesTrak の「同じデータを頻繁に取りに来ない」お願いの範囲
・ISS は地球儀の時計ではなく「いま」の位置で動かす（時計の約束の例外。Lens に明記）

使い方: python scripts/fetch_iss.py --latest _site/data/latest
"""
import argparse
import datetime as dt
import json
import math
import os
import urllib.request

from sgp4.api import Satrec, jday

URL = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE"
UA = "globe-prototype/iss (+https://github.com/makohey/earth; GitHub Actions; one request per run)"
STEP_S, BEFORE_MIN, AFTER_H = 30, 95, 8
R_EARTH = 6371.0


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def gmst(jd_ut1):
    t = (jd_ut1 - 2451545.0) / 36525.0
    g = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t ** 3
    return math.radians((g % 86400) / 240.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            lines = [l.strip() for l in r.read().decode("ascii", "replace").splitlines() if l.strip()]
    except Exception as e:
        note(f"ISS の軌道要素を取得できませんでした（今回は ISS なし）: {e}", "warning")
        return
    l1 = next((l for l in lines if l.startswith("1 ")), None)
    l2 = next((l for l in lines if l.startswith("2 ")), None)
    if not l1 or not l2:
        note("ISS の軌道要素の形式が読めません: " + " | ".join(lines[:3])[:200], "warning")
        return
    sat = Satrec.twoline2rv(l1, l2)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    t0 = now - dt.timedelta(minutes=BEFORE_MIN)
    n = int((BEFORE_MIN * 60 + AFTER_H * 3600) / STEP_S) + 1
    pts = []
    for k in range(n):
        t = t0 + dt.timedelta(seconds=k * STEP_S)
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second)
        e, r, _ = sat.sgp4(jd, fr)
        if e != 0:
            continue
        th = gmst(jd + fr)                                   # TEME → 地球に固定した座標（地軸まわりに回す）
        x = r[0] * math.cos(th) + r[1] * math.sin(th)
        y = -r[0] * math.sin(th) + r[1] * math.cos(th)
        z = r[2]
        rr = math.sqrt(x * x + y * y + z * z)
        pts.append([round(math.degrees(math.asin(z / rr)), 3), round(math.degrees(math.atan2(y, x)), 3), round(rr - R_EARTH, 1)])
    manifest = json.load(open(mpath, encoding="utf-8"))
    with open(os.path.join(args.latest, "iss.json"), "w", encoding="utf-8") as f:
        json.dump({"t0": int(t0.timestamp()), "step": STEP_S, "pts": pts}, f, separators=(",", ":"))
    epoch = sat.jdsatepoch + sat.jdsatepochF
    ep = dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc) + dt.timedelta(days=epoch - 2451545.0)
    manifest["layers"]["iss"] = {
        "type": "orbit", "file": "iss.json", "format": "track",
        "meta": {
            "title": "ISS（国際宇宙ステーション）", "kind": "計算（軌道要素から）",
            "model": "CelesTrak の軌道要素（TLE）から SGP4 で計算",
            "clock": "now", "tleEpoch": ep.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "validFrom": t0.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "validTo": (t0 + dt.timedelta(seconds=(n - 1) * STEP_S)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "credit": "CelesTrak（軌道要素）、計算：SGP4（sgp4 ライブラリ）",
            "caution": "ISS だけは地球儀の時計ではなく「いま」の位置で動いています。数分〜数十km の誤差があります",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"ISS 付加: {len(pts)} 点（{t0:%H:%M}〜{AFTER_H}時間先、30秒ごと）／軌道要素の時刻 {ep:%Y-%m-%d %H:%M} UTC／いまの高度 約{pts[BEFORE_MIN*2][2]:.0f} km")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
名前を聞いたことのある人工衛星（ISS・天宮・ハッブル・ひまわり・GPS・ガリレオ・みちびき）の軌道要素を
CelesTrak から取り、「いま」の前後の位置を計算して配る Adapter（fetch_iss.py を広げたもの）。

  外（CelesTrak の GP データ・無料公開）→ この Adapter（SGP4 で計算）→ sats.json ＋ 目録の1項目

・取得は定時の更新ごとに 5 リクエスト（測位衛星のグループ1つ＋個別4機）。1日4回。間を2秒あける
・ブラウザは計算済みの位置を時刻で補間するだけ。見ている人のブラウザから CelesTrak へは取りに行かない
・衛星は地球儀の時計ではなく「いま」の位置で動かす（時計の約束の例外。Lens に明記）
・高さはブラウザ側で縮めて描く（順番は本物のまま）。ここでは本当の高さ（km）を配る

使い方: python scripts/fetch_sats.py --latest _site/data/latest
"""
import argparse
import datetime as dt
import json
import math
import os
import time
import urllib.request

from sgp4.api import Satrec, jday

GP = "https://celestrak.org/NORAD/elements/gp.php"
UA = "globe-prototype/sats (+https://github.com/makohey/earth; GitHub Actions; 5 requests per run, 4 runs per day)"
R_EARTH = 6371.0

# 個別に取る衛星（NORAD 番号）
SINGLE = [
    {"catnr": 25544, "id": "iss", "kind": "station", "ja": "ISS（国際宇宙ステーション）", "label": "ISS"},
    {"catnr": 48274, "id": "css", "kind": "station", "ja": "天宮（中国の宇宙ステーション）", "label": "天宮"},
    {"catnr": 20580, "id": "hst", "kind": "telescope", "ja": "ハッブル宇宙望遠鏡", "label": "ハッブル"},
    {"catnr": 41836, "id": "himawari9", "kind": "weather", "ja": "ひまわり9号（気象衛星）", "label": "ひまわり"},
]
# 測位衛星はグループでまとめて1回。名前で選ぶ
GNSS_GROUP = "gnss"
GNSS_PICK = [("GPS ", "gps", "GPS（アメリカの測位衛星）"), ("GSAT", "galileo", "ガリレオ（ヨーロッパの測位衛星）"), ("QZS", "qzss", "みちびき（日本の測位衛星）")]

# 計算する時間の幅と間隔：低い衛星は細かく、高い衛星は粗く。みちびきは「8の字」が一周するよう24時間
SPAN = {
    "station": (-95 * 60, 8 * 3600, 30), "telescope": (-95 * 60, 8 * 3600, 30),
    "weather": (-3600, 9 * 3600, 600), "gps": (-3600, 9 * 3600, 300), "galileo": (-3600, 9 * 3600, 300),
    "qzss": (-3600, 24 * 3600, 300),
}


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get_tle(query):
    req = urllib.request.Request(f"{GP}?{query}&FORMAT=TLE", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        lines = [l.rstrip() for l in r.read().decode("ascii", "replace").splitlines() if l.strip()]
    out = []
    for i in range(len(lines) - 2):
        if lines[i + 1].startswith("1 ") and lines[i + 2].startswith("2 ") and not lines[i].startswith(("1 ", "2 ")):
            out.append((lines[i].strip(), lines[i + 1], lines[i + 2]))
    if not out and len(lines) >= 2 and lines[-2].startswith("1 "):
        out.append(("", lines[-2], lines[-1]))
    return out


def gmst(jd_ut1):
    t = (jd_ut1 - 2451545.0) / 36525.0
    g = 67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t ** 3
    return math.radians((g % 86400) / 240.0)


def track(l1, l2, now, kind):
    sat = Satrec.twoline2rv(l1, l2)
    b, a, step = SPAN[kind]
    t0 = now + dt.timedelta(seconds=b)
    n = int((a - b) / step) + 1
    pts = []
    for k in range(n):
        t = t0 + dt.timedelta(seconds=k * step)
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second)
        e, r, _ = sat.sgp4(jd, fr)
        if e != 0:
            return None, None, None                       # 計算が崩れた衛星は出さない（途中で抜けると補間が狂う）
        th = gmst(jd + fr)                                 # TEME → 地球に固定した座標（地軸まわりに回す）
        x = r[0] * math.cos(th) + r[1] * math.sin(th)
        y = -r[0] * math.sin(th) + r[1] * math.cos(th)
        z = r[2]
        rr = math.sqrt(x * x + y * y + z * z)
        pts.append([round(math.degrees(math.asin(z / rr)), 3), round(math.degrees(math.atan2(y, x)), 3), round(rr - R_EARTH, 1)])
    ep = dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc) + dt.timedelta(days=sat.jdsatepoch + sat.jdsatepochF - 2451545.0)
    return {"t0": int(t0.timestamp()), "step": step, "pts": pts}, ep, t0 + dt.timedelta(seconds=(n - 1) * step)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    sats, epochs, ends, missing = [], [], [], []

    def add(meta, name, l1, l2):
        tr, ep, end = track(l1, l2, now, meta["kind"])
        if not tr:
            missing.append(meta.get("ja") or name); return
        sats.append({**{k: meta[k] for k in ("id", "kind", "ja") if k in meta}, "name": name, "label": meta.get("label"), **tr})
        epochs.append(ep); ends.append(end)

    for s in SINGLE:
        try:
            got = get_tle(f"CATNR={s['catnr']}")
            if got:
                add(s, got[0][0] or s["ja"], got[0][1], got[0][2])
            else:
                missing.append(s["ja"])
        except Exception as e:
            note(f"{s['ja']} の軌道要素を取得できませんでした: {e}", "warning"); missing.append(s["ja"])
        time.sleep(2)                                      # 相手に優しく
    count = {}
    try:
        for name, l1, l2 in get_tle(f"GROUP={GNSS_GROUP}"):
            for pre, kind, ja in GNSS_PICK:
                if name.startswith(pre):
                    count[kind] = count.get(kind, 0) + 1
                    add({"id": f"{kind}-{l2[2:7].strip()}", "kind": kind, "ja": ja}, name, l1, l2)
                    break
    except Exception as e:
        note(f"測位衛星の軌道要素を取得できませんでした: {e}", "warning")
    if not sats:
        note("人工衛星：一つも計算できませんでした（今回は衛星なし）", "warning")
        return
    with open(os.path.join(args.latest, "sats.json"), "w", encoding="utf-8") as f:
        json.dump({"sats": sats}, f, ensure_ascii=False, separators=(",", ":"))
    manifest = json.load(open(mpath, encoding="utf-8"))
    manifest["layers"].pop("iss", None)                   # ISS は sats.json の一機になった
    manifest["layers"]["sats"] = {
        "type": "orbit", "file": "sats.json", "format": "tracks",
        "meta": {
            "title": "人工衛星（名前の知られたもの）", "kind": "計算（軌道要素から）",
            "model": "CelesTrak の軌道要素（TLE）から SGP4 で計算",
            "clock": "now", "computedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "tleEpochOldest": min(epochs).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "validTo": min(ends).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "credit": "CelesTrak（軌道要素）、計算：SGP4（sgp4 ライブラリ）",
            "caution": "衛星は地球儀の時計ではなく「いま」の位置で動いています。高さは縮めて描いています（どれが上を飛んでいるかの順番は本物のまま）",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    iss = next((s for s in sats if s["id"] == "iss"), None)
    note(f"人工衛星 付加: {len(sats)} 機（{', '.join(f'{k} {v}' for k, v in count.items())}／個別 {sum(1 for s in sats if s['kind'] in ('station', 'telescope', 'weather'))}）"
         f"{'／取れなかった: ' + '、'.join(missing) if missing else ''}"
         + (f"／ISS 高度 約{iss['pts'][190][2]:.0f} km" if iss else ""))


if __name__ == "__main__":
    main()

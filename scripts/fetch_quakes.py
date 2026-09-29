#!/usr/bin/env python3
"""
最近の地震（USGS 公式 GeoJSON Summary Feed）を、地球儀の「物の層（Feature）」の共通形式に直す Adapter。

  外（USGS Earthquake Hazards Program・米国政府の公開データ）→ この Adapter → quakes.json ＋ 目録の1項目

・過去7日分（M2.5 以上）がまとめて配られるので、時計（GFS の有効時刻）に合わせて後から選べる
・時計より後の地震は出さない（ブラウザ側で windowBefore：時計以前・24時間以内）
・マグニチュードは USGS の値。気象庁の発表とは求め方が違い、値が異なることがある。震度ではない
・警報・危険判定・予測はしない。並べるだけ

使い方: python scripts/fetch_quakes.py --latest _site/data/latest
"""
import argparse
import datetime as dt
import json
import os
import sys
import urllib.request

FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson"
UA = "globe-prototype/quakes (+https://github.com/makohey/earth; GitHub Actions; one request per run)"
WINDOW_MIN = 24 * 60


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        note("地球儀の最新データがないので、地震は付けません", "warning")
        return
    try:
        req = urllib.request.Request(FEED, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=60) as r:
            fc = json.load(r)
    except Exception as e:
        note(f"USGS の地震フィードを取得できませんでした: {e}", "warning")
        return
    rows = []
    for f in fc.get("features", []):
        p, g = f.get("properties", {}), f.get("geometry") or {}
        c = g.get("coordinates") or []
        if len(c) < 2 or p.get("time") is None or p.get("mag") is None:
            continue
        if p.get("type") not in (None, "earthquake"):
            continue                                        # 発破などは除く
        rows.append([
            f.get("id"), round(c[1], 3), round(c[0], 3),
            int(p["time"] // 60000),                        # 発生時刻（UNIX 分）
            round(float(p["mag"]), 1), p.get("magType"),
            round(float(c[2]), 1) if len(c) > 2 and c[2] is not None else None,
            p.get("place"), p.get("url"),
        ])
    manifest = json.load(open(mpath, encoding="utf-8"))
    with open(os.path.join(args.latest, "quakes.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": ["id", "lat", "lon", "tmin", "mag", "magType", "depth", "place", "url"], "rows": rows},
                  f, ensure_ascii=False, separators=(",", ":"))
    gen = fc.get("metadata", {}).get("generated")
    manifest["layers"]["quakes"] = {
        "type": "feature", "file": "quakes.json", "format": "rows",
        "meta": {
            "title": "最近の地震", "level": "震源", "kind": "観測（地震の解析）",
            "model": "USGS による震源とマグニチュード（M2.5 以上）",
            "selection": {"policy": "windowBefore", "windowMin": WINDOW_MIN},
            "feedGenerated": dt.datetime.fromtimestamp(gen / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if gen else None,
            "coverage": "全世界（M2.5 以上。地域によって検出できる大きさに差がある）",
            "credit": "USGS Earthquake Hazards Program（米国地質調査所）",
            "caution": "マグニチュードは USGS の値で、気象庁の発表と異なることがあります。震度ではありません。日本の地震は気象庁の情報を確認してください",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"地震 付加: {len(rows)} 件（過去7日・M2.5以上）")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
大きめの地震の「揺れが広がった範囲」（USGS ShakeMap の揺れの境目の線）を取り、地球儀の波紋に使う Adapter。

  外（USGS の地震ごとの詳細 → ShakeMap の境目の線 cont_mmi.json）→ この Adapter → shake.json ＋ 目録の1項目

・対象：時計の24時間前から時計まで（地震の層と同じ窓）、M5.0 以上で、ShakeMap がある地震
・取った地震の分は置き場（--cache）に残し、取り直さない。1回の更新で新しく取るのは最大12件、間を1秒あける
・地球儀では揺れの強さの数字は出さない（波紋の形だけ。マグニチュードで表記し、震度は専門の情報へ案内）

使い方: python scripts/fetch_shakemaps.py --latest _site/data/latest --cache shake_cache
"""
import argparse
import datetime as dt
import json
import os
import time
import urllib.request

DETAIL = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/detail/{id}.geojson"
UA = "globe-prototype/shakemap (+https://github.com/makohey/earth; GitHub Actions; new M5+ events only, cached)"
MIN_MAG, WINDOW_MIN, MAX_NEW = 5.0, 24 * 60, 12


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def simplify(coords, tol=0.03):
    out = []
    for lon, lat, *_ in coords:
        if out and abs(out[-2] - lon) < tol and abs(out[-1] - lat) < tol:
            continue
        out += [round(lon, 2), round(lat, 2)]
    return out


def fetch_event(eid):
    d = get_json(DETAIL.format(id=eid))
    sm = (d.get("properties", {}).get("products", {}) or {}).get("shakemap") or []
    if not sm:
        return None
    url = ((sm[0].get("contents") or {}).get("download/cont_mmi.json") or {}).get("url")
    if not url:
        return None
    time.sleep(1)
    c = get_json(url)
    lines = []
    for f in c.get("features", []):
        v = (f.get("properties") or {}).get("value")
        g = f.get("geometry") or {}
        parts = g.get("coordinates", []) if g.get("type") == "MultiLineString" else [g.get("coordinates", [])] if g.get("type") == "LineString" else []
        for p in parts:
            s = simplify(p)
            if v is not None and len(s) >= 4:
                lines.append({"v": float(v), "c": s})
    return lines


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    mpath, qpath = os.path.join(args.latest, "manifest.json"), os.path.join(args.latest, "quakes.json")
    if not (os.path.exists(mpath) and os.path.exists(qpath)):
        return
    os.makedirs(args.cache, exist_ok=True)
    manifest = json.load(open(mpath, encoding="utf-8"))
    clock = dt.datetime.fromisoformat(manifest["layers"]["wind-10m"]["meta"]["validTime"].replace("Z", "+00:00"))
    cmin = int(clock.timestamp() // 60)
    q = json.load(open(qpath, encoding="utf-8"))
    F = {n: i for i, n in enumerate(q["fields"])}
    cand = [r for r in q["rows"] if r[F["mag"]] is not None and r[F["mag"]] >= MIN_MAG and cmin - WINDOW_MIN <= r[F["tmin"]] <= cmin]
    events, new, none = [], 0, 0
    for r in sorted(cand, key=lambda r: -r[F["mag"]]):
        eid = r[F["id"]]
        path = os.path.join(args.cache, f"{eid}.json")
        rec = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else None
        age_h = (time.time() / 60 - r[F["tmin"]]) / 60
        if rec is None or (rec.get("none") and age_h < 12 and time.time() - rec.get("checkedAt", 0) > 5 * 3600):
            if new >= MAX_NEW:
                continue
            try:
                lines = fetch_event(eid)
            except Exception as e:
                note(f"ShakeMap 取得に失敗 {eid}: {e}", "warning")
                continue
            new += 1
            rec = {"none": True, "checkedAt": int(time.time())} if not lines else {"lines": lines}
            json.dump(rec, open(path, "w", encoding="utf-8"), separators=(",", ":"))
            time.sleep(1)                                   # 相手に優しく
        if rec.get("lines"):
            events.append({"id": eid, "lat": r[F["lat"]], "lon": r[F["lon"]], "tmin": r[F["tmin"]], "mag": r[F["mag"]], "lines": rec["lines"]})
        else:
            none += 1
    keep = {f"{r[F['id']]}.json" for r in q["rows"]}
    for name in os.listdir(args.cache):                     # 地震の一覧（過去7日）から外れた分は消す
        if name.endswith(".json") and name not in keep:
            os.remove(os.path.join(args.cache, name))
    with open(os.path.join(args.latest, "shake.json"), "w", encoding="utf-8") as f:
        json.dump({"events": events}, f, separators=(",", ":"))
    manifest["layers"]["quake-shake"] = {
        "type": "shake", "file": "shake.json", "format": "contours",
        "meta": {
            "title": "揺れが広がった範囲（波紋）", "kind": "観測と推定（地震計の記録から）",
            "model": "USGS ShakeMap の揺れの境目の線（M5.0 以上）",
            "credit": "USGS ShakeMap（米国地質調査所）",
            "caution": "波紋の形は揺れが届いた範囲の推定です。動きは見せ方の演出です。震度ではありません",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"揺れの波紋 付加: {len(events)} 件（候補 M{MIN_MAG}+ {len(cand)} 件／新しく取得 {new}／ShakeMap なし {none}）")


if __name__ == "__main__":
    main()

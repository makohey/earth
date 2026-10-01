#!/usr/bin/env python3
"""
世界の火山の一覧（NOAA NCEI Global Volcano Locations Database、CC0。元はスミソニアン GVP）を地球儀の「物の層」に直す Adapter。

・動かないデータなので月に1回だけ取り直す（置き場＝Actions のキャッシュ）。数ページに分けて、間を1秒あける
・スミソニアン GVP の配信（週報 CAP・WFS）は自動取得を断られた（2026-10-01、403／接続を切られる）ので取りに行かない。
  「いま活動中の火山」は地球儀では出さず、スミソニアンの週報へ案内する（交通整理）
・日本の火山の警戒レベルや噴火警報は出さない（気象庁の情報へ案内する）

使い方: python scripts/fetch_volcanoes.py --latest _site/data/latest --cache volc_cache
"""
import argparse
import datetime as dt
import glob
import html
import json
import os
import re
import time
import urllib.request

NCEI = "https://www.ngdc.noaa.gov/hazel/hazard-service/api/v1/volcanolocs?page={page}"
UA = "globe-prototype/volcanoes (+https://github.com/makohey/earth; GitHub Actions; full list once a month)"


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def fetch_ncei():
    items, page, pages = [], 1, 1
    while page <= pages and page <= 30:
        d = json.loads(get(NCEI.format(page=page)))
        if page == 1:
            pages = int(d.get("totalPages") or 1)
            if d.get("items"):
                note("火山の一覧（NCEI）の項目名: " + ", ".join(list(d["items"][0].keys())[:25]))
        items += d.get("items", [])
        page += 1
        time.sleep(1)                                       # 相手に優しく
    return json.dumps({"items": items}).encode()


def parse_ncei(body):
    rows = []
    for it in json.loads(body).get("items", []):
        lat, lon = it.get("latitude"), it.get("longitude")
        if lat is None or lon is None:
            continue
        rows.append([it.get("name"), round(float(lat), 3), round(float(lon), 3), it.get("morphology"), it.get("elevation"),
                     it.get("country"), it.get("id"), it.get("timeErupt") or it.get("status")])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--cache", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        return
    os.makedirs(args.cache, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    path = os.path.join(args.cache, f"ncei_{now:%Y%m}.json")
    if os.path.exists(path):
        body, src = open(path, "rb").read(), "キャッシュ"
    else:
        try:
            body, src = fetch_ncei(), "取得"
            for old in glob.glob(os.path.join(args.cache, "ncei_*.json")):
                os.remove(old)
            open(path, "wb").write(body)
        except Exception as e:
            note(f"火山の一覧（NCEI）を取得できませんでした: {e}", "warning")
            old = sorted(glob.glob(os.path.join(args.cache, "ncei_*.json")))
            body, src = (open(old[-1], "rb").read(), "古いキャッシュ") if old else (None, None)
    rows = parse_ncei(body) if body else []
    active = []
    if not rows:
        note("火山：一覧が使えませんでした（今回は火山なし）", "warning")
        return
    with open(os.path.join(args.latest, "volcanoes.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": ["name", "lat", "lon", "type", "elev", "country", "num", "lastEruption"], "rows": rows, "active": active},
                  f, ensure_ascii=False, separators=(",", ":"))
    manifest = json.load(open(mpath, encoding="utf-8"))
    manifest["layers"]["volcanoes"] = {
        "type": "volcano", "file": "volcanoes.json", "format": "rows",
        "meta": {
            "title": "火山", "kind": "観測の記録（一覧）",
            "model": "NOAA NCEI 世界の火山の位置（元はスミソニアン GVP）",
            "fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "credit": "NOAA NCEI Global Volcano Locations Database（CC0）。元データ：Global Volcanism Program, Smithsonian Institution",
            "caution": "火山の場所の一覧です。いま噴火しているかどうかは表していません。噴火警報・警戒レベルではありません。日本の火山は気象庁の情報を確認してください",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"火山 付加: 一覧 {len(rows)} か所（{src}）")


if __name__ == "__main__":
    main()

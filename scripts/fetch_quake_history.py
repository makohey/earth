#!/usr/bin/env python3
"""
地球の中（断面）用：過去の大きめの地震（M5.0 以上、1990年〜2025年）の場所と深さを、USGS の地震カタログから取る Adapter。

  外（USGS FDSN Event Web Service・米国政府の公開データ）→ この Adapter → quakehist.bin ＋ 目録の1項目

・深さで並べると、沈み込んだ海のプレート（スラブ）の形が浮かび上がる（和達－ベニオフ帯）
・過去の記録なので一度取れば変わらない。5年ずつ8回に分けて、間を3秒あけて取り、置き場（Actions のキャッシュ）に残す。
  置き場にあれば二度と取りに行かない
・断られたら（403／429／503）その回は取りに行かない

使い方: python scripts/fetch_quake_history.py --latest _site/data/latest --cache qhist_cache
"""
import argparse
import csv
import io
import json
import os
import time
import urllib.error
import urllib.request

import numpy as np

API = "https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&minmagnitude=5&orderby=time-asc&starttime={a}&endtime={b}"
UA = "globe-prototype/quake-history (+https://github.com/makohey/earth; GitHub Actions; one-time M5+ catalog 1990-2025, cached)"
SPANS = [(f"{y}-01-01", f"{min(y + 5, 2026)}-01-01") for y in range(1990, 2026, 5)]


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=180) as r:
        return r.read().decode("utf-8", "replace")


def parse(text):
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        try:
            if r.get("type", "earthquake") != "earthquake":
                continue
            rows.append((float(r["latitude"]), float(r["longitude"]), float(r["depth"] or 0), float(r["mag"])))
        except (KeyError, ValueError):
            continue
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
    got, new = 0, 0
    refused = os.path.exists(os.path.join(args.cache, "REFUSED"))   # 一度断られたら、人が見直すまで取りに行かない
    for a, b in SPANS:
        path = os.path.join(args.cache, f"m5_{a[:4]}.csv")
        if os.path.exists(path):
            got += 1
            continue
        if refused:
            break
        try:
            text = get(API.format(a=a, b=b))
            open(path, "w", encoding="utf-8").write(text)
            got += 1; new += 1
            time.sleep(3)                                  # 相手に優しく
        except urllib.error.HTTPError as e:
            note(f"過去の地震（USGS）{a[:4]}〜: {e.code}。今回はここで止めます", "warning")
            if e.code in (403, 429):
                open(os.path.join(args.cache, "REFUSED"), "w").write(f"{e.code}\n")
            break                                          # 断られたら続けない
        except Exception as e:
            note(f"過去の地震（USGS）{a[:4]}〜: {e}", "warning")
            break
    rows = []
    for a, _ in SPANS:
        path = os.path.join(args.cache, f"m5_{a[:4]}.csv")
        if os.path.exists(path):
            rows += parse(open(path, encoding="utf-8").read())
    if not rows:
        note("過去の地震：使える記録がありません（今回は断面の地震なし）", "warning")
        return
    a = np.array(rows, dtype="float64")
    q = np.stack([np.round(a[:, 0] * 100), np.round(a[:, 1] * 100), np.clip(np.round(a[:, 2]), 0, 800), np.round(a[:, 3] * 10)], axis=1).astype("<i2")
    q = q[np.argsort(a[:, 2])]                              # 浅い順（深い地震を後に描いて見えやすく）
    with open(os.path.join(args.latest, "quakehist.bin"), "wb") as f:
        f.write(q.tobytes())
    manifest = json.load(open(mpath, encoding="utf-8"))
    manifest["layers"]["quake-history"] = {
        "type": "points", "file": "quakehist.bin", "format": "int16-lat100-lon100-depthkm-mag10", "lazy": True,
        "meta": {
            "title": "過去の地震の深さ（M5.0 以上）", "kind": "観測の記録",
            "model": f"USGS の地震カタログ（{SPANS[0][0][:4]}〜{int(SPANS[-1][1][:4]) - 1}年、M5.0 以上）",
            "count": int(len(q)), "complete": got == len(SPANS),
            "credit": "USGS Earthquake Hazards Program（米国地質調査所）の地震カタログ",
            "caution": "過去の地震の記録です。いまの地震ではありません。これから起きる場所を示すものでもありません",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    deep = int((a[:, 2] >= 300).sum())
    note(f"過去の地震（深さ）付加: {len(q)} 件（300km より深い {deep} 件）・{got}/{len(SPANS)} 期間・新しく取得 {new}")


if __name__ == "__main__":
    main()

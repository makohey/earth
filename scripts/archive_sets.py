#!/usr/bin/env python3
"""
ためて再生（もらった水の記録庫）：一度もらった GFS の「風・雨・気圧」を捨てずに、直近の分だけ取っておく。

  今回の一式（data/latest） → この仕組み → 記録庫（Actions の置き場）＋ 公開ページの data/archive/

・水源（NOAA）へは一度も取りに行かない。今もらった分を捨てないだけ
・回（初期時刻）ごとに1つのフォルダ。同じ回は二度入れない
・KEEP_DAYS 日より古い回は消す（置き場と公開ページが太りすぎないように）
・置き場（キャッシュ）が消えていたら、自分の公開ページ（makohey.github.io）から取り戻す。
  水源ではなく自分のページなので、取り戻しは許される。取り戻せなければ、今回の分から ため直す

使い方: python scripts/archive_sets.py --latest _site/data/latest --store archive_store --out _site/data/archive
"""
import argparse
import datetime as dt
import json
import os
import shutil
import urllib.request

KEEP_DAYS = 31
LAYERS = ["wind-10m", "rain", "pressure"]          # ためるもの：流れが見えるもの（1回 約0.8MB）
OWN = "https://makohey.github.io/earth/data/archive/"
UA = "globe-prototype/archive (+https://github.com/makohey/earth; restoring its own archive)"


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def load_index(store):
    p = os.path.join(store, "index.json")
    if os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return {"keepDays": KEEP_DAYS, "sets": []}


def restore_from_own_page(store):
    """置き場が空のとき、自分の公開ページに残っている記録庫を取り戻す（なければ何もしない）"""
    try:
        idx = json.loads(get(OWN + "index.json"))
    except Exception as e:
        note(f"記録庫：自分のページからの取り戻しなし（{e}）")
        return 0
    got = 0
    for s in idx.get("sets", []):
        d = os.path.join(store, s["id"])
        try:
            os.makedirs(d, exist_ok=True)
            for f in s["files"] + ["meta.json"]:
                open(os.path.join(d, f), "wb").write(get(f"{OWN}{s['id']}/{f}"))
            got += 1
        except Exception as e:
            shutil.rmtree(d, ignore_errors=True)
            note(f"記録庫：{s['id']} を取り戻せず（{e}）", "warning")
    return got


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    ap.add_argument("--store", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    os.makedirs(args.store, exist_ok=True)

    restored = 0
    if not os.path.exists(os.path.join(args.store, "index.json")):
        restored = restore_from_own_page(args.store)

    # 今の一式を記録庫に入れる（同じ回はもう入っていれば入れない）
    added = None
    mpath = os.path.join(args.latest, "manifest.json")
    if os.path.exists(mpath):
        man = json.load(open(mpath, encoding="utf-8"))
        w = man["layers"].get("wind-10m", {}).get("meta", {})
        issued = w.get("issuedTime")
        if man.get("mode") == "live" and issued:
            sid = dt.datetime.fromisoformat(issued.replace("Z", "+00:00")).strftime("%Y%m%d%H")
            d = os.path.join(args.store, sid)
            if not os.path.exists(os.path.join(d, "meta.json")):
                os.makedirs(d, exist_ok=True)
                layers = {}
                for k in LAYERS:
                    L = man["layers"].get(k)
                    if L and os.path.exists(os.path.join(args.latest, L["file"])):
                        shutil.copy2(os.path.join(args.latest, L["file"]), os.path.join(d, L["file"]))
                        layers[k] = L
                json.dump({"id": sid, "issuedTime": issued, "validTime": w.get("validTime"), "layers": layers},
                          open(os.path.join(d, "meta.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
                added = sid

    # 一覧を作り直す（フォルダが正）。古い回は消す
    cut = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=KEEP_DAYS)
    sets, removed = [], 0
    for sid in sorted(os.listdir(args.store)):
        d = os.path.join(args.store, sid)
        if not os.path.isdir(d):
            continue
        mp = os.path.join(d, "meta.json")
        if not os.path.exists(mp):
            shutil.rmtree(d, ignore_errors=True)
            continue
        m = json.load(open(mp, encoding="utf-8"))
        t = dt.datetime.fromisoformat(m["issuedTime"].replace("Z", "+00:00"))
        if t < cut:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
            continue
        files = [L["file"] for L in m["layers"].values()]
        size = sum(os.path.getsize(os.path.join(d, f)) for f in files)
        sets.append({"id": sid, "issuedTime": m["issuedTime"], "validTime": m["validTime"],
                     "layers": sorted(m["layers"]), "files": files, "bytes": size})
    index = {"keepDays": KEEP_DAYS, "updatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
             "note": "地球儀がもらった GFS の風・雨・気圧を捨てずに取っておいたもの（モデル計算・過去の記録）",
             "sets": sets}
    json.dump(index, open(os.path.join(args.store, "index.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    # 公開ページへ写す
    shutil.rmtree(args.out, ignore_errors=True)
    shutil.copytree(args.store, args.out)
    total = sum(s["bytes"] for s in sets)
    note(f"記録庫: {len(sets)} 回分・{total / 1e6:.1f} MB（今回足した回 {added or 'なし'}・消した古い回 {removed}・取り戻し {restored}）")


if __name__ == "__main__":
    main()

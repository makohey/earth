#!/usr/bin/env python3
"""
日本の地震の記録庫：気象庁の地震情報の一覧を、更新の回ごとに1回だけもらい、捨てずにためる。

  気象庁（bosai の地震情報の一覧）→ この仕組み → 記録庫（Actions の置き場）＋ 公開ページの data/quakejp/quakes.json

・取りに行くのは新しい GFS の回のときだけ（1日4回まで）。断られたら（403/429）その回はあきらめ、取りに行き直さない
・同じ地震（eid）は1件にまとめる。後から出た情報（震源・マグニチュードの更新、最大震度）で上書きする
・日本の地図に入る範囲（北緯20〜50°・東経120〜155°）だけ残す。遠い国の地震は入れない
・ためた記録は消さない（文字だけなので1年で約1MB）。置き場が消えていたら、自分の公開ページから取り戻す
・過去の記録だけを扱う。地震の予知・予報ではない
・出典：気象庁ホームページ（政府標準利用規約 第2.0版に準拠・CC BY 4.0 互換。数値データは著作物ではない）

使い方: python scripts/quake_jp.py --store quakejp_store --out _site/data/quakejp --fetch true
"""
import argparse
import datetime as dt
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request

SRC = "https://www.jma.go.jp/bosai/quake/data/list.json"
OWN = "https://makohey.github.io/earth/data/quakejp/quakes.json"
UA = "globe-prototype/quake-jp (+https://github.com/makohey/earth; GitHub Actions; one request per GFS cycle)"
BOX = (20.0, 50.0, 120.0, 155.0)   # 南・北・西・東
MAX_ROWS = 60000
SHINDO_RANK = {"1": 1, "2": 2, "3": 3, "4": 4, "5-": 5, "5+": 6, "6-": 7, "6+": 8, "7": 9}


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get(url, timeout=40):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def parse_cod(cod):
    """ISO 6709 の形（例 +35.0+135.7-10000/）→ 緯度・経度・深さ(km)。深さはメートルの負の数で書かれている"""
    if not cod:
        return None
    m = re.match(r"^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/?", cod.strip())
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    dep = round(-float(m.group(3)) / 1000) if m.group(3) else None
    return lat, lon, dep


def num(v):
    try:
        x = float(str(v).replace("Ｍ", "").strip())
        return x if x == x else None   # NaN は無し扱い
    except Exception:
        return None


def from_list(items):
    """一覧の各報（同じ地震に何報も出る）を、地震ごと（eid）に1件へまとめる"""
    by = {}
    for e in items if isinstance(items, list) else []:
        eid = str(e.get("eid") or "").strip()
        if not eid:
            continue
        r = by.setdefault(eid, {"eid": eid})
        ctt = str(e.get("ctt") or "")
        c = parse_cod(e.get("cod"))
        newer = ctt >= r.get("_ctt", "")
        if c and (newer or "lat" not in r):
            r["lat"], r["lon"], r["dep"] = c
            if e.get("at"):
                r["t"] = e["at"]
            if e.get("anm"):
                r["area"] = e["anm"]
            if e.get("en_anm"):
                r["area_en"] = e["en_anm"]
            m = num(e.get("mag"))
            if m is not None:
                r["mag"] = m
            r["_ctt"] = max(ctt, r.get("_ctt", ""))
        elif "t" not in r and e.get("at"):
            r["t"] = e["at"]
        mi = str(e.get("maxi") or "").strip()
        if mi in SHINDO_RANK and SHINDO_RANK[mi] > SHINDO_RANK.get(r.get("maxi"), 0):
            r["maxi"] = mi
    out = []
    for r in by.values():
        r.pop("_ctt", None)
        if "lat" not in r or "t" not in r:
            continue   # 震源がまだ出ていない報だけのもの（震度速報だけ）は、次の回に震源が出てから入れる
        s, n, w, e = BOX
        if not (s <= r["lat"] <= n and w <= r["lon"] <= e):
            continue
        out.append(r)
    return out


def load(store):
    p = os.path.join(store, "quakes.json")
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding="utf-8")).get("rows", [])
        except Exception:
            pass
    try:   # 置き場が消えていたら、自分の公開ページから取り戻す（水源ではない）
        rows = json.loads(get(OWN)).get("rows", [])
        note(f"日本の地震：自分のページから {len(rows)} 件を取り戻しました")
        return rows
    except Exception as e:
        note(f"日本の地震：取り戻すものはありません（{e}）")
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--store", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--fetch", default="true")
    args = ap.parse_args()
    os.makedirs(args.store, exist_ok=True)
    rows = load(args.store)
    have = {r["eid"]: r for r in rows}
    added = updated = 0
    if args.fetch == "true":
        body = None
        for k in range(2):
            try:
                body = get(SRC)
                break
            except urllib.error.HTTPError as e:
                if e.code in (403, 429):
                    note(f"日本の地震：断られました（{e.code}）。この回はあきらめます", "warning")
                    break
                note(f"日本の地震：HTTP {e.code}", "warning")
            except Exception as e:
                note(f"日本の地震：取れませんでした（{e}）", "warning")
            time.sleep(10 * (k + 1))
        if body:
            try:
                fresh = from_list(json.loads(body))
            except Exception as e:
                fresh = []
                note(f"日本の地震：一覧を読めませんでした（{e}）", "warning")
            for r in fresh:
                old = have.get(r["eid"])
                if not old:
                    have[r["eid"]] = r
                    added += 1
                elif any(old.get(k) != r.get(k) for k in ("t", "lat", "lon", "dep", "mag", "maxi", "area")):
                    keep_maxi = old.get("maxi") if SHINDO_RANK.get(old.get("maxi"), 0) > SHINDO_RANK.get(r.get("maxi"), 0) else r.get("maxi")
                    old.update(r)
                    if keep_maxi:
                        old["maxi"] = keep_maxi
                    updated += 1
    rows = sorted(have.values(), key=lambda r: r["t"], reverse=True)[:MAX_ROWS]
    doc = {
        "title": "日本の地震（気象庁の地震情報をためた記録）",
        "credit": "出典：気象庁ホームページ（地震情報）を加工して作成",
        "caution": "過去の記録です。地震の予知や予報ではありません。震度1以上を観測した地震などの、気象庁が発表した情報だけが入ります。くわしくは気象庁へ。",
        "updatedAt": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "since": rows[-1]["t"] if rows else None,
        "rows": rows,
    }
    json.dump(doc, open(os.path.join(args.store, "quakes.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    shutil.rmtree(args.out, ignore_errors=True)
    os.makedirs(args.out, exist_ok=True)
    shutil.copy2(os.path.join(args.store, "quakes.json"), os.path.join(args.out, "quakes.json"))
    note(f"日本の地震: {len(rows)} 件（今回足した {added}・更新 {updated}・{os.path.getsize(os.path.join(args.out, 'quakes.json')) / 1e3:.0f} KB）")


if __name__ == "__main__":
    main()

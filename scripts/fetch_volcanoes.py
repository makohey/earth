#!/usr/bin/env python3
"""
世界の火山（スミソニアン Global Volcanism Program）を地球儀の「物の層」に直す Adapter。

  ① 完新世（約1万2千年前から）に活動した火山の一覧（約1,300）… 動かないデータ。月に1回だけ取り直す
  ② 週ごとの火山活動報告（Weekly Volcanic Activity Report、CAP 形式）… 1日1回まで

・取った物は置き場（--cache、Actions のキャッシュ）に残し、同じ月・同じ日の分は取り直さない
・利用条件：非商用、出典「Global Volcanism Program, Smithsonian Institution」とリンクを表示
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
import urllib.request

WFS = ("https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=1.0.0&request=GetFeature"
       "&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes&outputFormat=application%2Fjson")
CAP = "https://volcano.si.edu/news/WeeklyVolcanoCAP.xml"
UA = "globe-prototype/volcanoes (+https://github.com/makohey/earth; GitHub Actions; list monthly, weekly report daily)"


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def get(url, timeout=90):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cached(cache, name, url, keep_glob):
    """置き場にあればそれを使う。なければ1回だけ取る。古い同種のファイルは消す"""
    path = os.path.join(cache, name)
    if os.path.exists(path):
        return open(path, "rb").read(), "キャッシュ"
    try:
        body = get(url)
    except Exception as e:
        note(f"火山：取得に失敗 {url.split('?')[0]}: {e}", "warning")
        old = sorted(glob.glob(os.path.join(cache, keep_glob)))
        return (open(old[-1], "rb").read(), "古いキャッシュ") if old else (None, None)
    for old in glob.glob(os.path.join(cache, keep_glob)):
        os.remove(old)
    with open(path, "wb") as f:
        f.write(body)
    return body, "取得"


def pick(props, *names):
    low = {k.lower(): v for k, v in props.items()}
    for n in names:
        if n.lower() in low and low[n.lower()] not in (None, ""):
            return low[n.lower()]
    return None


def parse_list(body):
    d = json.loads(body)
    rows = []
    for f in d.get("features", []):
        p = f.get("properties", {})
        g = f.get("geometry") or {}
        lat, lon = pick(p, "Latitude"), pick(p, "Longitude")
        if (lat is None or lon is None) and g.get("type") == "Point":
            lon, lat = g["coordinates"][:2]
        if lat is None or lon is None:
            continue
        rows.append([pick(p, "Volcano_Name", "VolcanoName", "Name"), round(float(lat), 3), round(float(lon), 3),
                     pick(p, "Primary_Volcano_Type", "PrimaryVolcanoType"), pick(p, "Elevation", "Elev"),
                     pick(p, "Country"), pick(p, "Volcano_Number", "VolcanoNumber"), pick(p, "Last_Eruption_Year", "LastEruptionYear")])
    if d.get("features"):
        note("火山の一覧の項目名: " + ", ".join(list(d["features"][0].get("properties", {}).keys())[:20]))
    return rows


def tag(block, name):
    m = re.search(rf"<(?:\w+:)?{name}\b[^>]*>(.*?)</(?:\w+:)?{name}>", block, re.S)
    return html.unescape(re.sub(r"<!\[CDATA\[|\]\]>", "", m.group(1))).strip() if m else None


def parse_cap(body, by_name):
    text = body.decode("utf-8", "replace")
    blocks = re.findall(r"<(?:\w+:)?info\b.*?</(?:\w+:)?info>", text, re.S) or re.findall(r"<(?:\w+:)?alert\b.*?</(?:\w+:)?alert>", text, re.S)
    if blocks:
        note("火山の週報の形（最初の1件）: " + re.sub(r"\s+", " ", blocks[0])[:700].replace("::", ":"))
    else:
        note("火山の週報の形が読めません。先頭: " + re.sub(r"\s+", " ", text)[:500].replace("::", ":"), "warning")
    out = []
    for b in blocks:
        name = tag(b, "areaDesc") or tag(b, "headline") or tag(b, "event")
        head = " ".join(filter(None, [tag(b, "headline"), tag(b, "event"), tag(b, "description")]))[:4000]
        lat = lon = None
        c = tag(b, "circle")
        if c:
            m = re.match(r"\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)", c)
            if m:
                lat, lon = float(m.group(1)), float(m.group(2))
        if lat is None:
            pg = tag(b, "polygon")
            if pg:
                pts = [tuple(map(float, q.split(","))) for q in pg.split() if "," in q]
                if pts:
                    lat, lon = sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)
        key = (name or "").split("(")[0].split(",")[0].strip().lower()
        if lat is None and key in by_name:
            lat, lon = by_name[key][1], by_name[key][2]
        if lat is None or not name:
            continue
        status = "new" if re.search(r"\bnew\b", head, re.I) and not re.search(r"\bcontinuing\b", head[:200], re.I) else "continuing"
        out.append({"name": name.split("|")[0].strip(), "lat": round(lat, 3), "lon": round(lon, 3), "status": status,
                    "summary": re.sub(r"\s+", " ", tag(b, "description") or "")[:600]})
    return out


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
    lst, src1 = cached(args.cache, f"holocene_{now:%Y%m}.json", WFS, "holocene_*.json")
    rows = []
    if lst:
        try:
            rows = parse_list(lst)
        except Exception as e:
            note(f"火山の一覧が読めません: {e}／先頭 {lst[:200]!r}", "warning")
    by_name = {(r[0] or "").lower(): r for r in rows}
    cap, src2 = cached(args.cache, f"weekly_{now:%Y%m%d}.xml", CAP, "weekly_*.xml")
    active = []
    if cap:
        try:
            active = parse_cap(cap, by_name)
        except Exception as e:
            note(f"火山の週報が読めません: {e}", "warning")
    if not rows and not active:
        note("火山：一覧も週報も使えませんでした（今回は火山なし）", "warning")
        return
    with open(os.path.join(args.latest, "volcanoes.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": ["name", "lat", "lon", "type", "elev", "country", "num", "lastEruption"], "rows": rows, "active": active},
                  f, ensure_ascii=False, separators=(",", ":"))
    manifest = json.load(open(mpath, encoding="utf-8"))
    manifest["layers"]["volcanoes"] = {
        "type": "volcano", "file": "volcanoes.json", "format": "rows",
        "meta": {
            "title": "火山", "kind": "観測の記録（一覧と週ごとの報告）",
            "model": "完新世（約1万2千年前から）に活動した火山の一覧、週ごとの火山活動報告",
            "fetchedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "credit": "Global Volcanism Program, Smithsonian Institution（https://volcano.si.edu/）。週報は Smithsonian / USGS Weekly Volcanic Activity Report",
            "caution": "活動中の印は週ごとの報告に載った火山です（数日の遅れがあります）。噴火警報・警戒レベルではありません。日本の火山は気象庁の情報を確認してください",
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"火山 付加: 一覧 {len(rows)} か所（{src1}）／週報の活動中 {len(active)} か所（{src2}、新しい活動 {sum(1 for a in active if a['status'] == 'new')}）")


if __name__ == "__main__":
    main()

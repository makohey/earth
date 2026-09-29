#!/usr/bin/env python3
"""
世界の空港の定時観測（METAR）を、地球儀の「物の層（Feature）」の共通形式に直す Adapter。

  外（aviationweather.gov のキャッシュファイル）→ この Adapter → 軽い JSON

二つの使い方:
  snapshot : いま取れる観測を保存する（1時間ごとに別のワークフローが実行し、Actions のキャッシュに置く）
  attach   : 地球儀の時計の時刻に合う保存分を、公開データ（data/latest）に加える

観測の因果を守るため、時計より後の観測は attach の時点で落とす（ブラウザ側でも同じ規則で選ぶ）。
出典：NOAA / NWS Aviation Weather Center（米国政府の公開データ）。電文そのもの（raw）は加工せず添える。
"""
import argparse
import csv
import datetime as dt
import gzip
import io
import json
import os
import sys
import time
import urllib.request

CACHE_URL = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
UA = "globe-prototype/A0 (GitHub Actions; hourly cache-file fetch for a static globe page)"
KT = 0.514444  # ノット → m/s
MAX_AGE_MIN = 90


def log(*a):
    print("[fetch_metar]", *a, file=sys.stderr, flush=True)


def note(msg, level="notice"):
    # Actions の画面（注釈）に出す。ログを開けない環境からも結果が読める
    print(f"::{level}::{msg}", flush=True)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def download():
    for k in range(3):
        try:
            req = urllib.request.Request(CACHE_URL, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return gzip.decompress(r.read()).decode("utf-8", "replace")
        except Exception as e:
            log("失敗:", e)
            time.sleep(10 * (k + 1))
    raise SystemExit("METAR のキャッシュファイルを取得できませんでした")


def parse(text):
    """キャッシュの CSV は、先頭に数行の説明があり、その後に見出し行（raw_text で始まる）が来る"""
    lines = text.splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith("raw_text")), None)
    if start is None:
        note("METAR の CSV に見出し行が見つかりません。先頭: " + " | ".join(lines[:6])[:400], "error")
        raise SystemExit(1)
    rows = list(csv.reader(io.StringIO("\n".join(lines[start:]))))
    head = rows[0]
    ix = {}
    for i, h in enumerate(head):
        ix.setdefault(h, i)  # 同名の列（sky_cover など）は最初のものを使う
    need = ["raw_text", "station_id", "observation_time", "latitude", "longitude"]
    miss = [n for n in need if n not in ix]
    if miss:
        note(f"METAR の CSV に必要な列がありません: {miss}／見出し: {head[:12]}", "error")
        raise SystemExit(1)

    def g(r, name):
        i = ix.get(name)
        return r[i] if i is not None and i < len(r) and r[i] != "" else None

    out = []
    for r in rows[1:]:
        if len(r) < len(need):
            continue
        lat, lon, t = num(g(r, "latitude")), num(g(r, "longitude")), g(r, "observation_time")
        if lat is None or lon is None or not t:
            continue
        try:
            obs = dt.datetime.strptime(t, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
        except ValueError:
            try:
                obs = dt.datetime.fromisoformat(t.replace("Z", "+00:00"))
            except ValueError:
                continue
        wdir = g(r, "wind_dir_degrees")
        wspd, wgst = num(g(r, "wind_speed_kt")), num(g(r, "wind_gust_kt"))
        out.append([
            g(r, "station_id"),
            round(lat, 3), round(lon, 3),
            int(obs.timestamp() // 60),                      # 観測時刻（UNIX 分）
            num(g(r, "temp_c")),
            num(g(r, "dewpoint_c")),
            "VRB" if wdir == "VRB" else (int(float(wdir)) if num(wdir) is not None else None),
            round(wspd * KT, 1) if wspd is not None else None,
            round(wgst * KT, 1) if wgst is not None else None,
            g(r, "visibility_statute_mi"),
            g(r, "wx_string"),
            g(r, "sky_cover"),
            num(g(r, "sea_level_pressure_mb")),
            g(r, "raw_text"),
        ])
    return out


FIELDS = ["id", "lat", "lon", "tmin", "temp", "dew", "wdir", "wspd", "wgst", "vis_mi", "wx", "sky", "slp", "raw"]


def cmd_snapshot(args):
    now = dt.datetime.now(dt.timezone.utc)
    rows = parse(download())
    rows = [r for r in rows if r[3] * 60 <= now.timestamp() + 60]
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump({"snapshotAt": iso(now), "fields": FIELDS, "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
    ts = sorted(r[3] for r in rows)
    span = f"{iso(dt.datetime.fromtimestamp(ts[0]*60, dt.timezone.utc))}〜{iso(dt.datetime.fromtimestamp(ts[-1]*60, dt.timezone.utc))}" if ts else "なし"
    note(f"METAR 保存: {len(rows)} 件／観測点 {len({r[0] for r in rows})}／観測時刻 {span}／{os.path.getsize(args.out)//1024} KB")


def cmd_attach(args):
    mpath = os.path.join(args.latest, "manifest.json")
    if not os.path.exists(mpath):
        note("地球儀の最新データがないので、METAR は付けません", "warning")
        return
    if not os.path.exists(args.snapshot):
        note("時計の時刻に合う METAR の保存分がありません（最初の数時間は正常）", "warning")
        return
    manifest = json.load(open(mpath, encoding="utf-8"))
    clock = dt.datetime.fromisoformat(manifest["layers"]["wind-10m"]["meta"]["validTime"].replace("Z", "+00:00"))
    snap = json.load(open(args.snapshot, encoding="utf-8"))
    cmin = int(clock.timestamp() // 60)
    rows = [r for r in snap["rows"] if cmin - MAX_AGE_MIN <= r[3] <= cmin]  # 未来側は拾わない
    with open(os.path.join(args.latest, "metar.json"), "w", encoding="utf-8") as f:
        json.dump({"fields": snap["fields"], "rows": rows}, f, ensure_ascii=False, separators=(",", ":"))
    manifest["layers"]["metar"] = {
        "type": "feature", "file": "metar.json", "format": "rows",
        "meta": {
            "title": "空港の観測", "level": "地上", "kind": "観測",
            "model": "METAR（空港の定時・特別観測の電文）",
            "selection": {"policy": "latestBefore", "maxAgeMin": MAX_AGE_MIN},
            "snapshotAt": snap["snapshotAt"],
            "usualIntervalH": 1, "delivery": "自動取得（1時間ごとに保存、時計に合う分を使用）",
            "coverage": "世界の空港（観測点のある場所だけ。海の上などは空白）",
            "credit": "NOAA / NWS Aviation Weather Center（aviationweather.gov）",
            "stations": len({r[0] for r in rows}),
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"METAR 付加: 時計 {iso(clock)}／{len(rows)} 件（観測点 {manifest['layers']['metar']['meta']['stations']}）／保存時刻 {snap['snapshotAt']}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("snapshot"); s.add_argument("--out", required=True)
    a = sub.add_parser("attach"); a.add_argument("--snapshot", required=True); a.add_argument("--latest", required=True)
    args = ap.parse_args()
    {"snapshot": cmd_snapshot, "attach": cmd_attach}[args.cmd](args)


if __name__ == "__main__":
    main()

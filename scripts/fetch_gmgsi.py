#!/usr/bin/env python3
"""
全球の衛星赤外画像（NOAA/NESDIS GMGSI：GOES・Himawari・Meteosat などの静止気象衛星を合成したモザイク）を、
地球儀の「値の場（Scalar）」の共通形式に直す Adapter。

  外（NOAA Open Data on AWS の公開保管庫・アカウント不要）→ この Adapter → cloud.bin ＋ 目録の1項目

・時計（GFS の有効時刻）より前で一番新しい画像を選ぶ（latestBefore）。観測の因果を守る
・過去の画像も保管庫に残るので、時計に合わせて後から取りに行ける（空港の観測で当たった壁がない）
・値は「赤外の明るさ温度（K）」。雲量や雨ではない。低い雲・霧は地表と温度が近く見えにくい
・利用条件：出典表示、NOAA/JMA などとの提携・推奨を匂わせない、加工品を元データと誤認させない

使い方: python scripts/fetch_gmgsi.py --latest _site/data/latest   （manifest.json の時計を読む）
"""
import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np

BUCKET = "https://noaa-gmgsi-pds.s3.amazonaws.com"
PRODUCT = "GMGSI_LW"
MAX_AGE_H = 4
STEP = 0.25                       # 配る格子（度）
TMIN, TMAX = 180.0, 320.0          # 保存する温度の幅（K）
UA = "globe-prototype/A1a (GitHub Actions; a few requests per run)"


def note(msg, level="notice"):
    print(f"::{level}::{msg}", flush=True)


def iso(t):
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def list_keys(prefix):
    body = get(f"{BUCKET}/?list-type=2&prefix={prefix}&max-keys=200")
    root = ET.fromstring(body)
    ns = {"s": root.tag.split("}")[0].strip("{")} if root.tag.startswith("{") else {}
    q = ".//s:Contents" if ns else ".//Contents"
    out = []
    for c in root.findall(q, ns):
        k = c.find("s:Key" if ns else "Key", ns).text
        size = int(c.find("s:Size" if ns else "Size", ns).text)
        out.append((k, size))
    return out


def pick(clock):
    """時計より前で一番新しい画像（毎時）。見つからなければ1時間ずつさかのぼる"""
    for h in range(0, MAX_AGE_H + 1):
        t = (clock - dt.timedelta(hours=h)).replace(minute=0, second=0, microsecond=0)
        prefix = f"{PRODUCT}/{t:%Y/%m/%d/%H}/"
        try:
            keys = list_keys(prefix)
        except Exception as e:
            note(f"GMGSI 一覧の取得に失敗: {prefix} {e}", "warning")
            continue
        if keys:
            note(f"GMGSI 候補 {prefix}: " + ", ".join(f"{k.split('/')[-1]}({s//1024}KB)" for k, s in keys[:6]))
            nc = [k for k, _ in keys if not k.endswith(".html")]
            if nc:
                return t, nc[0]
        time.sleep(1)
    return None, None


def read(path):
    import netCDF4
    ds = netCDF4.Dataset(path)
    desc = "; ".join(f"{n}{tuple(v.shape)}[{getattr(v, 'units', '')}]" for n, v in ds.variables.items())
    note("GMGSI 中身: " + desc[:900])
    two = [(n, v) for n, v in ds.variables.items() if len(v.shape) >= 2]
    name, var = max(two, key=lambda nv: np.prod(nv[1].shape[-2:]))
    data = np.ma.filled(var[:].astype("float64"), np.nan)
    while data.ndim > 2:
        data = data[0]
    lat = lon = None
    for n in ("lat", "latitude", "Latitude", "lats"):
        if n in ds.variables:
            lat = np.ma.filled(ds.variables[n][:].astype("float64"), np.nan)
    for n in ("lon", "longitude", "Longitude", "lons"):
        if n in ds.variables:
            lon = np.ma.filled(ds.variables[n][:].astype("float64"), np.nan)
    attrs = {k: str(getattr(var, k)) for k in var.ncattrs()}
    note(f"GMGSI 値: {name} {data.shape} 範囲 {np.nanmin(data):.2f}〜{np.nanmax(data):.2f} 属性 {json.dumps(attrs, ensure_ascii=False)[:400]}")
    return data, lat, lon, attrs


def to_kelvin(data, attrs):
    """温度でない保存（明るさの段階など）なら、ここで換算する。わからなければ止める"""
    lo, hi = np.nanmin(data), np.nanmax(data)
    if 150 <= lo and hi <= 350:
        return data                                    # すでに K
    if -130 <= lo and hi <= 80:
        return data + 273.15                           # ℃
    raise SystemExit(f"GMGSI の値が温度として読めません（{lo}〜{hi}）")


def regrid(k, lat, lon):
    """元の格子（1次元または2次元の緯度経度）→ 北から南・-180〜180 の等間隔格子（最近傍の平均）"""
    ny, nx = int(180 / STEP), int(360 / STEP)
    if lat is None or lon is None:
        raise SystemExit("GMGSI に緯度経度がありません")
    if lat.ndim == 1 and lon.ndim == 1:
        LO, LA = np.meshgrid(lon, lat)
    else:
        LA, LO = lat, lon
    LO = ((LO + 180) % 360) - 180
    ok = ~np.isnan(k) & ~np.isnan(LA) & ~np.isnan(LO)
    j = np.clip(((90 - LA[ok]) / STEP).astype(int), 0, ny - 1)
    i = np.clip(((LO[ok] + 180) / STEP).astype(int), 0, nx - 1)
    idx = j * nx + i
    s = np.bincount(idx, weights=k[ok], minlength=nx * ny)
    c = np.bincount(idx, minlength=nx * ny)
    out = np.full(nx * ny, np.nan)
    m = c > 0
    out[m] = s[m] / c[m]
    return out.reshape(ny, nx), nx, ny


def encode(g):
    q = np.where(np.isnan(g), 255, np.clip(np.round((g - TMIN) / (TMAX - TMIN) * 254), 0, 254)).astype("uint8")
    return q.tobytes()


def main():
    try:
        _main()
    except SystemExit:
        raise
    except BaseException as e:
        note(f"GMGSI 失敗: {type(e).__name__}: {e}"[:900], "error")
        raise


def _main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--latest", required=True)
    args = ap.parse_args()
    mpath = os.path.join(args.latest, "manifest.json")
    manifest = json.load(open(mpath, encoding="utf-8"))
    clock = dt.datetime.fromisoformat(manifest["layers"]["wind-10m"]["meta"]["validTime"].replace("Z", "+00:00"))
    t, key = pick(clock)
    if not key:
        note(f"時計 {iso(clock)} 以前 {MAX_AGE_H} 時間に GMGSI の画像がありません", "warning")
        return
    tmp = os.path.join(args.latest, "_gmgsi.nc")
    try:
        body = get(f"{BUCKET}/{key}", timeout=300)
    except BaseException as e:
        note(f"GMGSI 取得に失敗: {type(e).__name__} {e}", "error"); raise
    with open(tmp, "wb") as f:
        f.write(body)
    note(f"GMGSI 取得: {len(body)//1024} KB、先頭 {body[:8]!r}")
    try:
        data, lat, lon, attrs = read(tmp)
        k = to_kelvin(data, attrs)
        g, nx, ny = regrid(k, lat, lon)
    except BaseException as e:
        import traceback
        note("GMGSI 変換に失敗: " + " | ".join(traceback.format_exception(e))[-900:].replace("\n", " ").replace("::", ":"), "error")
        raise
    finally:
        os.remove(tmp)
    m = re.search(r"(\d{10})", key.split("/")[-1])
    img_t = dt.datetime.strptime(m.group(1), "%Y%m%d%H").replace(tzinfo=dt.timezone.utc) if m else t
    with open(os.path.join(args.latest, "cloud.bin"), "wb") as f:
        f.write(encode(g))
    cover = np.mean(~np.isnan(g))
    manifest["layers"]["cloud-ir"] = {
        "type": "scalar", "file": "cloud.bin", "format": "uint8",
        "grid": {"nx": nx, "ny": ny, "lon0": -180, "lat0": 90, "dx": STEP, "dy": STEP},
        "meta": {
            "title": "衛星赤外（雲）", "level": "雲頂・地表", "kind": "衛星",
            "model": "静止気象衛星の赤外画像を全球に合成したモザイク（長波赤外）",
            "validTime": iso(img_t), "selection": {"policy": "latestBefore", "maxAgeMin": MAX_AGE_H * 60},
            "usualIntervalH": 1, "delivery": "自動取得（GitHub Actions・時計の時刻以前で一番新しい画像）",
            "resolution": f"{STEP}° 格子に整形", "units": "K",
            "coverage": f"全球の約{cover*100:.0f}%（極に近い所は写らない）",
            "credit": "NOAA/NESDIS GMGSI（GOES・Himawari・Meteosat などの合成）。NOAA Open Data Dissemination より",
            "caution": "雲量や雨ではなく、赤外で見た温度です。低い雲や霧は地表と温度が近く、見えにくいことがあります",
            "encoding": {"type": "linearByte", "min": TMIN, "max": TMAX, "levels": 254, "missing": 255},
        },
    }
    json.dump(manifest, open(mpath, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    note(f"GMGSI 付加: 画像 {iso(img_t)}／時計 {iso(clock)}／{nx}×{ny}／覆う割合 {cover*100:.0f}%")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
GFS（NOAA/NCEP）の最新サイクルから「地上10mの風」と「降水」を取り、
地球儀の共通形式（Canonical）に直す Adapter。

  外のデータ（GRIB2） → この Adapter → data/latest/{manifest.json, wind.bin, rain.bin}

・風と雨は「同じGFS実行・同じ予報時間」から取るので、地球儀の時計で同時に表示できる
・GFS の出力は米国政府の著作物（パブリックドメイン）。表示は「モデル計算」として出典つきで行う
・外の癖（走査方向、単位、欠測値）はここで吸収し、ブラウザ側には持ち込まない

使い方:
  python scripts/fetch_gfs.py --out _site/data/latest
  python scripts/fetch_gfs.py --out /tmp/latest --grib 手元の.grib2   # 取得を飛ばして変換だけ試す
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import numpy as np
import eccodes

NOMADS = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl"
FHOUR = 3                      # 初期時刻 +3時間（降水は 0〜3時間の平均）
CYCLE_H = 6                    # GFS は 6時間ごと（00/06/12/18 UTC）
LOOKBACK = 5                   # 何サイクル前までさかのぼって探すか
UA = "globe-prototype/1B (+https://github.com/makohey/earth; GitHub Actions; static site, fetches ~4 times a day)"

# GRIB2 の (discipline, category, number) で見分ける（名前表の違いに左右されない）
PARAMS = {
    (0, 2, 2): "u",            # UGRD
    (0, 2, 3): "v",            # VGRD
    (0, 1, 7): "prate",        # PRATE  kg m-2 s-1
    (0, 3, 1): "prmsl",        # PRMSL  海面更正気圧 Pa
    (10, 2, 0): "icec",        # ICEC   海氷の割合 0〜1
    (0, 0, 0): "t",            # TMP    気温 K（使うのは 850 hPa だけ。気温の境目＝前線のできやすい所を見るため）
    (0, 3, 0): "pres",         # PRES   地表の気圧 Pa（850 hPa 面が地面の下になる高い山や氷床を除くため）
}

# 上空の風（大気循環を見る「風の高さ」）：気圧面 hPa → 見せる名前
UPPER_LEVELS = {850: "約1.5km", 500: "約5.5km", 250: "約10km"}

RAIN_MAX = 60.0                # mm/h（これ以上は同じ色）
RAIN_ZERO = 0.05               # mm/h 未満は「雨なし」
CREDIT = "NOAA / NCEP GFS（米国政府の著作物・パブリックドメイン）"


def log(*a):
    print("[fetch_gfs]", *a, file=sys.stderr, flush=True)


def iso(t: dt.datetime) -> str:
    return t.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------- 取得 ----------
def url_for(cycle: dt.datetime) -> str:
    d, h = cycle.strftime("%Y%m%d"), cycle.strftime("%H")
    q = {
        "dir": f"/gfs.{d}/{h}/atmos",
        "file": f"gfs.t{h}z.pgrb2.1p00.f{FHOUR:03d}",
        "var_UGRD": "on", "var_VGRD": "on", "var_PRATE": "on", "var_PRMSL": "on", "lev_mean_sea_level": "on", "var_ICEC": "on", "var_TMP": "on", "var_PRES": "on",
        "lev_10_m_above_ground": "on", "lev_surface": "on",
        "lev_850_mb": "on", "lev_500_mb": "on", "lev_250_mb": "on",
    }
    return NOMADS + "?" + urllib.parse.urlencode(q)


def download(url: str, tries: int = 3) -> bytes | None:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                body = r.read()
            if body[:4] == b"GRIB":
                return body
            log("GRIB ではない応答（まだ出ていない可能性）:", body[:80])
            return None
        except urllib.error.HTTPError as e:
            log("HTTP", e.code, "（まだ出ていない／混雑）")
            if e.code in (403, 404):
                return None
        except Exception as e:  # ネットワークの揺れ
            log("失敗:", e)
        time.sleep(5 * (k + 1))
    return None


def fetch_latest(now: dt.datetime) -> tuple[bytes, dt.datetime]:
    base = now.replace(minute=0, second=0, microsecond=0)
    base = base.replace(hour=base.hour - base.hour % CYCLE_H)
    for i in range(LOOKBACK):
        cyc = base - dt.timedelta(hours=CYCLE_H * i)
        url = url_for(cyc)
        log("試す:", cyc.strftime("%Y-%m-%d %HZ"))
        body = download(url)
        if body:
            return body, cyc
        time.sleep(2)  # 相手に優しく
    print("::error::最新の GFS が見つかりませんでした", flush=True)
    raise SystemExit("最新の GFS が見つかりませんでした（ページは前回のデータかサンプルで表示されます）")


# ---------- 読み取り（外の癖をここで吸収） ----------
def read_grib(path: str) -> dict:
    fields = {}
    with open(path, "rb") as f:
        while True:
            h = eccodes.codes_grib_new_from_file(f)
            if h is None:
                break
            try:
                key = (eccodes.codes_get(h, "discipline"),
                       eccodes.codes_get(h, "parameterCategory"),
                       eccodes.codes_get(h, "parameterNumber"))
                name = PARAMS.get(key)
                if not name:
                    continue
                tol = eccodes.codes_get(h, "typeOfLevel")
                if name == "t":                                  # 気温は 850 hPa だけ使う
                    if tol != "isobaricInhPa" or int(eccodes.codes_get(h, "level")) != 850:
                        continue
                    name = "t850"
                if name == "pres" and tol != "surface":
                    continue
                if name in ("u", "v") and tol == "isobaricInhPa":
                    lev = int(eccodes.codes_get(h, "level"))
                    if lev not in UPPER_LEVELS:
                        continue
                    name = f"{name}{lev}"                   # 上空の風：u850 / v850 など
                ni, nj = eccodes.codes_get(h, "Ni"), eccodes.codes_get(h, "Nj")
                vals = np.array(eccodes.codes_get_values(h), dtype="float64")
                if eccodes.codes_get(h, "bitmapPresent"):
                    miss = eccodes.codes_get(h, "missingValue")
                    vals[vals == miss] = np.nan
                a = vals.reshape(nj, ni)
                lat1 = eccodes.codes_get(h, "latitudeOfFirstGridPointInDegrees")
                lat2 = eccodes.codes_get(h, "latitudeOfLastGridPointInDegrees")
                lon1 = eccodes.codes_get(h, "longitudeOfFirstGridPointInDegrees")
                lon2 = eccodes.codes_get(h, "longitudeOfLastGridPointInDegrees")
                dx = eccodes.codes_get(h, "iDirectionIncrementInDegrees")
                dy = eccodes.codes_get(h, "jDirectionIncrementInDegrees")
                # 北→南、西→東にそろえる
                if eccodes.codes_get(h, "jScansPositively"):
                    a = a[::-1]
                    lat1, lat2 = lat2, lat1
                if eccodes.codes_get(h, "iScansNegatively"):
                    a = a[:, ::-1]
                    lon1, lon2 = lon2, lon1
                if lat1 < lat2:
                    lat1, lat2 = lat2, lat1
                ddate, dtime = eccodes.codes_get(h, "dataDate"), eccodes.codes_get(h, "dataTime")
                issued = dt.datetime.strptime(f"{ddate:08d}{dtime:04d}", "%Y%m%d%H%M").replace(tzinfo=dt.timezone.utc)
                s0 = eccodes.codes_get(h, "startStep")
                s1 = eccodes.codes_get(h, "endStep")
                fields[name] = {
                    "a": a, "nx": ni, "ny": nj, "lon0": lon1, "lat0": lat1,
                    "dx": dx, "dy": dy, "issued": issued,
                    "from": issued + dt.timedelta(hours=s0), "to": issued + dt.timedelta(hours=s1),
                }
            finally:
                eccodes.codes_release(h)
    missing = [n for n in ("u", "v", "prate") if n not in fields]
    if missing:
        raise SystemExit(f"GRIB に必要な要素がありません: {missing}")
    return fields


# ---------- 共通形式へ ----------
def encode_wind(u: np.ndarray, v: np.ndarray) -> bytes:
    uv = np.empty(u.size * 2, dtype="<i2")
    uv[0::2] = np.clip(np.nan_to_num(u, nan=0.0) * 100, -32766, 32766).round().ravel()
    uv[1::2] = np.clip(np.nan_to_num(v, nan=0.0) * 100, -32766, 32766).round().ravel()
    return uv.tobytes()


def encode_rain(prate: np.ndarray) -> bytes:
    p = prate * 3600.0                         # kg m-2 s-1 → mm/h
    missing = np.isnan(p)
    p = np.where(missing, 0.0, np.maximum(p, 0.0))
    q = np.where(p < RAIN_ZERO, 0,
                 np.clip(np.round(np.log1p(p) / math.log1p(RAIN_MAX) * 253) + 1, 1, 254))
    q = np.where(missing, 255, q).astype("uint8")
    return q.tobytes()


def encode_pressure(pa: np.ndarray) -> bytes:
    """Pa → hPa。(hPa - 1000) × 10 を Int16 で（0.1 hPa 刻み）。欠測は -32768"""
    h = (pa / 100.0 - 1000.0) * 10.0
    q = np.where(np.isnan(h), -32768, np.clip(np.round(h), -32767, 32767)).astype("<i2")
    return q.tobytes()


def encode_front(t: np.ndarray, ps, lat0: float, dy: float, dx: float) -> tuple[bytes, float]:
    """850 hPa の気温（約1.5km）と、その変わり方の急さ（℃ / 100km）を1マス2バイトで。
    1バイト目＝気温＋80（℃）、2バイト目＝急さ×20。255＝なし（850 hPa 面が地面の下：高い山・氷床）"""
    T = t - 273.15
    ny, nx = T.shape
    lat = lat0 - np.arange(ny) * dy
    km_y = 111.2 * dy
    km_x = np.maximum(111.2 * dx * np.cos(np.radians(lat)), 5.0)[:, None]
    Tp = np.concatenate([T[:, -1:], T, T[:, :1]], axis=1)                     # 経度はつながっている
    gx = (Tp[:, 2:] - Tp[:, :-2]) / (2 * km_x)
    gy = np.zeros_like(T); gy[1:-1] = (T[:-2] - T[2:]) / (2 * km_y)
    g = np.hypot(gx, gy) * 100.0
    k = np.ones((3, 3)) / 9.0                                                  # 細かいざらつきを少しならす
    gp = np.pad(np.concatenate([g[:, -1:], g, g[:, :1]], axis=1), ((1, 1), (0, 0)), mode="edge")
    gs = sum(gp[1 + a: 1 + a + ny, 1 + b: 1 + b + nx] * k[a + 1, b + 1] for a in (-1, 0, 1) for b in (-1, 0, 1))
    under = (ps < 86000) if ps is not None else np.zeros_like(T, dtype=bool)   # 地面が 860 hPa より高い所は使わない
    q = np.zeros((ny, nx, 2), dtype="uint8")
    q[..., 0] = np.where(np.isnan(T) | under, 255, np.clip(np.round(T + 80), 0, 254))
    q[..., 1] = np.where(np.isnan(gs) | under, 255, np.clip(np.round(gs * 20), 0, 254))
    return q.tobytes(), float(np.nanpercentile(np.where(under, np.nan, gs), 99))


def build(fields: dict, out: str, source_url: str | None):
    u, v, pr = fields["u"], fields["v"], fields["prate"]
    if u["a"].shape != v["a"].shape:
        raise SystemExit("風の u と v の格子が合っていません")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "wind.bin"), "wb") as f:
        f.write(encode_wind(u["a"], v["a"]))
    with open(os.path.join(out, "rain.bin"), "wb") as f:
        f.write(encode_rain(pr["a"]))
    ic = fields.get("icec")                       # 海氷も無くてよい
    if ic is not None:
        a = ic["a"]
        q = np.where(np.isnan(a), 255, np.clip(np.round(a * 100), 0, 100)).astype("uint8")
        with open(os.path.join(out, "seaice.bin"), "wb") as f:
            f.write(q.tobytes())
    ps = fields.get("prmsl")                      # 気圧は無くても風と雨は出す
    if ps is not None:
        with open(os.path.join(out, "pressure.bin"), "wb") as f:
            f.write(encode_pressure(ps["a"]))

    def res(g):
        return f"{g['dx']:g}° 格子（{g['nx']}×{g['ny']}）"

    manifest = {
        "mode": "live",
        "generatedAt": iso(dt.datetime.now(dt.timezone.utc)),
        "source": {"name": "NOAA NOMADS（GFS 1.00°）", "url": source_url},
        "layers": {
            "wind-10m": {
                "type": "flow", "file": "wind.bin", "format": "int16-uv",
                "grid": {"nx": u["nx"], "ny": u["ny"], "lo1": u["lon0"], "la1": u["lat0"],
                         "dx": u["dx"], "dy": u["dy"], "scale": 100},
                "meta": {
                    "title": "風", "level": "地上10m", "kind": "モデル計算",
                    "model": f"GFS 予報（初期値 +{FHOUR}時間）",
                    "validTime": iso(u["to"]), "issuedTime": iso(u["issued"]),
                    "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                    "resolution": res(u), "units": "m/s", "credit": CREDIT,
                },
            },
            "rain": {
                "type": "scalar", "file": "rain.bin", "format": "uint8",
                "grid": {"nx": pr["nx"], "ny": pr["ny"], "lon0": pr["lon0"], "lat0": pr["lat0"],
                         "dx": pr["dx"], "dy": pr["dy"], "registration": "point"},
                "meta": {
                    "title": "降水", "level": "地表", "kind": "モデル計算",
                    "model": f"GFS 予報（初期値〜+{FHOUR}時間の平均降水強度）",
                    "validFrom": iso(pr["from"]), "validTo": iso(pr["to"]), "issuedTime": iso(pr["issued"]),
                    "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                    "resolution": res(pr), "units": "mm/h", "coverage": "全球", "credit": CREDIT,
                    "encoding": {"type": "log1p", "max": RAIN_MAX, "zero": 0, "missing": 255, "levels": 253},
                },
            },
        },
    }
    if ps is not None:
        manifest["layers"]["pressure"] = {
            "type": "scalar", "file": "pressure.bin", "format": "int16",
            "grid": {"nx": ps["nx"], "ny": ps["ny"], "lon0": ps["lon0"], "lat0": ps["lat0"],
                     "dx": ps["dx"], "dy": ps["dy"], "registration": "point"},
            "meta": {
                "title": "気圧配置", "level": "海面更正", "kind": "モデル計算",
                "model": f"GFS 予報（海面更正気圧・初期値 +{FHOUR}時間）",
                "validTime": iso(ps["to"]), "issuedTime": iso(ps["issued"]),
                "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                "resolution": res(ps), "units": "hPa", "coverage": "全球", "credit": CREDIT,
                "encoding": {"type": "linear", "scale": 0.1, "offset": 1000, "missing": -32768},
            },
        }
    for lev, alt in UPPER_LEVELS.items():            # 上空の風（無くても地上の風はそのまま）
        uu, vv = fields.get(f"u{lev}"), fields.get(f"v{lev}")
        if uu is None or vv is None:
            continue
        with open(os.path.join(out, f"wind{lev}.bin"), "wb") as f:
            f.write(encode_wind(uu["a"], vv["a"]))
        manifest["layers"][f"wind-{lev}"] = {
            "type": "flow", "file": f"wind{lev}.bin", "format": "int16-uv", "lazy": True,   # 選ばれたときだけ読む
            "grid": {"nx": uu["nx"], "ny": uu["ny"], "lo1": uu["lon0"], "la1": uu["lat0"], "dx": uu["dx"], "dy": uu["dy"], "scale": 100},
            "meta": {
                "title": "風", "level": f"{alt}（{lev} hPa）", "kind": "モデル計算",
                "model": f"GFS 予報（{lev} hPa 面の風・初期値 +{FHOUR}時間）",
                "validTime": iso(uu["to"]), "issuedTime": iso(uu["issued"]),
                "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                "resolution": res(uu), "units": "m/s", "credit": CREDIT,
            },
        }
    t8 = fields.get("t850")                           # 気温の境目（無くてもほかはそのまま）
    if t8 is not None:
        pr = fields.get("pres")
        body, g99 = encode_front(t8["a"], pr["a"] if pr is not None and pr["a"].shape == t8["a"].shape else None, t8["lat0"], t8["dy"], t8["dx"])
        with open(os.path.join(out, "front850.bin"), "wb") as f:
            f.write(body)
        manifest["layers"]["front-850"] = {
            "type": "field", "file": "front850.bin", "format": "uint8x2-temp80-grad20", "lazy": True,
            "grid": {"nx": t8["nx"], "ny": t8["ny"], "lon0": t8["lon0"], "lat0": t8["lat0"], "dx": t8["dx"], "dy": t8["dy"], "none": 255},
            "meta": {
                "title": "気温の境目（前線のできやすい所）", "level": "約1.5km（850 hPa）", "kind": "モデル計算から求めた目安",
                "model": f"GFS 予報（850 hPa の気温・初期値 +{FHOUR}時間）から、気温が急に変わる所を計算",
                "validTime": iso(t8["to"]), "issuedTime": iso(t8["issued"]),
                "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                "resolution": res(t8), "units": "℃ / 100km", "credit": CREDIT,
                "caution": "天気図の前線ではありません（前線は気象庁の予報官が判断して引くものです）。高い山や氷床の上は、この高さが地面の下になるので出していません",
            },
        }
        print(f"::notice::気温の境目 付加: 850 hPa の気温から計算／上位1%の急さ {g99:.1f} ℃/100km／地表気圧 {'あり' if pr is not None else 'なし'}", flush=True)
    if ic is not None:
        manifest["layers"]["sea-ice"] = {
            "type": "scalar", "file": "seaice.bin", "format": "uint8",
            "grid": {"nx": ic["nx"], "ny": ic["ny"], "lon0": ic["lon0"], "lat0": ic["lat0"],
                     "dx": ic["dx"], "dy": ic["dy"], "registration": "point"},
            "meta": {
                "title": "海氷", "level": "海面", "kind": "モデル計算",
                "model": f"GFS 予報（海氷の割合・初期値 +{FHOUR}時間）",
                "validTime": iso(ic["to"]), "issuedTime": iso(ic["issued"]),
                "usualIntervalH": CYCLE_H, "delivery": "自動取得（GitHub Actions・約6時間ごと）",
                "resolution": res(ic), "units": "%", "coverage": "全球の海（陸はデータなし）", "credit": CREDIT,
                "encoding": {"type": "raw", "missing": 255},
            },
        }
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)
    log("書き出し完了:", out, "初期時刻", iso(u["issued"]), "有効時刻", iso(u["to"]))
    print(f"::notice::GFS 書き出し: 初期時刻 {iso(u['issued'])}／有効時刻 {iso(u['to'])}／気圧 {'あり' if 'prmsl' in fields else 'なし'}／海氷 {'あり' if 'icec' in fields else 'なし'}／上空の風 {sorted(int(k[1:]) for k in fields if k.startswith('u') and k[1:].isdigit())}", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--grib", help="手元の GRIB2 を使う（取得しない）")
    ap.add_argument("--cycle", help="この回（YYYYMMDDHH）だけを試す。まだ出ていなければ終了コード 3")
    args = ap.parse_args()
    if args.grib:
        path, url = args.grib, None
    elif args.cycle:
        cyc = dt.datetime.strptime(args.cycle, "%Y%m%d%H").replace(tzinfo=dt.timezone.utc)
        body = download(url_for(cyc), tries=1)
        if not body:
            log("まだ出ていない:", args.cycle)
            sys.exit(3)
    else:
        body, cyc = fetch_latest(dt.datetime.now(dt.timezone.utc))
    if not args.grib:
        url = url_for(cyc)
        os.makedirs(args.out, exist_ok=True)
        path = os.path.join(args.out, "_gfs.grib2")
        with open(path, "wb") as f:
            f.write(body)
    fields = read_grib(path)
    build(fields, args.out, url)
    if not args.grib:
        os.remove(path)  # 生データは公開しない（軽く保つ）


if __name__ == "__main__":
    main()

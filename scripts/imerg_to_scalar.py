"""
Adapter: NASA GPM IMERG (HDF5, half-hourly) -> 共通 Scalar 格子
外の癖（縦横の向き、南→北、-180..180、GPS 基準の秒、期間値、欠損値）はここで吸収する。
出力は Earth Runtime 側が知っている形だけ:
  lon0=-180, lat0=90（北から南へ）, 等間隔, 値は uint8（255 = データなし）
"""
import h5py, numpy as np, json, base64, datetime, sys

src, out = sys.argv[1], sys.argv[2]
STEP = 4                        # 0.1° -> 0.4°（試験なので軽く）
f = h5py.File(src, "r"); g = f["Grid"]
p = g["precipitation"][0]       # 形: (lon=3600, lat=1800)、lat は南→北
fill = g["precipitation"].attrs.get("_FillValue", -9999.9)
p = np.where(p <= fill + 1e-3, np.nan, p).astype("float32")
p = p.T[::-1, :]                # -> (lat 北→南, lon -180..180)
ny, nx = p.shape
p = p[: ny // STEP * STEP, : nx // STEP * STEP].reshape(ny // STEP, STEP, nx // STEP, STEP)
missing = np.isnan(p).all(axis=(1, 3))
p = np.nanmean(p, axis=(1, 3))
# 0..254 に圧縮（対数、0 = 雨なし、254 ≒ 60 mm/h 以上）
MAXV = 60.0
q = np.where(p <= 0.05, 0, np.clip(np.round(np.log1p(p) / np.log1p(MAXV) * 253) + 1, 1, 254))
q = np.where(missing, 255, q).astype("uint8")
gps0 = datetime.datetime(1980, 1, 6, tzinfo=datetime.timezone.utc)
tb = g["time_bnds"][0]
t0 = gps0 + datetime.timedelta(seconds=int(tb[0])); t1 = gps0 + datetime.timedelta(seconds=int(tb[1]))
meta = {
  "title": "降水", "level": "地表", "kind": "推定", "model": "衛星観測からの推定（IMERG Final Run V07B・30分値）",
  "validFrom": t0.strftime("%Y-%m-%dT%H:%M:%SZ"), "validTo": t1.strftime("%Y-%m-%dT%H:%M:%SZ"),
  "usualIntervalH": 0.5, "delivery": "内蔵サンプル（更新なし）", "resolution": f"{0.1*STEP:.1f}° 格子（元は 0.1°）",
  "units": "mm/h", "coverage": "全球（ごく一部の格子は欠測）",
  "credit": "NASA GPM IMERG", "sampleCredit": "サンプル入手元：pydata/xarray-data",
  "encoding": {"type": "log1p", "max": MAXV, "zero": 0, "missing": 255, "levels": 253},
}
grid = {"nx": q.shape[1], "ny": q.shape[0], "lon0": -180.0, "lat0": 90.0, "dx": 0.1 * STEP, "dy": 0.1 * STEP}
open(out, "w").write("const RAIN = " + json.dumps({"meta": meta, "grid": grid, "b64": base64.b64encode(q.tobytes()).decode()}, ensure_ascii=False) + ";\n")
print(grid, meta["validFrom"], meta["validTo"], "missing cells", int(missing.sum()), "max mm/h", float(np.nanmax(p)))

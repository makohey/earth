# データの出典とライセンス

| データ | 出典 | 扱い |
|---|---|---|
| 風・降水（最新） | NOAA / NCEP GFS（NOMADS 経由で取得） | 米国政府の著作物・パブリックドメイン。数値モデルの計算結果として、そのまま表示 |
| 風（サンプル） | NOAA / NCEP GFS 2014-01-31、整形：[cambecc/earth](https://github.com/cambecc/earth) | MIT License（全文：`data/sample/LICENSE-MIT.txt`、ページ内 Lens にも表示） |
| 降水（サンプル） | NASA GPM IMERG Final Run V07B、入手元：[pydata/xarray-data](https://github.com/pydata/xarray-data) | NASA の公開データ。`scripts/imerg_to_scalar.py` で変換 |
| 陸地・海岸線 | Natural Earth 1:50m（world-atlas 経由） | パブリックドメイン |
| 国境線・国名（試作） | Natural Earth 1:50m（nvkelso/natural-earth-vector）。見方別データ（日本の見方／既定の見方）を `scripts/prep_map.py` で変換 | パブリックドメイン |
| 夜の街の灯り（試作） | NASA「Earth's City Lights」（three.js の例 `examples/textures/planets/earth_lights_2048.png` を白黒化） | NASA の画像（米国政府の著作物）。何年か前の合成画像で、今夜の灯りではない |
| 空港の観測（試作） | NOAA / NWS Aviation Weather Center（aviationweather.gov）の METAR | 米国政府の公開データ。電文は加工せず添える |
| 3D 表示 | three.js r147（jsDelivr から読み込み） | MIT License |

## 表示の決まり（気象業務法まわり）

- 表示するのは **モデルの計算結果そのもの**（「モデル計算」と明記）。
- 複数モデルを平均・合成して独自の予報を作らない。警報・注意報のような表現をしない。
- 気象庁の予報・警報の代わりにはならないことをページ内に書いている。

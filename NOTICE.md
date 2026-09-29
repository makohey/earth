# データの出典とライセンス

| データ | 出典 | 扱い |
|---|---|---|
| 風・降水（最新） | NOAA / NCEP GFS（NOMADS 経由で取得） | 米国政府の著作物・パブリックドメイン。数値モデルの計算結果として、そのまま表示 |
| 風（サンプル） | NOAA / NCEP GFS 2014-01-31、整形：[cambecc/earth](https://github.com/cambecc/earth) | MIT License（全文：`data/sample/LICENSE-MIT.txt`、ページ内 Lens にも表示） |
| 降水（サンプル） | NASA GPM IMERG Final Run V07B、入手元：[pydata/xarray-data](https://github.com/pydata/xarray-data) | NASA の公開データ。`scripts/imerg_to_scalar.py` で変換 |
| 陸地・海岸線 | Natural Earth 1:50m（world-atlas 経由） | パブリックドメイン |
| 国境線・国名（試作） | Natural Earth 1:50m（nvkelso/natural-earth-vector）。見方別データ（日本の見方／既定の見方）を `scripts/prep_map.py` で変換 | パブリックドメイン |
| 衛星赤外（雲）（試作） | NOAA/NESDIS GMGSI（GOES・Himawari・Meteosat などの静止気象衛星の合成）、NOAA Open Data Dissemination（AWS） | 公開利用可。出典を表示し、NOAA・JMA 等との提携や推奨を示唆しない。0.25° 格子に整形した加工品で、元データそのものではない |
| 氷河・氷床・棚氷（試作） | Natural Earth 1:50m（氷河・氷床、南極の棚氷）を `scripts/prep_map.py` で画像化 | パブリックドメイン。動かない地図 |
| 海氷（試作） | NOAA / NCEP GFS の海氷の割合（ICEC） | 米国政府の著作物。モデル計算（+3時間） |
| 夜の街の灯り（試作） | NASA「Earth's City Lights」（three.js の例 `examples/textures/planets/earth_lights_2048.png` を白黒化） | NASA の画像（米国政府の著作物）。何年か前の合成画像で、今夜の灯りではない |
| 空港の観測（試作） | NOAA / NWS Aviation Weather Center（aviationweather.gov）の METAR | 米国政府の公開データ。電文は加工せず添える |
| 3D 表示 | three.js r147（jsDelivr から読み込み） | MIT License |

## 表示の決まり（気象業務法まわり）

- 表示するのは **モデルの計算結果そのもの**（「モデル計算」と明記）。
- 複数モデルを平均・合成して独自の予報を作らない。警報・注意報のような表現をしない。
- 気象庁の予報・警報の代わりにはならないことをページ内に書いている。

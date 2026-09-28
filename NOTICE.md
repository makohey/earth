# データの出典とライセンス

| データ | 出典 | 扱い |
|---|---|---|
| 風・降水（最新） | NOAA / NCEP GFS（NOMADS 経由で取得） | 米国政府の著作物・パブリックドメイン。数値モデルの計算結果として、そのまま表示 |
| 風（サンプル） | NOAA / NCEP GFS 2014-01-31、整形：[cambecc/earth](https://github.com/cambecc/earth) | MIT License（全文：`data/sample/LICENSE-MIT.txt`、ページ内 Lens にも表示） |
| 降水（サンプル） | NASA GPM IMERG Final Run V07B、入手元：[pydata/xarray-data](https://github.com/pydata/xarray-data) | NASA の公開データ。`scripts/imerg_to_scalar.py` で変換 |
| 陸地・海岸線 | Natural Earth 1:50m（world-atlas 経由） | パブリックドメイン |
| 3D 表示 | three.js r147（jsDelivr から読み込み） | MIT License |

## 表示の決まり（気象業務法まわり）

- 表示するのは **モデルの計算結果そのもの**（「モデル計算」と明記）。
- 複数モデルを平均・合成して独自の予報を作らない。警報・注意報のような表現をしない。
- 気象庁の予報・警報の代わりにはならないことをページ内に書いている。

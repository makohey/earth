# 地球儀 試作1B

風と雨が流れる、ブラウザで動く地球儀の試作です。
GitHub Actions が約6時間ごとに最新の GFS（米国の数値予報モデル）を取りに行き、
**同じ計算から取った風と雨** を GitHub Pages で表示します。

- 最新データが取れないときは、サンプル（風2014年・雨2021年）で動きます
- 操作：横に動かすと地軸で回る／縦で北極・南極へ／ピンチ・ホイールで拡大／地球をタップでその地点の値
- 右上のボタンで Lens（出典・時刻・凡例・層の切り替え）

## この地球儀について（大事なこと）

- **眺めるための地球儀です。天気予報・警報・地震情報ではありません。** 風・雨・気圧・海氷は数値モデルの計算結果、雲は衛星の画像、地震は USGS の解析を、そのまま描いたものです。台風・大雨・地震への備えは、必ず気象庁など公的機関の情報で確かめてください
- 作ったのは、まこと（makohey）と、AI の相棒 ルミ（Claude）・みらい（ChatGPT）の三人です

## 使い方の条件（ライセンス）

- このリポジトリの**コードと、私たちが書いた加工の仕方**は、[PolyForm Noncommercial License 1.0.0](LICENSE) で公開しています
  - **非商用なら**、コピー・改変・再配布は自由です（「オープンソース」の定義には入らない、非商用限定の公開コードです）
  - 配布するときは `LICENSE` の条件と、次の一行を必ず一緒に渡してください
    `Required Notice: Copyright (c) 2026 makohey (https://github.com/makohey/earth)`
- **借りている部品とデータは、それぞれ元の条件のまま**です（このライセンスで上書きしません）。一覧は [NOTICE.md](NOTICE.md)
- データそのもの（NOAA の風など）は、このライセンスの対象ではありません

## 作った人たちからのお願い

- **この地球儀を越えるものを作ってくれて構いません。進化は大歓迎です**
- ただ、**商売にはしないでほしい**。そして、**あなたの進化版も、次の人が無料で使える形で渡してほしい**（これはお願いです）
- そして何より、**データを貸してくれている水源を絶対に荒らさないでください**。私たちはデータを「使っている」のではなく「頂いている」と考えています。取り方の約束は [DATA_USE.md](DATA_USE.md) にあります
- 優先順位：①水源を守る ②地球儀が長く回り続ける ③雲や風の動きを止めない ④機能を増やす ⑤利益（あれば嬉しい、くらい）
- 問題や気になることは、このリポジトリの Issues へ

## 動かすまで（最初の1回だけ）

1. このフォルダの中身をリポジトリの `main` ブランチに置く（`.github` フォルダも忘れずに）
2. リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
3. **Actions** タブ → 「データ更新と公開」 → **Run workflow**
4. 終わったら Settings → Pages に出る URL を開く

あとは自動で、1日4回（日本時間 おおよそ 1:20・7:20・13:20・19:20）更新されます。

> 注意：リポジトリに60日間まったく動きがないと、GitHub が自動実行を止めます。
> そのときは Actions タブで再開ボタンを押せば戻ります。

## 手元で見る

`index.html` を直接開くとデータを読めないので、簡易サーバーで開きます。

```
python3 -m http.server 8000
# → http://localhost:8000/
```

最新データも手元で作るなら：

```
pip install eccodes numpy
python3 scripts/fetch_gfs.py --out data/latest
```

## 中身の地図（器の境界）

```
index.html                 画面の骨組みと見た目
app.js                     地球儀本体
  ├ 天体プロフィール（EARTH）    天体固有の数字はここだけ
  ├ データ目録（Catalog）        manifest.json を読む。出典・時刻・種別はすべてここから
  ├ 時計（Clock）                ひとつだけ。いまは風の有効時刻で止まっている
  ├ 流れ場の口 sample(lon,lat,t) → [u,v]
  ├ 値の場の口 sample(lon,lat,t) → 値 | null（null は「データなし」で 0 とは別）
  ├ 値の面・見せる粒子・地軸回し・Lens
data/
  land.bin, coast.bin      陸地と海岸線（Int16：経度×100, 緯度×100、32767 で区切り）
  sample/                  サンプル一式（manifest.json + bin）
  latest/                  Actions が作る最新（リポジトリには入れない）
scripts/
  fetch_gfs.py             Adapter：GFS（GRIB2）→ 共通形式
  imerg_to_scalar.py       Adapter：IMERG（NetCDF）→ 共通形式（サンプル作成用）
```

新しいデータを足すときは **Adapter を書いて manifest.json に1項目足す** だけで、
ブラウザ側の口（流れ場／値の場）はそのまま使えるようにしてあります。

## データ形式（manifest.json）

```json
{
  "mode": "live",
  "generatedAt": "…",
  "layers": {
    "wind-10m": { "type": "flow",   "file": "wind.bin", "format": "int16-uv", "grid": {…}, "meta": {…} },
    "rain":     { "type": "scalar", "file": "rain.bin", "format": "uint8",    "grid": {…}, "meta": {…, "encoding": {…}} }
  }
}
```

- `wind.bin`：u, v を交互に Int16（m/s×100）。北から南、`lo1` から東へ
- `rain.bin`：uint8。0 = 雨なし、1〜254 = 対数で圧縮（最大 60 mm/h）、255 = データなし
- `grid.registration`：`point`（格子点の値、補間する）／ なし（升目の値）

## 出典とライセンス

- 出典と第三者の条件：[NOTICE.md](NOTICE.md)
- このプロジェクトのコード：[LICENSE](LICENSE)（PolyForm Noncommercial 1.0.0）
- データの取り方の約束：[DATA_USE.md](DATA_USE.md)

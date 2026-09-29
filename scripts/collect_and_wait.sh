#!/usr/bin/env bash
# 定時の実行（GFS の回が始まって約2時間半後）で呼ばれる。
#  1. 空港の観測（METAR）を10分ごとに保存しながら
#  2. その回の GFS（+3時間）が出るのを待つ
#  3. 出たら変換し、集めた観測のうち「時計（GFS の有効時刻）より前」のものを付ける
# GitHub の時間指定は遅れたり飛んだりするので、観測の保存を別の時間指定に頼らない形にしてある。
set -u
OUT="$1"                       # 例: _site/data/latest
MAX_MIN="${2:-150}"            # 最大で待つ分数
mkdir -p obs
CYCLE=$(python3 -c 'import datetime as d;n=d.datetime.now(d.timezone.utc);print(n.replace(hour=n.hour-n.hour%6).strftime("%Y%m%d%H"))')
echo "::notice::待つ回: ${CYCLE}Z（最大 ${MAX_MIN} 分）"
start=$(date +%s); i=0; got=0
while :; do
  i=$((i+1))
  python3 scripts/fetch_metar.py snapshot --out "obs/metar_${i}.json" || true
  if python3 scripts/fetch_gfs.py --out "$OUT" --cycle "$CYCLE"; then got=1; break; fi
  el=$(( ($(date +%s) - start) / 60 ))
  if [ "$el" -ge "$MAX_MIN" ]; then break; fi
  sleep 600
done
if [ "$got" -ne 1 ]; then
  echo "::warning::${CYCLE}Z が時間内に出なかったので、出ている中で一番新しい回を使います"
  python3 scripts/fetch_gfs.py --out "$OUT" || exit 0
fi
# 時計より少し後にもう一度だけ観測を取る（時計ちょうどの観測を拾うため）
python3 scripts/fetch_metar.py snapshot --out "obs/metar_last.json" || true
python3 scripts/fetch_metar.py attach --snapshot obs/metar_*.json --latest "$OUT" || true

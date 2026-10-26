#!/usr/bin/env bash
# golden-diff.sh — 黄金请求差分：同一组请求分别打 base 与 head，去噪后 diff 响应体。
#
# 用法：golden-diff.sh <env 文件>
# 依赖 env 文件里的：GOLDEN_DIR URL_BASE URL_HEAD PACK
# 请求文件格式（$GOLDEN_DIR/<name>.req）：
#   首行  METHOD /path?query
#   随后  可选若干 "Header-Name: value" 行
#   空行
#   可选  请求体（原文）
# $GOLDEN_DIR/ignore-keys.txt：每行一个噪声字段名（id created_at request_id …），JSON 响应在任意深度删除。
# 退出码：0 = 全部 SAME；1 = 至少一条 DIFF（需归类）；2 = 配置缺失或请求失败
ENVFILE_ARG="$1"
[ -n "$ENVFILE_ARG" ] && [ -f "$ENVFILE_ARG" ] || { echo "STOP: 用法 golden-diff.sh <env 文件>"; exit 2; }
# shellcheck disable=SC1090
. "$ENVFILE_ARG"
: "${GOLDEN_DIR:?}" "${URL_BASE:?}" "${URL_HEAD:?}" "${PACK:?}"
command -v curl >/dev/null || { echo "STOP: 缺 curl"; exit 2; }
command -v jq >/dev/null || { echo "STOP: 缺 jq"; exit 2; }
[ -d "$GOLDEN_DIR" ] || { echo "STOP: GOLDEN_DIR 不存在: $GOLDEN_DIR"; exit 2; }

OUTDIR="$PACK/golden"; mkdir -p "$OUTDIR"
SUMMARY="$OUTDIR/summary.txt"; : > "$SUMMARY"

FILTER='.'
if [ -s "$GOLDEN_DIR/ignore-keys.txt" ]; then
  KEYS=$(grep -v '^\s*$' "$GOLDEN_DIR/ignore-keys.txt" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | awk '{printf "%s.[\"%s\"]", (NR>1?",":""), $0}')
  FILTER="walk(if type==\"object\" then del(${KEYS}) else . end)"
fi

fire() { # fire <base|head> <url> <reqfile> <outfile>
  local url="$2" req="$3" out="$4" method path body="" line in_body=0
  local -a hdr=()
  method=$(head -1 "$req" | awk '{print $1}'); path=$(head -1 "$req" | awk '{print $2}')
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$in_body" -eq 1 ]; then body="${body}${line}"$'\n'; continue; fi
    if [ -z "$line" ]; then in_body=1; continue; fi
    hdr+=(-H "$line")
  done < <(tail -n +2 "$req")
  if [ -n "$body" ]; then
    curl -sS -o "$out.body" -w '%{http_code}' -X "$method" "${hdr[@]}" --data-binary "$body" "$url$path"
  else
    curl -sS -o "$out.body" -w '%{http_code}' -X "$method" "${hdr[@]}" "$url$path"
  fi
}

normalize() { # normalize <bodyfile> <normfile>
  if jq -e . "$1" >/dev/null 2>&1; then jq -S "$FILTER" "$1" > "$2"; else cp "$1" "$2"; fi
}

ANY_DIFF=0; ANY_ERR=0; N=0
for req in "$GOLDEN_DIR"/*.req; do
  [ -e "$req" ] || { echo "STOP: $GOLDEN_DIR 下没有 .req 文件"; exit 2; }
  N=$((N + 1)); name=$(basename "$req" .req)
  BASE_CODE=$(fire base "$URL_BASE" "$req" "$OUTDIR/$name.base") || { echo "$name ERR base 请求失败" | tee -a "$SUMMARY"; ANY_ERR=1; continue; }
  HEAD_CODE=$(fire head "$URL_HEAD" "$req" "$OUTDIR/$name.head") || { echo "$name ERR head 请求失败" | tee -a "$SUMMARY"; ANY_ERR=1; continue; }
  normalize "$OUTDIR/$name.base.body" "$OUTDIR/$name.base.norm"
  normalize "$OUTDIR/$name.head.body" "$OUTDIR/$name.head.norm"
  # diff 无条件跑：状态码不同但体相同时也要留下 .diff 文件，报告引用的路径必须存在。
  diff -u "$OUTDIR/$name.base.norm" "$OUTDIR/$name.head.norm" > "$OUTDIR/$name.diff.tmp"; DIFF_EXIT=$?
  if [ "$BASE_CODE" = "$HEAD_CODE" ] && [ "$DIFF_EXIT" -eq 0 ]; then
    mv "$OUTDIR/$name.diff.tmp" "$OUTDIR/$name.diff"
    echo "$name SAME http=$BASE_CODE" | tee -a "$SUMMARY"
  else
    { echo "http base=$BASE_CODE head=$HEAD_CODE"; cat "$OUTDIR/$name.diff.tmp"; } > "$OUTDIR/$name.diff"; rm -f "$OUTDIR/$name.diff.tmp"
    echo "$name DIFF http base=$BASE_CODE head=$HEAD_CODE → $OUTDIR/$name.diff" | tee -a "$SUMMARY"
    ANY_DIFF=1
  fi
done
printf 'requests=%s diff=%s err=%s summary=%s\n' "$N" "$ANY_DIFF" "$ANY_ERR" "$SUMMARY"
[ "$ANY_ERR" -eq 0 ] || exit 2
[ "$ANY_DIFF" -eq 0 ] || exit 1
exit 0

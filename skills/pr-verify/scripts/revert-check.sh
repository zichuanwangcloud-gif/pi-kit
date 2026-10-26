#!/usr/bin/env bash
# revert-check.sh — 反验：把 head 的测试文件放进 base worktree（不放实现），测试必须变红。
#
# 用法：revert-check.sh <env 文件>
# 依赖 env 文件里的：ROOT HEAD_OID WT_BASE WT_HEAD TEST_FILES TEST_CMD PACK
# 退出码：0 = 基线红且 head 绿（PASS）；1 = 基线绿或 head 红（需定论）；2 = 无测试文件或前置缺失（BLOCKED）
#
# 刻意不用 set -e：需要取回非零退出码。两侧命令逐字相同，任何差异都是口径漂移。
ENVFILE_ARG="$1"
[ -n "$ENVFILE_ARG" ] && [ -f "$ENVFILE_ARG" ] || { echo "STOP: 用法 revert-check.sh <env 文件>"; exit 2; }
# shellcheck disable=SC1090
. "$ENVFILE_ARG"
: "${ROOT:?}" "${HEAD_OID:?}" "${WT_BASE:?}" "${WT_HEAD:?}" "${TEST_FILES:?}" "${TEST_CMD:?}" "${PACK:?}"
[ -d "$WT_BASE" ] && [ -d "$WT_HEAD" ] || { echo "STOP: worktree 不存在"; exit 2; }
[ -s "$TEST_FILES" ] || { echo "NO-TESTS: PR 不含测试文件，反验无对象"; exit 2; }

REPORT="$PACK/revert-check.out"
: > "$REPORT"
COPIED=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  if git -C "$ROOT" cat-file -e "${HEAD_OID}:${t}" 2>/dev/null; then
    mkdir -p "$WT_BASE/$(dirname "$t")"
    git -C "$ROOT" show "${HEAD_OID}:${t}" > "$WT_BASE/$t" || { echo "STOP: 写入 $t 失败"; exit 2; }
    COPIED=$((COPIED + 1))
    echo "copied: $t" >> "$REPORT"
  else
    echo "deleted-in-head (skipped): $t" >> "$REPORT"
  fi
done < "$TEST_FILES"
[ "$COPIED" -gt 0 ] || { echo "NO-TESTS: head 侧无可放入的测试文件"; exit 2; }

echo "== base + head tests ==" >> "$REPORT"
( cd "$WT_BASE" && eval "$TEST_CMD" ) >> "$REPORT" 2>&1; BASE_EXIT=$?
echo "BASE_EXIT=$BASE_EXIT" >> "$REPORT"
echo "== head ==" >> "$REPORT"
( cd "$WT_HEAD" && eval "$TEST_CMD" ) >> "$REPORT" 2>&1; HEAD_EXIT=$?
echo "HEAD_EXIT=$HEAD_EXIT" >> "$REPORT"

printf 'copied=%s base+head-tests exit=%s / head exit=%s\n' "$COPIED" "$BASE_EXIT" "$HEAD_EXIT"
if [ "$BASE_EXIT" -ne 0 ] && [ "$HEAD_EXIT" -eq 0 ]; then
  echo "PASS: 测试在 base 上红、在 head 上绿"
  exit 0
fi
[ "$HEAD_EXIT" -eq 0 ] || echo "FAIL: head 自身测试不通过（先核对 TEST_CMD 是 CI 真实命令：运行器/模块解析/编译错误不是测试红，见 $REPORT）"
[ "$BASE_EXIT" -ne 0 ] || echo "BASELINE-GREEN: base 上 head 测试通过，按 references/revert-check.md 三分支定论"
exit 1

# 各门重跑口径

每轮推送后哪一门必须重跑、按什么机器判据决定、什么算口径漂移。

> 由 SKILL.md 的 Phase 4「各门重跑口径」引用。

## 本文小节

- [本文件的执行前提](#本文件的执行前提)
- [Correctness：每轮必跑，但不重新调用 pr-audit](#Correctness：每轮必跑，但不重新调用-pr-audit)
- [三层复验](#三层复验)
- [L2 影响面搜索（含降级守卫）](#L2-影响面搜索（含降级守卫）)
- [CI 等待](#CI-等待)
- [Security：四项机器判据](#Security：四项机器判据)
- [Requirements 与 Acceptance](#Requirements-与-Acceptance)
- [证据裁剪](#证据裁剪)

「相关」「触及」这类主观词一律替换为下文的机器判据。判据无法执行 → 该门 `BLOCKED`，不是沿用。

## 本文件的执行前提

本文件的片段依赖 SKILL.md「执行期约定：参数固化」写下的 env 文件，且**不使用 `set -e`**——
它要靠 `( cd "$WT" && <cmd> ); EXIT=$?` 取回退出码，而 `set -e` 会在 `<cmd>` 处直接中止，
根本走不到 `EXIT=$?`（已实测：`set -e` 下该行整段退出，`EXIT` 从不被赋值；只有把那一行放进
`set +e` … `set -e` 窗口，或像本 Skill 这样全程不开 `-e`，才能拿到非零码）。
因此每个片段首行 source **字面路径**（`. "$ENVFILE"` 在新 shell 里等于 `. ""`）+ 断言用到的每个变量，
每个闸门写成 `cmd || { echo "STOP: ..."; exit 1; }`：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${ROUND_OID:?}" "${CI_TIMEOUT_MIN:?}"
```

## Correctness：每轮必跑，但不重新调用 pr-audit

**禁止在修复轮里再次 `invoke_skill pr-audit`。** 它会建立/复用自己的
`<repo>-pr-<N>-audit` worktree，而那个 worktree 停在第 1 轮的 oid：

- 复用 → 在**修复前**的代码上跑测试，结论与当前 head 无关；
- 不复用 → 命中它自己的「worktree 路径已存在」停止条件，整轮卡死。

正确做法：在**验收 worktree** 内，重放第 1 轮从 `pr-audit` 记录下来的**那份命令清单**。

清单会被 `eval`，所以它自身必须先过闸门。硬要求：**一行一条完整命令，禁止续行**；
第 1 轮固化后取 `sha256sum` 指纹，此后每轮先验指纹再执行；清单内容在第 1 轮**完整展示给用户一次**
（要 `eval` 的文本，用户有权先看到）。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}"
CMDS="/tmp/pi-correctness-cmds-pr-${PR}.txt"     # 第 1 轮固化，此后只读
[ -s "$CMDS" ] || { echo "STOP: 首轮命令清单缺失，无法保证口径一致"; exit 1; }
HIT=$(grep -nE '\\$' "$CMDS" || true)
[ -z "$HIT" ] || { printf 'STOP: 命令清单含续行，eval 会把一条命令截成两条：\n%s\n' "$HIT"; exit 1; }
# —— 仅第 1 轮：展示 + 固化指纹 ——
cat -n "$CMDS"
sha256sum "$CMDS" > "${CMDS}.sha256"
# —— 每轮：验指纹后重放 ——
sha256sum -c "${CMDS}.sha256" || { echo "STOP: 命令清单指纹漂移，口径已被改动"; exit 1; }
while IFS= read -r cmd; do
  [ -n "$cmd" ] || continue
  case "$cmd" in \#*) continue ;; esac
  ( cd "$WT" && eval "$cmd" ); C_EXIT=$?
  [ "$C_EXIT" -eq 0 ] || { echo "FAIL: exit=$C_EXIT cmd=$cmd"; exit 1; }
done < "$CMDS"
```

命令集合任何增删改（换 flag、跳过一条、加一条）都是**口径漂移** → 停止询问，不静默调整。
指纹不符时不得「重新固化一份」绕过。

## 三层复验

替代「重跑相关测试」这一主观表述：

| 层 | 范围 | 每轮 |
|---|---|---|
| L1 | 全部**此前已 PASS** 的 AC + 本轮 FAIL 的 AC | 必跑 |
| L2 | 影响面：本轮 diff 的文件 + 对它们的反向依赖搜索（下节） | 必跑 |
| L3 | lint / typecheck / build 全量 | 必跑 |

**最后一轮**追加全量：跑项目 `on: pull_request` CI 所执行的同一套命令。
本地全量套件与 CI 都不可用 → Correctness `BLOCKED`，**不得**判 `PASS`。
报告必须写明最终 Correctness 证据来自**本地全量套件**还是**PR head CI**。

## L2 影响面搜索（含降级守卫）

裸 `grep -rln "$(basename "${f%.*}")" "$WT"` 已实测不可用：对 `src/index.ts` 的一行改动搜出 201 个文件，
其中 200 个在 `node_modules/`；且 `for f in $CHANGED` 会把含空格的路径拆开。改用 `-z` 读取 +
`git grep`（只搜版本控制内的文件，`node_modules`、`vendor`、`.git` 因未被跟踪自动排除）+ **完整词根**匹配：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${ROUND_OID:?}"
CHANGED_N=$(git -C "$WT" diff --name-only "${ROUND_OID}..HEAD" | wc -l)
[ "$CHANGED_N" -gt 0 ] || { echo "STOP: 本轮无改动却进入复验，流程不一致"; exit 1; }
IMPACT="/tmp/pi-impact-pr-${PR}.txt"; : > "$IMPACT"
EXACT="/tmp/pi-impact-exact-pr-${PR}.txt"; : > "$EXACT"
git -C "$WT" diff --name-only -z "${ROUND_OID}..HEAD" | while IFS= read -r -d '' f; do
  STEM="${f%.*}"                                   # 仓库根起算的完整 import 词根，例如 src/index
  git -C "$WT" grep -l -F -e "$STEM" -- . >> "$EXACT" || true
  git -C "$WT" grep -l -F -e "$STEM" -e "/$(basename "$STEM")" -- . >> "$IMPACT" || true
done
sort -u -o "$EXACT" "$EXACT"; sort -u -o "$IMPACT" "$IMPACT"
HITS=$(wc -l < "$IMPACT")
# 降级守卫：命中数超过本轮改动文件数的 20 倍即判定搜索退化（词根撞名），不得据此扩张 L2。
# 它与上面的搜索**必须在同一次 bash 调用里**：HITS / CHANGED_N / EXACT 不跨调用，
# 拆成两个围栏时它们全是空串，`[ "" -le 0 ]` 直接语法错，守卫等于不存在。
[ "$HITS" -le $(( CHANGED_N * 20 )) ] || {
  printf 'DEGRADED: L2 搜索退化（改动 %s 文件 → 命中 %s 文件），降级为同目录测试 + 精确 import 命中\n' \
    "$CHANGED_N" "$HITS"
  echo "降级集合 = $EXACT ∪ 改动文件所在目录下的既有测试"
}
```

- 匹配的是**完整词根**（`src/index`）和带路径分隔符的相对形式（`/index`），**不是裸 basename**——
  裸 `index`、`utils`、`config` 会命中整仓库的散文和同名标识符。
- 仓库把 `vendor/` 之类第三方目录纳入版本控制时，追加 pathspec 排除：`-- . ':(exclude)vendor/**'`。

降级后的 L2 集合 = `$EXACT`（精确 import 路径命中）∪ 改动文件**同目录**下的既有测试。
降级这件事必须写进报告的未验证项，写明命中数、改动文件数与降级后的实际集合，**不得**默认按全量命中处理。

未降级时，反向依赖搜索命中的文件，其既有测试进入 L2 必跑集合。

## CI 等待

`gh pr checks`（已在 gh 2.83.2 上核实）**没有超时 flag**，`--watch` 会一直阻塞到 checks 落定——
所以「45 分钟上限」只能由 `timeout` 提供。**`timeout 0` 不是「立刻超时」而是「永不超时」**（已实测）——
`CI_TIMEOUT_MIN` 空或 0 时 `$(( CI_TIMEOUT_MIN * 60 ))` 算出 0，等待将无限阻塞，正是本节要防的那件事，
所以断言行不可省。同时**退出码不能当判据**：

- `exit 0` **不等于全绿**：gh 把 `skipping` 算作非失败，全部 skip 的 run 也退 0。
  这与 `pr-audit` §1.3「pending/cancelled/skipped 不算 PASS」直接冲突，而本 Skill 声明继承该条。
- 「一个 check 都没有」时 gh 直接报错退非零，与「CI 失败」无法从退出码区分。
- 因此**禁用 `--fail-fast`**：它在第一个失败处退出，其余 check 的状态永远拿不到，无法据此定论整轮。

判据一律取自 `bucket` 明细（gh 把 `state` 归入 `pass` / `fail` / `pending` / `skipping` / `cancel`）：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${CI_TIMEOUT_MIN:?}"
[ "$CI_TIMEOUT_MIN" -ge 1 ] 2>/dev/null \
  || { echo "STOP: CI_TIMEOUT_MIN 非正整数，timeout 0 等于无上限，拒绝进入等待"; exit 1; }
ci_buckets() {
  gh pr checks "$PR" --json name,bucket,state \
    --jq 'group_by(.bucket)|map({bucket:.[0].bucket,count:length,names:map(.name)})' 2>/dev/null || true
}
sleep 30                                            # 给 GitHub 建 check run 的时间
DETAIL=$(ci_buckets)                                # 探测：无 check 时为空
WAIT_EXIT=0
if [ -n "$DETAIL" ] && [ "$DETAIL" != "[]" ]; then
  timeout "$(( CI_TIMEOUT_MIN * 60 ))" gh pr checks "$PR" --watch --interval 30 >/dev/null 2>&1
  WAIT_EXIT=$?                                      # 124 = 被 timeout 杀掉；其余退出码不作判据
  DETAIL=$(ci_buckets)
fi
REQ_SKIPPED=$(gh pr checks "$PR" --required --json name,bucket \
  --jq '.[]|select(.bucket=="skipping")|.name' 2>/dev/null || true)
WF=$(ls "$WT/.github/workflows/" 2>/dev/null | head -1)
PR_WF=$(grep -rl "pull_request" "$WT/.github/workflows/" 2>/dev/null || true)
printf 'wait_exit=%s\nrequired_skipped=%s\n%s\n' "$WAIT_EXIT" "${REQ_SKIPPED:-无}" "$DETAIL"
```

| 观察 | 判定 |
|---|---|
| `DETAIL` 为空或 `[]`，且 `$PR_WF` 非空（存在 `on: pull_request` 工作流） | CI 未被触发 → Correctness `BLOCKED` |
| `DETAIL` 为空或 `[]`，且确实没有 CI 配置（`$WF` 也为空） | 记限制项「无 CI 覆盖」，**评级上限 A**，不判 FAIL |
| `WAIT_EXIT` = 124 | 等待超过 `--ci-timeout` → `BLOCKED`，输出续跑指引（PR 号、审计分支、已推 oid、剩余待落定 check 名） |
| bucket 含 `fail` 或 `cancel` | 本轮 Correctness `FAIL`，回到缺口说明，不进入下一轮推送 |
| bucket 含 `pending` | **未落定**：继续等待或按超时处理，**任何情况下不判 PASS** |
| bucket 只有 `pass` 与 `skipping`，且 `$REQ_SKIPPED` 为空 | CI 证据成立 |
| `$REQ_SKIPPED` 非空（必需 check 被跳过） | `BLOCKED`——必需 check 没跑，等于没有证据 |

超时后**不得**用本地测试替代 PR head CI 结论。
`ci_buckets` 的 JSON 明细必须**原样**贴进报告的四门状态表证据列（含 `wait_exit` 与 `required_skipped`），
不允许只写一句「CI 全绿」。

## Security：四项机器判据

对**本轮 diff** 跑以下四项，任何一项有命中即 Security 全量重跑。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${ROUND_OID:?}"
D="${ROUND_OID}..HEAD"
# 1) 路径面
git -C "$WT" diff --name-only "$D" | grep -Ei \
 'auth|session|token|permission|crypto|middleware|cors|csrf|upload|webhook|migrat|Dockerfile|\.github/workflows/|\.env|terraform|helm'
# 2) 依赖清单与 lockfile
git -C "$WT" diff --name-only "$D" | grep -Ei \
 '(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|requirements.*\.txt|poetry\.lock|Gemfile(\.lock)?|composer\.(json|lock))$'
# 3) 新增行里的危险构造
git -C "$WT" diff -U0 "$D" | grep -E '^\+' | grep -Ei \
 'exec\(|spawn|eval\(|child_process|subprocess|os\.system|pickle|yaml\.load|innerHTML|dangerouslySetInnerHTML|raw\(|execute\(|\$where|redirect|\.\./|chmod'
# 4) 被删掉的安全检查
git -C "$WT" diff -U0 "$D" | grep -E '^-' | grep -Ei \
 'verify|validate|sanitiz|escape|authoriz|assert|check_|guard'
```

四项全空 → 可沿用上一轮 Security 结论，报告写明「四项机器判据均无命中」并注明沿用自第 N 轮。
任一项有命中 → 全量重跑 Security 门。

`grep` 输出必须原样贴进报告。**「本轮改动不涉及安全」不是可接受的表述**，
必须由四条命令的实际输出（含空输出）支撑。判据 (4) 单列的理由：放宽的校验通常藏在删除行里。

## Requirements 与 Acceptance

- **Requirements**：需求口径未变则沿用，但**每轮**都要确认本轮修复没有引入超出 Issue 范围的改动
  （比对本轮 diff 与 `$DECLARED_FILES`，见 write-safety.md 的暂存期机器闸门）。
- **Acceptance**：每轮**全部 AC** 重跑，不允许只跑上轮失败的那几条。

## 证据裁剪

每条 AC 的运行输出重定向到文件，报告只留摘要：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${ROUND:?}"
AC_N=3        # 当前这条 AC 的编号，**每条 AC 前现场改**；不要写进 $ENVFILE，它不是跨调用的固化参数
LOG="/tmp/pi-ac-${AC_N}-r${ROUND}-pr-${PR}.log"
( cd "$WT" && <AC 验证命令> ) > "$LOG" 2>&1; AC_EXIT=$?
grep -nEi 'assert|expect|FAIL|Error|✗|✓|passed|failed' "$LOG" | head -20
tail -40 "$LOG"
echo "AC=$AC_N exit=$AC_EXIT log=$LOG"
```

`AC_N` 必须逐条赋值：写成没有来源的 `${N}` 时它恒为空，每条 AC 都写进同一个
`/tmp/pi-ac--r<轮次>-pr-<N>.log`，后一条覆盖前一条，而报告模板要求逐条给出日志路径与证据。
同理 `ROUND` 每轮必须加一（见 SKILL.md §执行期约定），否则跨轮再撞一次。

报告里每条 AC 只保留：命令、退出码、断言/失败行、末尾 40 行上下文、日志路径。
完整日志留在磁盘，不粘贴进 Linear。

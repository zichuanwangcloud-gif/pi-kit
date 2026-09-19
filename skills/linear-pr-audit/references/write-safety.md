# 可写性、推送目标与隔离

判定能不能推、推到哪里、临时测试落在哪里，以及审计者自审自评的隔离规则。

> 由 SKILL.md 的 Phase 1、Phase 3.4、Phase 4 引用。

## 本文小节

- [本文件的执行前提](#本文件的执行前提)
- [推送目标解析](#推送目标解析)
- [可写性判据（机器化，不按分支名猜）](#可写性判据（机器化，不按分支名猜）)
- [worktree 建立](#worktree-建立)
- [临时测试隔离](#临时测试隔离)
- [暂存期机器闸门](#暂存期机器闸门)
- [推送与推送后的主工作区落后检查](#推送与推送后的主工作区落后检查)
- [自审隔离](#自审隔离)

## 本文件的执行前提

所有片段依赖 SKILL.md「执行期约定：参数固化」写下的 env 文件，且**不使用 `set -e`**。
每个片段首行 source **字面路径**（`ENVFILE` 只存在于该文件内部，`. "$ENVFILE"` 在新 shell 里是
`. ""`，什么都不 source）+ **按阶段**断言（只断言这一步之前已固化的变量）。
`: "${VAR:?}"` 是这里**唯一**替代 `set -u` 的机制：漏掉它，空变量会被拼进 `gh api` 的 URL 或 refspec，
命令带着 `2>/dev/null` 静默失败，判据于是读成「没有保护」「没有命中」。闸门一律
`cmd || { echo "STOP: ..."; exit 1; }`：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}" "${OUT:?}"          # 下节起额外加 HEAD_OID / HEAD_REF / PUSH_REMOTE
```

裸 `test ! -e "$WT"` 单独一行不会中止流程——非零退出码在非 `set -e` 的执行环境里被忽略。
`cmd && { echo "STOP"; exit 1; }` 只在命中时中止，不命中时返回非零但不中止，所以「必须无命中」的判据
一律先收进变量再判空：`HIT=$(cmd || true); [ -z "$HIT" ] || { echo "STOP: ..."; exit 1; }`。

## 推送目标解析

修复必须进 **head 仓库的 head 分支**。`origin` 通常是 base 仓库，fork PR 推 `origin` 会推错仓库。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${PR:?}" "${OUT:?}" "${ENVFILE:?}"
HEAD_NWO=$(gh pr view "$PR" --json headRepository,headRepositoryOwner \
  --jq '.headRepositoryOwner.login + "/" + .headRepository.name') || { echo "STOP: head 仓库解析失败"; exit 1; }
BASE_NWO=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || { echo "STOP: base 仓库解析失败"; exit 1; }
HEAD_REF=$(jq -r .headRefName "$OUT"); HEAD_OID=$(jq -r .headRefOid "$OUT"); BASE_OID=$(jq -r .baseRefOid "$OUT")
[ -n "$HEAD_NWO" ] && [ -n "$BASE_NWO" ] && [ -n "$HEAD_REF" ] && [ -n "$HEAD_OID" ] && [ -n "$BASE_OID" ] \
  || { echo "STOP: 推送目标或冻结 oid 为空"; exit 1; }
if [ "$HEAD_NWO" = "$BASE_NWO" ]; then PUSH_REMOTE=origin
else PUSH_REMOTE=$(gh repo view "$HEAD_NWO" --json sshUrl --jq .sshUrl) || { echo "STOP: fork URL 解析失败"; exit 1; }
fi
cat >> "$ENVFILE" <<EOF
export HEAD_NWO='$HEAD_NWO' BASE_NWO='$BASE_NWO' HEAD_REF='$HEAD_REF' PUSH_REMOTE='$PUSH_REMOTE'
export HEAD_OID='$HEAD_OID' BASE_OID='$BASE_OID'
EOF
printf 'HEAD_OID=%s BASE_OID=%s PUSH_REMOTE=%s HEAD_REF=%s\n' "$HEAD_OID" "$BASE_OID" "$PUSH_REMOTE" "$HEAD_REF"
```

| 条件 | `PUSH_REMOTE` |
|---|---|
| `HEAD_NWO` = `BASE_NWO` | `origin` |
| `HEAD_NWO` ≠ `BASE_NWO`（fork PR） | fork 的 URL（`sshUrl`），作为临时 remote 显式登记进写操作清单 |

`HEAD_NWO`、`BASE_NWO`、`HEAD_REF`、`PUSH_REMOTE` 是推送命令两个参数的来源，缺一即推送目标不确定，
所以解析出来就**立刻**追加进 `$ENVFILE`，不靠上一次 `bash` 调用的内存。

head 分支不在 `origin` 上时（fork），用 PR ref 抓取对象，不要指望同名本地分支：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}" "${HEAD_OID:?}"
git -C "$ROOT" fetch origin "+refs/pull/${PR}/head:refs/remotes/pi-head/pr-${PR}" \
  || { echo "STOP: 无法抓取 PR head ref"; exit 1; }
[ "$(git -C "$ROOT" rev-parse "refs/remotes/pi-head/pr-${PR}")" = "$HEAD_OID" ] \
  || { echo "STOP: 抓到的 ref 与冻结 oid 不一致"; exit 1; }
```

新登记的临时 remote 与新建的 `refs/remotes/pi-head/*` 都要进写操作清单，附还原命令
（`git remote remove <name>`、`git update-ref -d <ref>`）——隔离指纹不覆盖它们。

## 可写性判据（机器化，不按分支名猜）

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${PR:?}" "${HEAD_NWO:?}" "${HEAD_REF:?}"    # 断言不可省，见下方警告
gh api "repos/$HEAD_NWO" --jq .permissions.push        # 必须为 true
gh pr view "$PR" --json maintainerCanModify --jq .maintainerCanModify   # fork 必须为 true
gh api "repos/$HEAD_NWO/branches/$HEAD_REF/protection" >/dev/null 2>&1 && echo protected
gh api "repos/$HEAD_NWO/rules/branches/$HEAD_REF" --jq 'length'         # >0 即受规则集约束
gh repo view "$HEAD_NWO" --json defaultBranchRef --jq .defaultBranchRef.name
```

**第一行的断言是这段的安全前提。** `HEAD_NWO`/`HEAD_REF` 为空时第 3 行会去请求
`repos//branches//protection`，gh 报错、错误被 `2>/dev/null` 吞掉、`&&` 不成立、什么都不打印——
结果与「该分支没有保护规则」**完全一样**，于是判成可写并推上去。`dismiss_stale_reviews` 那条查询
（见 §自审隔离）是同一个形状。空变量在这里不是报错，是**误判**。

| 判据 | 结果 |
|---|---|
| `.permissions.push` 非 true | 不可写 |
| fork PR 且 `maintainerCanModify` 非 true | 不可写 |
| `branches/<head>/protection` 命中，或 `rules/branches/<head>` 非空 | 受保护，不可写 |
| `<head>` 等于 **head 仓库的**默认分支 | 受保护，不可写 |
| 以上全不命中 | 候选可写，仍需 dry-run 复核 |

**不要用分支名匹配 `main`/`master` 判受保护。** fork PR 的 head 分支名字面上经常就是 `main`，
那是贡献者自己 fork 里的 `main`，完全可推；反之 base 仓库里一个叫 `feat/x` 的分支可能被规则集锁死。
受保护与否由 API 判据决定，与名字无关。要比较的是 **head 仓库**的默认分支，不是 base 仓库的。

`git push --dry-run` 是唯一可信的最终判据——组织级 fork 限制会让 `maintainerCanModify` 静默失真：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PUSH_REMOTE:?}" "${HEAD_REF:?}" "${HEAD_OID:?}"
git -C "$ROOT" push --dry-run "$PUSH_REMOTE" "$HEAD_OID:refs/heads/$HEAD_REF" \
  || { echo "STOP: dry-run 失败，按不可写降级为只读 patch 输出"; exit 1; }
```

## worktree 建立

**不要把 `headRefName` 当作 worktree 的分支名。** `git worktree add "$WT" "<branch>"` 在该分支已被
任何工作树 checkout 时直接失败：`fatal: '<branch>' is already checked out at ...`。
改为建一个仅供审计的本地分支，指向冻结 oid，推送时用显式 refspec 映射回 head 分支。

`git show-ref --verify --quiet refs/heads/pi-acceptance/pr-1` **查不出目录/文件型 ref 冲突**：
已实测，扁平分支 `pi-acceptance` 存在时该判据照样通过（退出 1，即「不存在」），
随后 `git worktree add -b` 以 `cannot lock ref 'refs/heads/pi-acceptance/pr-1': 'refs/heads/pi-acceptance' exists`
失败（退出 255）。因此必须额外枚举命名空间冲突：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}" "${HEAD_OID:?}" "${ENVFILE:?}"
WT="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-acceptance"
AUDIT_BRANCH="pi-acceptance/pr-${PR}"
[ ! -e "$WT" ] || { echo "STOP: worktree 路径已存在，归属不明，询问用户"; exit 1; }
# 闸门写成「先收进变量再判空」，不写 `show-ref --quiet && { ...; exit 1; }`：
# 后者只在命中时中止，不命中时整行返回非零却继续，正是本文件开头禁止的形状。
HIT=$(git -C "$ROOT" show-ref --verify "refs/heads/$AUDIT_BRANCH" 2>/dev/null || true)
[ -z "$HIT" ] || { echo "STOP: 审计分支已存在，询问用户"; exit 1; }
CONFLICT=$(git -C "$ROOT" for-each-ref --format='%(refname)' 'refs/heads/**' \
  | grep -E "^refs/heads/pi-acceptance$|^refs/heads/${AUDIT_BRANCH}/" || true)
[ -z "$CONFLICT" ] \
  || { printf 'STOP: 与审计分支名冲突的既有 ref：\n%s\n询问用户改名，不要删除他人 ref\n' "$CONFLICT"; exit 1; }
git -C "$ROOT" cat-file -e "${HEAD_OID}^{commit}" || { echo "STOP: 冻结 oid 不可达"; exit 1; }
git -C "$ROOT" worktree add -b "$AUDIT_BRANCH" "$WT" "$HEAD_OID" || { echo "STOP: worktree 建立失败"; exit 1; }
[ "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_OID" ] || { echo "STOP: worktree HEAD 与冻结 oid 不一致"; exit 1; }
TMP_TEST_DIR="/tmp/pi-acceptance-pr-${PR}"; mkdir -p "$TMP_TEST_DIR"
DECLARED_FILES="/tmp/pi-declared-files-pr-${PR}.txt"
printf '%s\n' <3.3 闸门里逐条声明的实现文件...> > "$DECLARED_FILES"     # 一行一个仓库相对路径
cat >> "$ENVFILE" <<EOF
export WT='$WT' AUDIT_BRANCH='$AUDIT_BRANCH' TMP_TEST_DIR='$TMP_TEST_DIR'
export DECLARED_FILES='$DECLARED_FILES' ROUND_OID='$HEAD_OID'
EOF
printf 'WT=%s ROUND_OID=%s\n' "$WT" "$HEAD_OID"
```

冲突命中时**不得**删除、改写或 `git branch -D` 任何既有 ref——那可能是别人的工作分支。
只能请用户换名（例如 `pi-acceptance-pr-<N>`），或由用户自行清理后重跑。

## 临时测试隔离

已实测确认的事实，不要再试一遍：

- 在 linked worktree 里 `$(git rev-parse --git-dir)/info/` **不存在**，
  `echo x >> "$(git rev-parse --git-dir)/info/exclude"` 直接失败。
- 即使先 `mkdir -p`，git **也不读取** linked worktree 私有的 `info/exclude`。
- 只有 `$(git rev-parse --git-common-dir)/info/exclude` 生效——那是**主仓库**的文件，
  写进去会污染主工作区。**禁止写入 `$GIT_COMMON_DIR/info/exclude`。**

策略：

1. **首选**把临时验收测试写在仓库外 `TMP_TEST_DIR`（上节已建立并写入 `$ENVFILE`），
   用测试框架的 rootDir / testMatch / 路径参数指过去（`--rootDir`、`-c`、`pytest <path>`、`go test <dir>`）。
2. 框架强制要求测试位于树内时，才落在 `$WT/.acceptance-tmp/`。此时**不依赖任何 ignore 机制**，
   改用下节的暂存期机器闸门兜底。
3. ~~`git config --worktree core.excludesFile <path>`~~ —— **禁止使用**。已核实：它必须先打开仓库级
   `extensions.worktreeConfig`，而那一项写进**共享**的 `.git/config`；唯一有文档的清理动作
   `git config --worktree --unset core.excludesFile` **不会**移除该 extension，它会永久留在仓库配置里，
   且隔离基线指纹（只看工作树文件状态）对此完全无感。树内落点的兜底只有第 2 条的暂存期机器闸门。

**临时验收测试不提交。**

## 暂存期机器闸门

失败即停止，不接受人工目视核对。`DECLARED_FILES` 是**文件路径**（每行一个已声明实现文件），
不是 bash 数组——数组无法 `export`，跨 `bash` 调用必丢。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${DECLARED_FILES:?}" "${ROUND_OID:?}"
git -C "$WT" add -- <仅本轮实现文件...>   # 禁止 git add -A / git add . / git add -u；禁止 git commit -a
STAGED=$(git -C "$WT" diff --cached --name-only)
# 空暂存区会让下面每一条「必须无命中」的判据都通过：忘了 add 看起来和干净通过一模一样。
[ -n "$STAGED" ] || { echo "STOP: 暂存区为空，本轮无改动可推"; exit 1; }
HIT=$(printf '%s\n' "$STAGED" | grep -E '(^|/)\.acceptance-tmp/' || true)
[ -z "$HIT" ] || { printf 'STOP: 暂存区含临时验收测试：\n%s\n' "$HIT"; exit 1; }
HIT=$(printf '%s\n' "$STAGED" | grep -E '(^|/)(tests?|spec|__tests__)/|[._-](test|spec)\.[a-z]+$|_test\.go$' || true)
[ -z "$HIT" ] || { printf 'STOP: 暂存区含既有测试文件，禁止改测试让验收通过：\n%s\n' "$HIT"; exit 1; }
OUTSIDE=$(comm -23 <(printf '%s\n' "$STAGED" | sort -u) <(sort -u "$DECLARED_FILES"))
[ -z "$OUTSIDE" ] \
  || { printf 'STOP: 修复超出 PR 范围，以下文件不在 DECLARED_FILES：\n%s\n' "$OUTSIDE"; exit 1; }
LINES=$(git -C "$WT" diff --cached --numstat | awk '{a+=$1+0; d+=$2+0} END {print a+d+0}')
[ "$LINES" -le 80 ] \
  || { echo "STOP: 修复超出 PR 范围：本轮增删共 $LINES 行 > 80 行上限"; exit 1; }
git -C "$WT" diff --cached          # 完整展示给用户
```

`comm -23` 与 80 行上限是「**最小改动**」这个主观词的机器等价物：暂存集合必须是 `DECLARED_FILES`
的子集，且本轮增删行数合计不超过 80。任何一条不成立即按「修复超出 PR 范围」停止询问，
**不得**靠改写 `DECLARED_FILES` 让闸门通过——扩张已声明清单需要回到闸门重新授权。

## 推送与推送后的主工作区落后检查

推送只允许这一种写法，禁止无 refspec 的 `git push`、禁止 `--force`/`--force-with-lease`：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PUSH_REMOTE:?}" "${HEAD_REF:?}"
git -C "$WT" push "$PUSH_REMOTE" "HEAD:refs/heads/$HEAD_REF" \
  || { echo "STOP: push 失败，保留 worktree/分支/commit 并如实报告"; exit 1; }
```

推送成功后**必须**检查主工作区是否被落在远端后面。默认入口正是「用户站在 head 分支上」，
本 Skill 一推，用户的本地分支就落后于远端，他下一次 `git push` 会被非快进拒绝——
这恰好是最容易伸手去按 `--force` 的时刻，而本 Skill 整篇都在禁止 force push。隔离基线指纹
（`status --porcelain | sha256sum`）**看不到**这件事，所以只能显式检查并显式告知：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PUSH_REMOTE:?}" "${HEAD_REF:?}"
CUR=$(git -C "$ROOT" branch --show-current)
if [ "$CUR" = "$HEAD_REF" ]; then
  git -C "$ROOT" fetch "$PUSH_REMOTE" "$HEAD_REF" || { echo "STOP: fetch 失败，无法判定本地是否落后"; exit 1; }
  # PUSH_REMOTE 是具名 remote 时等价于 "HEAD..$PUSH_REMOTE/$HEAD_REF"；
  # fork 场景下 PUSH_REMOTE 是 URL，没有远端跟踪 ref，只能用刚 fetch 到的 FETCH_HEAD。
  BEHIND=$(git -C "$ROOT" rev-list --count "HEAD..FETCH_HEAD")
  [ "$BEHIND" -eq 0 ] || printf '⚠ 主工作区分支 %s 已落后远端 %s 个 commit（本次审计推送所致）。\n请执行 git pull --ff-only；**不要**用 git push --force / --force-with-lease。\n' \
    "$CUR" "$BEHIND"
fi
```

该警告与 `BEHIND` 数值必须写进报告的**写操作清单**（还原动作：`git -C <主工作区> pull --ff-only`），
即使指纹比对一致也要单列——指纹只覆盖工作树文件状态。

## 自审隔离

本 Skill 会推送自己写的代码，然后给自己的代码打分。硬规则：

- 本轮推送过任何 commit → 评级上限 **A**，结论行追加 `（含审计者修复，需人工复核）`。
- 每次推送后必须在 **PR** 上留披露评论。这是唯一允许的 PR 写操作；
  禁止 review / approve / request-changes / ready / merge / 改 title/body/base。
  理由：reviewer 看 PR，不看 Linear。
- 推送前检查 stale review 处置：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${PR:?}" "${HEAD_NWO:?}" "${HEAD_REF:?}"    # 空变量会让下一行静默读成「无保护规则」
gh api "repos/$HEAD_NWO/branches/$HEAD_REF/protection" \
  --jq '.required_pull_request_reviews.dismiss_stale_reviews' 2>/dev/null
gh pr view "$PR" --json reviewDecision --jq .reviewDecision
```

`dismiss_stale_reviews` 为 false 且 `reviewDecision` 为 `APPROVED` → 新 commit 会顶着既有 approval 混进去，
**停止并询问**，不要自行推送。

### PR 披露评论模板

披露评论用**自己的命名空间**，与 Linear 自测报告的标记分开——两者发在不同系统、职责不同，
共用一个前缀会让查重互相误命中：

```markdown
<!-- pi-kit:linear-pr-audit:disclosure:PR-<N>:<推送后 head oid 前 12 位> -->
### 🤖 审计者推送的修复（linear-pr-audit）

本 PR 的以下 commit 由验收审计自动生成，**未经独立人工评审**，请 reviewer 重点复核。

| commit | 改动说明 | 对应验收标准 |
|---|---|---|
| `<sha>` | <改动说明，含对应 AC/R 编号> | AC<n>：<验收标准原文摘要> |

- 冻结 head（本轮前）：`<oid>` → 推送后 head：`<oid>`
- 完整验收结论见 Linear <ISSUE> 评论区
- 审计者仅修改实现文件，未修改或删除既有测试，未提交临时验收测试
```

`gh pr comment "$PR" --body-file <file>` 发送；发送失败即停止，不要改用 review 接口绕过。

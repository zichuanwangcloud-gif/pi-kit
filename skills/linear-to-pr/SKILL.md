---
name: linear-to-pr
description: 把一个 Linear Issue 实现成 Pull Request：读完需求与全部评论后先与用户确认理解，再在隔离 worktree 中实现、验证并创建 PR。用于“按 Linear 开发”“Issue to PR”“issue 转 PR”“实现 TEAM-123”“拿 ENG-42 开工”“把这个需求做成 PR”“照这个 Issue 改代码”等请求，以及用户给出 Linear identifier 并要求开始开发的场景。
compatibility: Requires git, Node.js 18+, authenticated gh CLI, and LINEAR_API_KEY or ~/.config/pi/linear-api-key. The target repository must have an origin remote and an identifiable PR base branch. Non-GitHub hosts degrade to commit+push only.
allowed-tools: read bash edit write invoke_skill
metadata:
  category: issue-to-pr
  portability: project-agnostic
---

# Linear to PR：从 Issue 到 Pull Request

```text
预检 → 读取需求 → 形态/状态闸门 → 分层审阅评论/文档 → 定位代码 → 理解闸门 → 用户确认一次
→ 断点检测 → 建 worktree → 环境引导 → 实现与逐包验证 → 提交并推送任务分支 → 创建 PR → 隔离校验
```

详细流程分置于 `references/`：`requirement-reading.md`（抓取校验/评论分层/来源分类）、
`git-conventions.md`（base/栈式/平台分支规则）、`worktree-setup.md`（环境引导）、
`verification.md`（验证策略）、`pr-output.md`（PR/commit 产出）、`recovery.md`（失败与恢复）。

## 输入与可变参数

- 完整 identifier：`ENG-123`、`APP-42`；裸数字或 `#数字` 仅当 `LINEAR_TEAM_KEY` 已配置，或用户在同一请求中明确 team key
- `--base <branch>` 指定 PR base；`--worktree-root <path>` 指定 worktree 根目录
- `--dry-run` 只产出审阅卡/理解卡/实施计划，不建 worktree、不改代码
- `--no-pr` 做到提交并 push 任务分支为止，不创建 PR

示例：`/skill:linear-to-pr ENG-123 --base develop`、`/skill:linear-to-pr 123 --dry-run`（后者需 `LINEAR_TEAM_KEY`）。

不要假定团队 key、base branch、branch prefix、worktree 根目录、commit scope 或测试命令。出现未知参数、重复冲突开关或多个 identifier 时停止，不猜。

## 项目约定解析顺序

取证优先级、"只读目标仓库内部说明文件"的边界，以及"每个最终采用的约定都要连同证据写进实施计划"
的要求，见 `references/git-conventions.md` §项目约定的取证优先级。**不得**跳过取证直接假定约定。

## 五条硬安全规则

每条都附可执行校验，报告中必须给出校验结果，不接受口头复述。

| # | 规则 | 校验 |
|---|---|---|
| 1 | **绝不推送受保护分支，绝不 force push。** 受保护集合见 2.a | 推送前跑 `test "$(git -C "$WT" branch --show-current)" = "$BR" \|\| { echo "STOP: ..."; exit 1; }`（Step 6 的真实闸门，不是口头核对），且 `$BR` 不在受保护集合内；只允许显式 refspec 推送 |
| 2 | **任务分支必须从已确认的 `origin/<base>` 创建**，不用可能过期的本地分支 | `git -C "$WT" merge-base --is-ancestor "origin/$BASE" HEAD` |
| 3 | **不触碰主工作区的任何改动**，不 reset/clean/stash/覆盖 | Step 0 把 `status --porcelain=v1 \| sha256sum` 与 `HEAD` 固化成 `FP0`/`HEAD0` 写进 `$ENVFILE`，Step 8 用 `[ "$FP1" = "$FP0" ]` 机器比对（跨 `bash` 调用靠肉眼对比两次输出不成立） |
| 4 | **凭据不外泄**。`LINEAR_API_KEY` 只允许发往 `api.linear.app` | key 不出现在命令行、日志、commit、PR body、聊天；临时文件 `umask 077` |
| 5 | **不做未授权的外部动作**：不 merge/approve/ready PR、不回写 Linear、不部署 | 收尾报告逐条列出本次全部写操作 |

其余流程性约束写在各 Step 内。自动化失败时保留 worktree、分支和 commit，报告真实状态，不用更危险的操作兜底。

## 执行期约定：参数固化（强制）

**每次 `bash` 调用都是新 shell，环境变量不跨调用保留。** 依赖上次调用赋的变量会让 `cd "$WT"` 变成
`cd ""`（后续 `edit` 直接改主工作区，隔离归零），`git push -u origin "$BR"` 变成无 refspec 推送。
env 文件**分两阶段写**（`BASE`/`BR`/`WT` 在 Step 2 之前尚未确定），**阶段一必须先于 Step 0 执行**
（Step 0 就要把隔离基线指纹 `FP0`/`HEAD0` 追加进去）。
本节是参数模板的**唯一权威来源**，`references/` 不再重复给模板。

```bash
# 阶段一（Step 0 之前）
set -euo pipefail; umask 077
ISSUE='<TEAM-123>'; ISSUE_LOWER=$(printf '%s' "$ISSUE" | tr 'A-Z' 'a-z')
ROOT=$(git -C . rev-parse --show-toplevel); ENVFILE="/tmp/pi-linear-to-pr-${ISSUE_LOWER}.env"
cat > "$ENVFILE" <<EOF
export ISSUE='$ISSUE'
export ISSUE_LOWER='$ISSUE_LOWER'
export ROOT='$ROOT'
export ENVFILE='$ENVFILE'
export GIT_PAGER=cat GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
EOF
# 阶段二（Step 2.c 用户确认计划后追加）
cat >> "$ENVFILE" <<EOF
export BASE='<confirmed-base>'
export BR='<confirmed-branch>'
export WT='<confirmed-worktree-abs-path>'
EOF
# 现场追加（值在对应 Step 当场算出，由算出它的那次调用负责落盘）
cat >> "$ENVFILE" <<EOF
export FP0='<Step 0 隔离基线指纹>' HEAD0='<Step 0 HEAD>'
export OUT='<Step 1 Issue JSON 路径>' BODY='<Step 7 PR body 文件>'
EOF
```

**上面三段就是 env 文件的完整内容清单**：片段用到的变量都必须出现在其中一段里。

之后每次 `bash` 调用首行 source 并**按阶段断言**（Step 0/1/2.x 只断言阶段一的三个；Step 2.5 起再加
`: "${BASE:?}" "${BR:?}" "${WT:?}"`）：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ISSUE:?}" "${ISSUE_LOWER:?}" "${ROOT:?}"
```

- 所有 git 命令一律 `git -C "$ROOT"` 或 `git -C "$WT"`，禁止裸 `git`，禁止靠 `cd` 保证工作目录。
- 推送只允许 `git -C "$WT" push -u origin "refs/heads/$BR:refs/heads/$BR"`，禁止无 refspec 的 `git push`；
  diff/show/log 一律 `--no-pager`；`gh` 显式传全参数；禁止 `${VAR,,}` 等 bash 4 专有语法。
- **所有闸门一律写成 `cmd || { echo "STOP: ..."; exit 1; }`。** 禁止 `cmd && echo "STOP"` 和
  `cmd || echo "STOP"`——两者命中与不命中**都返回 0**，「STOP」只是一行字符串，流程照常走到 commit/push。
  需要「必须无命中」时先收进变量再判空：`HIT=$(cmd || true); [ -z "$HIT" ] || { echo "STOP: ..."; exit 1; }`。
- 探测与闸门必须区分：探测用 `... && echo yes || echo no`，永不中止；闸门必须能 `exit 1`。
- **取非零退出码的那一行必须用 `set +e` … `set -e` 包住**——`set -e` 会在该行中止，走不到 `EXIT=$?`，
  红色那个退出码会被吞掉；flaky 判定与五态报告都依赖它。
- `ENVFILE` 必须写进它自己：追加片段都是新 shell，不写就是空串，`set -u` 下硬失败。

## Step 0：环境与仓库预检

只检查，不做破坏性处理：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ISSUE:?}" "${ISSUE_LOWER:?}" "${ROOT:?}" "${ENVFILE:?}"
git -C "$ROOT" status --short --branch
FP0=$(git -C "$ROOT" status --porcelain=v1 | sha256sum | cut -d' ' -f1)   # 隔离基线指纹
HEAD0=$(git -C "$ROOT" rev-parse HEAD)
printf "export FP0='%s'\nexport HEAD0='%s'\n" "$FP0" "$HEAD0" >> "$ENVFILE"
printf 'FP0=%s HEAD0=%s\n' "$FP0" "$HEAD0"
git -C "$ROOT" remote -v
git -C "$ROOT" remote get-url origin
git -C "$ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD || true
gh auth status
gh repo view --json nameWithOwner,isFork,parent,defaultBranchRef
node --version
git -C "$ROOT" ls-files | grep -Ei '(^|/)(AGENTS|CLAUDE)\.md$|(^|/)CONTRIBUTING|(^|/)\.github/(PULL_REQUEST_TEMPLATE|CODEOWNERS)'
```

`FP0`/`HEAD0` 必须落进 `$ENVFILE`：Step 8 是另一次 `bash` 调用，靠肉眼比对两次终端输出不算校验。
用 `read` 阅读检索到的说明文件与 PR 模板。

要求：

- 当前目录位于用户想修改的目标仓库；不以仓库名称硬编码判断。
- **托管平台由 `origin` URL 判定，不以 `gh auth status` 成功为准**——它只验证 github.com 凭据，origin 指向 GitLab/Bitbucket/Gitea 时同样返回成功。非 GitHub 或 `gh` 不可用时**在此处停止**，按 `references/recovery.md` 给出降级方案（做到提交+push，PR 文本交用户手工创建）。
- 多个 remote 或托管目标不清时询问；Node.js ≥ 18；主工作区指纹已记录，后续不触碰其改动。

Linear 凭据按顺序读取：`LINEAR_API_KEY` → `LINEAR_API_KEY_FILE` → `~/.config/pi/linear-api-key`。裸数字的默认 team key 只来自 `LINEAR_TEAM_KEY`，未配置就询问用户提供完整 identifier。不要索要用户把 key 直接发进聊天。

## Step 1：读取 Linear Issue

辅助脚本相对于本 Skill：`scripts/fetch-linear-issue.mjs`。输出到私有临时文件，避免终端截断与并发覆盖：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ISSUE:?}" "${ISSUE_LOWER:?}" "${ENVFILE:?}"
OUT=$(umask 077; mktemp "/tmp/${ISSUE_LOWER}-linear.XXXXXX.json")
node "<skill目录>/scripts/fetch-linear-issue.mjs" "$ISSUE" --max-comment-chars 0 > "$OUT"
printf "export OUT='%s'\n" "$OUT" >> "$ENVFILE"; echo "$OUT"
jq -e '.identifier and .fetchMetadata.complete == true
       and .fetchMetadata.truncated == false
       and (.fetchMetadata.commentsOmitted // 0) == 0' "$OUT" >/dev/null \
  || { echo "STOP: 抓取不完整、被截断或有评论被丢弃，重新抓取，不得读残缺文件"; exit 1; }
HIT=$(jq -r '.comments[] | select(.bodyTruncated == true) | "#\(.sequence)"' "$OUT" || true)
[ -z "$HIT" ] || { printf 'STOP: 以下评论正文被截断，需求可能丢失：\n%s\n重新以 --max-comment-chars 0 抓取\n' "$HIT"; exit 1; }
FETCHED=$(jq -r '.fetchMetadata.fetchedAt' "$OUT")
AGE=$(( $(date -u +%s) - $(date -u -d "$FETCHED" +%s) ))
[ "$AGE" -lt 600 ] || { echo "STOP: 快照已 ${AGE}s（>10 分钟），重新抓取"; exit 1; }
printf 'fetchedAt=%s age=%ss\n' "$FETCHED" "$AGE"
```

`--max-comment-chars 0` 不可省：脚本默认 `4000`，超长评论正文会被裁掉，而 `fetchMetadata.truncated`
**只反映分页截断**，查不出正文丢失——正文截断单独标在 `comments[].bodyTruncated`，两个闸门缺一不可。
`OUT` 必须当场写进 `$ENVFILE`。脚本输出字段与抓取失败分类见 `references/requirement-reading.md`。

### Step 1.0：Issue 形态与状态闸门（先于评论审阅）

用 `jq` 读出 `state`/`canceledAt`/`completedAt`/`parent`/`children`/`relations`/`blockedBy`，
按 `references/requirement-reading.md` §Issue 形态与状态闸门 的处置表逐行判定。
命中「已取消 / 已完成 / duplicate / 含子 issue 的 parent / `blockedBy` 非空」任一条即**停止并询问**。
以上都不命中才进入 Step 1.1。

### Step 1.1：评论、附件和文档审阅（硬闸门）

**必须覆盖全部 Linear 评论**：人类评论与含需求信号的评论逐字阅读，机器人评论按类汇总登记。未完成前禁止开工。

`jq` 索引/读取命令、分层规则、阅读顺序与冲突处理见 `references/requirement-reading.md`
§评论分层协议、§阅读顺序与冲突处理。**必须按该协议执行后再产出下卡。** 输出：

```text
【TEAM-N 评论/文档审阅】
评论总数：N（人类 H / bot B）｜已逐字读序号：1-7,9,12-40｜汇总登记：8,10,11(bot)
分页完整性：complete=true
关键时间线：
- [正文][时间] ...
- [评论 #3][作者][时间] ...
文档/原型/附件：
- [已读取|不可读:类型] <标题或 URL> — 与需求的关系
冲突与修订：
- 无；或：旧口径 ... ↔ 新口径 ...，当前依据/待确认项 ...
```

### Step 1.2：文档与附件分类，不可读来源的降级

按来源分类见 `references/requirement-reading.md` §文档与附件来源分类；任何情况下不得凭标题、URL slug 或文件名推断内容。

不可读来源**不直接终止**：正文/评论已有等价口径（期望 + 验收标准 + 落点线索）→ 记为「参考性缺口」可继续；
若该来源**决定实现**（期望或验收标准只存在于其中）→ 一次性结构化索取，不反复追问。
索取模板与三级降级处置见 `references/recovery.md` §不可读需求来源。

用户确认「按正文与评论口径实现」后可继续，但必须在理解卡、PR body「假设」段和收尾报告**三处**同时登记
「<文档> 未核对」。

只要 `fetchMetadata.complete` 为 false、任一评论 `bodyTruncated` 为 true、冲突未解决，
或本节缺口既未补齐也未获用户明确豁免，就不能实施。

## Step 1.5：需求理解闸门

### 1.5.a 定位真实代码路径

机械步骤见 `references/requirement-reading.md` §定位真实代码路径：从真实入口追踪到业务与数据依赖、
排除同名候选、确定 monorepo 落点与 CODEOWNERS，**最低产出三项**（入口、生效实现 `文件:行`、被排除的候选及理由）。

### 1.5.b 输出理解卡

每项附精确来源：`[正文]`、`[评论 #序号/作者/日期]`、`[父 Issue X]`、`[文档/URL]`、`[代码 文件:行]` 或 `[推断]`。

```text
【TEAM-N 理解卡】
现象/动机：                     ... [来源]
复现或触发路径：                ... [来源]
期望：                          ... [来源]
验收标准：                      ... [来源]（须为 EARS 句式，见下）
影响面/受影响 package：         ... [来源|推断]
真实代码落点/调用链：           ... [代码 文件:行]
被排除的候选落点：              ... [理由]
最终需求口径：                  ... [采用依据]
```

**验收标准须为 EARS 句式，并逐项写出六项自检的通过/未通过**——句式与自检表见
`references/requirement-reading.md` §EARS 验收句式与六项自检。**缺口数 = 未通过项数**，不得凭感觉给数。

处理：

- 0 个缺口：回显理解卡和计划，请用户确认。
- 1–2 个缺口：列缺口及带 `[推断]` 的假设，让用户补充或明确同意。
- ≥3 个缺口，或期望/落点主要依赖推断：停止。

用户明确按假设推进时，将假设写入 PR body。

## Step 2：确定 Git 约定与实施计划

### 2.a 确定 base、栈式依赖与平台分支规则

完整判定流程见 `references/git-conventions.md`。必须落地的决策点：

1. **base**：优先显式 `--base`；否则按 项目文档 → `origin/HEAD` → open PR 的 base 分布 取证，
   确认前必须验证候选在远程真实存在。三方证据不一致时**必须询问**（证据摆法见该文件 §确定 base）。
2. **栈式依赖**：1.5.a 或 Step 1.0 发现本次改动依赖尚未合并的代码时，二选一由用户决定
   （`--base <父分支>` 走栈式，或等父 PR 合并），不自行决定。栈式的父分支记为「临时 base」，
   **不**纳入受保护集合，并在 PR body 顶部写明依赖关系。禁止 cherry-pick 父分支 commit 绕过依赖。
3. **平台真实规则**：读 branch ruleset、required status checks、CODEOWNERS，据此确定
   受保护分支集合、分支命名约束（存在强制模式时中性默认失效）、以及 Step 5 必须本地跑的最小集合。
   查不到（权限不足）时记为信息缺口并声明，**不要断言「无保护」**。

### 2.b 确定任务分支和 worktree

- 遵循 2.a 得到的命名约束；Linear 提供的 `branchName` 可作为候选，但仓库强制模式优先。
- 无规则时使用中性安全默认：`feature/<issue-lower>-<slug>` 或 `fix/<issue-lower>-<slug>`；类型不清则询问。
- worktree 默认放在主仓库父目录，名称 `<repo>-<issue-lower>`；`--worktree-root` 可覆盖。落点检查见 `references/worktree-setup.md`（父目录可写、且不得位于另一个 git 仓库内部）。
- 不硬编码任何绝对路径或仓库名称。

### 2.c 实施计划

计划至少包括：base 及证据与受保护分支集合（来源 2.a）；branch 与唯一 worktree 路径；
**受影响包矩阵**（每个被改动 package 一行，列见 `references/git-conventions.md` §受影响包矩阵）；
预计修改文件/职责层；schema/migration、依赖注入、生成文件等特殊步骤；环境引导需求；
Linear 集成副作用披露（见 Step 7）；自动 push/PR 的授权复述。

**禁止占位符**：TBD / 待补充 / 后续完善 / 适当处理 / 完善错误处理 / 处理边界情况 / 参考类似实现 / 同上
一律视为计划未完成，必须换成精确路径（`path:123-145`）、精确命令或明确的接口签名。

改动跨越 ≥2 个 CODEOWNERS owner 组或 ≥2 个独立发布单元时，必须在计划里提出并让用户选择：
单 PR（说明需要多组审批）或拆分为多个 PR（说明拆分边界与顺序）。**不要默认单 PR。**

用户确认前不修改业务代码、不创建 worktree。`--dry-run` 到此结束。

## Step 2.5：断点检测与恢复（重跑必查）

创建任何东西之前，先判断本 Issue 是否已有上次运行的残留。探测命令与完整判定表见 `references/recovery.md`：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${ISSUE:?}" "${BASE:?}" "${BR:?}" "${WT:?}"
git -C "$ROOT" worktree list --porcelain
git -C "$ROOT" worktree prune --dry-run
# 以下两行是探测，不是闸门：命中与否都要继续，交给判定表处置
git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BR" && echo "local-branch: yes" || echo "local-branch: no"
git -C "$ROOT" ls-remote --exit-code --heads origin "$BR" >/dev/null 2>&1 && echo "remote-branch: yes" || echo "remote-branch: no"
gh pr list --head "$BR" --state all --json url,state,baseRefName,headRefName
```

要点：worktree 注册但目录不存在 → prune 后继续；本地分支的 commit 全部属于本 `$ISSUE` → 复用并跳到 Step 5 复验；含无关 commit 或非 `origin/$BASE` 后代 → 停止让用户决定，不自行删除；远程已存在同名分支 → 停止并报告其作者与时间（可能是他人分支）；PR 已存在 → 交由 Step 7 判定。

**确认是本次任务残留时必须恢复，不得要求用户手工清理后从零重跑。**

## Step 3：创建隔离 worktree

阶段二 env 文件已在 Step 2.c 写好（见「执行期约定」），本步只 source：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${BASE:?}" "${BR:?}" "${WT:?}"
git -C "$ROOT" fetch origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
git -C "$ROOT" show-ref --verify --quiet "refs/remotes/origin/$BASE"
test ! -e "$WT" || { echo "STOP: worktree 路径已存在，归属不明"; exit 1; }
git -C "$ROOT" worktree add -b "$BR" "$WT" "origin/$BASE"
git -C "$WT" status --short --branch
git -C "$WT" merge-base --is-ancestor "origin/$BASE" HEAD
```

显式 refspec fetch 是必需的：single-branch / shallow clone 下 `git fetch origin "$BASE"` 不会更新 `refs/remotes/origin/$BASE`，随后的校验会失败并给出误导性错误。

创建后按 `references/worktree-setup.md` 完成环境引导（submodule、gitignore 的本地配置、**锁定模式**依赖安装、codegen）。该节任一步失败都必须标为「环境未就绪」，不得计为「测试失败」。

之后每次工具调用都以 `$WT` 为工作目录，并一律使用 `git -C "$WT"`。

## Step 4：实施

- 阅读目标代码和相邻测试，遵循既有模式。
- 使用 `edit` 精确修改，新文件使用 `write`。
- 不做无关重构、全仓格式化或依赖升级。
- 保持项目实际架构边界和错误/日志/响应约定。
- **migration / 生成代码 / lockfile**：三者各有硬规则与安全路径，见 `references/verification.md` §产出物规则。要点：已发布 migration 只增不改；生成物只能由生成命令产出且提交前须无额外漂移；lockfile 只在确实增删依赖时变更。
- 格式化只覆盖本任务文件，除非项目工具无法缩小范围且用户已知情。

## Step 5：验证

按 Step 2.c 的受影响包矩阵**逐包**验证，每包都要有结论。禁止用根目录一条聚合命令代替逐包验证，也禁止只跑其中一个包就宣布通过。

完整策略见 `references/verification.md`：作用域正确的命令形式、10 分钟时间预算、`timeout` + 落盘、**flaky 唯一判定路径（在未改动的 `origin/$BASE` 上复现）**、无测试框架时的手工验证降级。

结束检查：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
git -C "$WT" status --short
git -C "$WT" --no-pager diff --check
git -C "$WT" --no-pager diff --stat
git -C "$WT" --no-pager diff
```

报告所有**已运行/通过/失败/超预算未跑/未运行**五种状态。测试失败时按 flaky 判定路径处理；未能在 base 复现即视为本改动引入，停止，不提交/推送。

## Step 6：自动提交并推送任务分支

禁止 `git add -A`、`git add .`、`git add -u` 和 `git commit -a`。只允许显式逐个列出计划内文件。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}" "${BR:?}"
test "$(git -C "$WT" branch --show-current)" = "$BR" \
  || { echo "STOP: 当前分支不等于 \$BR，拒绝提交"; exit 1; }    # 硬规则 1，不是注释
git -C "$WT" add <task-files...>
git -C "$WT" --no-pager diff --cached --name-only
SENSITIVE=$(git -C "$WT" --no-pager diff --cached --name-only \
  | grep -Ei '(^|/)\.env|(^|/)\.npmrc|secret|credential|\.pem$|\.p12$|id_rsa' || true)
[ -z "$SENSITIVE" ] || { printf 'STOP: 疑似敏感文件已暂存：\n%s\n' "$SENSITIVE"; exit 1; }
git -C "$WT" --no-pager diff --cached --stat
git -C "$WT" --no-pager diff --cached
git -C "$WT" commit -m "<project-conventional-message>"
```

暂存文件集合必须与计划中的预计修改文件一致；出现计划外文件时停止，不要顺手一起提交。

commit 格式、scope 与 identifier 位置见 `references/pr-output.md`（存在 `commitlint` 的 `header-max-length` 时 identifier 放 footer）。不要添加虚假署名。

确认后无需再次询问，**自动提交、普通 push 当前任务分支**：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}" "${BR:?}"
test "$(git -C "$WT" branch --show-current)" = "$BR" \
  || { echo "STOP: 当前分支不等于 \$BR，拒绝推送"; exit 1; }
git -C "$WT" push -u origin "refs/heads/$BR:refs/heads/$BR"
```

缺这三行时 `WT`/`BR` 为空会退化成 `git -C "" push -u origin "refs/heads/:refs/heads/"`，而 `git -C ""` 已实测**静默落回当前工作目录**（很可能就是主工作区）——正是本节开头描述的那场事故。

禁止 `--force`，禁止 refspec 指向 base 或其他受保护分支。push 失败时保留状态并停止；被拒绝时按 `references/recovery.md` 处理，**不得用 force 解决**。

## Step 7：自动创建到已确认 base 的 PR

`--no-pr` 时跳过本步，只输出拟用标题与 body 文本。

先确认 head/base 仓库关系并检查已有 PR（fork 场景细节见 `references/pr-output.md`）。`BODY` 必须写进 `$ENVFILE`：写 body 与创建 PR 是两次 `bash` 调用，变量不跨调用。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${BR:?}" "${BASE:?}" "${ENVFILE:?}"
BODY=$(umask 077; mktemp "/tmp/pi-pr-body-XXXXXX")
printf "export BODY='%s'\n" "$BODY" >> "$ENVFILE"; echo "$BODY"
gh repo view --json nameWithOwner,isFork,parent -q '{repo:.nameWithOwner,fork:.isFork,parent:.parent.nameWithOwner}'
gh pr view "$BR" --json url,baseRefName,headRefName,state 2>/dev/null || true
```

- 已有 OPEN PR 且 base/head 正确：复用，不重复创建。
- 已有 PR 但 base/head 不正确，或状态 CLOSED/MERGED：停止并报告；不擅自重开、改 base 或建重复 PR。
- 不存在则**创建到已确认 base 的 PR**：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${BR:?}" "${BASE:?}" "${BODY:?}"
test -s "$BODY" || { echo "STOP: PR body 文件为空，拒绝创建"; exit 1; }
gh pr create --base "$BASE" --head "$BR" \
  --title "<project-style title>" --body-file "$BODY"
gh pr view "$BR" --json url,baseRefName,headRefName,state
```

PR body 以**仓库自己的 PR 模板**为骨架，再追加「关联 / 需求理解 / 变更 / 验证 / 假设」四段；无模板时使用默认结构。模板与脱敏规则见 `references/pr-output.md`——禁止把 Linear 里的客户身份信息、邮箱、订单号、内网地址、任何环境凭据或生产日志原文复制进 PR。

确认 `state=OPEN`、`baseRefName=$BASE`、`headRefName=$BR`。创建失败时报告错误和已推送分支，不把 push 成功误报成 PR 成功。**不要自动 merge、approve 或 ready**。

**Linear 侧副作用披露**：本 Skill 不调用 Linear 写接口，但分支名/PR 标题中的 `<ISSUE>` 会触发 Linear
GitHub 集成自动关联 PR 并推进 Issue 状态。**必须在 Step 2 展示计划时一并告知**；规避方式与 magic word
见 `references/pr-output.md` §Linear 关联与副作用。agent 主动发起的 Linear 评论/状态变更仍需另行同意。

## Step 8：收尾报告

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${WT:?}" "${FP0:?}" "${HEAD0:?}"
FP1=$(git -C "$ROOT" status --porcelain=v1 | sha256sum | cut -d' ' -f1)
HEAD1=$(git -C "$ROOT" rev-parse HEAD)
printf 'FP0=%s FP1=%s\nHEAD0=%s HEAD1=%s\n' "$FP0" "$FP1" "$HEAD0" "$HEAD1"
[ "$FP1" = "$FP0" ] && [ "$HEAD1" = "$HEAD0" ] \
  || { echo "STOP: 主工作区已被改动，报告最上方必须醒目声明并列出差异"; \
       git -C "$ROOT" status --short; exit 1; }
git -C "$WT" --no-pager show --stat --oneline HEAD
```

指纹或 HEAD 与 Step 0 不一致时，必须在报告最上方醒目声明并列出差异文件。**指纹只覆盖工作区文件状态**，不覆盖 `.git/config` 变更、新增 remote/ref，以及本地分支相对远端的落后——这三项单独逐条列出。

收尾报告的完整字段清单见 `references/recovery.md` §收尾报告字段。worktree 默认保留；清理临时文件（Issue JSON、PR body、env 文件）。

## 有效确认的判定

用户确认理解卡和实施计划，即授权验证通过后自动提交、普通 push 当前任务分支并创建到已确认 base 的 PR。授权不包括 force push、直推受保护分支、合并/approve/ready PR、主动回写 Linear、部署或其他未说明的外部动作。

**什么算有效确认（三条全满足）**：

1. 回复中没有新增疑问、条件、待办或「但是/不过/顺便看下/确认一下」这类附加要求；
2. 没有引入计划外的范围、文件或验收项；
3. 明确指向本次计划（「按这个来」「开始吧」「confirmed」），而不是泛泛的「好的/收到/嗯」。

任一条不满足即视为**未授权**：先只处理用户提出的那一点，更新受影响的理解卡/计划条目，再请求一次确认。禁止把条件式回复、表情、单字回复或对某一子问题的回答当作 push/PR 授权。

授权是对**某一版计划**的授权。计划中的 base、branch、改动文件集合或验收标准发生实质变化时，旧授权失效，必须重新确认。

## 立即停止并询问

- **Issue 形态**：已取消/已完成、是 duplicate、是含子 issue 的 parent，或 `blockedBy` 非空。
- **需求不可得**：Issue 读不全；决定实现的来源不可读且未获 1.2 豁免；期望/验收/真实落点不清；多个生效候选无法排除。
- **身份与约定**：team 不可见；team key/base/remote/分支策略无法唯一确定。
- **平台不兼容**：非 GitHub 托管或 `gh` 不可用（Step 0 停止并给降级方案）；对 origin 无 push 权限；head 落在受保护集合。
- **残留与并发**：branch/worktree 残留判定为「非本次任务」或「需判断」；远程已存在同名分支。
- **环境与产出物**：环境引导失败；lockfile 或生成物出现无关漂移。
- **验证**：测试失败且未能在 `origin/$BASE` 复现（即由本改动引入）。
- **越界**：schema/migration、兼容性、计费、安全、权限或发布策略有分歧；需要 Linear 回写、合并/approve/ready PR、部署或其他未授权动作。

**不得停下重复询问**：理解卡和实施计划已获用户确认、实现与验证成功、当前任务分支/worktree 正常、且未出现下列「重新开闸事实」时，必须继续完成提交、普通 push 和创建 PR，不再二次询问。

**重新开闸事实**（出现任一条，本次授权失效，停止并带证据重新确认）：

- 实际改动文件超出计划范围，或触及计划外的 package/模块/服务；
- 需要新增或修改环境变量、密钥、配置项、feature flag；
- 需要新增 migration、修改已发布 migration，或改动生成代码/lockfile；
- 需要改动既有测试的断言，或需要 skip 任何测试；
- 计划中的验证命令不存在、无法运行或明显超出时间预算；
- CODEOWNERS 显示改动横跨多个 owner 组；
- 发现该 Issue 的真实口径与理解卡不一致。

区分清楚：**已确认事项不重复问，新事实必须问。**

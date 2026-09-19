---
name: linear-pr-audit
description: 逐条验证一个 Pull Request 是否真的满足它对应 Linear Issue 的验收标准，未通过时说明缺口并可修复复验，全部通过后回写自测报告。用于“审计 PR 是否满足 Linear 验收标准”“验收这个 PR”“帮我把这个 PR 的验收跑通”“验收全过后回写自测报告”“这个 PR 能不能合并”“四门审计”“验收门”等请求。
compatibility: Requires git, Node.js 18+, authenticated gh CLI with push access to the PR head repository, and LINEAR_API_KEY or ~/.config/pi/linear-api-key with comment-write scope. Test and scan commands are discovered from repository configuration.
allowed-tools: read bash edit write invoke_skill
metadata:
  category: pull-request-audit
  portability: project-agnostic
---

# Linear PR Audit：四门审计与验收闭环

在 `pr-audit` 的 Correctness / Requirements / Security 三门之上，叠加第四门 **Acceptance（验收门）**：
把 Linear 需求里的验收标准逐条拆开，用**可执行证据**验证它在当前 PR head 上是否真的成立。

```text
冻结 PR → 解析推送目标 → 三门审计 → 提取验收标准 → 验收计划（用户确认一次）→ 环境就绪 → 反重言基线
→ 逐条验证 → 未过则说明缺口并修复 → 推送修复 → 等待 CI → 复验 → 4/4 PASS → 脱敏 → 报告写回 Linear
```

与 `pr-audit` 的区别：`pr-audit` 始终只读、只输出到 Pi。本 Skill 会写临时测试、可能修改实现、推送修复
commit、在 PR 上发披露评论、并回写 Linear 评论；因此它有一个明确的授权闸门，且默认不修改 PR 状态、
**不部署**、**不触碰主工作区**，所有写操作都限定在下文列出的范围内。
细节分置于 `references/`：`write-safety.md`（可写性/推送目标/隔离/自审）、
`ac-taxonomy.md`（验收标准分型）、`anti-tautology.md`（反重言基线）、
`rerun-scope.md`（各门重跑与 CI 等待）、`report-templates.md`（模板与脱敏）。

## 与 pr-audit 的职责分工

- **Requirements（门 2，由 `pr-audit` 产出）**：每条需求**有没有**实现代码和对应测试；证据是静态追踪矩阵与 `file:line`。
- **Acceptance（门 4，本 Skill 新增）**：每条**验收标准**在冻结 head 上**跑不跑得通**；证据是可复现命令 + 实际输出 + 失败基线。

门 4 以门 2 矩阵为主输入。矩阵按**原子需求**拆分，粒度常与验收标准不一致，所以补读 Linear 原文是常规动作；补读时只读 description 与 comments 中的验收段落，不重建整个矩阵。

### 冲突仲裁：可执行证据优先

两门结论不一致时**不是各记各的**，必须按下表回写再重算门禁，否则报告会同时印出「Requirements PASS」和「AC3 FAIL」这种自相矛盾的结论：

| 门 2 结论 | 门 4 结论 | 仲裁 |
|---|---|---|
| R_i 完整 | 对应 AC `FAIL` | 静态矩阵被实测推翻。R_i 下调为「部分」，Requirements 重判 `FAIL`，矩阵备注写 `被 AC<n> 实测推翻` |
| R_i 完整 | 对应 AC `BLOCKED`/`UNVERIFIABLE` | R_i 下调为「部分」，Requirements 至多 `BLOCKED` |
| R_i 缺失/部分 | 对应 AC `PASS` | 实测优先，但必须查清矩阵为何漏判（多为 AC 拆得比需求窄，或落点与矩阵不符）。查清前 Requirements 维持原判，不得因 AC 绿灯上调 |
| 无对应 R_i | AC 存在 | 门 2 漏项。补进矩阵后重判 Requirements |

每条 AC 必须标注对应的 `R` 编号；标不出对应关系说明门 2 矩阵不完整，Requirements 记 `BLOCKED`。
验收标准是本 Skill 的存在前提，Linear 对比恒定开启，没有 `--linear off`；无法唯一定位 Linear Issue 时停止询问，不降级为三门审计。

## 输入

```text
/skill:linear-pr-audit 123 TEAM-456
/skill:linear-pr-audit https://github.com/org/repo/pull/123 TEAM-456
/skill:linear-pr-audit 123 TEAM-456 --max-rounds 2 --ci-timeout 60 --no-post
```

- 第一个位置参数：PR 编号或完整 URL；省略时用 `gh pr view` 定位当前分支的唯一 PR。
- 第二个位置参数：Linear identifier。省略时从 PR body、title 和 head 分支名提取；提取不到或提取到多个时停止询问。
- `--max-rounds N`：修复复验循环最大轮次，默认 `3`。
- `--ci-timeout M`：每轮推送后等待 CI 落定的分钟数，默认 `45`，写入 `CI_TIMEOUT_MIN`；靠
  `timeout $((CI_TIMEOUT_MIN * 60)) gh pr checks --watch` 实现（`gh pr checks` 自己没有超时 flag，
  不套 `timeout` 就是无限阻塞）。超时（`timeout` 退 124）记 Correctness `BLOCKED`。
- `--no-post`：完成全部验证但不发送 Linear 评论，只在 Pi 输出报告。

出现未知参数、重复冲突开关或多个 PR/Issue 标识时停止，不猜测。

## 授权模型：确认一次

Phase 3.3 输出「验收清单 + 验证计划 + 预算估算 + 授权复述」。用户确认这一次，即授权后续全部动作，
**不得再为每一步重复询问**。**已授权**：

- 在隔离 worktree 内编写并运行临时验收测试、为反重言基线创建 detached 临时 worktree、修改实现代码以满足已声明的验收标准
- 每轮展示完整 staged diff 后，普通推送修复 commit 到 **head 仓库的 head 分支**
- 每轮推送后在 PR 上发一条**披露评论**（唯一允许的 PR 写操作）；4/4 PASS 后向 Linear Issue 评论区发送自测报告

**未授权**（任何确认都不包含）：**禁止 force push**；禁止推送受保护分支；禁止 refspec 指向 base；
合并、approve、ready、关闭 PR，或修改 PR title/body/base；修改 Linear 的状态、字段、标签、验收标准本身；
部署、发布、访问生产环境；提交临时验收测试；修改或删除既有测试。

授权复述必须按开关生成，不得复述未启用的动作（`--no-post` 写「本次不发送任何 Linear 评论」；只读降级写「不推送任何 commit，产出 patch」）。即使首轮就 4/4 PASS，也必须先过闸门。

## 状态模型

### 单条验收标准（AC）

| 状态 | 判定 |
|---|---|
| `PASS` | 有可复现的执行证据，且已通过反重言基线（基线失败 + 修复后通过，两个退出码齐全） |
| `PASS(pre-existing)` | 该 AC 在 `baseRefOid` 上已成立，本 PR 未涉及 |
| `PASS(partial)` | 自动化只能覆盖该 AC 的一个子集（典型：可访问性），已枚举未覆盖项 |
| `PASS(waiver)` | 本质不可验证，且已获可核验的人工签核 |
| `FAIL` | 已执行，结果不符合验收标准 |
| `BLOCKED` | 本身可验证，但环境、凭据、依赖或 CI 缺失 |
| `UNVERIFIABLE` | 本质上无法在本环境验证（真实第三方支付、线上流量与真实负载、特定终端/浏览器/OS、硬件、需真人主观判断的可访问性与视觉一致性） |

标记 `UNVERIFIABLE` 必须同时写明三项，缺一律按 `BLOCKED` 处理：为什么本质不可验证；已尝试过哪些替代手段（mock、stub、录制回放、契约测试）以及为什么不成立；需要谁在什么环境人工验证。

**签核不由本 Skill 代记**：签核人须用自己的 Linear 账号在该 Issue 下留一条逐字签核评论，本 Skill 用
`fetch-linear-issue.mjs` 重新拉取并验证该评论存在、作者非当前 API key 对应用户。找不到则维持
`UNVERIFIABLE`；对话中的口头同意**不构成签核**。**waiver 必然跨两次调用**——签核评论在本次运行开始前
不存在，本 Skill 也无权代发，所以本轮只输出待签核清单并按未达标交付物收尾，由用户在签核评论存在之后
**重新运行**本 Skill。**禁止在运行内轮询等待人工签核**（禁止 sleep／反复拉取 Issue 直到出现评论）。
逐字评论模板、作者自签标注与「签核凭证」列见 `references/report-templates.md` §人工签核（waiver）。

### 计数口径与 Gate

- **分母 = Phase 3.1 拆分出的 AC 总条数**，恒定不变。`FAIL`、`BLOCKED`、`UNVERIFIABLE` 一律计入分母。
- **分子 = `PASS` + `PASS(waiver)` + `PASS(pre-existing)` + `PASS(partial)` 的条数。**
- 结论行固定 `验收 <分子>/<分母> 通过`；分子小于分母时必须在括号内列出未过条目的状态分布。任何情况下不得改写分母来让比值好看。
- 四个 Gate 均为 `PASS` / `FAIL` / `BLOCKED`，没有 `DISABLED`。Acceptance 聚合：全部 AC 计入分子 → `PASS`；任一 `FAIL` → `FAIL`；否则 → `BLOCKED`。

## 通过规则与评级

- **四门都必须 `PASS`，即 **4/4 PASS**。**
- 任一 Gate `FAIL` → 总体 `FAIL`；无 `FAIL` 但任一 `BLOCKED` → 总体 `BLOCKED`；全部 `PASS` → 总体 `PASS`。
- 评级沿用 `pr-audit` 的 `S/A/B/C/D/F` 表。总体 `PASS` 蕴含无 FAIL 无 BLOCKED，**因此默认落在 `S/A`；仅当下方上限清单把上限压到更低（作者自签 → `B`）时按清单取值**。上限清单优先于本句。
- 评级上限清单（**本清单是唯一权威**；reference 里出现的上限规则都必须登记到这里，未登记的以本清单为准）：

  | 情形 | 上限 | 来源 |
  |---|---|---|
  | 存在 `PASS(waiver)` / `PASS(partial)` / `PASS(pre-existing)` | A | 本文件 |
  | 本次审计推送过任何 commit | A | write-safety.md 自审隔离 |
  | 仓库无 CI 覆盖 | A | rerun-scope.md CI 等待 |
  | 某条 AC 降到「人工复现步骤」 | A | ac-taxonomy.md 功能性阶梯 |
  | AC 由本 Skill 修复引入、PR 内无已提交回归测试 | A | anti-tautology.md 回归保护回查 |
  | 项目没有专用 scanner，只做了人工审阅 | A | `pr-audit` Gate 3 的 SAST 与依赖扫描规则 |
  | 签核人为 PR 作者本人（作者自签） | B | 本文件 |

- 只有总体 `PASS`、且最终 head 校验通过时才发送自测报告。存在 waiver 时报告照常发送，但结论行写成
  `验收 5/5 通过（其中 1 条 waiver）`，紧跟 `> ⚠ 本报告含 1 条人工签核项，未获得可执行证据。`，
  并含独立的「waiver 记录」小节。
- 禁止用总分平均掉任何一门的失败。

## 执行期约定：参数固化（强制）

**每次 `bash` 调用都是新 shell，环境变量不跨调用保留。** `HEAD_OID HEAD_REF PUSH_REMOTE WT
DECLARED_FILES ROUND_OID BASE_OID TMP_TEST_DIR SINKS FORBIDDEN_PATTERN TARGET` 全部出现在闸门和推送
命令里，没赋值就等于空串：`git -C "$WT" push "$PUSH_REMOTE" "HEAD:refs/heads/$HEAD_REF"` 退化成
`git -C "" push "" "HEAD:refs/heads/"`——`git -C ""` 已实测静默落回当前工作目录。所以先固化，再执行。
env 文件按阶段追加，同名变量后写覆盖先写；**阶段一必须先于 Phase 0 执行**（Phase 0 已经在 source 它）：

```bash
umask 077
PR=123; ISSUE=TEAM-456; CI_TIMEOUT_MIN=45; MAX_ROUNDS=3; ROUND=1
ROOT=$(git rev-parse --show-toplevel) || { echo "STOP: 不在 git 仓库内"; exit 1; }
ENVFILE="/tmp/pi-linear-pr-audit-pr-${PR}.env"
OUT=$(umask 077; mktemp "/tmp/pi-pr-${PR}-acceptance.XXXXXX")
cat > "$ENVFILE" <<EOF
export PR='$PR' ISSUE='$ISSUE' ROOT='$ROOT' OUT='$OUT' ENVFILE='$ENVFILE'
export CI_TIMEOUT_MIN='$CI_TIMEOUT_MIN' MAX_ROUNDS='$MAX_ROUNDS' ROUND='$ROUND'
export GIT_PAGER=cat GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
EOF
printf 'ENVFILE=%s OUT=%s\n' "$ENVFILE" "$OUT"
# 阶段二（Phase 1 解析出推送目标后追加；真实取值由 write-safety.md 的片段现场算出）
cat >> "$ENVFILE" <<EOF
export HEAD_NWO='<head-owner/repo>' BASE_NWO='<base-owner/repo>'
export HEAD_REF='<head 分支名>' PUSH_REMOTE='<origin 或 fork URL>'
export HEAD_OID='<冻结 head oid>' BASE_OID='<baseRefOid>'
EOF
# 阶段三（Phase 3.4 建树后追加）
cat >> "$ENVFILE" <<EOF
export WT='<验收 worktree 绝对路径>' AUDIT_BRANCH='pi-acceptance/pr-<PR>'
export TMP_TEST_DIR='<仓库外临时测试目录>' DECLARED_FILES='<已声明实现文件清单的路径>'
export ROUND_OID='<本轮起始 oid>'
EOF
# 现场追加（Phase 0 指纹／Phase 1 分页/Phase 3.1 JSON／Phase 6 报告正文／负向与哨兵 AC）
cat >> "$ENVFILE" <<EOF
export FP0='<隔离基线指纹>' OUT_FILES='<分页 files JSON>' ISSUE_JSON='<Issue JSON 路径>'
export BODY='<报告正文文件>' SINKS='<sink 清单文件>' FORBIDDEN_PATTERN='<负向匹配模式>' TARGET='<哨兵被断言的文件>'
EOF
```

**上面这三段就是 env 文件的完整内容清单**：任何片段用到的变量都必须出现在其中一段里，
写它的那个片段负责在算出值的同一次调用内 `cat >>`／`printf ... >>` 落盘。约定：

- **每次 `bash` 调用首行 source 的是字面路径 `/tmp/pi-linear-pr-audit-pr-<PR>.env`，不是 `. "$ENVFILE"`**——
  `ENVFILE` 只存在于该文件*内部*，新 shell 里它是空串，`. ""` 什么都不 source，后面所有断言都在空值上跑。
- **变量不在同一小节的两个 ```bash 围栏之间传递**：每个围栏是一次独立 `bash` 调用，上一个围栏里的
  赋值、函数定义、`cd` 全部丢失。要么合成一个围栏，要么 `printf ... >> "$ENVFILE"` 落盘再 source 回来。
- source 之后按阶段断言：`: "${WT:?}" "${HEAD_REF:?}" "${PUSH_REMOTE:?}"`。
- `DECLARED_FILES`、`SINKS` 是**文件路径**（每行一项），不是 bash 数组——数组无法 `export`，跨调用必丢。
- `HEAD_OID`、`ROUND_OID` 与 `ROUND` **每轮重写**：改写前后各 `printf` 一次，并在报告「复验轮次」逐轮
  列出。`ROUND` 漏加会让基线 B 的 worktree 名与 AC 日志名跨轮撞名，前一轮的证据被后一轮覆盖。
- 推送只允许这一种写法：`git -C "$WT" push "$PUSH_REMOTE" "HEAD:refs/heads/$HEAD_REF"`。
- git 命令一律 `git -C "$ROOT"` 或 `git -C "$WT"`，禁止裸 `git`；本节是参数模板的唯一权威来源。

**本 Skill 不使用 `set -e`**（`linear-to-pr` 相反）：反重言基线与证据裁剪要靠
`( cd "$WT" && <cmd> ); EXIT=$?` 取回**非零**退出码，而 `set -e` 会在 `<cmd>` 处直接中止，永远走不到
`EXIT=$?`（已实测：整段在那一行退出，`EXIT` 从不被赋值）。代价是 `-e`/`-u` 必须手工补回：

- **每个闸门一律写成 `cmd || { echo "STOP: ..."; exit 1; }`。** 禁止裸命令单占一行（非零退出码被忽略），
  禁止 `cmd || echo "STOP"`（命中与否都返回 0，「STOP」只是一行字符串，流程照常走到 commit/push）。
  「必须无命中」的判据先收进变量再判空：`HIT=$(cmd || true); [ -z "$HIT" ] || { echo "STOP: ..."; exit 1; }`。
- 每个片段开头用 `: "${VAR:?}"` 显式断言替代 `set -u`；探测与闸门分开写——探测用 `... && echo yes || echo no`，永不中止；闸门必须能 `exit 1`。

## Phase 0：环境与可写性预检

沿用 `pr-audit` Phase 0 的全部预检，另加三条增量：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${ENVFILE:?}"
git -C "$ROOT" status --short --branch
git -C "$ROOT" branch --show-current                 # 增量①：记录主工作区当前分支
FP0=$(git -C "$ROOT" status --porcelain=v1 | sha256sum | cut -d' ' -f1)   # 隔离基线指纹
printf "export FP0='%s'\n" "$FP0" >> "$ENVFILE"; printf 'FP0=%s\n' "$FP0"
gh auth status; node --version
find "$ROOT/.." -maxdepth 3 \( -name AGENTS.md -o -name CLAUDE.md \) -print
```

- **增量①**：主工作区当前分支等于 `headRefName` 是默认入口的常见情形，必须走 Phase 3.4 的审计专用
  本地分支，**不得**要求用户切走，也不得在主工作区 checkout；推送后按 Phase 4 步骤 7 检查是否落后。
- **增量②**：Linear 凭据按序解析 `LINEAR_API_KEY` → `LINEAR_API_KEY_FILE` → `~/.config/pi/linear-api-key`；不打印、不记录、不提交 API key，缺失时停止。
- **增量③**：记录隔离基线指纹 `FP0` 并写进 `$ENVFILE`，Phase 6 收尾用 `[ "$FP1" = "$FP0" ]` 机器比对（两次是不同的 `bash` 调用，肉眼对比两段输出不算校验），并按 Phase 6 声明其覆盖边界。

全过程不 reset、clean、stash 或覆盖主工作区的任何改动。

### 断点检测：上次运行的残留

本 Skill 跨最多 3 轮向 head 分支推送，中断后远端已带着修复 commit，所以**不能一律停止**：
先探测归属，再按表处置。以下三行是**探测**不是闸门，命中与否都继续。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}"
WT_GUESS="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-acceptance"; AB="pi-acceptance/pr-${PR}"
[ -e "$WT_GUESS" ] && echo "wt: yes" || echo "wt: no"
git -C "$ROOT" show-ref --verify --quiet "refs/heads/$AB" && echo "branch: yes" || echo "branch: no"
git -C "$ROOT" worktree list --porcelain
```

| 探测结果 | 处置 |
|---|---|
| worktree 注册但目录缺失 | `git -C "$ROOT" worktree prune`，继续 |
| 审计分支存在，且其 commit 全部是本 Skill 的修复（commit message／披露评论可对上本 PR 与 AC 编号） | 本次任务残留 → 复用 worktree 与分支，`ROUND` 接着上次的轮次，跳回 Phase 3.5 重跑全部 AC |
| 审计分支存在但含无关 commit、不是 `HEAD_OID` 的后代，或 worktree 目录不是该分支的工作树 | 归属不明 → 停止询问；**绝不** `branch -D`／`reset`／`rebase` |
| 只有残留 env 文件 | 校对其中 `PR`/`ISSUE` 一致后覆盖重写，不复用旧的 `HEAD_OID` |
| `pr-audit` 的 `<repo>-pr-<N>-audit` worktree 已存在且非本次创建 | 按 `pr-audit` 的规则询问用户（见 Phase 2） |

确认是本次运行残留时必须续做，**不得要求用户手工清理后从零重跑**——那会在已推送的 head 上重复推同样的修复。

## Phase 1：冻结 PR 与解析推送目标

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${PR:?}" "${OUT:?}"                 # OUT 是 mktemp 出来的 0600 私有文件
gh pr view "$PR" --json number,url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner,headRepository,maintainerCanModify,author,mergeable,reviewDecision,statusCheckRollup,files > "$OUT"
if [ "$(jq '.files|length' "$OUT")" -ge 100 ]; then
  OUT_FILES=$(umask 077; mktemp "/tmp/pi-pr-${PR}-files.XXXXXX")
  gh api "repos/{owner}/{repo}/pulls/${PR}/files" --paginate > "$OUT_FILES"
  printf "export OUT_FILES='%s'\n" "$OUT_FILES" >> "$ENVFILE"
fi
```

`OUT` 不用固定名：可预测的 world-readable 路径装着私有仓库的 PR body/files/reviewDecision，
且并发会话会互相覆盖。一律 `mktemp` + `umask 077`，路径存进 `$ENVFILE`。用 `read` 分段读完。验证 PR 为 `OPEN`；`CLOSED`/`MERGED` 停止。draft 可以审计，但**默认不发送 Linear
评论**（见 Phase 6）。记录 `headRefOid` 作为**第 1 轮**冻结基准并写入 `$ENVFILE`。`files` 达到 100 说明被
截断，以 API 分页结果为准，否则变更面被低估。

**推送目标与可写性判定见 `references/write-safety.md`**，解析出的
`HEAD_OID BASE_OID HEAD_REF HEAD_NWO BASE_NWO PUSH_REMOTE` 立刻追加进 `$ENVFILE`。要点：修复推送到
**head 仓库**的 head 分支，不是 `origin`（origin 是 base 仓库）；可写性用 `permissions.push`、
`maintainerCanModify`、head 分支保护查询和 `git push --dry-run` 机器判定，**不按分支名硬判**
`main`/`master`——fork PR 的 head 常常就叫 `main` 且完全可推。

不可写时**降级为只读模式**：仍完成三门审计和验收验证，验收失败时把已在 worktree 验证通过的修复输出为
patch（`git format-patch`）交给用户，Acceptance 记 `BLOCKED`，不发送自测报告。
**无法 push 时降级为只读 patch 输出**，不得改用其他路径绕过权限。

## Phase 2：执行三门审计

`invoke_skill pr-audit "<PR> --linear on"`。调用前先探测其 worktree 路径 `<repo>-pr-<N>-audit` 是否已存在；
存在且非本次创建时按 `pr-audit` 的规则询问用户，不得自行复用或删除。首轮结束后记录该路径，
并在最终写操作清单中列出。

从其报告中必须提取并原样记录（提取不到即视为 `pr-audit` 不可用，走自行审计路径并在报告注明）：三门
Gate 状态；需求追踪矩阵全部行（3.1 的 AC 输入）；**Correctness 实际执行的命令清单**（后续轮次逐字
复用，固化方式见 `references/rerun-scope.md`）；冻结 head oid；全部 Critical/High 发现。

校验它冻结的 head 与 Phase 1 一致；不一致重新执行 Phase 1 并重试**至多 2 次**，第 3 次仍漂移即停止询问。
重试前**必须先删掉本次调用刚建的那个 `pr-audit` worktree**（`git -C "$ROOT" worktree remove --force <路径>`），
否则第 2 次调用会撞上它自己的「worktree 路径已存在」停止条件而卡死。删除动作记进写操作清单；
**只允许删本次调用创建的路径**，既存的一律询问用户。

`pr-audit` 自身 `FAIL` 或 `BLOCKED` 时**仍然继续执行 Acceptance**，但必须在 3.3 闸门第一行如实写出三门
结论，并告知「即使 Acceptance 全过，总体门禁仍为 <FAIL|BLOCKED>，本次不会发送自测报告」——
不得让用户在误以为能闭环的前提下授权。

## Phase 3：Acceptance Gate

### 3.1 提取验收标准

从 Phase 2 矩阵中挑出验收标准条目，必要时补读原始数据：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ISSUE:?}"
ISSUE_JSON=$(umask 077; mktemp "/tmp/pi-${ISSUE}-acceptance.XXXXXX")
node <linear-to-pr-skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$ISSUE_JSON"
printf "export ISSUE_JSON='%s'\n" "$ISSUE_JSON" >> "$ENVFILE"
```

拆分规则：一条 AC 必须是**单一、可观察、有明确判定条件**的陈述。机器判据：AC 原文含并列连词
（且／并／同时／以及／and／、）或含多于一个动词短语 → **必须拆**，拆完每条只有一个断言点
（「支持导出并发送邮件通知」拆成两条）；拆不动时在报告写明理由。每条记来源标注
`[正文]`／`[评论 #序号/作者/日期]`／`[文档/URL]` 与对应 `R` 编号。验收标准缺失、只有现象没有期望、
或多条评论口径冲突且无覆盖证据时，停止询问，不自行发明验收标准。

### 3.2 设计验证方式

按优先级选择：自动化测试 > 可复现命令 > 数据/状态断言 > 人工复现步骤，并说明为什么不能用更高优先级的方式。
测试必须断言 AC 描述的**用户可观察行为**，不是内部函数返回值。

- 非功能性（性能/兼容/可访问性）、负向（「必须不」）、多主体/异步/有状态 AC 有专门口径，
  **必须**先读 `references/ac-taxonomy.md`。用普通自动化测试一次跑出布尔值会稳定产出假 PASS。
- **绝对阈值不得在审计机上判定。** 「P95 < 200ms」在审计机上跑出 180ms 不算 `PASS`，一律
  `UNVERIFIABLE` 并写明需要谁在什么环境压测；性能只判**相对 base** 的回归，阈值见 `ac-taxonomy.md`。
- **测试禁止 mock 任何出现在 `base...head` diff 面内的模块**——那正是本 PR 要证明的代码，
  两个退出码兜不住它（理由与检查命令见 `references/anti-tautology.md` §Mock 禁区）。
- 每条自动化测试 AC 都要通过**反重言基线**，程序见 `references/anti-tautology.md`。
  新写的测试绿灯不是证据，绿灯 + 已证明它会红才是。**不做即不得记 PASS。**

### 3.3 验收计划闸门

闸门文本必须逐项给全：三门结论、推送目标与可写性判据、逐条 AC（来源 → `R` 编号 → 验证方式 → 落点
→ 基线）、worktree 与审计分支、临时测试隔离方式、`DECLARED_FILES` 清单（含 ≤80 行上限）、
最大复验轮次与 CI 等待上限、预算估算、按开关生成的授权复述。逐字模板见
`references/report-templates.md` §验收计划闸门模板。

AC 超过 8 条、或最坏耗时估算超过 3 小时时，在闸门处**额外提示一次**，让用户选择：(a) 按现方案跑；
(b) `--max-rounds 1` 先出纯诊断；(c) 缩小本次验收范围。这是唯一允许在闸门处追加的询问。
用户确认前不创建 worktree、不修改任何代码。

### 3.4 建立 worktree 与隔离

**不得**把 `headRefName` 当作 worktree 的 checkout 分支——git 禁止同一分支在两个 worktree 同时 checkout，
而本 Skill 的默认入口恰恰假设用户正站在该分支上。改为创建审计专用本地分支指向冻结 oid，推送时用显式
refspec。完整命令（含命名空间冲突枚举）、fork fetch 与隔离机制见 `references/write-safety.md`。
隔离首选把临时测试放在仓库外（`TMP_TEST_DIR`）；框架强制树内时依赖暂存期机器闸门，
**不依赖任何 ignore 机制**，也**禁止** `git config --worktree core.excludesFile`（理由见 write-safety.md）。
**临时验收测试不提交。** 报告中记录这些文件的完整路径与内容，便于用户日后自行落地。

### 3.4.1 测试环境就绪

新建 worktree 是空的。跑第一条 AC 之前完成依赖安装（锁定模式）、服务启动、迁移与 seed，否则全部 AC
会假性 `BLOCKED`。`.env` 只从 `.env.example` 或项目文档指定的本地模板生成，**绝不复用主工作区的 `.env`**，
也不写入任何真实凭据。环境失败只在报告里记一次（写明缺哪一项），起过的服务列入清理清单。

### 3.5 执行验证与判定

逐条 AC 执行，记录：命令、退出码、**基线退出码**、关键输出片段、判定。证据裁剪规则见
`references/rerun-scope.md`——完整日志落盘，上下文只保留命令、退出码、断言/失败行和尾部 40 行。
不运行涉及生产、外部写入、凭据上传或未知 installer 的命令；不自动安装未知工具。这类情况记 `BLOCKED`。

按状态模型给出每条 AC 状态和 Gate 聚合结果。「看起来实现了」「PR 描述声称已完成」「相关单测通过」
「我新写的测试通过了」都不是 PASS 证据——必须有针对该 AC 的可复现执行证据**和失败基线**。

## Phase 4：修复复验循环

Acceptance 出现 `FAIL` 时进入循环。采用**分轮冻结**：每一轮都有自己的冻结 `oid`。

1. **说明缺口**（重点输出）。每条 FAIL 的 AC 按六段式写清：缺什么／缺在哪 `file:line`／期望／实际
   （附命令与输出片段）／修复方向／影响范围。逐字模板见 `references/report-templates.md`。
2. **等待用户确认修复方案**。用户可以自行修复、调整方案或叫停。
3. **在 worktree 内修改实现**。「最小改动」不是形容词而是机器判据：本轮
   `git -C "$WT" diff --name-only "$ROUND_OID"..HEAD` 必须是 `$DECLARED_FILES` 的**子集**，且本轮增删
   行数合计不超过 **80**。任一条不成立 → 按「修复超出 PR 范围」停止询问，不得靠扩写 `DECLARED_FILES`
   过关（扩清单要回闸门重新授权）。命令见 `references/write-safety.md`。
4. **三层本地复验**（L1 全部已 PASS 的 AC + 本轮 FAIL 项；L2 从 diff 机械反推的影响面，含降级守卫；
   L3 lint/typecheck/build 全量）。口径见 `references/rerun-scope.md`，不用「相关」这种主观词。
5. **暂存期机器闸门**：禁止 `git add -A/./-u` 与 `git commit -a`；断言暂存集合不含临时测试目录、
   不含既有测试文件、且等于已声明的实现文件清单。失败即停止，不接受人工目视代替。
6. **提交并普通推送**到 head 仓库的 head 分支，用显式 refspec，不依赖 `push.default`。
   完整 staged diff 先展示给用户。
7. **推送后检查主工作区是否被落在后面**（强制，命令见 `references/write-safety.md`）：主工作区正站在
   `$HEAD_REF` 上时，本 Skill 一推它就落后，用户下一次 push 会被非快进拒绝——这正是最容易伸手按
   `--force` 的时刻。隔离指纹看不见它，必须单列进写操作清单并告知 `git pull --ff-only`。
8. **在 PR 上发披露评论**（见 `references/write-safety.md`），每轮推送后立即发，不等全部通过：
   本 Skill 推送的代码无人复核，而 reviewer 通常不看 Linear。推送前检查 `dismiss_stale_reviews`
   为 false 且 `reviewDecision` 已是 `APPROVED` 时**停止询问**。
9. **等待 CI 落定**（完整命令与判定表见 `references/rerun-scope.md`）：必须用 `timeout` 包住
   `gh pr checks --watch`，**判据取 `bucket` 明细而不是退出码**，禁用 `--fail-fast`，
   并区分「无 CI 配置」与「CI 未启动」。秒级重读会把 Correctness 判成 `BLOCKED`，循环永远没有出口。
10. **重新冻结**：`gh pr view "$PR" --json headRefOid` 必须等于刚推送的本地 HEAD；不等说明有他人并发
    推送，停止。改写 `HEAD_OID`、`ROUND_OID` 并把 `ROUND` 加一后进入下一轮。

### 修复范围边界

- 只允许修改让**已声明的验收标准**成立所必需的实现代码，范围由上文步骤 3 的子集 + 80 行机器判据界定。
- **禁止修改或删除既有测试**来让验收「通过」。既有测试与 AC 冲突时停止询问，这是需求问题不是代码问题。
- 「无关重构」也是机器判据：**任何一行改动都必须能挂到某条 AC 或 `R` 编号上**，挂不上即无关 → 停止；
  报告里每个被改文件都要写出对应的 AC/R 编号。全仓格式化、依赖升级、顺手改名一律按无关处理。
- 禁止修改验收标准本身或 Linear 上的任何内容。
- 性能未达标**不进入**本循环：优化几乎必然超出范围判据，按「修复需要超出 PR 范围」停止询问。
- 临时验收测试不得充当 Requirements 的测试证据。判定 Acceptance PASS 后逐条回查该 AC 在 PR 中是否有
  **已提交**的回归测试，处置一律按 `references/anti-tautology.md` §回归保护回查的三行表（**那张表是唯一
  权威，本文件不复述**），回查必须给出行级对应关系，只给文件名不成立。

### 终止条件与未达标交付物

终止条件：全部 AC 计入分子；达到 `--max-rounds`；用户叫停；修复超出 PR 范围；出现不可写、head 被他人
推动、既有测试与 AC 冲突、CI 超时等停止条件。未达 4/4 时不发送 Linear 自测报告，但必须在 Pi 输出
**完整**交付物，逐项清单与模板见 `references/report-templates.md` §未达标交付物模板，缺一不可。
其中：已推送 commit 清单非空时**必须已在 PR 上发过披露评论**——报告发不出去不构成不披露的理由；
worktree、审计分支和临时测试**一律保留**，不因失败而清理。

## Phase 5：最终校验与门禁计算

`gh pr view "$PR" --json headRefOid,state,statusCheckRollup,isDraft,reviewDecision`

- `headRefOid` 必须等于本 Skill 最后一次推送得到的 `oid`（未推送过修复时等于第 1 轮冻结值）。不等说明
  期间有他人推送，**立即停止、不发送报告**，避免把别人的改动算进自测结论。
- PR 已关闭或合并 → 报告状态变化，不发送。
- CI 结论按 Phase 4 步骤 9 的 bucket 明细采信，不用秒级快照。

然后按顺序：统计四门状态 → 总体门禁 → 评级（含上限清单）→ 结论。

## Phase 6：脱敏、自测报告与 Linear 回写

总体 `PASS` 且最终 head 校验通过时生成报告并发送；否则只在 Pi 输出当前状态。
**验收未全部 PASS 前不发送自测报告。** PR 仍为 Draft 时**默认也不发送**：只在 Pi 输出完整报告并写明
「PR 仍为 Draft，自测报告不外发」；只有用户在 3.3 闸门处明确要求「Draft 也发」才发送，且必须保留
Draft 警示行。
**发送前必须执行外发前脱敏**（见 `references/report-templates.md`）：本 Skill 是唯一把仓库内部数据外发的
组件，**硬闸门的模式集合必须与检测集合逐条相同**，只在检测里出现的模式就是一条外泄通道。
证据列只放命令、退出码、断言行、失败 diff 摘要，**不贴原始日志、响应体或固件数据**。
报告首行是幂等标记 `<!-- pi-kit:linear-pr-audit:PR-<PR编号>:<最终headOid前12位> -->`。它的两个职责
（精确标记防重发、带尾冒号的 PR 前缀定位历史报告）、前缀扫描命令，以及与 PR 披露评论命名空间
`pi-kit:linear-pr-audit:disclosure:PR-<N>:` 的隔离，见 `references/report-templates.md`
§幂等标记的两个职责——那里是唯一权威，本节不复述规则。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ISSUE:?}" "${ENVFILE:?}"
BODY=$(umask 077; mktemp "/tmp/pi-${ISSUE}-selftest.XXXXXX.md")     # 报告正文写进这个文件
printf "export BODY='%s'\n" "$BODY" >> "$ENVFILE"; echo "$BODY"    # 脱敏闸门在另一次调用里要用
node <本skill目录>/scripts/post-linear-comment.mjs "$ISSUE" --body-file "$BODY" --dry-run
node <本skill目录>/scripts/post-linear-comment.mjs "$ISSUE" --body-file "$BODY"
```

先 `--dry-run`，确认 `issue.identifier` 正确**且 `marker` 非 `null`**。`marker` 为 `null` 说明标记未被识别
（首行有 BOM／空行／缩进／代码围栏），此时查重是关闭的，必须修正 body 首行后重跑 dry-run，不得直接发送。
`--dry-run` 只验证 Issue 解析与当时的重复状态，不构成发送时刻的保证。脚本返回
`skipped: duplicate-marker` 时不要用 `--allow-duplicate` 强推；若携带该标记的评论**作者**不是本 Skill
使用的 API key 对应用户，说明标记是别人搬过去的，报告该情况并停止询问。
`--no-post` 时跳过发送，只在 Pi 输出完整报告并给出手动发送命令。

Pi 侧输出在报告基础上追加：三门完整发现清单、每条 AC 的完整命令与两个退出码、评级依据、
以及本次所有写操作的清单，每条附还原命令。

最后比对 Phase 0 固化的 `FP0`：`FP1=$(git -C "$ROOT" status --porcelain=v1 | sha256sum | cut -d' ' -f1)`，
用 `[ "$FP1" = "$FP0" ]` 判定并把两个值都打印进报告。同时声明指纹的**覆盖边界**——它只覆盖主工作区的
工作树文件状态，不覆盖本地分支落后远端、`.git/config` 变更、新增的 remote 与 ref；这三项各自单列并附
还原命令（表格见 `references/report-templates.md`）。「指纹一致」不等于「什么都没改」。

## 完成前硬检查

- [ ] Linear Issue 唯一确定，验收标准逐条拆分（并列连词已拆）、有来源标注且标出对应 `R` 编号。
- [ ] 每条 AC 有可复现的执行证据，且自动化测试 AC 附**基线与修复后两个退出码**；无 diff 面内的 mock。
- [ ] 非功能性/负向/异步 AC 已按 `ac-taxonomy.md` 的口径处理，未用普通布尔测试顶替；绝对阈值未在本机判定。
- [ ] `UNVERIFIABLE` 的三项说明齐全；waiver 有可核验的 Linear 签核评论 URL，且未在运行内轮询等待签核。
- [ ] 分母等于 AC 总条数，未被改写；门 2/门 4 冲突已按仲裁表回写，三门结论与最终 head 对应。
- [ ] 每条 PASS 的 AC 都回查过 PR 内是否有已提交的回归测试，无则已下调 Requirements。
- [ ] 每轮 push 前展示了完整 staged diff；机器闸门确认暂存集合非空且 ⊆ `DECLARED_FILES`、增删 ≤80 行、不含临时测试与既有测试文件；每个被改文件都挂到了 AC/R 编号。
- [ ] 没有为了让验收通过而修改既有测试；推送过 commit 的运行已在 PR 上发披露评论，评级已按上限清单封顶。
- [ ] 每轮推送后已等待 CI 落定，判定取自 `bucket` 明细（非退出码），明细已贴进报告。
- [ ] 最终 `headRefOid` 等于本 Skill 最后一次推送的 oid；报告列出了**本次审计推送的修复 commit**，Linear 与 PR 两处一致，并已通过外发前脱敏硬闸门。
- [ ] 未达 4/4 PASS 时（含 Draft 默认不发）没有发送 Linear 评论，但已输出完整未达标交付物。
- [ ] 全过程未 force push、未修改 PR 状态、未改 Linear 字段、未部署、未触碰主工作区；`FP1` 与 `FP0` 已机器比对，且已单列指纹覆盖不到的三类写操作（本地分支落后、`.git/config`、新增 remote/ref）。

## 立即停止并询问

除 `pr-audit` 的停止条件外，本 Skill 追加：

- PR 无法唯一定位、已关闭/合并，或 head 无法冻结；审计期间 head 被他人推动；`pr-audit` 冻结 head 连续 3 次漂移。
- Linear Issue 不唯一、凭据缺失、决定验收的文档不可访问；验收标准缺失、只有现象没有期望、多方口径冲突且无覆盖证据，或 AC 拆不成单一断言点。
- 对 head 仓库无 push 权限，或 head 分支被保护规则覆盖（降级为只读 patch 输出后停止）。
- worktree 路径、审计分支或与其命名空间冲突的 ref 已存在且归属不明；`pr-audit` 的 worktree 已存在且非本次创建。
- 修复需要超出 PR 范围（含性能优化、超出 `DECLARED_FILES` 或 80 行上限、挂不到 AC/R 的改动），或既有测试与验收标准直接冲突。
- `dismiss_stale_reviews` 为 false 且 PR 已是 `APPROVED`；达到最大复验轮次仍未 4/4 PASS；CI 等待超过 `--ci-timeout`；必需 check 被跳过或 CI 未被触发。
- 反重言基线在 base 上通过，且无法在 (a) 重言测试 / (b) pre-existing / (c) AC 覆盖面更宽 之间定论。
- 需要执行未经阅读的新增脚本、下载工具、使用生产凭据或访问生产环境。

除这些阻塞外，用户确认验收计划后应连续完成验证、修复、推送、等待 CI、复验和回写，不在每一步前重复询问。

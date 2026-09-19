---
name: pr-audit
description: 对已创建的 GitHub Pull Request 执行三门审计：正确性验证、可开关的 Linear 需求完整性验证、代码安全与静态扫描，并按启用门的 PASS 结果给出 S/A/B/C/D/F 评级和是否可通过结论。用于“审计 PR”“检查 PR 能否合并”“验证实现是否完整”“PR 安全扫描”“PR 三项检查”等请求。
compatibility: Requires a readable git checkout and authenticated gh CLI. Linear requirement auditing additionally requires LINEAR_API_KEY or ~/.config/pi/linear-api-key. Project test and security tools are discovered from repository configuration.
allowed-tools: read bash invoke_skill
metadata:
  category: pull-request-audit
  portability: project-agnostic
---

# PR Audit：Pull Request 三门审计

对已经发起的 GitHub PR 进行只读审计。默认只在 Pi 输出报告，不提交代码、不 push、不创建 review/comment、不修改 PR、Linear 或 CI 状态。

审计门：

1. **Correctness（正确性）**：代码审阅、单元测试、lint、typecheck、编译和相关静态验证。
2. **Requirements（需求完整性）**：按开关读取 Linear，建立需求到实现和测试的**静态**追踪矩阵，只判定实现与测试证据是否存在。验收标准的可执行验证不属于本门，见「Gate 2 的边界」。
3. **Security（安全性）**：先勘察仓库既有安全基线，再判本 PR 对该基线的偏离与数据流风险，并运行项目既有 SAST/secret/dependency 扫描。

通过规则：

- `--linear on`：三个 Gate 都必须 `PASS`，即 **3 PASS**。
- `--linear off`：Requirements 标记 `DISABLED`，只计算 Correctness 和 Security；二者都 `PASS`，即 **2 PASS**。
- `BLOCKED`、`FAIL`、`DISABLED` 不是 `PASS`，不得凑数。
- 评级与门禁结论必须同时输出。

## 输入

接受当前仓库 PR 编号、完整 URL，或可由当前分支唯一定位的 PR：

```text
/skill:pr-audit 123
/skill:pr-audit https://github.com/org/repo/pull/123
/skill:pr-audit 123 --linear on
/skill:pr-audit 123 --linear off
```

参数：

- `--linear on|off`：是否启用需求完整性 Gate。默认 `off`。
- 不支持自动发布参数。第一版始终只输出到 Pi。

解析规则：

1. 输入是 PR URL：确认 URL 指向当前 checkout 的预期 GitHub 仓库；不一致时停止询问。
2. 输入是数字：作为当前仓库 PR 编号。
3. 未提供 PR：尝试 `gh pr view` 定位当前分支的唯一 PR；不存在或不唯一时询问。
4. 出现未知参数、重复冲突开关或多个 PR 标识时停止，不猜测。

## 状态模型

每个 Gate 必须是以下之一：

| 状态 | 含义 |
|---|---|
| `PASS` | 已获得足够证据，且未发现阻断问题 |
| `FAIL` | 已发现可复现错误、需求缺失或高风险安全问题 |
| `BLOCKED` | 关键工具、权限、依赖、环境或证据缺失，无法形成可信结论 |
| `DISABLED` | 仅 Requirements Gate 在 `--linear off` 时使用 |

规则：

- 命令没运行不等于通过。
- CI 绿色不替代本次代码审阅；本地通过也不替代 PR head CI。
- 工具错误、网络错误与“扫描发现漏洞”分开记录。
- 只要一个启用 Gate 为 `FAIL`，总体门禁为 `FAIL`。
- 没有 `FAIL` 但任一启用 Gate 为 `BLOCKED`，总体门禁为 `BLOCKED`。
- 所有启用 Gate 为 `PASS`，总体门禁才为 `PASS`。

## 评级与严重级别

评级基于启用 Gate 状态和审计证据完整性，等级为 `S/A/B/C/D/F`：所有启用 Gate PASS 取 `S/A`；无 FAIL
但有 BLOCKED 取 `B/C`；出现 FAIL 取 `D/F`。所有发现按 `Critical / High / Medium / Low / Info` 标级，
未解决的 `Critical/High` → 对应 Gate `FAIL`；`Medium` 是否阻断必须逐条解释；`Low/Info` 不单独导致
FAIL，但可能使评级从 S 降为 A。

`DISABLED` 不降低评级，也不计入 PASS 数；因此 `--linear off` 时可以在两个启用 Gate 全部高质量通过后获得 `S/A`。只有总体门禁 `PASS` 且等级为 `S/A`，才输出“建议通过”。

完整评级判据表、各严重级别定义与降级封顶规则见 `references/severity-and-grading.md`——那是唯一权威表。

## 执行期约定：参数固化（强制）

**每次 `bash` 调用都是新 shell，环境变量不跨调用保留。** `PR`、`ROOT`、`WT`、`HEAD_OID`、`BASE_OID`
出现在 fetch、worktree 与 diff 命令里，没赋值就是空串：`git worktree add --detach "" ""` 与
`git diff "..."` 会在空参数上失败或作用到错误的对象。所以先固化，再执行。本节是参数模板的
**唯一权威来源**，`references/` 不重复给模板。

```bash
set -euo pipefail; umask 077
PR=123; LINEAR=off                       # LINEAR=on|off，对应 --linear
ROOT=$(git rev-parse --show-toplevel) || { echo "STOP: 不在 git 仓库内"; exit 1; }
ENVFILE="/tmp/pi-pr-audit-pr-${PR}.env"
OUT=$(umask 077; mktemp "/tmp/pi-pr-${PR}-audit.XXXXXX.json")
cat > "$ENVFILE" <<EOF
export PR='$PR' LINEAR='$LINEAR' ROOT='$ROOT' OUT='$OUT' ENVFILE='$ENVFILE'
export GIT_PAGER=cat GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
EOF
# 现场追加（Phase 1 冻结后／建 worktree 后／Gate 2.1 定位 Issue 后）
cat >> "$ENVFILE" <<EOF
export HEAD_OID='<headRefOid>' BASE_OID='<baseRefOid>' HEAD_REF='<headRefName>'
export WT='<审计 worktree 绝对路径>' ISSUE='<TEAM-123>' ISSUE_JSON='<Issue JSON 路径>'
EOF
```

- 每次 `bash` 调用首行 `set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env`，再按阶段
  `: "${VAR:?}"` 断言这一步之前已固化的变量。source 的是**字面路径**：`ENVFILE` 只存在于该文件
  内部，`. "$ENVFILE"` 在新 shell 里等于 `. ""`，什么都不 source。
- `ENVFILE` 必须写进它自己；上面三段就是 env 文件的完整内容清单，算出值的那次调用负责落盘。
- 临时文件一律 `mktemp` + `umask 077`。**禁止 `/tmp/pr-<N>-audit.json` 这种固定名**：那是可预测的
  world-readable 路径，装着私有仓库的 PR body / files / reviewDecision，并发会话还会互相覆盖。
- **所有闸门一律写成 `cmd || { echo "STOP: ..."; exit 1; }`。** 裸命令单占一行、`cmd && echo "STOP"`
  和 `cmd || echo "STOP"` 都不会中止流程——「STOP」只是一行字符串。需要「必须无命中」时先收进变量
  再判空：`HIT=$(cmd || true); [ -z "$HIT" ] || { echo "STOP: ..."; exit 1; }`。
- 探测与闸门必须区分：探测用 `... && echo yes || echo no`，永不中止；闸门必须能 `exit 1`。
- git 命令一律 `git -C "$ROOT"` 或 `git -C "$WT"`，禁止裸 `git`，禁止靠 `cd` 保证工作目录；
  diff/show/log 一律 `--no-pager`。
- **禁止 `${VAR,,}`、`${VAR^^}` 等 bash 4 专有语法**（本 Skill 声明 `portability: project-agnostic`，
  macOS 自带 bash 3.2 会直接语法错）。要小写用 `tr 'A-Z' 'a-z'`。

## Phase 0：只读与环境预检

先确认当前环境，不修改仓库：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${PR:?}" "${ROOT:?}" "${OUT:?}"
git -C "$ROOT" status --short --branch
git -C "$ROOT" remote -v
gh auth status
node --version
find "$ROOT/.." -maxdepth 3 \( -name AGENTS.md -o -name CLAUDE.md \) -print
```

必须遵守：

- 阅读仓库根目录及受影响模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*` 和安全说明。
- 记录主工作区 dirty 状态；不得 reset、clean、stash 或覆盖。
- 不在主工作区 checkout PR head，不修改当前分支。
- 不运行会写外部状态的命令：`gh pr comment/review/edit/merge/close/ready`、push、部署、发布、Linear mutation。
- 测试或扫描可能生成本地文件时，使用隔离 worktree；结束默认保留，除非确定由本 Skill 新建且用户同意清理。
- 不自动安装未知工具，不执行 PR 中新增且未经阅读的任意脚本。

## Phase 1：冻结 PR 审计对象

读取 PR 元数据并保存到临时 JSON，避免终端截断：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${PR:?}" "${OUT:?}" "${ENVFILE:?}"
gh pr view "$PR" --json number,url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner,author,mergeable,reviewDecision,statusCheckRollup,commits,files,additions,deletions > "$OUT"
HEAD_OID=$(jq -r .headRefOid "$OUT"); BASE_OID=$(jq -r .baseRefOid "$OUT"); HEAD_REF=$(jq -r .headRefName "$OUT")
[ -n "$HEAD_OID" ] && [ "$HEAD_OID" != null ] && [ -n "$BASE_OID" ] && [ "$BASE_OID" != null ] \
  || { echo "STOP: 冻结 oid 解析失败，审计对象不确定"; exit 1; }
printf "export HEAD_OID='%s' BASE_OID='%s' HEAD_REF='%s'\n" "$HEAD_OID" "$BASE_OID" "$HEAD_REF" >> "$ENVFILE"
printf 'HEAD_OID=%s BASE_OID=%s\n' "$HEAD_OID" "$BASE_OID"
```

用 `read` 分段读完。至少记录：PR URL / title / body / state / draft；base 与 head 分支及
**base/head OID**；fork 与 owner 信息；commits 与 changed files；CI checks 的成功/失败/跳过/运行中
状态；mergeability 与 review decision（只作上下文，不替代审计）。

验证 PR 为 `OPEN`；draft 可以审计，但报告标记为 draft。审计开始后以 `headRefOid` 为冻结版本。

获取对象而不 checkout 主工作区。先 fetch 精确 base，再抓取 PR head 到 `FETCH_HEAD`，避免创建长期本地分支/ref：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${ROOT:?}" "${PR:?}" "${OUT:?}" "${HEAD_OID:?}" "${BASE_OID:?}"
BASE_REF=$(jq -r .baseRefName "$OUT")
git -C "$ROOT" fetch origin "$BASE_REF" || { echo "STOP: 无法抓取 base"; exit 1; }   # 只更新 FETCH_HEAD，不建长期 ref
git -C "$ROOT" fetch origin "pull/${PR}/head" || { echo "STOP: 无法抓取 PR head"; exit 1; }
test "$(git -C "$ROOT" rev-parse FETCH_HEAD)" = "$HEAD_OID" \
  || { echo "STOP: FETCH_HEAD 不等于冻结 head oid，审计对象不可信"; exit 1; }
git -C "$ROOT" cat-file -e "${HEAD_OID}^{commit}" || { echo "STOP: 冻结 head oid 不可达"; exit 1; }
git -C "$ROOT" cat-file -e "${BASE_OID}^{commit}" || { echo "STOP: base oid 不可达"; exit 1; }
```

这三个闸门必须带 `|| { ...; exit 1; }`。写成裸 `test ...` / 裸 `git cat-file -e` 时，不匹配只是一个被
忽略的非零退出码，流程照常带着**别人的 commit** 走完整场审计，报告里的 `branch@oid` 是假的。

若平台/ref 不支持，使用只读 `gh pr diff` 保存 patch，并说明无法运行 head 代码时 Gate 可能 BLOCKED。不要信任同名本地 branch 或未核验的 `FETCH_HEAD` 代表 PR head。

建立隔离 worktree（需要执行测试/扫描时）：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${ROOT:?}" "${PR:?}" "${HEAD_OID:?}" "${ENVFILE:?}"
WT="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-audit"
test ! -e "$WT" || { echo "STOP: worktree 路径已存在，归属不明，询问用户"; exit 1; }
git -C "$ROOT" worktree list --porcelain
git -C "$ROOT" worktree add --detach "$WT" "$HEAD_OID" || { echo "STOP: worktree 建立失败"; exit 1; }
test "$(git -C "$WT" rev-parse HEAD)" = "$HEAD_OID" \
  || { echo "STOP: worktree HEAD 与冻结 oid 不一致"; exit 1; }
printf "export WT='%s'\n" "$WT" >> "$ENVFILE"; echo "$WT"
```

裸 `test ! -e "$WT"` 是**假保护**：路径已存在时它只返回非零，随后的 `worktree add` 照样执行或报错，
而「路径已存在时不要删除或复用未知目录」这条规则从未真正生效。`linear-pr-audit` 明确依赖本条
（「按 `pr-audit` 的规则询问用户」），所以它必须能 `exit 1`。

路径已存在时不要删除或复用未知目录；询问用户或选取经确认的新路径。所有测试和扫描在冻结 head worktree 中运行。

## Phase 2：定义变更面

使用精确 OID 比较，不用易漂移的分支名：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${WT:?}" "${BASE_OID:?}" "${HEAD_OID:?}"
D="${BASE_OID}...${HEAD_OID}"
git -C "$WT" --no-pager diff --stat "$D"
git -C "$WT" --no-pager diff --name-status "$D"
git -C "$WT" --no-pager diff --check "$D"
git -C "$WT" --no-pager diff --find-renames "$D"
```

阅读完整 diff；输出很长时保存临时文件并用 `read` 分段读完。识别：生产代码/测试/配置/
schema-migration/生成文件/依赖与 lockfile 的分布；public API、权限、数据流、异步任务与外部调用的
变化；新增或删除的测试与实现的对应关系；PR body 声明但 diff 未体现、或 diff 超出声明的内容。

二进制、大生成文件、vendor 或无法查看的子模块必须列为审计限制。

## Gate 1：Correctness

### 1.1 静态代码审阅

沿变更调用链逐项检查，检查项清单见 `references/verification-commands.md` §静态代码审阅检查项
（实现侧七类 + 测试质量三类）。发现必须附 `file:line`、触发条件、实际影响和建议修复方向。

### 1.2 选择验证命令

按证据选择，不猜：

1. 项目 Agent/贡献/CI 文档明确命令。
2. CI workflow、Makefile、Taskfile、package scripts、语言构建配置。
3. 受影响模块的既有测试模式。

最低努力：

- 与改动直接相关的单元/回归测试
- 项目已有 lint/format check
- 项目已有 typecheck/compile/build
- 适用时 schema/migration/generated-code 校验

先阅读命令对应脚本。如果 PR 修改了脚本，比较 base 与 head，避免盲目执行新增的危险 shell、下载或部署动作。命令涉及生产、外部写入、凭据上传或未知 installer 时不运行，标记 BLOCKED 并解释。

各语言栈的命令识别示例、monorepo 逐包收敛、时间预算与每条命令的状态记法见 `references/verification-commands.md`。

### 1.3 CI 交叉验证

- 对照 `statusCheckRollup`，记录 required/相关 checks 的结论。
- pending/cancelled/skipped 不算 PASS。
- CI 与本地结果冲突时 Gate 至少 BLOCKED；若已复现失败则 FAIL。
- CI 未覆盖改动模块时不能因“绿色”直接通过。

### 1.4 Correctness 判定

`PASS` 至少要求：

- 完整阅读相关 diff 和调用链；
- 必要的目标测试通过；
- 项目要求的静态检查/编译通过；
- 测试能覆盖修改意图；
- 没有未解决的阻断正确性发现。

关键命令因工具/依赖/权限无法运行，且 CI 也无等价可信证据 → `BLOCKED`，不是 PASS。

## Gate 2：Requirements（可关闭）

### 2.0 边界与开关

本 Gate 只回答**静态存在性**：每个原子需求有没有可指认的实现代码，有没有可指认的对应测试。它**不**回答验收标准在冻结 head 上跑不跑得通——本 Skill 全程只读，不执行验收场景，也不据此判定验收成败。可执行验证的分工见 2.4。

- `--linear off`：状态直接记为 `DISABLED`，不读取 Linear，不影响评级，不计入 PASS 分母。
- `--linear on`：必须完成本 Gate。找不到唯一 Linear Issue、凭据缺失或关键文档不可访问时为 `BLOCKED`。

### 2.1 确定 Linear Issue

从以下来源收集完整 identifier：

- 用户输入中除 PR 之外明确给出的 `TEAM-123`
- PR title/body
- commit messages
- branch name

只有一个唯一候选才继续。零个或多个候选时询问用户，不按相似度选择。裸数字只有配置 `LINEAR_TEAM_KEY` 才补全。

使用 `linear-to-pr` Skill 同目录的脚本逻辑获取数据。如果可发现的已安装 `linear-to-pr` Skill 路径未知，可通过 Pi 已提供的 Skill 列表定位并读取；不要假定其绝对路径。脚本调用示例：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${ENVFILE:?}"
ISSUE='<TEAM-123>'
ISSUE_LOWER=$(printf '%s' "$ISSUE" | tr 'A-Z' 'a-z')   # 不用 ${ISSUE,,}：那是 bash 4 专有语法
ISSUE_JSON=$(umask 077; mktemp "/tmp/pi-${ISSUE_LOWER}-pr-audit-linear.XXXXXX.json")
node <linear-to-pr-skill-dir>/scripts/fetch-linear-issue.mjs "$ISSUE" --max-comment-chars 0 > "$ISSUE_JSON"
HIT=$(jq -r '.comments[] | select(.bodyTruncated == true) | "#\(.sequence)"' "$ISSUE_JSON" || true)
[ -z "$HIT" ] || { printf 'STOP: 以下评论正文被截断，需求可能丢失：\n%s\n' "$HIT"; exit 1; }
printf "export ISSUE='%s' ISSUE_JSON='%s'\n" "$ISSUE" "$ISSUE_JSON" >> "$ENVFILE"
```

`${ISSUE,,}` 是 bash 4 专有语法，macOS 自带的 bash 3.2 直接语法错，与本 Skill 的
`portability: project-agnostic` 冲突；一律用 `tr`。`fetchMetadata.truncated` 只反映**分页**截断，
正文截断单独标在 `comments[].bodyTruncated`，所以抓取要传 `--max-comment-chars 0` 并加上这道闸门。

用 `read` 分段读完 description、全部 comments、attachments 和 documentLinks。要求与 `linear-to-pr` 一致：评论数完整、按时间线审阅、冲突有明确处理、决定实现的文档可访问。

### 2.2 建立需求追踪矩阵

将最终有效口径拆成原子需求；不得只比较 PR title 与 Issue title：

| 需求 ID | 最终需求与来源 | 实现证据 | 测试/验证证据 | 结论 |
|---|---|---|---|---|
| R1 | `[正文/评论/文档]` | `file:line` | `test:line / command` | 完整/部分/缺失/越界 |

结论只按证据**存在与否**给：实现与测试证据都能指认为「完整」，只有其一为「部分」，两者都指认不到为「缺失」，超出确认口径为「越界」。不要因为「测试大概覆盖不到边界」这类未经执行的推测下调结论——那是门 4 的判据。

检查（一律只问「有没有」，不问「跑不跑得通」）：

- 每个原子需求是否有可指认的实现证据 `file:line`
- 每个原子需求是否有可指认的测试/验证证据 `test:line` 或命令
- 角色、权限、状态、边界、错误场景是否各有对应实现落点
- 评论/PRD 的最终修订是否在 diff 中有对应改动
- 是否实现了未经确认的范围
- UI 文案、API、schema、migration、配置是否协同完整
- PR 测试是否指向需求描述的行为，而不仅是内部函数

可按需调用 `feature-trace` 辅助定位，但必须基于冻结的 PR head，并自行完成最终矩阵。

### 2.3 Requirements 判定

- 所有原子需求都有可指认的实现证据和测试/验证证据，未出现未授权范围 → `PASS`。
- 实现证据或测试证据明确缺失，或实现与最终口径直接冲突 → `FAIL`。
- Issue/评论/文档不完整或无法唯一判定，或矩阵有行无法确定证据是否存在 → `BLOCKED`。

“看起来合理”或“PR 描述声称已完成”不是 PASS 证据。

本 Gate 的 `PASS` 只声明**静态可追溯性成立**，不声明验收标准已被实际执行并通过。缺少可执行证据时记 `BLOCKED` 或在报告的未验证项中说明，**不**据此判 `FAIL`。

### 2.4 与 linear-pr-audit 门 4 的分工

| Gate | 问题 | 证据形态 | 归属 |
|---|---|---|---|
| Requirements（门 2） | 每条需求**有没有**实现代码和对应测试 | 静态追踪矩阵，`file:line` | 本 Skill |
| Acceptance（门 4） | 每条**验收标准**在冻结 head 上**跑不跑得通** | 可复现命令 + 实际输出 + 失败基线 | `linear-pr-audit` |

因此：

- 需要可执行的验收结论时改用 `/skill:linear-pr-audit <PR> <TEAM-N>`，它在本 Skill 三门之上叠加门 4，要求 4/4 PASS。
- 本 Skill 只读，无法运行验收场景，也不会自行给出「验收通过/未通过」的结论。
- 门 4 的实测结论可以推翻本 Gate 的静态判定（矩阵某行由「完整」下调为「部分」）。该仲裁表由 `linear-pr-audit` 持有并执行，本 Skill 不预判、也不改写其结论。

## Gate 3：Security

安全 Gate 由“人工 diff 审计 + 项目既有扫描器”共同组成。人工审阅按三个阶段推进：先摸清本仓库自己的安全基线，再判偏离，最后才走数据流。**不得**把外部通用最佳实践直接当成本仓库的既定标准。

### 3.1 阶段一：勘察仓库既有安全框架

先只读地找出仓库中**已经存在**的安全机制与既定写法，此阶段不看 diff：

- 认证/鉴权中间件、权限装饰器、策略引擎、租户隔离层的落点
- 输入校验与转义/清洗 helper（validator schema、sanitizer、参数化查询封装、模板自动转义）
- secret 与配置的既定取用方式、密码学封装
- 既有安全测试、安全相关 lint 规则、CI 中的安全 job
- `AGENTS.md`、`CLAUDE.md`、`SECURITY*`、`CONTRIBUTING*` 中写死的安全约定

产出基线清单：每条写 `file:line` 与适用场景。若仓库确实没有任何既定模式，这本身是一条结论：说明无可比基线，后续偏离判定降为 `Info` 观察项。

### 3.2 阶段二：对照基线判偏离

把变更面逐项与基线清单比对。报告的是**偏离本仓库既定实践**，不是偏离通用最佳实践：

- 新代码是否绕过既有 helper，自己手写校验、转义或字符串拼接
- 新端点/新任务是否接入既有鉴权与租户隔离层
- 是否引入与既定模式并行的第二套写法（框架分叉）
- 既有安全控制是否被削弱、放宽或删除
- 新依赖、新配置是否绕开既定的 secret 与权限约定

每条偏离写明：偏离了哪条基线（`file:line`）、新写法在哪（`file:line`）、可利用后果。基线本身不安全时另开 `Info` 观察项，不算本 PR 引入。

### 3.3 阶段三：数据流与权限边界

只针对本 PR 触及的路径，沿不可信输入到敏感操作核查：

- 入口：HTTP 参数/body/header、webhook、上传、消息队列、CLI 参数、第三方响应、库中用户可控内容
- 传播：是否经过基线清单里的校验/转义节点；是否在信任边界上被误判为可信
- sink：SQL/命令/文件路径/模板/反序列化/动态执行/网络请求/日志与响应体
- 权限边界：调用链上每次跨越租户、角色、对象所有权时，是否有默认拒绝的判定点
- 状态与时序：竞态、TOCTOU、事务边界、安全状态失配

按改动类型反查威胁类别与典型 sink 的对照表见 `references/security-threat-checklist.md`；它是查表工具，不是必须逐条勾选的清单。

只报告 PR 新增或显著恶化的问题；既存问题可列为观察项，并明确不是本 PR 引入。

### 3.4 Secret 扫描

优先运行项目已配置的工具（gitleaks、detect-secrets、trufflehog 等仓库模式）。扫描范围必须同时覆盖 `base...head` 最终 diff 与 PR 全部 commits（避免最终 diff 已删除但历史仍含 secret）。

没有项目工具时可做高置信模式与熵线索审阅，但不得把简单 grep 表述成完整 secret scanner。发现疑似真实 secret 时不复述完整值，只给文件、行号和脱敏指纹；Gate 至少 `FAIL`，并建议轮换。

### 3.5 SAST 与依赖扫描

从项目配置发现并运行已有工具。工具目录、配置证据来源与 finding 处理表见 `references/security-threat-checklist.md`。硬性规则：

- 不自动安装未知工具，不全局下载未知 scanner。
- 项目明确要求的 scanner 缺失/无法运行 → Security `BLOCKED`。
- 项目没有专用 scanner → 完成人工审阅，并运行环境已有且与项目可信配置一致的工具；报告“扫描覆盖有限”。若无未验证高风险面可以 PASS，但最高评级 A，不能 S。
- 依赖网络失败记为工具 BLOCKED，不伪装成“无漏洞”。
- 新增依赖须区分 direct/transitive、runtime/dev 与漏洞可达性；不能只粘贴 audit 数量。
- scanner finding 必须去重、验证上下文并标记 true/false positive。

### 3.6 Security 判定

`PASS` 要求：

- 已完成三阶段人工审阅，且基线清单与偏离结论均有 `file:line`；
- 项目要求的安全扫描均成功，或项目没有要求且覆盖限制已清晰评估；
- 无未解决的 Critical/High；
- Medium 已逐项判断是否阻断。

关键安全面无法查看、项目要求 scanner 未运行、fork/生成物导致审计不完整 → `BLOCKED`。

## Phase 4：一致性与漂移检查

在最终报告前再次读取 PR：

```bash
set -euo pipefail; . /tmp/pi-pr-audit-pr-<PR>.env
: "${PR:?}" "${HEAD_OID:?}"
FINAL=$(gh pr view "$PR" --json headRefOid,state,statusCheckRollup --jq .headRefOid)
gh pr view "$PR" --json headRefOid,state,statusCheckRollup
[ "$FINAL" = "$HEAD_OID" ] || echo "DRIFT: head 已从 $HEAD_OID 漂移到 $FINAL —— 总体 BLOCKED"
```

- `headRefOid` 与冻结值不同：审计已过期。总体 `BLOCKED`，不得沿用旧结论；询问是否对新 head 重跑。
- PR 已关闭/合并：报告状态变化，不给“建议合并”。
- CI 新增失败/pending：更新 Correctness 结论。

## Phase 5：计算门禁与评级

若发现 `Critical` 或 `High` 问题，应先输出阻断摘要；不要为了凑齐报告而继续执行与结论无关、耗时或有风险的命令。已经安全取得的其他 Gate 证据仍应报告，未继续的项明确标为 `BLOCKED/未执行`。

按以下顺序，不凭主观印象跳级：

1. 统计启用 Gate 数：Linear on 为 3，off 为 2。
2. 统计 `PASS/FAIL/BLOCKED/DISABLED`。
3. 计算总体门禁：
   - 任一启用 Gate FAIL → `FAIL`
   - 否则任一启用 Gate BLOCKED → `BLOCKED`
   - 否则全部启用 Gate PASS → `PASS`
4. 按评级表给 S/A/B/C/D/F。
5. 输出明确建议：
   - `PASS + S/A` → `建议通过`
   - `BLOCKED` → `暂缓，补齐证据后重审`
   - `FAIL` → `不建议通过，修复后重审`

禁止用总分平均掉安全或正确性失败。

## 输出模板

完整报告骨架、11 段的固定顺序与填写规则见 `references/output-template.md`——**那里是唯一权威模板**，
本节不复述段落清单。段落顺序不得改动，无内容的段写「无」而不是删掉；「结论」段的门禁、等级、建议
三者必须同时出现并互相自洽，并附 Gate 状态表与 `实际 PASS 数/启用 Gate 数`。

## 完成前硬检查

- [ ] PR base/head 使用精确 OID，最终检查无漂移。
- [ ] 阅读完整相关 diff，而非只看 PR 描述或文件统计。
- [ ] Correctness 同时包含代码审阅、测试质量和静态命令证据。
- [ ] Linear on 时读完正文、全部评论和关键文档，并形成逐项矩阵。
- [ ] Requirements 结论只依据实现/测试证据的存在性，没有给出未经执行的验收成败判断。
- [ ] Linear off 时 Requirements 为 DISABLED，结果按 2 Gate 计算。
- [ ] Security 走完三阶段（既有基线勘察、偏离判定、数据流与权限边界）并跑了适用 scanner；工具缺失没有误报 PASS。
- [ ] 每个发现有严重级、Gate、文件行号、影响和依据。
- [ ] FAIL/BLOCKED 没有被平均分掩盖。
- [ ] 报告只输出到 Pi，没有执行外部写操作。

## 立即停止并询问

- PR 无法唯一定位、仓库/URL 不一致或 PR head 无法冻结。
- worktree 路径已存在且归属不明。
- 需要执行未经审阅的新增脚本、下载工具、使用生产凭据或访问生产环境。
- Linear on 但 Issue 不唯一或关键需求文档决定实现且不可访问。
- PR 审计期间 head 漂移，需要用户决定是否重跑。

除这些安全/证据阻塞外，应完成审计并直接输出报告，不在每个本地只读测试前重复询问。

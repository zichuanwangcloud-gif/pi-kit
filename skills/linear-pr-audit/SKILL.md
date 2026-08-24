---
name: linear-pr-audit
description: 在 pr-audit 三门审计之上叠加 Acceptance 验收门，逐条读取 Linear 需求的验收标准并用可执行测试或可复现命令实际验证；未通过时重点说明缺口并与用户确认，确认后可在隔离 worktree 修复实现、推送修复并复验，直到 4/4 PASS 后按固定模板生成自测报告并发送到 Linear Issue 评论区。用于“审计 PR 是否满足 Linear 验收标准”“验收全过后回写自测报告”“帮我把这个 PR 的验收跑通”等请求。
compatibility: Requires git, Node.js 18+, authenticated gh CLI with push access to the PR head branch, and LINEAR_API_KEY or ~/.config/pi/linear-api-key with comment-write scope. Test and scan commands are discovered from repository configuration.
allowed-tools: read bash edit write invoke_skill
metadata:
  category: pull-request-audit
  portability: project-agnostic
---

# Linear PR Audit：四门审计与验收闭环

在 `pr-audit` 的 Correctness / Requirements / Security 三门之上，叠加第四门 **Acceptance（验收门）**：
把 Linear 需求里的验收标准逐条拆开，用**可执行证据**验证它在当前 PR head 上是否真的成立。

```text
冻结 PR → 三门审计 → 提取验收标准 → 验收计划（用户确认一次）
→ 逐条可执行验证 → 未过则说明缺口并修复 → 推送修复并复验
→ 4/4 PASS → 生成自测报告 → 发送到 Linear Issue 评论区
```

与 `pr-audit` 的区别：`pr-audit` 始终只读、只输出到 Pi。本 Skill 会写临时测试、可能修改实现、
推送修复 commit、并回写 Linear 评论；因此它有一个明确的授权闸门，且默认不 push、不修改 PR 状态、
不部署、不触碰主工作区，所有写操作都限定在下文列出的范围内。

## 与 pr-audit 的职责分工

两个门看起来相邻，但问的不是同一个问题，不要重复劳动：

| Gate | 问题 | 证据形态 |
|---|---|---|
| Requirements（门 2，由 `pr-audit` 产出） | 每条需求**有没有**实现代码和对应测试 | 静态追踪矩阵，`file:line` |
| **Acceptance（门 4，本 Skill 新增）** | 每条**验收标准**在冻结 head 上**跑不跑得通** | 可复现命令 + 实际输出 |

门 4 直接复用门 2 已产出的需求追踪矩阵作为输入，只挑出其中属于**验收标准**的条目做可执行验证，
不重新通读一遍 Linear，也不重建矩阵。

因为验收标准是本 Skill 的存在前提，Linear 对比恒定开启，没有 `--linear off`。无法唯一定位 Linear
Issue 时停止询问，不降级为三门审计。

## 输入

```text
/skill:linear-pr-audit 123 TEAM-456
/skill:linear-pr-audit https://github.com/org/repo/pull/123 TEAM-456
/skill:linear-pr-audit 123                    # 从 PR body / 分支名推断 identifier
/skill:linear-pr-audit 123 TEAM-456 --max-rounds 2
```

参数：

- 第一个位置参数：PR 编号或完整 URL；省略时用 `gh pr view` 定位当前分支的唯一 PR。
- 第二个位置参数：Linear identifier。省略时从 PR body、PR title 和 head 分支名中提取；提取不到
  或提取到多个时停止询问，不猜。
- `--max-rounds N`：修复复验循环的最大轮次，默认 `3`。
- `--no-post`：完成全部验证但不发送 Linear 评论，只在 Pi 输出报告。

出现未知参数、重复冲突开关或多个 PR/Issue 标识时停止，不猜测。

## 授权模型：确认一次

Phase 3.3 会输出「验收清单 + 验证计划 + 授权复述」。用户确认这一次，即授权后续全部动作，
**不得再为每一步重复询问**：

**已授权**：

- 在隔离 worktree 内编写并运行临时验收测试
- 在隔离 worktree 内修改实现代码以满足已声明的验收标准
- 每轮展示完整 staged diff 后，普通推送修复 commit 到 PR 的 head 分支
- 4/4 PASS 后向 Linear Issue 评论区发送自测报告

**未授权**（任何确认都不包含）：

- 禁止 force push；禁止推送受保护分支；禁止 refspec 指向 base
- 合并、approve、ready、关闭 PR，或修改 PR title/body/base
- 修改 Linear 的状态、字段、标签、验收标准本身
- 部署、发布、访问生产环境
- 提交临时验收测试
- 修改或删除既有测试

即使首轮就 4/4 PASS、完全不需要修复，也必须先通过这个闸门才能发送 Linear 评论。

## 状态模型

### 单条验收标准（AC）

| 状态 | 判定 |
|---|---|
| `PASS` | 有可复现的执行证据证明通过 |
| `FAIL` | 已执行，结果不符合验收标准 |
| `BLOCKED` | 本身可验证，但环境、凭据或依赖缺失 |
| `UNVERIFIABLE` | 本质上无法在本环境验证（依赖真实第三方支付、线上流量、硬件等） |

标记 `UNVERIFIABLE` 必须同时写明三项，缺一不可，否则一律按 `BLOCKED` 处理：

1. 为什么本质上不可验证；
2. 已经尝试过哪些替代手段（mock、stub、录制回放、契约测试）以及为什么不成立；
3. 需要谁在什么环境人工验证。

`UNVERIFIABLE` **不计入 PASS 分子**。存在即 Acceptance Gate 至多 `BLOCKED`，不发送自测报告。
只有用户对具体某条明确人工签核后才转 `PASS(waiver)`，并在报告中永久保留 waiver 记录和签核人。

### Gate

四个 Gate 均为 `PASS` / `FAIL` / `BLOCKED`，没有 `DISABLED`。Acceptance 聚合规则：

- 全部 AC 为 `PASS`（含 `PASS(waiver)`）→ `PASS`
- 任一 AC 为 `FAIL` → `FAIL`
- 否则 → `BLOCKED`

## 通过规则与评级

- 四门都必须 `PASS`，即 **4/4 PASS**。
- 任一 Gate `FAIL` → 总体 `FAIL`；无 `FAIL` 但任一 `BLOCKED` → 总体 `BLOCKED`；全部 `PASS` → 总体 `PASS`。
- 评级沿用 `pr-audit` 的 `S/A/B/C/D/F` 表，分母改为 4。
- 只有总体 `PASS`、Acceptance 无 waiver、且最终 head 校验通过时，才发送自测报告。
- 禁止用总分平均掉任何一门的失败。

## Phase 0：环境与可写性预检

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
gh auth status
node --version
find .. -name AGENTS.md -o -name CLAUDE.md
```

阅读仓库根目录及受影响模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*` 和安全说明。记录主工作区
dirty 状态；不得 reset、clean、stash 或覆盖，全过程不触碰主工作区的任何改动。

Linear 凭据按顺序解析：`LINEAR_API_KEY` → `LINEAR_API_KEY_FILE` → `~/.config/pi/linear-api-key`。
不打印、不记录、不提交 API key。缺失时停止。

## Phase 1：冻结 PR 与判定可写性

```bash
PR=123
OUT="/tmp/pr-${PR}-acceptance.json"
gh pr view "$PR" --json number,url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner,headRepository,maintainerCanModify,author,mergeable,reviewDecision,statusCheckRollup,files > "$OUT"
```

用 `read` 分段读完。验证 PR 为 `OPEN`；`CLOSED`/`MERGED` 停止。draft 可以审计，报告标记 draft。
记录 `headRefOid` 作为**第 1 轮**的冻结基准。

### 可写性判定

修复要推送到 PR 的 **head 分支**。审计只需要读权限，推送修复需要对 head 分支的写权限，两者不等价。
判定为**不可写**的情况：

- head 仓库与 base 仓库不同（fork PR）且 `maintainerCanModify` 为 false；
- 当前账号对 head 仓库没有 push 权限；
- head 分支名落在受保护分支集合（至少 `main`、`master` 和已确认的 PR base）。

不可写时**降级为只读模式**：仍然完成三门审计和验收验证，验收失败时把已在 worktree 验证通过的修复
输出为 patch（`git format-patch` 或 `git diff`）交给用户，Acceptance 记 `BLOCKED`，
**不发送自测报告**。无法 push 时降级为只读 patch 输出，不得改用其他路径绕过权限。

## Phase 2：执行三门审计

调用 `pr-audit` 取得 Correctness / Requirements / Security 三门结论，Linear 开启：

```text
invoke_skill pr-audit "<PR> --linear on"
```

保留它输出的需求追踪矩阵、Gate 状态、发现清单和冻结 `headRefOid`。校验它冻结的 head 与 Phase 1
一致；不一致说明期间发生漂移，重新开始。

若 `pr-audit` 不可用，按其 SKILL 中的门定义自行完成三门审计，并在报告中注明是自行执行而非调用。

## Phase 3：Acceptance Gate

### 3.1 提取验收标准

从 Phase 2 的需求矩阵中挑出验收标准条目。矩阵不足以覆盖时，用 `linear-to-pr` 同目录脚本补读原始数据：

```bash
ISSUE=TEAM-456
node <linear-to-pr-skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" > "/tmp/${ISSUE}-acceptance.json"
```

拆分规则：一条 AC 必须是**单一、可观察、有明确判定条件**的陈述。把「支持导出并发送邮件通知」拆成
两条。对每条记录来源标注：`[正文]`、`[评论 #序号/作者/日期]`、`[文档/URL]`。

验收标准缺失、只有现象没有期望、或多条评论对同一验收给出冲突口径且无覆盖证据时，停止询问，
不自行发明验收标准。

### 3.2 设计验证方式

按优先级为每条 AC 选择验证形式，并说明为什么不能用更高优先级的方式：

1. **自动化测试**（首选）：新写一个针对该 AC 的测试，遵循项目既有测试框架和模式。
2. **可复现命令**：CLI 调用、HTTP 请求、脚本，附完整命令与实际输出。
3. **数据/状态断言**：查询 schema、配置、生成物、迁移结果。
4. **人工复现步骤**：仅在前三种都不适用时使用，必须给出精确步骤和观察到的结果。

测试必须断言 AC 描述的**用户可观察行为**，不是内部函数返回值；并且要能在修复前的版本上失败。

### 3.3 验收计划闸门

输出并请用户确认一次：

```text
【TEAM-456 / PR #123 验收计划】
三门结论：Correctness PASS / Requirements PASS / Security PASS
验收标准（N 条）：
- AC1 ... [来源]  → 验证方式：自动化测试（<框架>），落点 <临时测试路径>
- AC2 ... [来源]  → 验证方式：可复现命令 `...`
worktree：<路径>（新建，PR head 分支）
临时测试隔离：写入 <目录>，登记到该 worktree 的 .git/info/exclude，不提交
最大复验轮次：3
授权复述：确认后授权写临时测试、修实现、展示 diff 后推送修复到 head 分支、4/4 PASS 后发送 Linear 评论；
不授权 force push、合并/approve/ready、改 Linear 状态、部署、提交临时测试、修改既有测试。
```

用户确认前不创建 worktree、不修改任何代码。

### 3.4 建立 worktree 并隔离临时测试

修复需要推送，因此必须 checkout PR 的 head 分支，不能用 detached HEAD：

```bash
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-acceptance"
test ! -e "$WT"
git worktree list --porcelain
git fetch origin "<headRefName>"
git worktree add "$WT" "<headRefName>"
cd "$WT"
git rev-parse HEAD          # 必须等于本轮冻结的 headRefOid
```

路径已存在时不要删除或复用未知目录，询问用户。

临时验收测试统一写进 worktree 内一个固定目录（例如 `.acceptance-tmp/`），并登记到**该 worktree 的**
`.git/info/exclude`，而不是仓库 `.gitignore`——这样它们既不出现在 `git status`，也不会产生任何 diff：

```bash
echo ".acceptance-tmp/" >> "$(git rev-parse --git-dir)/info/exclude"
```

临时验收测试不提交。若项目测试框架强制要求测试位于特定目录，仍然把文件登记到 `info/exclude`，
并在报告中记录这些文件的完整路径与内容摘要，便于用户日后自行落地。

### 3.5 执行验证

逐条 AC 执行，记录：命令、退出码、关键输出片段、对应 AC 判定。输出很长时保存临时文件并用 `read` 读完。

不运行涉及生产、外部写入、凭据上传或未知 installer 的命令；不自动安装未知工具。这类情况记 `BLOCKED`。

### 3.6 判定

按状态模型给出每条 AC 状态和 Gate 聚合结果。「看起来实现了」「PR 描述声称已完成」「相关单测通过」
都不是 AC 的 PASS 证据——必须有针对该 AC 的可复现执行证据。

## Phase 4：修复复验循环

Acceptance 出现 `FAIL` 时进入循环。整个 `pr-audit` 模型建立在冻结 head 上，而本 Skill 会自己推送
修复、主动制造漂移，因此采用**分轮冻结**：每一轮都有自己的冻结 `oid`。

### 每轮步骤

1. **说明缺口**（重点输出，不要一笔带过）。每条 FAIL 的 AC 都要写清：

   ```text
   [FAIL] AC3：<验收标准原文> [来源]
   - 缺什么：<能力/分支/校验/文案 具体缺失点>
   - 缺在哪：`file:line`（或“完全缺失，应落在 file:line 附近”）
   - 期望：<AC 要求的可观察结果>
   - 实际：<执行得到的结果，附命令与输出片段>
   - 修复方向：<最小改动方案>
   - 影响范围：<会牵动的文件与调用链>
   ```

2. **等待用户确认修复方案**。用户可以选择自行修复、调整方案或叫停。
3. **在 worktree 内修改实现**，遵循项目既有模式，只做让已声明验收标准成立所必需的最小改动。
4. **本地复验**：重跑该 AC 的验证，并重跑项目既有的相关测试、lint、typecheck，确认没有引入回归。
5. **精确暂存并强制自检**：

   ```bash
   git add <仅实现文件...>
   git diff --cached --name-only    # 逐个核对：不得包含临时验收测试目录，不得包含既有测试文件
   git status --porcelain
   git diff --cached                # 完整展示给用户
   ```

6. **提交并普通推送**：

   ```bash
   git branch --show-current        # 必须等于 headRefName，且不在受保护集合
   git commit -m "<project-conventional-message> (<ISSUE>)"
   git push origin "<headRefName>"
   ```

   禁止 `--force`。push 失败时保留 worktree、分支和 commit，报告真实状态并停止。

7. **重新冻结**：`gh pr view "$PR" --json headRefOid` 取得新的 `oid`，必须等于刚推送的本地 HEAD；
   不等说明有他人并发推送，停止。进入下一轮。

### 各门重跑口径

不是每轮都全量重跑四门：

- **Correctness**：每次推送后**必须**重跑；最后一轮基于最终 head 全量重跑。
- **Security**：修复触及安全面（鉴权、输入处理、依赖、配置、外部调用）时重跑；否则沿用并在报告中
  注明沿用的轮次。
- **Requirements**：需求口径未变则沿用，但每轮都要确认修复没有引入超出 Issue 范围的改动。
- **Acceptance**：每轮全部 AC 重跑，不允许只跑上轮失败的那几条。

### 修复范围边界

- 只允许修改让**已声明的验收标准**成立所必需的实现代码。
- **禁止修改或删除既有测试**来让验收「通过」。既有测试与 AC 冲突时停止询问，这是需求问题不是代码问题。
- 禁止无关重构、全仓格式化、依赖升级、扩大 PR 范围。
- 禁止修改验收标准本身或 Linear 上的任何内容。
- 临时验收测试不提交。

### 终止条件

全部 AC `PASS`；或达到 `--max-rounds`；或用户叫停；或修复需要超出 PR 范围；或出现不可写、
head 被他人推动、既有测试与 AC 冲突等停止条件。未达成 4/4 时如实输出当前状态，不发送自测报告。

## Phase 5：最终校验与门禁计算

发送报告前的最后一道闸：

```bash
gh pr view "$PR" --json headRefOid,state,statusCheckRollup
```

- `headRefOid` 必须等于本 Skill 最后一次推送得到的 `oid`（未推送过修复时，等于第 1 轮冻结值）。
  不等说明期间有他人推送，**立即停止、不发送报告**，避免把别人的改动算进自测结论。
- PR 已关闭或合并 → 报告状态变化，不发送。
- CI 新增失败或 pending → 更新 Correctness 结论，重新计算门禁。

然后按顺序计算：统计四门状态 → 总体门禁 → `S/A/B/C/D/F` 评级 → 结论。

## Phase 6：自测报告与 Linear 回写

总体 `PASS`、Acceptance 无 waiver、最终 head 校验通过时，生成报告并发送；否则只在 Pi 输出当前状态。
**验收未全部 PASS 前不发送自测报告。**

报告首行是幂等标记，脚本据此避免重复刷屏：

```text
<!-- pi-kit:linear-pr-audit:PR-<PR编号>:<最终headOid前12位> -->
```

```bash
node <本skill目录>/scripts/post-linear-comment.mjs "$ISSUE" --body-file "/tmp/${ISSUE}-selftest.md" --dry-run
node <本skill目录>/scripts/post-linear-comment.mjs "$ISSUE" --body-file "/tmp/${ISSUE}-selftest.md"
```

先 `--dry-run` 确认 Issue 解析正确且无重复标记，再正式发送。脚本返回 `posted: false` 且
`skipped: duplicate-marker` 时说明同一 head 的报告已存在，不要用 `--allow-duplicate` 强推。

`--no-post` 时跳过发送，只在 Pi 输出完整报告并给出手动发送命令。

## Linear 自测报告模板

```markdown
<!-- pi-kit:linear-pr-audit:PR-123:0123456789ab -->
## 自测报告 · TEAM-456 · PR #123

**结论：验收 5/5 通过 | 门禁 PASS | 等级 A**

### 验收标准逐条结果
| # | 验收标准（来源） | 验证方式 | 证据 | 结果 |
|---|---|---|---|---|
| AC1 | ... [正文] | 自动化测试 | `<命令>` → 通过 | PASS |
| AC2 | ... [评论 #3] | 可复现命令 | `<命令>` + 输出摘要 | PASS |

### 四门状态
| Gate | 状态 | 关键证据 |
|---|---|---|
| Correctness | PASS | ... |
| Requirements | PASS | ... |
| Security | PASS | ... |
| Acceptance | PASS | 5/5 |

### 复验轮次
- 第 1 轮（head `abc123def456`）：AC3 FAIL — <缺口摘要> → 修复 `file:line`
- 第 2 轮（head `0123456789ab`）：5/5 PASS

### 本次审计推送的修复 commit
<!-- 让人类 reviewer 知道 PR 中哪些改动出自审计者之手；没有则写“无” -->
- `<sha>` <message>

### 验证方式说明
- 临时验收测试仅在隔离 worktree 中运行，未提交进本 PR。路径与摘要：...

### 未验证项与限制
- ...

### 审计元信息
- 冻结 head：`<最终 oid>`
- PR：<url>
```

Pi 侧输出在此基础上追加：三门的完整发现清单、每条 AC 的完整命令与输出、评级依据、
以及本次所有写操作的清单（新建 worktree、临时文件、推送的 commit、发送的评论 URL）。

## 完成前硬检查

- [ ] Linear Issue 唯一确定，验收标准逐条拆分且有来源标注。
- [ ] 每条 AC 有可复现的执行证据，不是「看起来实现了」。
- [ ] `UNVERIFIABLE` 的三项说明齐全，且未计入 PASS 分子。
- [ ] 三门结论来自 `pr-audit` 或等价审计，且与最终 head 对应。
- [ ] 每轮 push 前展示了完整 staged diff，且不含临时验收测试和既有测试文件。
- [ ] 没有为了让验收通过而修改既有测试。
- [ ] 最终 `headRefOid` 等于本 Skill 最后一次推送的 oid。
- [ ] 报告列出了本次审计推送的全部修复 commit。
- [ ] 未达 4/4 PASS 时没有发送 Linear 评论。
- [ ] 全过程未 force push、未修改 PR 状态、未改 Linear 字段、未部署、未触碰主工作区。

## 立即停止并询问

- PR 无法唯一定位、已关闭/合并，或 head 无法冻结。
- Linear Issue 不唯一、凭据缺失，或决定验收的文档不可访问。
- 验收标准缺失、只有现象没有期望，或多方口径冲突且无覆盖证据。
- fork PR 或对 head 分支无 push 权限（降级为只读 patch 输出后停止）。
- head 分支落在受保护分支集合。
- worktree 路径已存在且归属不明。
- 修复需要超出 PR 范围，或既有测试与验收标准直接冲突。
- 达到最大复验轮次仍未 4/4 PASS。
- 审计期间 head 被他人推动。
- 需要执行未经阅读的新增脚本、下载工具、使用生产凭据或访问生产环境。

除这些阻塞外，用户确认验收计划后应连续完成验证、修复、推送、复验和回写，不在每一步前重复询问。

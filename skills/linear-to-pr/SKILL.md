---
name: linear-to-pr
description: 根据一个 Linear Issue 标识读取正文、全部评论、附件和需求文档，输出可追溯的理解卡；用户确认后从目标仓库已确认的远程基线创建隔离 worktree，完成实现、验证、提交、任务分支 push 和 PR。用于“按 Linear 开发”“Issue to PR”“拿 TEAM-123 开工”等请求。
compatibility: Requires git, Node.js 18+, authenticated gh CLI, and LINEAR_API_KEY or ~/.config/pi/linear-api-key. The target repository must have an origin remote and an identifiable PR base branch.
allowed-tools: read bash edit write invoke_skill
metadata:
  category: issue-to-pr
  portability: project-agnostic
---

# Linear to PR：从 Issue 到 Pull Request

输入一个 Linear identifier，完成：

```text
读取需求 → 审阅全部评论/文档 → 定位代码 → 理解闸门 → 用户确认一次
→ 从已确认远程基线创建 worktree → 实现与验证 → 提交并推送任务分支 → 创建 PR
```

理解卡和实施计划确认后，不再为本任务分支的普通 push 和 PR 创建二次询问。

## 输入与可变参数

接受：

- 完整 identifier：`ENG-123`、`APP-42`
- 裸数字或 `#数字`：仅当 `LINEAR_TEAM_KEY` 已配置，或用户在同一请求中明确 team key
- 可选 base：`--base develop`

示例：

```text
/skill:linear-to-pr ENG-123 --base develop
/skill:linear-to-pr 123             # 需要 LINEAR_TEAM_KEY
```

不要假定团队 key、base branch、branch prefix、worktree 根目录、commit scope 或测试命令。如果输入无法唯一解析，先询问。

## 项目约定解析顺序

所有可变约定按以下优先级确定：

1. 用户在当前请求中的明确参数或说明。
2. 目标仓库根目录/目标模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、PR 文档。
3. Git/托管平台证据，例如 `origin/HEAD`、现有 open PR 的 base、当前分支关系。
4. 安全默认；若仍不唯一，询问用户。

将每个最终采用的约定及证据写入实施计划，尤其是 base、受保护分支、任务分支命名和验证命令。

## 必须遵守的安全规则

1. **绝不直接 push 已确认的受保护分支，绝不 force push。** 至少将 `main`、`master` 和已确认 PR base 视为受保护；项目文档或远程规则列出的其他分支也同样保护。
2. 必须先 fetch 已确认 base，并显式从 `origin/<base>` 创建任务分支和独立 worktree，不能使用可能过期的本地分支。
3. 不得修改主工作区，不得清理、stash、reset 或覆盖用户已有改动。主工作区 dirty 可以继续，但必须报告并保持隔离。
4. 进入 worktree 后，所有读写和构建都使用该 worktree 内路径。禁止用主工作区绝对路径读写目标项目。
5. 需求、base、真实代码落点、架构约束或验收不清时停止询问，不能猜。
6. 用户确认理解卡和实施计划，即授权验证通过后自动提交、普通 push 当前任务分支并创建到已确认 base 的 PR。授权不包括 force push、直推受保护分支、合并/approve/ready PR、回写 Linear、部署或其他未说明的外部动作。
7. 不打印、记录或提交 API key。凭据不得写入仓库、PR body 或聊天。
8. 必须阅读全部 Linear 评论，并审阅附件和决定实现的需求文档；未完成前禁止开工。
9. 遵守仓库和目标模块说明。使用项目真实架构，不强加固定分层。
10. 自动化失败时保留 worktree、分支和 commit，报告真实状态，不用更危险的操作兜底。

## Step 0：环境与仓库预检

只检查，不做破坏性处理：

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true
gh auth status
node --version
find .. -name AGENTS.md -o -name CLAUDE.md
```

还应查找当前仓库适用的 `CONTRIBUTING*` 和 PR 文档并用 `read` 阅读。

要求：

- 当前目录位于用户想修改的目标仓库；不以仓库名称硬编码判断。
- `origin` 指向用户预期 remote；若有多个 remote 或托管目标不清，询问。
- `gh` 已认证且目标托管在 GitHub；否则说明当前 Skill 的 PR 创建步骤不兼容并停止。
- Node.js ≥ 18。
- 主工作区状态已记录且后续不触碰其改动。

Linear 凭据按以下顺序读取：

1. `LINEAR_API_KEY`
2. `LINEAR_API_KEY_FILE`
3. `~/.config/pi/linear-api-key`

裸数字的默认 team key 只来自 `LINEAR_TEAM_KEY`，未配置就询问用户提供完整 identifier。不要索要用户把 key 直接发进聊天。

## Step 1：读取 Linear Issue

辅助脚本路径相对于本 Skill：

```text
scripts/fetch-linear-issue.mjs
```

使用完整 identifier，输出到临时文件，避免终端截断：

```bash
ISSUE=ENG-123
OUT="/tmp/${ISSUE,,}-linear.json"
node <skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$OUT"
```

随后用 `read` 分段读取 `$OUT` 到文件末尾。可用 `jq` 建索引，但不能用摘要替代对正文和全部 `comments[].body` 的阅读。

脚本返回：

- `description`
- 按时间排序的完整 `comments`
- `commentCount`
- 只作导航提示的 `requirementRelevantComments`
- `documentLinks`
- `attachments`
- 分页完整性元数据

失败处理：

- `401/403`：提示检查 API key 权限。
- `not found`：确认 identifier，不选择相近 Issue。
- 网络/分页错误：报告并停止，不根据记忆补全。

### Step 1.1：评论、附件和文档审阅（硬闸门）

1. 先读正文，再按 `sequence` 从旧到新阅读每条评论。
2. 建立需求时间线：最初描述、关键补充、验收、链接、后续修订和最终结论。
3. 对潜在 PRD、原型、设计或验收文档：可访问则读取相关内容；登录墙、私有文档、过期附件明确列为缺口。不能凭标题猜内容。
4. 有冲突时列出双方摘要、作者、时间和来源。新评论只有明确覆盖证据时才作为候选最终口径；否则询问。
5. 评论出现新范围但未明确纳入当前 Issue 时，作为范围疑问。

输出：

```text
【TEAM-N 评论/文档审阅】
评论总数：N（已审阅 N）
关键时间线：
- [正文][时间] ...
- [评论 #3][作者][时间] ...
文档/原型/附件：
- [已读取|无法访问] <标题或 URL> — 与需求的关系
冲突与修订：
- 无；或：旧口径 ... ↔ 新口径 ...，当前依据/待确认项 ...
```

只要已审阅数不等于 `commentCount`、分页不完整、决定实现的文档无法访问，或冲突未解决，就不能实施。

## Step 1.5：需求理解闸门

### 1.5.a 定位真实代码路径

使用 `bash` 搜索、`read` 阅读：

- 从项目真实入口追踪 route/command/event/job 到业务与数据/外部依赖。
- 有 UI 时确认路由/导航 → 实际渲染组件 → 用户可见字段。
- 存在旧版/新版、平台覆写、feature flag 或同名候选时，沿注册/import/config 判定实际生效路径。
- 可按需调用 `feature-trace`；未安装时自行完成，不能跳过。

### 1.5.b 输出理解卡

每项附精确来源：`[正文]`、`[评论 #序号/作者/日期]`、`[文档/URL]`、`[代码 文件:行]` 或 `[推断]`。

```text
【TEAM-N 理解卡】
现象/动机：                     ... [来源]
复现或触发路径：                ... [来源]
期望：                          ... [来源]
验收标准：                      ... [来源]
影响面：                        ... [来源|推断]
真实代码落点/调用链：           ... [代码 文件:行]
最终需求口径：                  ... [采用依据]
```

逐项检查：

- 期望是否明确，而不只有现象？
- 正文、全部评论、附件和关键文档是否审阅完？
- 冲突是否解决？
- 是否有可验证验收标准？
- 是否定位唯一生效落点？
- 是否知道触发条件？

处理：

- 0 个缺口：回显理解卡和计划，请用户轻确认。
- 1–2 个缺口：列缺口及带 `[推断]` 的假设，让用户补充或明确同意。
- ≥3 个缺口，或期望/落点主要依赖推断：停止。

用户明确按假设推进时，将假设写入 PR body。

## Step 2：确定 Git 约定与实施计划

### 2.a 确定 base

优先使用显式 `--base`。否则：

1. 查项目文档是否明确开发/PR base。
2. 获取远程默认分支（只读）：

```bash
git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true
gh repo view --json defaultBranchRef
```

若 `origin/HEAD` 未配置，只把它记为信息缺口；不要为了探测运行会修改本地 remote 配置的命令。
3. 必要时查看少量 open PR 的 base 作为辅助证据，但不能仅凭数量覆盖明确文档。
4. 默认分支不一定是日常开发 base；证据冲突或发布流复杂时询问。

### 2.b 确定任务分支和 worktree

- 遵循项目命名规则。
- 无规则时使用中性安全默认：`feature/<issue-lower>-<slug>` 或 `fix/<issue-lower>-<slug>`；类型不清则询问。
- worktree 默认放在主仓库父目录，名称取 `<repo>-<issue-lower>`；先用 `git worktree list` 和 `test ! -e` 验证唯一性。
- 不硬编码 `/opt`、`~/git` 或仓库名称。

计划至少包括：

- base 及证据、保护分支集合
- branch 和唯一 worktree 路径
- 预计修改文件/职责层
- 测试、构建、lint/typecheck 命令及来源
- schema/migration、依赖注入、生成文件等特殊步骤
- 自动 push/PR 的授权复述

用户确认前不修改业务代码、不创建 worktree。

## Step 3：创建隔离 worktree

在主仓库根目录，用确认后的值：

```bash
BASE="develop"
BR="fix/eng-123-short-slug"
ROOT=$(git rev-parse --show-toplevel)
REPO=$(basename "$ROOT")
WT="$(dirname "$ROOT")/${REPO}-eng-123"

git fetch origin "$BASE"
git show-ref --verify --quiet "refs/remotes/origin/$BASE"
git show-ref --verify --quiet "refs/heads/$BR" && echo "branch exists"
git worktree list --porcelain
test ! -e "$WT"
git worktree add -b "$BR" "$WT" "origin/$BASE"
```

如果 branch/path 已存在，停止并让用户决定复用、换名或清理；不要自行删除。

进入后验证：

```bash
cd "$WT"
git status --short --branch
git merge-base --is-ancestor "origin/$BASE" HEAD
```

之后每次工具调用都以 `$WT` 为工作目录。依赖复用、符号链接或安装必须先遵守项目说明，不能修改主工作区依赖状态。

## Step 4：实施

- 阅读目标代码和相邻测试，遵循既有模式。
- 使用 `edit` 精确修改，新文件使用 `write`。
- 不做无关重构、全仓格式化或依赖升级。
- 保持项目实际架构边界和错误/日志/响应约定。
- schema、migration、代码生成和依赖注入按项目文档执行；不修改已发布 migration。
- 格式化只覆盖本任务文件，除非项目工具无法缩小范围且用户已知情。

## Step 5：验证

从项目配置和计划执行最小针对性验证，再执行合理的模块级验证。技术栈示例仅供选择：

```bash
# JavaScript/TypeScript（以 package scripts 为准）
npm test -- <target>
npm run build

# Go
go test ./path/to/package/...
go build ./...

# Rust
cargo test -p <package>
cargo check -p <package>

# Python
pytest <target>
```

结束检查：

```bash
git status --short
git diff --check
git diff --stat
git diff
```

报告所有已运行、通过、失败和未运行项。测试失败且不能证明与本改动无关时停止，不提交/推送。

## Step 6：自动提交并推送任务分支

提交前确认当前分支等于计划中的 `$BR`，且不在保护集合中：

```bash
git branch --show-current
git status --short --branch
git diff --check
```

只暂存任务文件并审阅 staged diff：

```bash
git add <task-files...>
git diff --cached --stat
git diff --cached
git commit -m "<project-conventional-message> (<ISSUE>)"
```

commit 格式和 scope 来自项目规范；没有规范时使用简洁、真实的描述。不要添加虚假署名。

确认后无需再次询问，普通推送任务分支：

```bash
git push -u origin "$BR"
```

禁止 `--force`，禁止 refspec 指向 base 或其他保护分支。push 失败时保留状态并停止。

## Step 7：自动创建到已确认 base 的 PR

先检查已有 PR：

```bash
gh pr view "$BR" --json url,baseRefName,headRefName,state 2>/dev/null || true
```

- 已有 OPEN PR 且 base/head 正确：复用，不重复创建。
- 已有 PR 但 base/head 不正确，或状态 CLOSED/MERGED：停止并报告；不擅自重开、改 base 或建重复 PR。
- 不存在：

```bash
gh pr create --base "$BASE" --head "$BR" \
  --title "<project-style title> (<ISSUE>)" \
  --body-file "/tmp/${ISSUE,,}-pr-body.md"
```

PR body：

```markdown
## 关联
- Linear: TEAM-123 <issue URL>

## 需求理解
- 现象/动机：...
- 期望：...
- 验收标准：...

## 变更
- ...

## 验证
- `command` ✅
- 未执行：...（原因）

## 假设
<!-- 仅在用户明确同意按假设推进时保留 -->
- ...
```

再次运行：

```bash
gh pr view "$BR" --json url,baseRefName,headRefName,state
```

确认 `state=OPEN`、`baseRefName=$BASE`、`headRefName=$BR`。创建失败时报告错误和已推送分支，不把 push 成功误报成 PR 成功。不要自动 merge、approve 或 ready。

回写 Linear 评论/状态需另行征得用户同意，并先展示拟写内容。

## Step 8：收尾报告

输出：

- Issue identifier、标题、URL
- base 及其选择证据
- branch、worktree、commit SHA
- PR URL 与 base/head/state
- `git show --stat --oneline HEAD` 对应文件清单
- 测试/构建结果
- 限制、未验证项和已同意的假设

worktree 默认保留。只有用户确认不再需要后才清理。

## 立即停止并询问

- Issue 无法完整读取或关键需求文档不可访问。
- team key、base、remote、分支策略无法唯一确定。
- 期望、验收或真实代码落点不清。
- 多个生效候选无法排除。
- schema/migration、兼容性、计费、安全、权限或发布策略有分歧。
- branch/worktree 已存在。
- 测试失败且不能明确排除本改动影响。
- 需要 Linear 回写、合并/approve/ready PR、部署或其他未授权动作。

**不得停下重复询问**：理解卡和实施计划已获用户确认、实现与验证成功、当前任务分支/worktree 正常时，必须继续完成提交、普通 push 和创建到已确认 base 的 PR。

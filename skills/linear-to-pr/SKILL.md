---
name: linear-to-pr
description: 根据一个 Linear Issue 标识读取正文、全部评论、附件和需求文档，输出可追溯的理解卡；用户确认后从目标仓库已确认的远程基线创建隔离 worktree，完成实现、验证、提交、任务分支 push 和 PR。用于“按 Linear 开发”“Issue to PR”“拿 TEAM-123 开工”等请求。边界：本 Skill 用于从 Linear Issue 到 PR 的完整实现交付；只想定位现有代码请用 feature-trace，只想审计已开的 PR 请用 pr-audit。
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
→ 标记 Issue 进行中 → 从已确认远程基线创建 worktree → 实现与验证 → 提交并推送任务分支 → 创建 PR
```

理解卡和实施计划确认后，不再为本任务分支的普通 push、PR 创建和一次性 Linear 状态更新二次询问。

按需读取的参考文件（路径相对本 Skill 目录，用到时再读，不要预加载）：`references/understanding-card.md`（审阅输出格式、理解卡模板、缺口分级）、`references/git-workflow.md`（worktree/提交推送/PR 命令与 body 模板）、`references/validation-commands.md`（各技术栈验证命令与结束检查）。

## 输入与可变参数

接受完整 identifier（`ENG-123`、`APP-42`）；裸数字或 `#数字` 仅当 `LINEAR_TEAM_KEY` 已配置或用户在同一请求中明确 team key；可选 `--base develop`；可选 `--no-status` 关闭状态回写；可选 `--state-name "<状态名>"` 覆盖自动匹配。

```text
/skill:linear-to-pr ENG-123 --base develop
/skill:linear-to-pr ENG-123 --no-status
/skill:linear-to-pr 123             # 需要 LINEAR_TEAM_KEY
```

不要假定团队 key、base branch、branch prefix、worktree 根目录、commit scope 或测试命令。如果输入无法唯一解析，先询问。

## 项目约定解析顺序

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
6. 用户确认理解卡和实施计划，即授权验证通过后自动提交、普通 push 当前任务分支并创建到已确认 base 的 PR，以及把本 Issue 一次性置为该团队 `type=started` 的状态（`--no-status` 可关闭）。授权不包括 force push、直推受保护分支、合并/approve/ready PR、回写 Linear 评论、修改标题/负责人/优先级/标签等其他 Issue 字段、部署或其他未说明的外部动作。
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
find . -maxdepth 3 \( -name AGENTS.md -o -name CLAUDE.md \) -not -path './.git/*'
```

还应查找当前仓库适用的 `CONTRIBUTING*` 和 PR 文档并用 `read` 阅读。要求：当前目录位于用户想修改的目标仓库（不以仓库名称硬编码判断）；`origin` 指向用户预期 remote，若有多个 remote 或托管目标不清则询问；`gh` 已认证且目标托管在 GitHub，否则说明当前 Skill 的 PR 创建步骤不兼容并停止；Node.js ≥ 18；主工作区状态已记录且后续不触碰其改动。

Linear 凭据按 `LINEAR_API_KEY` → `LINEAR_API_KEY_FILE` → `~/.config/pi/linear-api-key` 顺序读取。裸数字的默认 team key 只来自 `LINEAR_TEAM_KEY`，未配置就询问用户提供完整 identifier。不要索要用户把 key 直接发进聊天。

## Step 1：读取 Linear Issue

使用完整 identifier 调用本 Skill 目录下的 `scripts/fetch-linear-issue.mjs`，输出到临时文件，避免终端截断：

```bash
ISSUE=ENG-123
ISSUE_LC=$(printf '%s' "$ISSUE" | tr '[:upper:]' '[:lower:]')
OUT="/tmp/${ISSUE_LC}-linear.json"
node <skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$OUT"
```

随后用 `read` 分段读取 `$OUT` 到文件末尾。可用 `jq` 建索引，但不能用摘要替代对正文和全部 `comments[].body` 的阅读。脚本返回 `description`、按时间排序的完整 `comments`、`commentCount`、只作导航提示的 `requirementRelevantComments`、`documentLinks`、`attachments` 和分页完整性元数据。

失败处理：`401/403` 提示检查 API key 权限；`not found` 确认 identifier，不选择相近 Issue；网络/分页错误报告并停止，不根据记忆补全。

### Step 1.1：评论、附件和文档审阅（硬闸门）

1. 先读正文，再按 `sequence` 从旧到新阅读每条评论，建立需求时间线。
2. 对潜在 PRD、原型、设计或验收文档：可访问则读取相关内容；登录墙、私有文档、过期附件明确列为缺口。不能凭标题猜内容。
3. 有冲突时列出双方摘要、作者、时间和来源；新评论只有明确覆盖证据时才作为候选最终口径，否则询问。
4. 评论出现新范围但未明确纳入当前 Issue 时，作为范围疑问。

输出格式见 `references/understanding-card.md`。

**硬闸门判定**：只要已审阅数不等于 `commentCount`、分页不完整、决定实现的文档无法访问，或冲突未解决，就不能实施。

## Step 1.5：需求理解闸门

**1.5.a 定位真实代码路径**：用 `bash` 搜索、`read` 阅读，从项目真实入口追踪 route/command/event/job 到业务与数据/外部依赖；有 UI 时确认路由/导航 → 实际渲染组件 → 用户可见字段；存在旧版/新版、平台覆写、feature flag 或同名候选时，沿注册/import/config 判定实际生效路径。可按需调用 `feature-trace`；未安装时自行完成，不能跳过。

**1.5.b 输出理解卡**：模板和缺口分级处理规则见 `references/understanding-card.md`；每项必须附精确来源。逐项检查：期望是否明确而不只有现象？正文、全部评论、附件和关键文档是否审阅完？冲突是否解决？是否有可验证验收标准？是否定位唯一生效落点？是否知道触发条件？

任一项不满足即计为缺口，按参考文件的分级规则决定轻确认、列假设还是停止。用户明确按假设推进时，将假设写入 PR body。

## Step 2：确定 Git 约定与实施计划

### 2.a 确定 base

优先使用显式 `--base`。否则：

1. 查项目文档是否明确开发/PR base。
2. 获取远程默认分支（只读）：`git symbolic-ref --quiet --short refs/remotes/origin/HEAD || true` 和 `gh repo view --json defaultBranchRef`。若 `origin/HEAD` 未配置，只把它记为信息缺口；不要为了探测运行会修改本地 remote 配置的命令。
3. 必要时查看少量 open PR 的 base 作为辅助证据，但不能仅凭数量覆盖明确文档。
4. 默认分支不一定是日常开发 base；证据冲突或发布流复杂时询问。

### 2.b 确定任务分支和 worktree

- 遵循项目命名规则。无规则时使用中性安全默认：`feature/<issue-lower>-<slug>` 或 `fix/<issue-lower>-<slug>`；类型不清则询问。
- worktree 默认放在主仓库父目录，名称取 `<repo>-<issue-lower>`；先用 `git worktree list` 和 `test ! -e` 验证唯一性。不硬编码 `/opt`、`~/git` 或仓库名称。

计划至少包括：base 及证据与保护分支集合、branch 和唯一 worktree 路径、预计修改文件/职责层、测试/构建/lint/typecheck 命令及来源、schema/migration 与依赖注入等特殊步骤、自动 push/PR 的授权复述、Linear 状态回写的目标状态名或已用 `--no-status` 关闭的说明。

用户确认前不修改业务代码、不创建 worktree、不改 Issue 状态。

## Step 2.5：把 Issue 标记为进行中

用户确认后、创建 worktree 前执行一次。传入 `--no-status` 时整步跳过。

```bash
node <skill目录>/scripts/update-issue-state.mjs "$ISSUE"
```

规则与边界见 `references/git-workflow.md`：目标取该团队 `type=started` 候选中 `position` 最小者；已是 `started`（含 In Review 等更靠后的列）不改也不回退；`completed`/`canceled` 不改；无候选不猜。只写状态，不写评论，不改其他字段。

按退出码处理：`0` 读 stdout JSON 的 `applied`/`reason`/`to.name` 记入收尾报告；`1` 状态未更新但**继续后续步骤**，把错误原文记入报告，不重试、不换状态兜底；`2` 命令参数有误，修正后只重跑一次。

## Step 3：创建隔离 worktree

命令见 `references/git-workflow.md`。在主仓库根目录用已确认的值 fetch base，显式从 `origin/$BASE` 创建 `$BR` 和独立 worktree，并验证 worktree 由 `origin/$BASE` 派生。如果 branch/path 已存在，停止并让用户决定复用、换名或清理；不要自行删除。之后每次工具调用都以 worktree 为工作目录，不修改主工作区依赖状态。

## Step 4：实施

阅读目标代码和相邻测试，遵循既有模式；用 `edit` 精确修改，新文件用 `write`。不做无关重构、全仓格式化或依赖升级，保持项目实际架构边界和错误/日志/响应约定。schema、migration、代码生成和依赖注入按项目文档执行，不修改已发布 migration。格式化只覆盖本任务文件，除非项目工具无法缩小范围且用户已知情。

## Step 5：验证

从项目配置和计划执行最小针对性验证，再执行合理的模块级验证。技术栈命令示例和提交前结束检查见 `references/validation-commands.md`。报告所有已运行、通过、失败和未运行项。测试失败且不能证明与本改动无关时停止，不提交/推送。

## Step 6：自动提交并推送任务分支

命令见 `references/git-workflow.md`。用户已确认理解卡与计划即授权本步骤，无需再次询问。提交前确认当前分支等于计划中的 `$BR` 且不在保护集合中；只暂存任务文件并审阅 staged diff；commit 格式和 scope 来自项目规范，不添加虚假署名。只做普通 push 任务分支，禁止 `--force`，禁止 refspec 指向 base 或其他保护分支；push 失败时保留状态并停止。

## Step 7：自动创建到已确认 base 的 PR

命令与 PR body 模板见 `references/git-workflow.md`。先用 `gh pr view "$BR"` 检查已有 PR：OPEN 且 base/head 正确则复用不重复创建；base/head 不正确或状态 CLOSED/MERGED 则停止并报告，不擅自重开、改 base 或建重复 PR；不存在则创建到已确认 base 的 PR，再复核 `state=OPEN`、`baseRefName=$BASE`、`headRefName=$BR`。

创建失败时报告错误和已推送分支，不把 push 成功误报成 PR 成功。不要自动 merge、approve 或 ready。回写 Linear 评论需另行征得用户同意，并先展示拟写内容。状态回写只限 Step 2.5 那一次「进行中」更新；PR 创建后不再改动 Issue 状态。

## Step 8：收尾报告

输出 Issue identifier/标题/URL、base 及其选择证据、branch/worktree/commit SHA、PR URL 与 base/head/state、`git show --stat --oneline HEAD` 对应文件清单、测试/构建结果、限制与未验证项和已同意的假设。worktree 默认保留，只有用户确认不再需要后才清理。

Linear 状态单独报告：`旧状态 → 新状态`；未更新时给出原因（已是 started／终态／无 started 候选／`--no-status`／失败原文）。有多个 `type=started` 候选时列出选中项和全部被排除项。

## 立即停止并询问

- Issue 无法完整读取或关键需求文档不可访问。
- Issue 当前状态已是 `completed` 或 `canceled`，但用户未说明为何仍要实现。
- team key、base、remote、分支策略无法唯一确定。
- 期望、验收或真实代码落点不清；多个生效候选无法排除。
- schema/migration、兼容性、计费、安全、权限或发布策略有分歧。
- branch/worktree 已存在；测试失败且不能明确排除本改动影响。
- 需要 Linear 评论回写、修改状态以外的 Issue 字段、合并/approve/ready PR、部署或其他未授权动作。

**不得停下重复询问**：理解卡和实施计划已获用户确认、实现与验证成功、当前任务分支/worktree 正常时，必须继续完成提交、普通 push 和创建到已确认 base 的 PR。

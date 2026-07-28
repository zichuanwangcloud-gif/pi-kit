---
name: linear-to-pr
description: 只给一个 Linear 编号（如 CR-1170、#1170 或裸数字 1170），读取 Linear issue，基于 origin/dev 创建隔离 worktree，完成实现、验证、推送功能分支并向 dev 创建 PR。用于“linear”“CR-编号”“拿 issue 做需求”“按编号开发”“issue to pr”“编号开工”等请求。
compatibility: Requires git, Node.js 18+, authenticated gh CLI, and LINEAR_API_KEY or ~/.config/pi/linear-api-key. Designed for the CloudRouter repository.
allowed-tools: read bash edit write invoke_skill
metadata:
  source: /opt/CloudRouter/.claude/skills/clouditera/linear-to-pr/SKILL.md
  pi-port: "1"
---

# linear-to-pr：从 Linear 编号到 dev PR

输入一个 Linear 编号，完成“读取需求 → 理解闸门 → 隔离开发 → 验证 → 推送功能分支 → 创建 dev PR”。

此版本专用于 Pi：

- Pi 没有内置 MCP，使用 `scripts/fetch-linear-issue.mjs` 调 Linear GraphQL API。
- 使用 Pi 的 `read`、`bash`、`edit`、`write` 工具，不使用 Claude 的 `Grep`、`Glob`、`Skill` 或 `mcp__linear__*`。
- 不依赖 Claude memory 中的 `[[wiki links]]`；所有关键约束均写在本文件中。
- 不写 Claude 专属署名。提交和 PR 只描述真实变更。

## 输入

接受以下格式：

- `CR-1170`
- `1170`
- `#1170`

团队 key 固定为 `CR`。将裸数字和 `#数字` 归一化为 `CR-<数字>`。如果输入无法唯一解析为一个编号，先询问用户。

## 必须遵守的安全规则

1. **绝不直接 push `main`、`dev` 或 `test`，绝不对任何受保护分支 force push。**
2. 日常功能和修复只能从最新 `origin/dev` 创建 `feature/*` 或 `fix/*` 分支，并通过 PR 合入 `dev`。
3. `test` 只读；不要在 `test` 上开发或提交。
4. 必须先运行 `git fetch origin dev`，worktree base 必须显式为 `origin/dev`，不能使用可能过期的本地 `dev`。
5. 必须在独立 worktree 中修改代码。不得修改主仓库工作区，不得清理、stash、reset 或覆盖用户已有改动。
6. 进入 worktree 后，所有读写和构建都使用该 worktree 内的路径。禁止用 `/opt/CloudRouter/...` 指向主工作区文件。
7. 需求不清、代码中找不到对应功能、存在多个候选落点或需要产品选型时，必须停下来询问，不能猜。
8. 创建 Linear 评论、修改 Linear 状态、推送分支和创建 PR 都是外部动作。执行前必须让用户看到计划；推送和建 PR 应在理解卡确认及实现验证完成后进行。回写 Linear 必须单独征得用户同意。
9. 不打印、记录或提交 `LINEAR_API_KEY`。不得把凭据写入仓库。
10. 遵守仓库根目录及目标模块的 `AGENTS.md` / `CLAUDE.md`。后端保持 handler → service → repository 分层。
11. **必须阅读全部 Linear 评论。** 评论可能包含 PRD、验收标准、产品澄清、原型链接和对正文的修订；未审阅完整评论时间线、附件及相关 PRD 链接前禁止开工。

## Step 0：环境与仓库预检

先检查，不做破坏性处理：

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
gh auth status
node --version
```

要求：

- 当前仓库是 CloudRouter。
- `origin` 指向预期仓库。
- `gh` 已认证。
- Node.js ≥ 18。
- 主工作区即使有未提交改动也可以继续创建 worktree，但必须报告并保证完全不触碰这些改动。

Linear 凭据按以下顺序读取：

1. 环境变量 `LINEAR_API_KEY`
2. `LINEAR_API_KEY_FILE` 指定的文件
3. `~/.config/pi/linear-api-key`

缺少凭据时停止，并提示用户配置；不要索要用户把密钥直接发进聊天。

推荐配置方式：

```bash
mkdir -p ~/.config/pi
chmod 700 ~/.config/pi
read -rsp "Linear API key: " LINEAR_API_KEY; echo
umask 077
printf '%s' "$LINEAR_API_KEY" > ~/.config/pi/linear-api-key
unset LINEAR_API_KEY
```

## Step 1：读取 Linear issue

Pi 加载 Skill 时会提供 Skill 文件位置。将辅助脚本解析为该 Skill 目录下的：

```text
scripts/fetch-linear-issue.mjs
```

运行时写入临时文件，避免长评论被终端的 50KB/2000 行输出限制截断：

```bash
ISSUE=CR-1170
OUT="/tmp/${ISSUE,,}-linear.json"
node <skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$OUT"
```

随后必须用 `read` 分段读取 `$OUT` 直到文件末尾；不能只读开头或仅用 `jq` 摘要替代正文审阅。可以用 `jq` 生成索引帮助导航，但最终必须读取全部 `comments[].body`。任务结束时可删除该临时文件。

脚本会分页拉取全部评论和附件，并按时间顺序返回 JSON，主要字段包括：

- `description`：issue 正文。
- `comments`：完整评论时间线；每条含 `sequence`、作者、时间、正文、链接、`requirementSignals` 和 `isRequirementRelevant`。
- `commentCount`：评论总数。必须与实际审阅数量一致。
- `requirementRelevantComments`：命中 PRD、需求、期望、验收、修订、结论、原型等信号的候选评论。它只是审阅优先级提示，**不能替代阅读全部评论**。
- `documentLinks`：从正文、全部评论和附件中汇总的链接，并标记来源及是否可能是 PRD/设计文档。
- `attachments`：全部 issue 附件。

若请求失败：

- `401/403`：提示检查 Linear API key 权限。
- `not found`：确认团队 key 和编号，不要改成相近 issue。
- 网络错误：报告错误并停止，不得根据本地记忆臆造 issue。

拿到数据后不要立即改代码，先完成以下评论/PRD 审阅和理解闸门。

### Step 1.1：评论、附件和 PRD 审阅（硬闸门）

1. 先读 issue 正文，再按 `sequence` 从旧到新阅读**每一条**评论；不能只读 `isRequirementRelevant=true` 的候选评论。
2. 建立“需求时间线”，至少记录：
   - issue 正文最初描述；
   - 产品/设计/开发/测试各自的关键补充（保留作者和时间）；
   - PRD、原型、截图、验收说明、关联 PR 等链接；
   - 后续对旧方案的否定、修订和最终结论。
3. 对 `documentLinks` 中可能是 PRD、原型或设计文档的链接：
   - 在当前环境可访问时读取与本 issue 相关的内容；
   - 私有文档、登录墙、过期附件或不可访问链接必须明确列为缺口，请用户提供可访问内容或关键摘录；
   - 不得仅凭链接标题猜测 PRD 内容。
4. 评论与正文发生冲突时：
   - 后续明确澄清可以作为“候选最新口径”，但不能只凭时间自动认定谁有权覆盖谁；
   - 输出冲突双方的原话摘要、作者、时间和链接/评论序号；
   - 只有“产品明确说以新方案为准”等证据充分时才按新口径理解，否则必须询问用户。
5. 评论中出现新的需求范围但没有明确说是否纳入当前 issue 时，列为范围疑问，不能顺手实现。
6. 输出评论审阅摘要：

```text
【CR-N 评论/PRD 审阅】
评论总数：N（已审阅 N）
关键时间线：
- [正文][时间] …
- [评论 #3][作者][时间] …
- [评论 #8][作者][时间] …
PRD/原型/附件：
- [已读取|无法访问] <标题或 URL> — 与需求的关系
冲突与修订：
- 无；或：旧口径 … ↔ 新口径 …，当前依据/待确认项 …
```

只要“已审阅数 != `commentCount`”、关键 PRD 无法访问且其内容决定实现、或冲突未解决，就不能进入实施。

## Step 1.5：需求理解闸门

### 1.5.a 代码定位

使用 Pi 工具定位真实执行路径：

- 用 `bash` + `rg --files` / `rg -n` 查找关键词、路由、页面、API、handler、service。
- 用 `read` 阅读命中文件，不要用 `cat`/`sed` 代替。
- 前端至少确认：路由入口 → 实际渲染页面/组件 → 用户可见字段。
- 后端至少确认：路由 → handler → service；涉及数据访问时继续定位 repository。
- CloudRouter 可能存在上游原组件与 `clouditera` 影子组件两棵树，必须沿实际路由/import 确认真正渲染的文件，不能只按同名文件猜测。

可按需显式调用已安装的 `feature-trace` Skill；如果它没有安装，直接按上述方法定位，不得因此跳过落点确认。

### 1.5.b 输出理解卡

每格必须标注精确来源：`[正文]`、`[评论 #序号/作者/日期]`、`[PRD/链接]`、`[代码证据 文件:行]` 或 `[推断]`。不能只写笼统的 `[评论]`：

```text
【CR-N 理解卡】
现象（用户实际看到什么）：      … [正文|评论 #N/作者/日期|PRD]
复现路径（页面/角色/操作）：     … [正文|评论 #N/作者/日期|PRD]
期望（改完应变成什么）：        … [正文|评论 #N/作者/日期|PRD]
验收标准（怎么算修好）：        … [正文|评论 #N/作者/日期|PRD]
影响面（关联角色/协议/模块）：   … [正文|评论 #N/作者/日期|PRD|推断]
落点（拟改文件/组件/调用链）：   … [代码证据 文件:行]
最终需求口径：                   … [说明正文/哪条评论/哪个 PRD 为依据]
```

同时逐项检查：

- issue 正文或评论/PRD 是否明确写出期望结果，而不只是现象？
- 正文、全部评论、附件和关键 PRD 是否均已审阅？
- 正文与评论、评论之间、评论与 PRD 之间是否不存在未解决冲突？
- 是否有验收标准？
- 是否能在代码中定位到唯一生效落点？
- 是否有复现步骤或触发条件？

分级处理：

- **0 个缺口**：回显理解卡和实施计划，请用户轻确认后开工。
- **1–2 个缺口**：列出缺口和带 `[推断]` 的假设，让用户选择补充信息或明确同意按假设推进。
- **≥3 个缺口，或“期望/落点”全是推断**：必须停止，不能开工。

如果用户明确要求按假设推进，必须把假设写入 PR body，供 reviewer 审计。

## Step 2：制定实现和验证计划

计划至少包括：

- 分支类型：Bug 用 `fix/cr-<n>-<slug>`，功能用 `feature/cr-<n>-<slug>`；判断不清时询问用户。
- 唯一 worktree 路径。
- 预计修改文件和分层。
- 测试、编译、lint/typecheck 命令。
- 是否涉及 Ent、Wire、migration、overlay 受控例外或生成文件。

不要在确认前修改业务代码。

## Step 3：从 origin/dev 创建隔离 worktree

在主仓库根目录运行：

```bash
git fetch origin dev
BR="fix/cr-1170-short-slug"       # 或 feature/...
WT="/opt/CloudRouter-cr-1170"     # 必须是新的、唯一的路径

git show-ref --verify --quiet "refs/heads/$BR" && echo "branch exists"
git worktree list --porcelain
test ! -e "$WT"
git worktree add -b "$BR" "$WT" origin/dev
```

如果分支或路径已存在，停止并让用户决定复用、换名或清理；不要自行删除已有 worktree/branch。

创建后验证：

```bash
cd "$WT"
git status --short --branch
git merge-base --is-ancestor origin/dev HEAD
```

之后所有代码操作都必须在 `$WT` 内进行。每次调用工具时明确设置工作目录，避免回到主工作区。

如果前端需要依赖，可以在确认安全后复用主仓库依赖目录的只读/符号链接方案；不要未经检查就重复安装或修改主工作区依赖。

## Step 4：实施

- 先阅读目标模块附近现有代码和测试，遵循既有模式。
- 使用 `edit` 做精确修改；新文件用 `write`。
- 修改多个独立位置时，尽量一次 `edit` 提交多个不重叠替换。
- 不做与 issue 无关的重构或格式化。
- Go 后端保持 handler → service → repository；handler 不直连 repository，service 不直连数据库/Redis 实现。
- 日志使用项目 logger，响应使用统一 response 包。
- 修改 Ent schema 后按仓库规范执行 `go generate ./ent`。
- 修改 Wire 依赖后按仓库规范执行 `wire ./cmd/server/`；如果目标模块有 overlay/wire_gen 特殊约束，先读相关文档并遵守，不要盲目重生成。
- migration 必须新增递增/时间戳文件，不改已发布 migration。
- `gofmt` 仅作用于本次修改的 Go 文件，禁止整目录格式化。

## Step 5：验证

按改动范围执行最小针对性测试，再执行模块级构建。CloudRouter 常用命令：

```bash
# 后端：在对应 backend 目录
# 单元测试若项目使用 unit build tag，必须带 -tags=unit
go test -tags=unit ./path/to/changed/package/...
go build ./...

# 前端：从 workspace 根目录或目标 package
pnpm --filter <package> test -- <target>
pnpm --filter <package> build
```

实际命令以目标模块的 `package.json`、Makefile、AGENTS.md/CLAUDE.md 为准。

验证结束后检查：

```bash
git status --short
git diff --check
git diff --stat
git diff
```

必须报告：运行了哪些命令、哪些通过、哪些未运行及原因。失败不得隐瞒。

## Step 6：提交、推送功能分支

提交前确认：

```bash
git branch --show-current
git status --short --branch
git diff --check
```

当前分支必须是本任务的 `feature/*` 或 `fix/*`，绝不能是 `dev`、`main`、`test`。

只暂存本任务文件，核对 staged diff 后提交：

```bash
git add <本任务文件...>
git diff --cached --stat
git diff --cached
git commit -m "<type>(cv2): <简述> (CR-1170)"
```

不要自动添加虚假或不适用的 Co-Authored-By。

向用户汇报验证与提交摘要，并确认可以执行外部动作后：

```bash
git push -u origin "$BR"
```

禁止 `--force`。

## Step 7：创建到 dev 的 PR

再次确认 base/head：

```bash
gh pr view "$BR" --json url,baseRefName,headRefName,state 2>/dev/null || true
```

如果不存在 PR，创建：

```bash
gh pr create --base dev --head "$BR" \
  --title "<type>(cv2): <简述> (CR-1170)" \
  --body-file /tmp/cr-1170-pr-body.md
```

PR body 使用：

```markdown
## 关联
- Linear: CR-1170 <issue URL>

## 需求理解
- 现象：...
- 期望：...
- 验收标准：...

## 变更
- ...

## 验证
- `command` ✅
- 未执行：...（原因）

## 假设
<!-- 仅在用户明确同意“按假设推进”时保留 -->
> 本 PR 基于以下推断；若不符合产品意图，请驳回：
- ...
```

创建后验证 PR 的 `baseRefName` 必须为 `dev`、`headRefName` 必须为当前功能分支。不要自动合并 PR。

回写 Linear 评论或状态必须另行征得用户同意。Pi 版默认不提供写入 Linear 的辅助脚本，避免无意对外修改；如获同意，可使用 Linear GraphQL mutation，但必须先展示拟写内容。

## Step 8：收尾报告

输出：

- Linear issue 编号、标题和 URL。
- 分支、worktree 路径和 commit SHA。
- PR URL、base/head。
- 实际修改文件清单，以 `git show --stat --oneline HEAD` 为准。
- 测试/构建结果。
- 已知限制、未验证项和按假设推进内容。

worktree 默认保留供 review。只有用户确认已不需要后才能清理；不得自动删除。

## 立即停止并询问用户的情形

- Linear issue 无法读取或缺少关键描述。
- 期望结果或真实代码落点无法确定。
- 同名/相近功能存在多个生效候选。
- 分支类型、schema/migration、数据兼容、计费、安全或权限设计存在分歧。
- branch/worktree 路径已经存在。
- 测试失败且无法明确证明与本改动无关。
- 需要 push、建 PR、回写 Linear，而用户尚未看到并确认对应计划/结果。

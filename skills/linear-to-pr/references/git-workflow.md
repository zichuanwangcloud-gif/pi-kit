# Git 与 PR 命令细节

配合 `SKILL.md` 的 Step 2.5、Step 3、Step 6、Step 7 使用。安全规则与授权边界以主干为准；本文件只提供具体命令与模板。所有命令都在对应步骤要求的工作目录下执行。

## Step 2.5：把 Issue 标记为进行中

用户确认理解卡和实施计划后、创建 worktree 前执行一次。传入 `--no-status` 时整步跳过。

```bash
ISSUE=ENG-123
node <skill目录>/scripts/update-issue-state.mjs "$ISSUE"
```

脚本自身决定是否写入，不要用其他命令改状态，也不要在脚本判定不改时手动覆盖。

### 目标状态如何确定

取该 Issue 所属团队（不是 `LINEAR_TEAM_KEY`）`type=started` 的状态作为候选，按固定顺序判定：

| 情况 | 行为 | `selectionRule` |
|---|---|---|
| 传了 `--state-name` 且精确命中（忽略大小写） | 用该状态 | `explicit-name` |
| 传了 `--state-name` 但不存在 | 不改，退出码 2 | `explicit-name-not-found` |
| 无 `started` 候选 | 不改，记为限制 | `no-started-state` |
| 只有一个候选 | 用它 | `only-candidate` |
| 多个候选 | 取 `position` 最小者 | `lowest-position` |

Linear 默认配置下 `type=started` 通常有多个状态（In Progress / In Review / Ready to Merge）。取 `position` 最小者，因为 started 区间最靠左的列在结构上就是入口；这与列叫 `In Progress`、`进行中` 还是 `Doing` 无关。**不要改成按英文名匹配**——那会让非英文工作区静默走另一条路径。

多候选时披露而非询问：把选中项和全部被排除项写进收尾报告，让选错可被看见并用 `--state-name` 纠正。

### 幂等与边界

| 当前状态 `type` | 行为 | `reason` |
|---|---|---|
| `triage` / `backlog` / `unstarted` | 改为目标状态 | `applied` |
| `started` 且已是目标 | 不改 | `already-target` |
| `started` 但是别的列 | **不改，不回退** | `already-started` |
| `completed` / `canceled` | 不改 | `terminal-state` |

`already-started` 是重点：把已在 In Review 的 Issue 拖回 In Progress 会破坏人工录入的信号并触发全组通知。「标记开工」的意图对 In Review 已经成立。

终态（`completed`/`canceled`）永不由自动化重开。主干的「立即停止并询问」已要求在 Step 1 就对终态 Issue 提问，那是需求本身的问题。

每次运行最多一次 mutation：`success: false` 不重试，不换候选兜底。

### 输出与失败处理

stdout 恒为单个 JSON（即使未改也输出 `startedCandidates`，供报告审计）：

```json
{
  "identifier": "ENG-123",
  "url": "https://linear.app/...",
  "applied": true,
  "reason": "applied",
  "from": { "id": "...", "name": "Todo", "type": "unstarted" },
  "to": { "id": "...", "name": "In Progress", "type": "started" },
  "startedCandidates": [
    { "id": "...", "name": "In Progress", "position": 2, "selected": true },
    { "id": "...", "name": "In Review", "position": 3, "selected": false }
  ],
  "selectionRule": "lowest-position"
}
```

| 退出码 | 含义 | 工作流反应 |
|---:|---|---|
| 0 | 已决定（`applied: true`，或带 `reason` 的有意不改） | 继续 |
| 1 | 运行时失败（网络、HTTP、GraphQL、`success: false`） | **继续后续步骤**，把错误原文记入收尾报告，不重试 |
| 2 | 用法错误（identifier/flag 有误，或 `--state-name` 不存在） | 修正命令后只重跑一次 |

状态回写是记账动作，不是任何下游步骤的前提。因权限或网络失败中止一个已确认的实现计划，等于为附属功能牺牲用户真正要的产出。只读 API key 是合理配置，必须降级为「PR 已建、状态未更新」而不是「什么都没做」。

真正要避免的是*静默*失败——用户以为看板更新了其实没有。所以未更新时必须在报告里写明原因。

本步骤只写状态，不写评论，不改标题/负责人/优先级/标签等任何其他字段。

## Step 3：创建隔离 worktree

在主仓库根目录，用用户确认后的值：

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

## Step 6：提交并推送任务分支

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

普通推送任务分支：

```bash
git push -u origin "$BR"
```

禁止 `--force`，禁止 refspec 指向 base 或其他保护分支。push 失败时保留状态并停止。

## Step 7：创建 PR

先检查已有 PR：

```bash
gh pr view "$BR" --json url,baseRefName,headRefName,state 2>/dev/null || true
```

不存在时创建：

```bash
ISSUE_LC=$(printf '%s' "$ISSUE" | tr '[:upper:]' '[:lower:]')
gh pr create --base "$BASE" --head "$BR" \
  --title "<project-style title> (<ISSUE>)" \
  --body-file "/tmp/${ISSUE_LC}-pr-body.md"
```

PR body 模板：

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

创建后复核：

```bash
gh pr view "$BR" --json url,baseRefName,headRefName,state
```

确认 `state=OPEN`、`baseRefName=$BASE`、`headRefName=$BR`。创建失败时报告错误和已推送分支，不把 push 成功误报成 PR 成功。

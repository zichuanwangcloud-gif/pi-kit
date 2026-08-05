# Git 与 PR 命令细节

配合 `SKILL.md` 的 Step 3、Step 6、Step 7 使用。安全规则与授权边界以主干为准；本文件只提供具体命令与模板。所有命令都在对应步骤要求的工作目录下执行。

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

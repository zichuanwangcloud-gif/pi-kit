# Phase 1 参考：冻结 PR 审计对象与隔离 worktree

本文件是 `SKILL.md` Phase 1 的完整命令细节。完整档必读；快速档只需读取 PR 元数据与 diff，可跳过 worktree 部分。

## 1. 读取并保存 PR 元数据

读取 PR 元数据并保存到临时 JSON，避免终端截断：

```bash
PR=123
OUT="/tmp/pr-${PR}-audit.json"
gh pr view "$PR" --json number,url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner,author,mergeable,reviewDecision,statusCheckRollup,commits,files,additions,deletions > "$OUT"
```

用 `read` 分段读完。至少记录：

- PR URL、title、body、state、draft
- base/head 分支及 **base/head OID**
- fork/owner 信息
- commits 和 changed files
- CI checks 的成功、失败、跳过、运行中状态
- mergeability/review decision（只作上下文，不替代审计）

验证 PR 为 `OPEN`；draft 可以审计，但报告标记为 draft。审计开始后以 `headRefOid` 为冻结版本，后续所有 diff、测试、扫描都针对这个 OID。

## 2. 获取对象但不动主工作区

先 fetch 精确 base，再抓取 PR head 到 `FETCH_HEAD`，避免创建长期本地分支/ref：

```bash
git fetch origin "<baseRefName>"
git fetch origin "pull/${PR}/head"
test "$(git rev-parse FETCH_HEAD)" = "<headRefOid>"
git cat-file -e "<headRefOid>^{commit}"
git cat-file -e "<baseRefOid>^{commit}"
```

- OID 校验失败（`test` 不相等）时不要继续，说明拿到的不是 PR head。
- 不要信任同名本地 branch 或未核验的 `FETCH_HEAD` 代表 PR head。
- 若平台/ref 不支持 `pull/*/head`，使用只读 `gh pr diff` 保存 patch，并说明无法运行 head 代码时相关 Gate 可能 `BLOCKED`。

## 3. 建立隔离 worktree

需要执行测试/扫描时建立，不在主工作区 checkout：

```bash
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-audit"
test ! -e "$WT"
git worktree list --porcelain
git worktree add --detach "$WT" "<headRefOid>"
```

- 路径已存在时不要删除或复用未知目录；询问用户或选取经确认的新路径。
- 所有测试和扫描在冻结 head worktree 中运行。
- 结束时默认保留 worktree；只有确定由本次审计新建且用户同意时才清理。

## 4. 定义变更面

使用精确 OID 比较，不用易漂移的分支名：

```bash
git diff --stat "<baseRefOid>...<headRefOid>"
git diff --name-status "<baseRefOid>...<headRefOid>"
git diff --check "<baseRefOid>...<headRefOid>"
git diff --find-renames "<baseRefOid>...<headRefOid>"
```

阅读完整 diff；输出很长时保存临时文件并用 `read` 分段读完。识别：

- 生产代码、测试、配置、schema/migration、生成文件、依赖和 lockfile
- public API、权限、数据流、异步任务和外部调用变化
- 新增/删除测试与实现的对应关系
- PR body 声明但 diff 未体现、或 diff 超出声明的内容

二进制、大生成文件、vendor 或无法查看的子模块必须列为审计限制。

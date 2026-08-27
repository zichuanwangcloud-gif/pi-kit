# base、栈式依赖与托管平台分支规则

确定 PR base、识别未合并的前置依赖、并从托管平台读取真实的分支约束，全部要有证据。

> 由 SKILL.md 的 §项目约定解析顺序、Step 2 引用。

## 本文小节

- [项目约定的取证优先级](#项目约定的取证优先级)
- [本节片段的执行前提](#本节片段的执行前提)
- [确定 base](#确定-base)
- [依赖未合并分支（栈式 PR）](#依赖未合并分支栈式-pr)
- [读取托管平台的真实分支规则](#读取托管平台的真实分支规则)
- [受影响包矩阵](#受影响包矩阵)

## 项目约定的取证优先级

1. 用户在当前请求中的明确参数或说明。
2. 目标仓库根目录/目标模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、PR 模板。
   monorepo 中 package 级说明优先于仓库根说明。
3. 托管平台真实规则：branch ruleset、required status checks、CODEOWNERS（见本文末两节）。
4. Git 证据：`origin/HEAD`、现有 open PR 的 base、当前分支关系。
5. 安全默认；若仍不唯一，询问用户。

只读取**目标仓库内部**的说明文件。禁止把仓库外（兄弟目录、其他项目）的 `AGENTS.md`/`CLAUDE.md`
当作本仓库约定。将每个最终采用的约定及其证据写入实施计划。

## 本节片段的执行前提

参数模板见 SKILL.md §执行期约定：参数固化。那里是**唯一**的参数模板来源，本文件不重复给模板。

本文件的片段在 **Step 2.a 执行，此时 `BASE` 尚未确定**，不在 `$ENVFILE` 里。
因此**禁止**在本文件里写 `$BASE`：候选一律用片段内现场赋值的 `CAND`，
确认之后才由 Step 2.c 的阶段二写成 `BASE`。片段一律写成：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
CAND='<本轮候选 base>'
git -C "$ROOT" ls-remote --exit-code --heads origin "$CAND" \
  || { echo "STOP: 候选 base $CAND 不在远端"; exit 1; }
```

## 确定 base

优先使用显式 `--base`。否则：

1. 查项目文档是否明确开发/PR base。
2. 只读获取远程默认分支：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
git -C "$ROOT" symbolic-ref --quiet --short refs/remotes/origin/HEAD || true
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
```

`origin/HEAD` 未配置时只记为信息缺口，不要运行会修改本地 remote 配置的探测命令。

3. **确认前必须验证候选 base 在远程真实存在**，并统计 open PR 的 base 分布：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
CAND='<本轮候选 base>'
git -C "$ROOT" ls-remote --exit-code --heads origin "$CAND" \
  || { echo "STOP: 候选 base $CAND 不在远端"; exit 1; }
gh pr list --state open --limit 30 --json baseRefName -q '[.[].baseRefName]|group_by(.)|map({base:.[0],n:length})'
```

4. 默认分支不一定是日常开发 base。三方证据（项目文档 / `origin/HEAD` / open PR 分布）不一致时**必须询问**，并摆出三条证据原文与计数让用户在具体候选间选择：

```text
【base 证据冲突】
- 文档 CONTRIBUTING.md:L23 → develop
- origin/HEAD → main
- 当前 18 个 open PR：release/2026-09 ×15，main ×3
请指定本次 PR 的 base。
```

不得仅凭 PR 数量覆盖明确文档，也不得仅凭文档忽略当前发布分支的实际用法。

## 依赖未合并分支（栈式 PR）

1.5.a 发现本次改动依赖尚未合并的代码时必须显式处理，不得默认从长期分支起步。判断依据：Linear 的 blocked-by/parent 关系、评论提到的前置 PR、目标文件在 `origin/<候选 base>` 上不存在或签名不同。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
CAND='<当前考察的候选 base>'
gh pr list --state open --json number,title,headRefName,baseRefName --search "<关键词>"
git -C "$ROOT" --no-pager log --oneline "origin/$CAND..origin/<候选父分支>"
```

确认存在依赖时二选一，不自行决定：

- **栈式**：`--base <父分支>`，任务分支从 `origin/<父分支>` 建，PR base 指向它。该父分支记为「临时 base」，**不**纳入受保护集合，并在 PR body 顶部写明「依赖 #<父 PR>，需在其合并后再合并」。
- **等待**：暂停本任务，等父 PR 合并。

用户未确认前不建 worktree。禁止 cherry-pick 父分支 commit 来「绕过」依赖。

## 读取托管平台的真实分支规则

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
CAND='<本轮候选 base>'
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
gh api "repos/$REPO/rules/branches/$CAND" 2>/dev/null || echo "no ruleset readable"
gh repo view --json deleteBranchOnMerge,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed
test -f "$ROOT/.github/CODEOWNERS" && cat "$ROOT/.github/CODEOWNERS" || echo "no CODEOWNERS"
```

据此确定并写入计划：

- **受保护分支集合** = {`main`, `master`, 已确认长期 base} ∪ ruleset 中带 `creation`/`update`/`deletion`/`non_fast_forward` 限制的分支。按 2.a.5 选定的临时栈式 base 不计入。
- **分支命名约束**：ruleset 的 `branch_name_pattern`、CI 的 branch-name lint、`commitlint`/`.husky` 配置。存在强制模式时以它为准，中性默认失效。
- **必需状态检查**：`required_status_checks` 的 context 列表即 Step 5 必须本地跑的最小集合。
- **CODEOWNERS 命中的 owner 组**：写入计划与收尾报告。
- 任一项查不到（权限不足）时记为信息缺口，用中性默认并声明，不要断言「无保护」。

## 受影响包矩阵

每个被改动的 package/module 一行，六列缺一不可：

| 包路径 | 测试命令 | 构建命令 | lint/typecheck 命令 | 命令来源 | CODEOWNERS owner |
|---|---|---|---|---|---|
| `packages/api` | `pnpm --filter api test` | `pnpm --filter api build` | `pnpm --filter api typecheck` | `package.json:scripts` L12–14 | `@org/backend` |

「命令来源」必须指到具体文件与行（`package.json`/`Makefile`/CI 配置），不接受「按惯例」。
矩阵是 Step 5 逐包验证的输入：**禁止**用根目录一条聚合命令代替逐包验证。

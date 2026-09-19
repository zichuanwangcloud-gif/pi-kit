# 失败、并发与恢复

在创建任何东西之前探测断点，区分“本任务的残留”与“别人的东西”，并在失败时保留真实状态。

> 由 SKILL.md 的 Step 0、Step 3、Step 6–8 引用。

## 本文小节

- [断点探测](#断点探测)
- [恢复对照表](#恢复对照表)
- [并发同名分支](#并发同名分支)
- [shallow / single-branch clone](#shallow-/-single-branch-clone)
- [非 GitHub 与缺少 gh](#非-GitHub-与缺少-gh)
- [失败兜底口径](#失败兜底口径)
- [主工作区隔离指纹](#主工作区隔离指纹)
- [临时文件卫生](#临时文件卫生)
- [pager 与交互](#pager-与交互)
- [收尾报告字段](#收尾报告字段)
- [不可读需求来源](#不可读需求来源)
- [常见借口与事实](#常见借口与事实)

参数模板的唯一权威来源是 SKILL.md §执行期约定：参数固化。本文件片段首行一律 `set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env`，并只断言该阶段已固化的变量，git 命令一律 `git -C "$ROOT"` 或 `git -C "$WT"`，diff/log 加 `--no-pager`。

## 断点探测

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${BR:?}" "${BASE:?}"
git -C "$ROOT" worktree list --porcelain
git -C "$ROOT" worktree prune --dry-run
git -C "$ROOT" show-ref --verify --quiet "refs/heads/$BR" && echo "local branch exists" || echo "no local branch"
git -C "$ROOT" ls-remote --exit-code --heads origin "$BR" || echo "no remote branch"
gh pr list --head "$BR" --state all --json url,state,baseRefName,headRefName
```

## 恢复对照表

| 探测结果 | 处理 |
|---|---|
| worktree 已注册但目录缺失 | `git -C "$ROOT" worktree prune`，继续 |
| 本地分支存在，且 `origin/$BASE..$BR` 的 commit 全部带本 `$ISSUE` | 判定为本任务残留 → 复用分支与 worktree，直接跳到重新验证 |
| 本地分支存在但含无关 commit，或不是 `origin/$BASE` 的后代 | 停止并报告，交用户决定；**绝不删除、绝不 reset、绝不 rebase** |
| 远程有 `$BR` 但本地没有 | 停止并报告作者/时间（很可能是别人的分支） |
| PR 已存在 | 留给 PR 步骤判定，不新建 |
| worktree 目录存在但分支不匹配 | 停止并报告，换名或由用户裁决 |

归属判定与远程分支溯源：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${BR:?}" "${BASE:?}" "${ISSUE:?}"
git -C "$ROOT" --no-pager log --oneline "origin/$BASE..$BR"
git -C "$ROOT" --no-pager log --format='%h %an %ad %s' -5 "origin/$BR"
git -C "$ROOT" merge-base --is-ancestor "origin/$BASE" "$BR" && echo descendant || echo diverged
git -C "$ROOT" --no-pager log --format=%s "origin/$BASE..$BR" | grep -cv "$ISSUE"
```

最后一条计数为 `0` 才算“全部属于本任务”。只有“不属于本任务”和“需要判断”两类才是停止条件；已确认属于本任务的残留**必须自动续做**，不得要求用户手动清理后重来。

## 并发同名分支

只查 `refs/heads/$BR` 不够：同事已 push 的同名分支要到 Step 6 push 时才暴露，此时全部工作已完成，正是最容易伸手去按 `--force` 的时刻。因此 Step 3 前就必须跑 `ls-remote`。

- 远程已有同名分支且不是本任务 commit → 换分支名或询问用户，不在别人分支上叠加 commit。
- push 被拒绝（non-fast-forward）→ 停止报告，禁止 `--force`、`--force-with-lease`、`+refspec` 任何形式的覆盖。

## shallow / single-branch clone

`remote.origin.fetch` 被限制时（CI 与部分 IDE clone 常见），`git fetch origin "$BASE"` 只更新 `FETCH_HEAD`，**不会**更新 `refs/remotes/origin/$BASE`，随后的 `show-ref --verify` 失败，Skill 卡在一个看不懂的错误上。始终用显式 refspec：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${BASE:?}"
git -C "$ROOT" config --get-all remote.origin.fetch
git -C "$ROOT" rev-parse --is-shallow-repository
git -C "$ROOT" fetch origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
git -C "$ROOT" show-ref --verify "refs/remotes/origin/$BASE"
```

仓库为 shallow 时，`merge-base`/历史判定可能不可靠，需要时 `git -C "$ROOT" fetch --unshallow` 前先征得用户同意。

## 非 GitHub 与缺少 gh

`gh auth status` 只校验 github.com 凭据，origin 指向 GitLab/Bitbucket/Gitea 时它照样成功。平台必须由 origin URL 加探测共同判定：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
git -C "$ROOT" remote get-url origin
command -v gh >/dev/null || echo "gh missing"
gh repo view --json nameWithOwner 2>&1 | head -3 || true
# GitHub Enterprise：
# GH_HOST=<host> gh auth status --hostname <host>
```

不兼容时**在 Step 0 就停止**，给出降级路径供用户选择：“完成到任务分支的 commit + push；PR 由你创建；我输出 title 与 body 文本”。收尾报告必须明确写“未创建 PR”。

## 失败兜底口径

push 被拒、PR 创建失败、验证失败：保留 worktree、分支和 commit，报告真实状态、失败命令与原文错误。禁止用更危险的操作兜底（force push、删分支重建、改 base、直推受保护分支、`reset --hard`）。

## 主工作区隔离指纹

Step 0 记录、Step 8 复核，两次都写进报告：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}"
git -C "$ROOT" rev-parse HEAD
git -C "$ROOT" status --porcelain=v1 | sha256sum
```

两次指纹不一致时，在报告**最顶部**显著声明主工作区已被改动，并列出差异文件（`git -C "$ROOT" status --short`）；不要自行回滚。

## 临时文件卫生

固定路径 `/tmp/<issue>.json` 有三个真实故障：并发会话互相覆盖；抓取中途失败留下空文件但存在；隔日重跑静默读到旧快照。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
umask 077
JSON=$(mktemp "/tmp/pi-linear-XXXXXX.json")
node <skill-dir>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$JSON"
jq -e '.identifier and .description != null and (.comments | type == "array")' "$JSON" >/dev/null
jq -r '.fetchedAt // "unknown"' "$JSON"; date -u +%Y-%m-%dT%H:%M:%SZ
```

`jq -e` 失败即视为抓取失败，重抓而不是读残缺文件；`fetchedAt` 与当前时间差异明显时按过期快照处理。最终报告输出后删除临时 JSON、PR body 与 `$WT/.pi-verify-*.log`。

## pager 与交互

所有命令在非交互环境下运行，避免挂在 pager 或提示上。`GIT_PAGER=cat GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1` 已写入 `$ENVFILE`，因此每个片段首行 source 之后即生效；一次性命令也可在行首显式带上这三个变量。

git 侧同时用 `--no-pager`；`gh` 侧所有参数（`--base`、`--head`、`--title`、`--body-file`、`--repo`）显式传，不依赖交互提示补全。

## 收尾报告字段

Step 8 的报告必须逐项给出，缺项即视为报告不完整：

- Issue identifier、标题、URL、形态闸门结论
- base 及其选择证据、受保护分支集合
- branch、worktree、commit SHA
- PR URL 与 base/head/state
- 变更文件清单
- 逐包验证结果（已运行/通过/失败/超预算未跑/未运行 五种状态）
- **主工作区隔离校验**：`status` 指纹 <前> → <后>（一致/不一致）+ 指纹的覆盖边界声明
- 本次全部写操作清单（worktree、临时文件、commit、push、PR），每条附还原命令
- 限制、未验证项、未核对文档和已同意的假设

## 不可读需求来源

一次性结构化索取，不反复追问：

```text
【TEAM-N 需求来源缺口】
不可读来源：<标题/URL> — 类型：Linear document / 图片附件 / 外部文档 — 为什么它决定实现：...
需要你提供（任选其一）：
- 粘贴该文档的相关段落（期望 + 验收标准）
- 或直接在此确认期望与验收标准
- 或确认「按正文与评论口径实现」，我将把该文档标记为未核对并写入 PR
```

三级处置：

| 情形 | 处置 |
|---|---|
| 正文/评论已有等价口径 | 记「参考性缺口」，继续，登记进理解卡与 PR body「假设」段 |
| 该来源决定实现，用户补齐了内容 | 按补齐内容更新理解卡，正常继续 |
| 该来源决定实现，用户选择「按正文与评论口径实现」 | 继续，但在理解卡、PR body「假设」段、收尾报告三处同时登记「<文档> 未核对」 |
| 该来源决定实现，用户未回应 | 停止。不得凭标题或文件名推断内容 |

## 常见借口与事实

「立即停止并询问」是正向规则，本表是反向堵漏。左列出现在自己的推理里，就按右列办：

| 借口 | 事实 |
|---|---|
| 测试刚才跑过了 | 要在**即将推送的那棵树**上重跑；改完再跑才算 |
| 环境跑不起来，先当测试失败报上去 | 环境未就绪与测试失败是两类结论，不得混报 |
| CI 是绿的 | CI 可能没覆盖本次模块；pending / skipped 都不算通过 |
| 评论太多，只看最新的几条 | 较新的评论不自动具有覆盖权，须有明确覆盖证据 |
| 文档打不开，按标题猜个大概 | 禁止凭标题、URL slug 或文件名推断内容，按 Step 1.2 降级 |
| 顺手把这个明显的问题也修了 | 计划外改动即越界；记为既存问题，单独提案 |
| lockfile 变了应该没关系 | 与依赖变更无关的漂移必须还原，不得提交 |
| 远程有同名分支，push 上去应该能合 | 可能是他人分支；禁止在他人分支上叠加 commit |
| push 被拒，force 一下就好 | 未授权。按本文判定原因，force 永不是解法 |
| 用户说「看着还行」就是同意了 | 条件式回复不构成授权，见 SKILL.md §有效确认的判定 |
| worktree 里有没提交的文件，删掉重来 | 拒绝正说明这些改动只存在于那里，先报告再由用户决定 |

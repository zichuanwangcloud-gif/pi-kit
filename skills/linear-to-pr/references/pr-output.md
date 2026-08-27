# PR 与 commit 产出

按仓库既有模板与提交规范产出 commit message 和 PR body，并核验 PR 真实创建成功。

> 由 SKILL.md 的 Step 6–7 引用。

## 本文小节

- [仓库模板优先](#仓库模板优先)
- [默认 body 模板](#默认-body-模板)
- [关联](#关联)
- [需求理解](#需求理解)
- [变更](#变更)
- [验证](#验证)
- [假设](#假设)
- [敏感内容](#敏感内容)
- [commit message](#commit-message)
- [fork 场景](#fork-场景)
- [创建与核验](#创建与核验)
- [Linear 关联与副作用](#Linear-关联与副作用)

参数模板的唯一权威来源是 SKILL.md §执行期约定：参数固化。本文件片段首行一律 `set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env`，并只断言该阶段已固化的变量，git 命令一律 `git -C "$WT"`，diff/log 加 `--no-pager`。

## 仓库模板优先

先探测，命中即以模板为骨架：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
ls -1 "$WT"/.github/pull_request_template.md \
      "$WT"/.github/PULL_REQUEST_TEMPLATE* \
      "$WT"/docs/pull_request_template.md 2>/dev/null || echo "no repo template"
```

- 命中：保留模板全部标题与 checkbox 原样，在其后追加本 Skill 的 `关联`/`需求理解`/`验证`/`假设` 段。
- 禁止删除或改写模板标题、checkbox。
- 无法自行核实的 checkbox 留空并写明原因（如 `未勾选：需 QA 在 staging 验证`）。绝不代用户勾选合规、测试、发布或安全声明。
- 多个模板（`PULL_REQUEST_TEMPLATE/` 目录）时按 Issue 类型选一个，并在报告里说明选择依据。

## 默认 body 模板

仅在仓库没有模板时使用：

```markdown
## 关联
- Linear: <TEAM-123> <issue URL>

## 需求理解
- 现象/动机：...
- 期望：...
- 验收标准：...

## 变更
- `<file>`：...

## 验证
- `<command>` 通过
- 超预算未跑：`<command>`（原因）
- 未运行：`<command>`（原因）

## 假设
<!-- 仅在用户明确同意按假设推进时保留 -->
- ...
```

stacked PR 追加一段 `## 依赖`：`依赖 #<父 PR>，需在其合并后再合并`。

## 敏感内容

PR body 源自 Linear 文本，其中经常混有客户名称/邮箱、订单号或账号 ID、内部主机名与内网 URL、staging 凭据、生产日志原文。

- 禁止把上述任何内容复制进 PR body、commit message、代码注释或日志。
- 用 Issue 链接代替引用，或写脱敏摘要（`某企业客户`、`<order-id>`、`内部网关`）。
- 涉及疑似真实凭据时不回显取值，只说明位置与需轮换。

## commit message

先读规范再写：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
ls -1 "$WT"/commitlint.config.* "$WT"/.commitlintrc* "$WT"/.husky/* 2>/dev/null || true
git -C "$WT" --no-pager log --oneline -20
```

- 有 `commitlint`/hook：严格按其 `type`、`scope` 枚举与长度限制。
- 存在 `header-max-length`（常见 72）时，标识符放 footer 而不是 subject 后缀：

```text
fix(<scope>): <简述>

<可选正文>

Refs: <TEAM-123>
```

- 无规范时沿用 `git log` 中的既有风格，写真实、具体的描述。
- 禁止伪造 `Co-authored-by`、`Signed-off-by` 或任何未经授权的 trailer。
- 只暂存本任务文件，提交前审阅 staged diff：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}" "${BR:?}"
test "$(git -C "$WT" branch --show-current)" = "$BR"
git -C "$WT" add -- '<task-file-1>' '<task-file-2>'
git -C "$WT" --no-pager diff --cached --stat
git -C "$WT" --no-pager diff --cached
```

## fork 场景

origin 是 fork 时，head 必须带 owner 前缀，且 `--repo` 必须同时传给 `gh pr create` **和** `gh pr view`——否则查重命令查的是 fork 自己的仓库，探测不到 upstream 上已存在的 PR，会重复创建：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${BR:?}"
gh repo view --json nameWithOwner,isFork,parent
# isFork=true 时：
UP='<upstream-owner/repo>'
OWNER='<origin-owner>'
gh pr list --repo "$UP" --head "$OWNER:$BR" --state all \
  --json url,state,baseRefName,headRefName
```

- 仓库归属有歧义（多个 remote、`gh` 提示选择）时用 `gh repo set-default` 明确，但先询问用户，不静默接受默认值。
- GitHub Enterprise 需先设置 `GH_HOST`。

## 创建与核验

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${BR:?}" "${BASE:?}" "${WT:?}"
umask 077
BODY=$(mktemp "/tmp/pi-pr-body-XXXXXX.md")
# 写入 body 后：
gh pr create --repo <owner/repo> --base "$BASE" --head "<origin-owner>:$BR" \
  --title "<project-style title>" --body-file "$BODY"
gh pr view "$BR" --repo <owner/repo> --json url,state,baseRefName,headRefName
rm -f "$BODY"
```

非 fork 时省略 `--repo` 与 head 的 owner 前缀。创建后必须逐项确认 `state=OPEN`、`baseRefName=$BASE`、`headRefName=$BR`；三项不全部满足即视为未成功：报告真实状态与错误原文，保留分支与 commit。**push 成功不等于 PR 成功**，禁止把 push 结果当作 PR 结果上报。不自动 merge、approve、ready，不回写 Linear。

## Linear 关联与副作用

本 Skill 自身不调用 Linear 写接口。但若仓库启用了 Linear 的 GitHub 集成，分支名或 PR 标题中的
`<ISSUE>` 会触发集成自动关联 PR 并按团队工作流推进 Issue 状态（常见 In Progress → In Review）。
这是集成行为，不受本 Skill 控制，但由本 Skill 的默认命名主动触发，因此必须在计划阶段披露。

PR body 首行的 magic word 决定状态自动化的强度，按用户意图选一个，不要默认：

| 写法 | 效果 |
|---|---|
| `Fixes <ISSUE>` | 关联并在 PR 合并时把 Issue 推进到 Done。**这是一个不可撤销的外部副作用，必须在计划里说明后才用** |
| `Part of <ISSUE>` | 关联但不闭环，适用于一个 Issue 拆多个 PR |
| 纯文本引用 Issue 链接 | 不建立关联、不触发任何状态自动化 |

用户要求完全避免自动化时：改用不含 identifier 的分支名与标题，并在 body 中用纯文本引用 Issue。
注意写在 PR **评论**里的 magic word 不建立关联，只有 body 生效。

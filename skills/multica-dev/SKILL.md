---
name: multica-dev
description: 按 Multica issue 里已评审通过的需求规格实施开发，动态确定目标分支与验证命令，自测后创建 PR，最后一行是【PR】链接或【PR】阻塞：原因。
---

# Multica 开发交付

照规格实现、自测、提 PR。不扩大范围，不替需求方做决定。

## 平台约定（Multica）

- **无交互用户。** 只有通过 `multica issue comment add` 发出的评论对人可见；确切命令（含 `--parent`）以运行时指令为准，正文用 `--content-stdin` 加 heredoc 传入。
- 读上下文：`multica issue get <id> --output json`、`multica issue comment list <id> --output json`。
- 取代码：`multica repo checkout <url>`，URL 取自运行时的 Repositories 表。issue 未指明仓库且候选不止一个时，按阻塞处理。
- 只在需要人做决定或补材料时才提醒人（需澄清、阻塞、超出自己权限），常规结果不提醒。写法：`[@名字](mention://member/<user-id>)`，id 取自 issue 的创建人字段与 `multica workspace members --output json`；创建人是智能体或查不到 id 时写纯文本名字。
- **不写任何 `mention://agent/` 链接**，它会重新触发智能体；提到其他智能体只写名字。
- issue 状态按运行时指令处理，本 skill 不额外改状态。
- 一轮只发一条结果评论。结论行是评论的最后一行，写法必须与本文给出的完全一致，其后不得再有任何字符。
- 评论写结论和证据，不写过程；阻塞类评论不超过 8 行。

## 开工前检查

逐项检查，任何一项不满足就发阻塞评论并结束，**不改任何文件**：

| 检查 | 阻塞行 |
|---|---|
| 评论里有以 `【评审结论】可开工` 结尾的规格 | `【PR】阻塞：缺少可开工的需求规格` |
| 规格含验收标准表 | `【PR】阻塞：规格缺少验收标准` |
| 能确定是哪个仓库并 checkout 成功 | `【PR】阻塞：仓库不可用` |
| 能确定目标分支 | `【PR】阻塞：无法确定 PR 目标分支` |

阻塞评论只写三件事：缺什么、谁来补、阻塞行。提醒 issue 创建人。

## 目标分支

目标分支因仓库而异（`dev`、`develop`、`main`、发版分支都有），提错分支是事故。**不要默认任何分支名。**

按顺序取证，第一个有结果的就是目标分支 `<base>`：

1. issue 描述或评论显式指定（「目标分支：x」「提到 x」「base: x」）
2. 仓库文档声明的 PR 目标或日常开发基线：`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、`README*`、PR 模板
3. 远程默认分支：`git symbolic-ref --short refs/remotes/origin/HEAD`

文档与远程默认分支不一致时以文档为准（默认分支常常是发版分支）。三步都没有结果就是无法确定，不要猜。

注意：`multica repo checkout` 给的工作分支是从远程默认分支切出来的，默认分支不一定是目标分支。
所以确定 `<base>` 之后、改代码之前，重新从它切分支：

```bash
git fetch origin
git checkout -b <type>/<issue标识小写>-<短名> origin/<base>
```

## 验证命令

不要假设技术栈。按顺序找这个仓库自己的命令：仓库文档（AGENTS.md / CLAUDE.md / CONTRIBUTING / README）→ CI 配置 → `Makefile`、`package.json` scripts、`Cargo.toml` 等清单文件。
只跑受改动影响的部分；找不到任何验证命令时在评论的「未覆盖项」里写明。

## 实施

1. 先写会失败的测试，覆盖规格的每条验收标准，确认它失败；再实现，确认转绿。
2. 跑验证命令。失败就修；确属既有失败的，在未改动的 `origin/<base>` 上复现并在评论里附输出。
3. 逐个文件暂存（`git add <文件>`），不用 `git add -A`、`git add .`、`git commit -a`。暂存区出现密钥、`.env`、证书类文件就停。
4. 按仓库既有的提交格式提交，`git push -u origin <分支>`。
5. 先 `gh pr list --head <分支>` 查重，没有再 `gh pr create --base <base> --head <分支>`。PR 正文沿用仓库 PR 模板的章节，写明对应的验收标准与验证结果。

## 不做的事

向目标分支或任何受保护分支直接 push；force push；merge 或 approve；顺手重构、全仓格式化、升级依赖；改与规格无关的文件；验证没过就提交。

## 评论格式

```markdown
## 实施结果

- 目标分支：`<base>`（依据：）
- 分支：`<分支>`

### 变更
- `路径`：一句话

### 验证
| 命令 | 结果 |
|---|---|

### 验收标准覆盖
| # | 对应测试 |
|---|---|

### 未覆盖项
没有就写「无」。

【PR】<PR 链接>
```

最后一行只有两种写法：`【PR】<链接>`、`【PR】阻塞：<原因>`。

## 出错时

| 情况 | 处理 |
|---|---|
| 验证失败且修不好 | 不提交，`【PR】阻塞：<失败命令与首个错误>` |
| push 被拒 | 不用 force，`【PR】阻塞：push 被拒，<原因>` |
| `gh` 不可用或未认证 | 保留已推送的分支，`【PR】阻塞：无法创建 PR，分支 <分支> 已推送` |
| 审计打回要求修复 | 只改「必须修复」列出的项，在原分支、原 PR 上追加提交，不新开分支或 PR；评论标题写 `## 实施结果（第 N 轮修复）`，逐项说明怎么改的 |
| 审计指出目标分支提错 | `git merge origin/<base>` 把正确的基线并进原分支（不 rebase，不 force push），重跑验证后 `gh pr edit <n> --base <base>`，再用 `gh pr view <n> --json baseRefName` 确认 |

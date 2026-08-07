# Linear → PR 使用经验

## 需求来源不只有正文

Linear 评论区经常包含：

- 产品需求或设计说明
- 原型与附件
- 验收标准和测试补充
- 对正文的修订或否定

因此必须按时间顺序审阅全部评论、附件和关键文档，不能只看 issue description，也不能只看关键词命中的评论。

## 冲突处理

较新的评论不自动拥有覆盖权。只有出现“最终方案”“以此为准”“旧方案取消”等明确证据，才能作为候选最新口径；否则应列出冲突并询问用户。

## 项目标识与输入

Linear identifier 应优先使用完整形式，例如 `ENG-123`。不同项目的 team key 不同，Skill 不应写死团队 key。

裸数字输入仅在显式配置 `LINEAR_TEAM_KEY` 时才可补全：

```bash
export LINEAR_TEAM_KEY=ENG
```

未配置时应询问，而不是选择任意团队。

## 代码落点

同一仓库可能存在旧版/新版页面、平台覆写组件、生成代码或多个服务实现。必须从实际路由、注册关系和 import 沿调用链确认真实生效文件，避免只按同名文件或关键词判断。

分层名称因项目而异。报告应使用代码真实存在的层次，例如 controller/use-case/adapter、route/handler/service/repository，不能把某种架构模板强加给所有项目。

## Git 基线与隔离

通用解析顺序：

1. 用户显式给出的 `--base <branch>`。
2. 目标仓库的 `AGENTS.md`、贡献指南或其他明确工作流文档。
3. 远程默认分支和已有 PR 约定。
4. 仍有歧义时询问用户。

确认后：

- `git fetch origin <base>`
- 显式以 `origin/<base>` 为 worktree base
- 在独立任务分支/worktree 中修改
- 主工作区 dirty 时不做 reset/clean/stash
- PR base 使用同一个已确认基线

不要假定每个项目都使用 `dev`，也不要假定任务分支只能叫 `feature/*` 或 `fix/*`；优先遵循仓库规范。

## 自动 PR 的授权边界

用户确认需求理解卡和实施计划后，Skill 可在验证通过后自动：

- 提交本任务文件
- 推送本任务分支（不 force）
- 创建到已确认 base 的 PR
- 把 Issue 一次性置为团队 `type=started` 的状态（`--no-status` 关闭）

授权不包括：

- 直推受保护分支
- force push
- 合并、approve 或 ready PR
- 回写 Linear 评论，或修改状态以外的 Issue 字段
- 发布、部署或操作生产环境

## Linear 状态回写

这是 Pi Kit 唯一对外部系统的写操作。设计上有四个反直觉的决定，都不要"顺手改掉"。

### 按 `position` 选状态，不按名字

Linear 默认团队配置里 `type=started` 通常有多个状态：In Progress、In Review、Ready to Merge。取 `position` 最小者，因为 started 区间最靠左的列在结构上就是入口——后面几列 position 更大正是因为它们在流程后段。

不按名字匹配 `"In Progress"`，因为那是英文专属：在中文或改过名的工作区永远不命中，于是同一个 Skill 会因客户语言不同而走两条不同路径，这是最难排查的分歧，也直接违反项目中立原则。一条规则，处处适用。

### 已在 started 不回退

有人把 Issue 拖到 In Review 之后，自动化再把它拖回 In Progress，会破坏人工录入的信号并触发全组通知。用户的意图是「标记开工」——In Review 本身已经表示开工了。所以判定看的是 `type`，不是具体哪一列。

### 终态永不重开

`completed` / `canceled` 的 Issue 不由自动化重开。重开是语义很重的动作，用户确认实施计划时并没有覆盖它，而且可能跨越发布或 QA 流程。脚本不改，改由主干在 Step 1（闸门前）就对终态 Issue 提问——那本质是需求问题：要么在重做已完成的工作，要么贴错了 identifier。

### 失败继续，但绝不静默

状态回写不是任何下游步骤的前提。因 403 中止一个已确认的实现计划，等于为附属功能牺牲用户真正要的产出（可工作的代码和 PR）。只读 API key 是完全合理的配置，必须降级为「PR 已建、状态未更新」。

真正的危险是*静默*失败——用户以为看板更新了其实没有。所以退出码 1 时把错误原文记入收尾报告，一次点击就能补上。

### 脚本为何独立

`update-issue-state.mjs` 与只读的 `fetch-linear-issue.mjs` 分离，不是为了整洁。`pr-audit` 承诺「不运行会写外部状态的命令……Linear mutation」，并会调用 fetch 脚本取需求数据。当前这条承诺可以用一次 grep 证明；若给 fetch 脚本加 `--set-state` 之类的开关，保证就退化成「模型没传错参数」——这类保证会在复制粘贴和后续重构中失效。只读审计路径不该离写操作只有一个参数之遥。

代价是两个脚本重复了约 50 行凭据解析和 GraphQL 封装。这个重复是有意接受的：提取共享模块要改动 `pr-audit` 依赖的那个文件，为省 50 行稳定代码引入只读路径的回归风险，不划算。

## 验证

Skill 应从目标项目读取实际命令，例如：

- `package.json` / workspace scripts
- `Makefile` / task runner 配置
- `go.mod`、`Cargo.toml`、构建文件
- `AGENTS.md` / `CLAUDE.md` / contributing guide

报告必须区分已通过、失败和未执行的验证，不应把某个项目的命令当作通用默认。

## 凭据

Linear API key 可来自：

1. `LINEAR_API_KEY`
2. `LINEAR_API_KEY_FILE`
3. `~/.config/pi/linear-api-key`

文件权限建议为 `600`。不要把 key 放入 Git、日志、PR body 或会话文本。

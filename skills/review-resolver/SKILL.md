---
name: review-resolver
description: 汇总 PR 或代码审查意见，验证每条意见在当前 head 上是否成立，去重并形成解决计划；仅在用户明确授权且确认计划后，才可在隔离任务工作区修改代码并验证。用于“处理 review comments”“逐条解决审查意见”“review 反馈是否合理”等请求。
compatibility: Requires a readable git checkout. Reading hosted review threads may require the repository's authenticated CLI. Editing requires an isolated task branch or worktree and explicit user approval of the proposed plan.
allowed-tools: read bash edit write
metadata:
  category: review-resolution
  portability: project-agnostic
---

# Review Resolver

把 review comment 从“文字意见”转换为“已验证事实 → 决策 → 可审阅计划 → 经授权实现”。默认模式是**只读分析**：不 push、不修改 PR/Linear、不部署、不触碰主工作区。本 Skill 是九个通用开发 Skill 中唯一可修改任务代码的能力，但必须同时满足：用户明确要求修复、已展示逐条计划、用户确认计划、当前目录是安全的隔离任务分支/worktree。任何确认都不授权 push、PR comment/review、resolve thread、合并、Issue 回写或部署。

## 模式

- `analyze`（默认）：读取、验证、分类和计划；不改文件。
- `apply`：只有通过授权闸门后修改任务代码并本地验证。

“看看/分析/处理一下 comments”不等于修改授权。若用户在初始请求已明确“修复”，仍需先给计划并等待确认。

## 1. 项目与审查对象探测

读取根目录和受影响模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、review/测试文档。记录主工作区状态，不 reset、clean、stash 或覆盖改动。

唯一确定 PR/commit/head SHA。使用托管平台的只读 API/CLI 获取：review、inline threads、一般评论、作者、时间、文件、原始行、是否 outdated/resolved、reply 和当前 head。先核实 CLI 帮助及权限；禁止 comment/reply/resolve/dismiss/approve/request-changes/edit。

日志或 JSON 保存到仓库外临时文件并完整读取。若用户粘贴意见，也要标注其版本边界。

## 2. 建立意见清单

为每条赋稳定本地 ID（如 `R1`），保留来源 URL/数据库 ID，绝不声称本地 ID 是平台 ID。将重复或同根因意见聚类，但逐条保留处置：

- `VALID`：当前 head 上仍成立；
- `ALREADY_FIXED`：后续提交已解决，并附证据；
- `OUTDATED`：原行漂移，且意见不再适用；
- `DUPLICATE`：与另一条同根因；
- `QUESTION/CLARIFICATION`：需回答，不一定改代码；
- `DISAGREE`：基于项目事实不采纳；
- `BLOCKED`：缺少上下文、权限或产品决策。

不要因为 thread resolved 就认定代码正确，也不要因为 reviewer 提出就自动接受。对当前 head 阅读完整上下文、调用方、测试和项目规范。

## 3. 风险与解决方案

对 `VALID` 意见说明：问题触发条件、影响、最小修复、兼容性、应加测试及验证命令来源。检查多条建议是否冲突、是否要求 schema/API/迁移/安全决策。产品或安全取舍不能由 Skill 猜测，使用 `<loop-blocked>问题</loop-blocked>` 或普通问题等待决定。

输出确认卡：

```markdown
## Review 解决计划（待确认）
| ID | 状态 | 当前证据 | 计划/回复要点 | 文件 | 验证 |
|---|---|---|---|---|---|

边界：只修改列出的任务文件并本地验证；不 push、不发布回复、不 resolve thread、不修改 PR/Issue、不部署。
请确认该计划后再进入 apply。
```

## 4. 修改授权闸门

进入 `apply` 前逐项满足：

- 用户已明确授权修改，并在计划展示后确认；
- head/review 没有漂移，漂移则更新分析并重新确认；
- 当前分支不是 `main`、`master`、已确认 base 或项目保护分支；
- 当前目录是任务 worktree/分支，且已有改动归属清楚；
- 计划内文件、测试和生成步骤明确；
- 不需要生产凭据、外部 mutation 或未知 installer。

主工作区、detached 审计 worktree、他人分支、dirty 状态来源不明时不得修改。询问用户切换/创建安全环境；本 Skill 不自行触碰主工作区。

## 5. 经授权实现

- 开始前再次冻结 head 与 `git status`。
- 只修改确认计划中的任务代码；使用 `edit` 精确修改，新文件用 `write`。
- 遵循项目真实格式、测试、生成和架构约定，不顺手重构。
- 一条评论需要扩大范围时暂停并更新计划，不借“修 review”引入未确认 API/schema 变化。
- 不执行 `git add/commit/push`，除非用户另行授权且其他上层安全策略允许；本 Skill 默认只保留工作树改动。

从项目文档、CI、manifest 和相邻测试发现验证命令。先阅读脚本；不运行部署/发布/远程写入。依赖缺失则记录，继续可行静态检查。至少运行目标测试（可用时）和 `git diff --check`，阅读最终 diff。

## 6. 收尾映射

```markdown
# Review Resolver 报告
## 对象
- PR/commit/head：...
- 模式：analyze / apply

## 意见处置
| ID | 来源 | 状态 | 证据 | 变更/建议回复 |
|---|---|---|---|---|

## 修改（仅 apply）
- `file:line` — 原因

## 验证
| 命令/检查 | 结果 | 覆盖/限制 |
|---|---|---|

## 待人工动作
- 可发布的回复草稿（明确标记未发布）
- 尚需决策/权限的意见

## 安全声明
- 未 push，未评论/resolve review，未修改 PR/Issue，未部署。
```

不得把回复草稿描述为已发布，也不得把本地修复描述为 reviewer 已接受。

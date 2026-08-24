# Pi Kit

面向通用软件项目的便携 Pi 技能与扩展包。它提供可按需加载的工程工作流，但不假定仓库名称、目录结构、技术栈、Issue 团队 key、默认分支或发布流程。

## 设计原则

- **项目中立**：先读取目标仓库的 `AGENTS.md`、`CLAUDE.md`、贡献指南和 Git 配置，再决定工作流参数。
- **约定可发现**：优先从当前分支、远程 HEAD、PR 配置和仓库文档推导；无法唯一判断时询问，不猜测。
- **渐进加载**：Pi 启动时只发现 Skill 描述，任务匹配时再加载完整说明。
- **安全默认**：不覆盖用户改动，不 force push，不自动合并、部署或修改 Issue 状态。
- **证据优先**：代码定位、需求理解和测试结论都附真实来源；无法确认的内容明确列为缺口。

> Pi Kit 是工作流工具箱，不会替代目标项目自己的开发规范。仓库级说明始终优先于本文示例。

## 能力

| 能力 | 入口 | 适用场景 |
|---|---|---|
| 帮助中心 | `/help` | 动态查看已安装命令、Skill、通用安全规则和配置提示；不调用模型 |
| Skill 调度 | `/skills`、`invoke_skill` | 交互或由模型按任务加载已发现的 Skill |
| 功能溯源 | `/skill:feature-trace <描述>` | 在 Web、服务端或 monorepo 中追踪真实代码路径、UI 入口、文案和测试点 |
| Linear → PR | `/skill:linear-to-pr TEAM-123` | 完整审阅 Linear 需求，确认后在隔离 worktree 实现、验证并创建 PR |
| PR 三门审计 | `/skill:pr-audit 123 [--linear on]` | 审计正确性、可选需求完整性和代码安全；启用 Gate 全部 PASS 后给出评级 |
| Linear 验收审计 | `/skill:linear-pr-audit 123 TEAM-456` | 在三门之上叠加验收门：逐条可执行验证 Linear 验收标准，确认后可修复并复验，4/4 PASS 后回写自测报告 |
| CI 排障 | `/skill:ci-triage <run|job|PR>` | 还原失败时间线，定位首个有效错误并区分代码、flaky、配置和基础设施问题 |
| Review 解决 | `/skill:review-resolver <PR|comments>` | 验证、去重和规划审查意见；确认计划后才可在隔离任务工作区修改代码 |
| 影响面分析 | `/skill:change-impact <range|PR|提案>` | 追踪依赖、运行时、数据、契约、交付和用户影响 |
| 测试缺口 | `/skill:test-gap <range|功能>` | 建立行为—测试矩阵，评价断言质量并排序补测 |
| Schema 迁移审计 | `/skill:schema-migration-audit <range|PR>` | 审计兼容窗口、锁、数据校验、执行顺序和恢复 |
| API 契约审计 | `/skill:api-contract-audit <range|PR>` | 审计 HTTP/RPC/事件/CLI/库契约兼容和消费者风险 |
| 发布就绪 | `/skill:release-readiness <candidate>` | 汇总质量、安全、运维、rollout 和 rollback 门禁 |
| 依赖升级 | `/skill:dependency-upgrade <package|range>` | 核对版本、lockfile、上游 breaking、安全、许可证和验证计划 |
| Incident 初排 | `/skill:incident-triage <evidence>` | 安全地建立事件范围、时间线、假设、缓解建议和交接材料 |
| Engineering Loop | `/loop` | 在当前非受保护分支中进行有完成条件的安全迭代 |

## 快速安装

要求：Node.js 22+、Pi、Git。部分能力另需 `rg`、`gh`、`jq`、Linear API key；运行 `./scripts/doctor.sh` 可查看状态。

### 本地开发安装

```bash
git clone <your-pi-kit-repository> ~/git/pi-kit
cd ~/git/pi-kit
./scripts/install.sh
```

脚本本质上执行：

```bash
pi install /absolute/path/to/pi-kit
```

已有 Pi 会话中运行：

```text
/reload
/help installed
```

也可以按 Pi package 语法从可信 Git 仓库安装，并使用 tag 或 commit 固定版本：

```bash
pi install git:<git-url>@<tag-or-commit>
```

扩展拥有当前用户权限。安装第三方 fork 前应审阅源码。

## 项目适配

Pi Kit 不再内置某个项目的分支和目录约定。使用前应确认：

- 默认开发基线，例如 `main`、`develop` 或 `dev`
- PR 目标分支
- 受保护分支集合
- 功能/修复分支命名
- Issue 标识，例如 `ENG-123`、`APP-42`
- 测试、构建、lint 和生成代码命令
- worktree 的安全存放位置

`linear-to-pr` 接受显式参数来消除歧义：

```text
/skill:linear-to-pr ENG-123 --base develop
```

若不传 `--base`，Skill 会从仓库文档、远程默认分支和当前工作流中探测；证据冲突时先询问。裸数字只有在 `LINEAR_TEAM_KEY` 已配置时才会补全。

可选环境变量：

| 变量 | 用途 |
|---|---|
| `LINEAR_API_KEY` | Linear API key |
| `LINEAR_API_KEY_FILE` | Linear API key 文件位置 |
| `LINEAR_TEAM_KEY` | 裸数字 Issue 的默认团队 key |

API key 默认也可放在 `~/.config/pi/linear-api-key`，权限应为 `600`。

## 常见用法

### 功能溯源

```text
/skill:feature-trace "用户在哪里修改通知偏好，这个功能如何测试？"
```

Skill 会先探测项目结构，再按真实路由/import/调用关系追踪，不要求项目必须使用特定前后端框架。

### Linear 到 PR

```text
/skill:linear-to-pr ENG-123 --base develop
```

工作流为：完整需求审阅 → 理解卡与计划 → 用户确认 → 从远程基线创建 worktree → 实现与验证 → 提交并推送任务分支 → 创建到确认基线的 PR。

确认理解卡和计划即授权最后的任务分支 push 与 PR 创建；force push、合并/approve/ready PR、回写 Linear、部署仍不在授权范围内。

### PR 三门审计

```text
/skill:pr-audit 123
/skill:pr-audit 123 --linear on
```

默认关闭 Linear 对比，仅审计 Correctness 和 Security，二者都通过即 `2/2 PASS`。开启后增加 Requirements Gate，必须 `3/3 PASS`。报告同时给出 Gate 状态、S/A/B/C/D/F 等级和合并建议；第一版只在 Pi 输出，不自动评论或修改 PR。

### Linear 验收审计

```text
/skill:linear-pr-audit 123 TEAM-456
/skill:linear-pr-audit 123 TEAM-456 --max-rounds 2
/skill:linear-pr-audit 123 TEAM-456 --no-post
```

在三门之上叠加 Acceptance 验收门，必须 `4/4 PASS`。它把 Linear 的验收标准逐条拆开，用自动化测试或可复现命令**实际验证**，而不是静态比对；未通过时重点说明缺什么、缺在哪、期望与实际，等用户确认后可在隔离 worktree 修复实现、推送修复并复验，循环直到全过，最后按固定模板把自测报告发送到 Linear Issue 评论区。

它是本包中唯一会推送代码并回写 Linear 的 Skill，因此有一个明确的授权闸门：用户确认验收计划后才创建 worktree。临时验收测试只在 worktree 内运行、登记到 `.git/info/exclude`，不进入 PR；报告会列出本次审计推送的全部修复 commit，便于人类 reviewer 分辨哪些改动出自审计者。fork PR 或对 head 分支无 push 权限时降级为只读 patch 输出，不发送「全过」报告。

### 通用开发审计与排障

九个新增 Skill 覆盖从 CI 到发布/事件的只读工作流：

```text
/skill:ci-triage <run-or-job>
/skill:review-resolver <pr-or-comments>
/skill:change-impact <commit-range>
/skill:test-gap <commit-range-or-feature>
/skill:schema-migration-audit <commit-range>
/skill:api-contract-audit <commit-range>
/skill:release-readiness <candidate-sha-or-tag>
/skill:dependency-upgrade <package-or-commit-range>
/skill:incident-triage <incident-evidence>
```

它们先读取目标仓库说明、manifest、CI 和相关配置，再选择证据与命令；示例参数不是固定平台或项目约定。缺少 CLI、依赖、网络或权限时会标记 `BLOCKED`/未验证并继续可行的静态审计，不会编造结果或自动安装未知工具。

统一安全边界：默认不 push、不修改 PR/Linear、不部署、不触碰主工作区。只有 `review-resolver` 能修改任务代码，而且必须先收到明确修复授权、展示逐条计划、再由用户确认，并且当前目录必须是安全隔离的任务分支/worktree；它仍不会自动 push、发布回复或 resolve thread。

用 `/help development` 查看分类入口，用 `/help installed` 核对当前实际加载路径。

### Engineering Loop

先进入任务分支或 worktree，再启动 Pi：

```text
/loop "修复解析器边界条件并保持现有 API 行为" \
  --validator "npm test -- parser" \
  --max-iterations 8
```

管理命令：

```text
/loop-status
/loop-pause
/loop-resume
/loop-cancel
```

需要人工决策时，模型应输出：

```xml
<loop-blocked>需要用户确认的问题</loop-blocked>
```

Loop 会暂停。它默认阻止 push、PR、SSH、部署和破坏性 Git 操作。

## 目录

```text
extensions/             Pi 扩展
skills/                 Agent Skills 及其脚本
skills/*/references/    Skill 按需读取的详细参考
scripts/                安装、迁移和诊断脚本
docs/                   用户指南、设计说明和维护文档
tests/                  轻量结构与策略检查
```

## 开发与审查

```bash
npm run check
pi -e ./extensions/engineering-loop/index.ts
```

新增或修改 Skill 时：

1. frontmatter 的 `name` 使用小写字母、数字和连字符。
2. `description` 同时写清“做什么”和“何时使用”。
3. 相对资源路径以 `SKILL.md` 所在目录为基准。
4. 通用流程放在 Skill；项目专属命令和路径放在目标项目自己的说明中。
5. 示例使用占位符或中性名称，不把单个项目约定描述为普遍规则。

详见 [贡献与通用化指南](docs/CONTRIBUTING.md)、[迁移清单](docs/MIGRATION.md)、[通用开发 Skills 设计](docs/experience/development-skills.md)、[PR Audit 设计](docs/experience/pr-audit.md) 和 [经验文档](docs/experience/)。

## 安全边界

- 新增的审计/排障 Skill 默认只读：不 push、不修改 PR/Linear、不部署、不触碰主工作区。
- `linear-pr-audit` 是唯一会推送代码并回写 Linear 的 Skill：必须先展示验收计划并由用户确认一次，之后才可在隔离 worktree 修实现、展示 diff 后推送修复到 PR head 分支、并在 4/4 PASS 后发送自测报告；它仍不 force push、不改 PR 状态、不改 Linear 字段、不提交临时验收测试、不修改既有测试。
- `review-resolver` 只有在明确修复授权、计划展示并确认、隔离任务工作区都满足时才可改任务代码；该确认不授权外部写操作。
- 不直接修改或推送已确认的受保护分支。
- 不 force push，不擅自 reset/clean/stash 用户改动。
- 在需求、基线、真实代码落点或验证结果不清时停止并询问。
- 自动 PR 授权不包含合并、审批、部署或 Issue 回写。
- 凭据、会话历史、验证日志和机器相关状态不进入仓库。

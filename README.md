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

详见 [贡献与通用化指南](docs/CONTRIBUTING.md)、[迁移清单](docs/MIGRATION.md) 和 [经验文档](docs/experience/)。

## 安全边界

- 不直接修改或推送已确认的受保护分支。
- 不 force push，不擅自 reset/clean/stash 用户改动。
- 在需求、基线、真实代码落点或验证结果不清时停止并询问。
- 自动 PR 授权不包含合并、审批、部署或 Issue 回写。
- 凭据、会话历史、验证日志和机器相关状态不进入仓库。

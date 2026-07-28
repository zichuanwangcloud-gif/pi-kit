# Pi Kit

CloudRouter 团队/个人使用的便携 Pi 工具包，集中保存：

- Pi Extensions
- Agent Skills
- 使用经验与安全约定
- 新电脑迁移脚本

## 当前能力

| 能力 | 命令/工具 | 说明 |
|---|---|---|
| 帮助中心 | `/help` | 动态展示已安装命令、Skill、路线图与安全规则，不调用模型 |
| Skill 调度 | `/skills`、`invoke_skill` | 交互或模型自动加载已发现 Skill |
| 功能溯源 | `/skill:feature-trace <描述>` | 回溯真实前后端调用链、渲染树、UI 文案和 QA checklist |
| Linear → PR | `/skill:linear-to-pr CR-N` | 读取正文、全部评论/PRD，理解确认后从 origin/dev 建 worktree并走 PR 流程 |
| Engineering Loop | `/loop` | 单 Session 安全迭代，支持 validator、promise、空转检测和外部操作阻断 |

## 安装

### 本地开发安装

```bash
./scripts/install.sh
```

脚本执行：

```bash
pi install /absolute/path/to/pi-kit
```

然后在 Pi 中运行：

```text
/reload
/help installed
```

### 新电脑安装

```bash
git clone git@github.com:zichuanwangcloud-gif/pi-kit.git ~/git/pi-kit
cd ~/git/pi-kit
./scripts/bootstrap.sh
```

也可以直接从 Git 安装：

```bash
pi install git:git@github.com:zichuanwangcloud-gif/pi-kit.git@main
```

建议使用 tag 固定版本：

```bash
pi install git:git@github.com:zichuanwangcloud-gif/pi-kit.git@v0.1.0
```

更新未固定 ref 的包：

```bash
pi update --extensions
```

## 凭据不进入仓库

此仓库永远不保存密钥。新电脑需要单独配置：

- 模型 Provider/API Key：按 Pi 自己的登录/环境变量方式配置
- Linear：`~/.config/pi/linear-api-key`，权限 `600`
- GitHub CLI：`gh auth login`
- Git SSH：`~/.ssh` 或操作系统密钥链

Linear 配置：

```bash
mkdir -p ~/.config/pi
chmod 700 ~/.config/pi
read -rsp "Linear API key: " LINEAR_API_KEY; echo
umask 077
printf '%s' "$LINEAR_API_KEY" > ~/.config/pi/linear-api-key
unset LINEAR_API_KEY
```

## Engineering Loop

必须先进入 feature/fix worktree，再启动 Pi。v0.1 拒绝在 `main/dev/test` 上启动。

```text
/loop "修复目标包测试并保持现有行为" \
  --validator "cd apps/console-v2/backend && go test -tags=unit ./internal/clouditera/service/..." \
  --completion-promise DONE \
  --max-iterations 10
```

管理命令：

```text
/loop-status
/loop-pause
/loop-resume
/loop-cancel
```

模型遇到需要人工决策的阻塞时应输出：

```xml
<loop-blocked>需要用户确认的问题</loop-blocked>
```

Loop 会自动暂停。

## 目录

```text
extensions/             Pi 扩展
skills/                 Agent Skills
docs/experience/        使用经验、设计和迁移说明
scripts/                安装、初始化和诊断脚本
tests/                  轻量结构/回归检查
```

## 开发与检查

```bash
npm run check
pi -e ./extensions/engineering-loop/index.ts
```

## 安全原则

- 不直接 push `main/dev/test`
- 不 force push 受保护分支
- Loop 默认阻止 push、PR、SSH、部署和破坏性 Git 操作
- 项目存在未提交改动时不 reset/clean/stash
- Linear 正文、全部评论和关键 PRD 未审阅完前不实现
- 用户确认前不执行外部动作

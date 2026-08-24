# 安装与迁移清单

Pi Kit 可以通过 Git、Git bundle 或其他可信分发方式迁移。迁移的是代码和通用工作流，不迁移凭据、会话或目标项目配置。

## 自动获得的内容

安装本 package 后可获得：

- `/help`
- `/skills` 和 `invoke_skill`
- `feature-trace`
- `linear-to-pr`
- `pr-audit`
- `linear-pr-audit`
- 九个通用开发审计/排障 Skill：
  - `ci-triage`
  - `review-resolver`
  - `change-impact`
  - `test-gap`
  - `schema-migration-audit`
  - `api-contract-audit`
  - `release-readiness`
  - `dependency-upgrade`
  - `incident-triage`
- `/loop`、`/loop-status`、`/loop-pause`、`/loop-resume`、`/loop-cancel`
- `docs/` 中的使用与维护说明

## 不应进入仓库或 bundle 的内容

- `~/.config/pi/linear-api-key`
- 模型 API key、OAuth token
- `gh` token 和 SSH 私钥
- Pi session 历史
- `~/.pi/agent/state/` 下的 Loop 状态与 validator 日志
- 目标项目的私有配置和未提交改动

## 新环境安装

```bash
# 1. 安装 Node.js 22+、Git 和 Pi
node --version
git --version
pi --version

# 2. 获取并安装 Kit
git clone <your-pi-kit-repository> ~/git/pi-kit
cd ~/git/pi-kit
./scripts/bootstrap.sh

# 3. 按需安装/登录可选工具
#    gh：GitHub PR 工作流；rg/jq：代码检索与 JSON 导航
gh auth login

# 4. 按需配置 Linear key
mkdir -p ~/.config/pi
chmod 700 ~/.config/pi
read -rsp "Linear API key: " LINEAR_API_KEY; echo
umask 077
printf '%s' "$LINEAR_API_KEY" > ~/.config/pi/linear-api-key
unset LINEAR_API_KEY
chmod 600 ~/.config/pi/linear-api-key

# 5. 可选：为裸数字 Issue 配置默认团队 key
export LINEAR_TEAM_KEY=ENG

# 6. 验证
./scripts/doctor.sh
pi
```

Pi 内：

```text
/reload
/help installed
/help skills
/help development
/help safety
```

## 目标项目适配

迁移完成不代表任何目标仓库已自动适配。首次使用前确认：

1. 目标仓库自己的 Agent/贡献说明。
2. 远程默认分支和日常 PR base。
3. 受保护分支和分支命名规则。
4. 测试、构建、lint、代码生成和安全扫描命令。
5. Linear 团队 key 与 GitHub CLI 认证范围。
6. `linear-pr-audit` 所需的额外写权限：对 PR head 分支的 push 权限，以及带评论写入范围的 Linear API key。缺任一项时它会降级为只读 patch 输出。
7. 新增审计 Skill 所需的平台只读权限、日志保留与敏感数据处理规则。
8. migration/API/release/incident 工作流各自的 owner、runbook 与人工签核点。

九个通用开发 Skill 不把缺失工具当成功：依赖、网络或权限不足时记录 `BLOCKED`/未验证，继续能够完成的静态检查。它们默认不 push、不改 PR/Linear、不部署，也不触碰主工作区。`review-resolver` 是唯一修改例外，但只有用户明确要求修复、已看到并确认计划、且当前位于隔离任务工作区后才能修改任务代码；仍不得自动发布回复、resolve thread 或执行其他外部写操作。

`linear-pr-audit` 不属于这九个只读 Skill：它在用户确认验收计划后可以修改实现、推送修复到 PR head 分支并回写 Linear 评论。迁移到新项目前应先确认该项目允许审计流程推送代码，以及 Linear API key 的评论写入范围。

不要把某台机器上的绝对 worktree 路径复制成团队标准。

## Git Bundle 离线迁移

旧环境：

```bash
cd ~/git/pi-kit
./scripts/export-bundle.sh ~/pi-kit.bundle
```

复制 bundle 后：

```bash
git clone ~/pi-kit.bundle ~/git/pi-kit
cd ~/git/pi-kit
./scripts/bootstrap.sh
```

Bundle 只包含已提交 Git 对象，不包含凭据、Pi Session 或未提交文件。

## 迁移验证

```bash
pi list
cd ~/git/pi-kit
npm run check
git diff --check
bash -n scripts/*.sh
./scripts/doctor.sh
```

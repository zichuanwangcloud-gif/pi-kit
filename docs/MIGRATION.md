# 安装与迁移清单

Pi Kit 可以通过 Git、Git bundle 或其他可信分发方式迁移。迁移的是代码和通用工作流，不迁移凭据、会话或目标项目配置。

## 自动获得的内容

安装本 package 后可获得：

- `/help`
- `/skills` 和 `invoke_skill`
- `feature-trace`
- `linear-to-pr`
- `pr-audit`
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
/help safety
```

## 目标项目适配

迁移完成不代表任何目标仓库已自动适配。首次使用前确认：

1. 目标仓库自己的 Agent/贡献说明。
2. 远程默认分支和日常 PR base。
3. 受保护分支和分支命名规则。
4. 测试、构建、lint、代码生成和安全扫描命令。
5. Linear 团队 key 与 GitHub CLI 认证范围。

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
./scripts/doctor.sh
```

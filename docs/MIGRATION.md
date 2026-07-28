# 新电脑迁移清单

## 自动迁移的内容

安装本 Package 后自动获得：

- `/help`
- `/skills` 和 `invoke_skill`
- `linear-to-pr`
- `/loop`、`/loop-status`、`/loop-pause`、`/loop-resume`、`/loop-cancel`
- `docs/experience` 中的经验文档

## 不应自动迁移的敏感/机器相关内容

- `~/.config/pi/linear-api-key`
- 模型 API Key/OAuth token
- `gh` token
- SSH 私钥
- Orca 管理的 `orca-agent-status.ts`
- Pi session 历史和 validator 日志

## 步骤

```bash
# 1. 安装 Node.js 22+ 和 Pi
node --version
pi --version

# 2. 克隆并安装 Kit
git clone git@github.com:zichuanwangcloud-gif/pi-kit.git ~/git/pi-kit
cd ~/git/pi-kit
./scripts/bootstrap.sh

# 3. GitHub 登录
gh auth login

# 4. 配置 Linear key
mkdir -p ~/.config/pi
chmod 700 ~/.config/pi
read -rsp "Linear API key: " LINEAR_API_KEY; echo
umask 077
printf '%s' "$LINEAR_API_KEY" > ~/.config/pi/linear-api-key
unset LINEAR_API_KEY
chmod 600 ~/.config/pi/linear-api-key

# 5. 启动 Pi 并验证
pi
```

Pi 内：

```text
/reload
/help installed
/help linear
/help safety
```

## 无远程仓库：Git Bundle 离线迁移

旧电脑：

```bash
cd ~/git/pi-kit
./scripts/export-bundle.sh ~/pi-kit.bundle
```

将 bundle 复制到新电脑后：

```bash
git clone ~/pi-kit.bundle ~/git/pi-kit
cd ~/git/pi-kit
./scripts/bootstrap.sh
```

Bundle 只包含 Git 已提交内容，不包含 Linear Key、模型凭据、SSH 私钥或 Pi Session。

## 迁移验证

```bash
pi list
cd ~/git/pi-kit
npm run check
```

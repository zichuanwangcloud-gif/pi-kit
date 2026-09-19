# worktree 环境引导

在新建 worktree 内把项目引导到可验证状态，并把引导失败与测试失败区分开。

> 由 SKILL.md 的 Step 3 引用。

## 本文小节

- [参数冻结约定](#参数冻结约定)
- [为什么必须引导](#为什么必须引导)
- [落点前置检查](#落点前置检查)
- [引导顺序](#引导顺序)
- [硬规则](#硬规则)
- [忽略规则写在哪里](#忽略规则写在哪里)
- [失败口径](#失败口径)

## 参数冻结约定

见 SKILL.md §执行期约定：参数固化。那里是**唯一**的参数模板来源，分两阶段写；本文件不重复给模板。
本文件片段一律以 `set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env` 开头，
并只断言该阶段已固化的变量。

所有 git 命令一律 `git -C "$ROOT"` 或 `git -C "$WT"`，不用裸 `git`，不依赖 `cd`；diff/show/log 加 `--no-pager`。

## 为什么必须引导

`git worktree add` 只 checkout 受版本控制的文件。新 worktree 里没有 `node_modules`/`vendor`/虚拟环境，submodule 未初始化，被 gitignore 的 `.env` 不存在，代码生成产物为空。第一条验证命令因此失败，而失败信息看起来像业务错误——这是本 Skill 最容易把纯环境问题误报成“我的改动弄坏了测试”的地方。

## 落点前置检查

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}" "${ROOT:?}"
PARENT=$(dirname "$WT")
test -d "$PARENT" && test -w "$PARENT"
test ! -e "$WT"
OUTER=$(git -C "$PARENT" rev-parse --show-toplevel 2>/dev/null || true)
test -z "$OUTER" || { printf '环境未就绪：%s 位于仓库 %s 内\n' "$PARENT" "$OUTER"; exit 1; }
git -C "$ROOT" worktree list --porcelain
```

父目录本身在另一个 git 仓库内时停止换路径：新 worktree 会在外层仓库里表现为未跟踪文件，可能被外层 `git add -A` 一并扫入提交。

## 引导顺序

按序执行，任一步失败即停止，不跳过后面的步骤自行开跑测试。

1. submodule：仅当 `.gitmodules` 存在。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
# 探测与动作必须分开：写成 `test -f ... && update ... || echo "no submodules"` 时，
# 一次**失败的** submodule update 会走进 `||` 分支，打印「no submodules」并把失败吞掉。
if test -f "$WT/.gitmodules"; then
  git -C "$WT" submodule update --init --recursive \
    || { echo "环境未就绪：submodule update 失败"; exit 1; }
else
  echo "no submodules"
fi
```

2. 本地配置：**复制，不生成**。只从主工作区已存在的同名文件拷贝，`cp -n` 保证不覆盖。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}" "${ROOT:?}"
for f in .env .env.local .env.development .npmrc; do
  test -f "$ROOT/$f" && cp -n "$ROOT/$f" "$WT/$f" && echo "copied $f"
done
true
```

3. 依赖：**只用锁定模式**。

| 生态 | 命令 | lockfile |
|---|---|---|
| npm | `npm ci` | `package-lock.json` |
| pnpm | `pnpm install --frozen-lockfile` | `pnpm-lock.yaml` |
| yarn (berry) | `yarn install --immutable` | `yarn.lock` |
| Go | `go mod download` | `go.sum` |
| Python (uv) | `uv sync --frozen` | `uv.lock` |
| Ruby | `bundle install --deployment` | `Gemfile.lock` |
| Rust | `cargo fetch --locked` | `Cargo.lock` |

4. 代码生成：执行项目文档/脚本里明确的 codegen 命令（如 `npm run codegen`、`go generate ./...`、`./gradlew generateProto`），命令来源写成 `文件:行`。

## 硬规则

- 禁止 `npm install`、`npm update`、`pnpm up`、`yarn upgrade`、`bundle update`、`cargo update`——它们会改写 lockfile。
- 安装后断言 lockfile 未变；变了就停止，这是工具链版本不匹配，不是本任务要提交的改动。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
LOCK='<lockfile>'
test -z "$(git -C "$WT" status --porcelain -- "$LOCK")" \
  || { printf '环境未就绪：%s 被安装过程改写\n' "$LOCK"; git -C "$WT" --no-pager diff -- "$LOCK"; exit 1; }
```

- 绝不臆造 `.env` 取值；绝不把任何环境变量值写进 commit、PR body、日志或聊天。
- 缺必需变量时停止询问用户，只说明变量**名称与用途**，不索要也不回显其值。

## 忽略规则写在哪里

`.git/info/exclude` 属于共享的 git common dir，从 worktree 写它会污染主仓库。worktree 私有的排除文件位置：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
git -C "$WT" rev-parse --git-dir          # .../.git/worktrees/<name>
git -C "$WT" rev-parse --git-common-dir   # .../.git —— 只读，禁止写入
printf '%s/info/exclude\n' "$(git -C "$WT" rev-parse --git-dir)"
```

首选方案是不写任何忽略规则：临时产物统一放 `$WT/.pi-*`，收尾时删除。

## 失败口径

本文件内任何一步失败，都报告为 **“环境未就绪”**，并给出失败命令、退出码与关键输出；明确写“不是测试失败，尚未验证本改动”。修好或用户裁决前不得进入 Step 5，不得据此判断改动正确性。

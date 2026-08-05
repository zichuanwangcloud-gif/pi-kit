# 验证命令参考

配合 `SKILL.md` 的 Step 5 使用。命令必须以项目配置（package scripts、Makefile、CI 配置、`AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING*`）和已确认的实施计划为准，本文件只是各技术栈的常见形态示例，不是默认值。

先跑最小针对性验证（只覆盖本次改动），再跑合理范围的模块级验证。全仓长时任务只在项目要求或用户要求时执行。

## JavaScript / TypeScript

```bash
npm test -- <target>
npm run lint
npm run typecheck
npm run build
```

包管理器按 lockfile 判断（`pnpm`/`yarn`/`bun` 同理）。脚本名必须真实存在于 `package.json`。

## Go

```bash
go test ./path/to/package/...
go vet ./path/to/package/...
go build ./...
```

## Rust

```bash
cargo test -p <package>
cargo clippy -p <package>
cargo check -p <package>
```

## Python

```bash
pytest <target>
ruff check <target>
mypy <target>
```

虚拟环境/依赖管理（`uv`、`poetry`、`venv`）遵循项目说明，不在 worktree 外安装依赖。

## 结束检查

无论技术栈，提交前都要在 worktree 内执行：

```bash
git status --short
git diff --check
git diff --stat
git diff
```

`git diff --check` 用于捕获行尾空白和冲突标记；`git diff` 用于逐行自审，确认没有调试代码、无关改动或凭据泄漏。

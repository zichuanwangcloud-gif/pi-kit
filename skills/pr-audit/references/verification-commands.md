# 验证命令识别示例

各语言栈的测试、lint、typecheck、build 命令形式，仅用于**识别**项目已有命令，不作为默认执行清单。

> 由 SKILL.md 的 Gate 1.1、Gate 1.2 引用。

## 静态代码审阅检查项

Gate 1.1 沿变更调用链逐项过一遍。实现侧：

- 条件、边界、错误处理、空值、并发、事务、资源释放
- API / schema / 配置兼容性
- migration 前后兼容与回滚风险
- 缓存、重试、幂等和异步一致性

测试质量侧：

- 测试是否断言行为，而不只是执行代码
- 测试是否会在**旧实现**上失败，是否覆盖核心分支与回归点
- mock 是否掩盖了真实集成错误

每条发现附 `file:line`、触发条件、实际影响与建议修复方向；说不出现实影响的降为 `Info`。

## 使用前提

命令必须来自证据（Agent/贡献/CI 文档、CI workflow、Makefile/Taskfile、package scripts、
语言构建配置、受影响模块的既有测试模式），来源在报告里写成 `文件:行`。
本文件只帮你把证据里的命令认出来并收敛到改动范围；**没有证据就询问，不要从本表发明命令**。

先跑最小针对性命令（单测试文件 / 单用例），通过后再扩到包级或模块级。

## 按栈收敛的命令形式

| 栈 | 测试 | lint / format | typecheck / build |
|---|---|---|---|
| npm / yarn | `npm test -- <target>` | `npm run lint` | `npm run typecheck` / `npm run build` |
| npm workspaces | `npm test --workspace <pkg>` | `npm run lint --workspace <pkg>` | `npm run typecheck --workspace <pkg>` |
| pnpm | `pnpm --filter <pkg> test` | `pnpm --filter <pkg> lint` | `pnpm --filter <pkg> typecheck` |
| turbo | `turbo run test --filter=<pkg>...` | `turbo run lint --filter=<pkg>` | `turbo run build --filter=<pkg>` |
| Go | `go test ./<module>/...` | `golangci-lint run ./<pkg>/...` | `go vet ./...` / `go build ./...` |
| Rust | `cargo test -p <pkg>` | `cargo fmt --check` / `cargo clippy` | `cargo check -p <pkg>` |
| Python | `pytest <target>` | `ruff check <path>` | `mypy <path>` |
| Java (Gradle) | `./gradlew :<module>:test` | `./gradlew :<module>:check` | `./gradlew :<module>:compileJava` |
| Java (Maven) | `mvn -pl <module> test` | `mvn -pl <module> verify` | `mvn -pl <module> compile` |
| Make / Task | `make test` | `make lint` | `make build` |

monorepo 中改动涉及多个包时，不得用一条根级聚合命令替代逐包验证——根级命令常按缓存跳过，
或不包含该包的 lint/typecheck。也不得只跑其中一个包就宣称整个改动已验证。

## schema、migration、生成物

适用时补上项目既有的一致性校验，例如：

- migration 的 up/down 演练或 dry-run 命令
- schema / 客户端 / protobuf 代码生成后 `git diff --exit-code` 应为空
- OpenAPI / GraphQL schema 的 lint 或 breaking-change 检查

## 执行前的只读审阅

- 先阅读命令对应的脚本本体，而不是只看命令名。
- PR 修改了脚本时，比较 base 与 head 两版脚本，避免盲目执行新增的危险 shell、下载或部署动作。
- 命令涉及生产环境、外部写入、凭据上传或未知 installer 时不运行，标 `BLOCKED` 并解释。

## 时间预算与输出

单条命令预计超过约 10 分钟即视为超预算：只跑与改动相关的子集，并记录
`未跑全量：<命令>（原因/预计耗时）`。禁止静默跳过，禁止硬跑到被工具超时截断——
那会丢掉全部输出且无法判定状态。

输出很长时落盘到临时文件（例如 `/tmp/pr-<n>-<name>.log`），上下文只保留命令、
退出码、失败断言行与尾部若干行。

## 每条命令的状态记法

| 状态 | 含义 |
|---|---|
| 通过 | 已运行且退出码 0 |
| 失败 | 已运行且退出码非 0（附关键输出） |
| 超预算未跑 | 明确判定超时间预算，附替代子集命令与原因 |
| 未运行 | 工具缺失、环境未就绪或项目无该命令，附原因 |

「未运行」永远不等于「通过」。

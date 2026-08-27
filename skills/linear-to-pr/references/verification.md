# 验证策略

在 worktree 内按改动范围逐包验证，并把每条命令的真实状态如实分级上报。

> 由 SKILL.md 的 Step 5 引用。

> 取退出码的片段必须用 `set +e` … `set -e` 包住那一行：`set -e` 会在该行直接中止，永远走不到
> `EXIT=$?`，两个退出码里红色那个会被吞掉——flaky 判定与五态报告都依赖它。

## 本文小节

- [逐包矩阵（monorepo 强制）](#逐包矩阵（monorepo-强制）)
- [按范围收敛的命令形式](#按范围收敛的命令形式)
- [时间预算](#时间预算)
- [flaky 判定（唯一允许的路径）](#flaky-判定（唯一允许的路径）)
- [无测试框架时](#无测试框架时)
- [新增测试](#新增测试)
- [required status checks](#required-status-checks)
- [结束检查](#结束检查)
- [五态报告](#五态报告)
- [产出物规则（migration / 生成代码 / lockfile）](#产出物规则migration--生成代码--lockfile)

参数模板的唯一权威来源是 SKILL.md §执行期约定：参数固化。本文件片段首行一律 `set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env`，并只断言该阶段已固化的变量，git 命令一律 `git -C "$WT"`，diff/log 加 `--no-pager`。

## 逐包矩阵（monorepo 强制）

改动涉及多个包时，先输出矩阵再跑命令，一行一个**被改动的包**：

| 包路径 | 测试 | 构建 | lint/typecheck | 命令来源(文件:行) | CODEOWNERS owner |
|---|---|---|---|---|---|
| `<pkg-path>` | `<cmd>` | `<cmd>` | `<cmd>` | `<file>:<line>` | `<team-or-无>` |

规则：

- 禁止用一条根级聚合命令替代逐包验证；根级命令常按缓存跳过、或不包含该包的 lint/typecheck。
- 禁止只跑其中一个包的测试就宣称整个改动已验证——这是本 Skill 最可能的假通过。
- 命令必须来自证据（package scripts、CI workflow、Makefile/Taskfile、模块既有测试模式），来源写成 `文件:行`；无证据则询问，不发明命令。
- owner 从 `.github/CODEOWNERS` 查，用于判断是否触及他人模块。

## 按范围收敛的命令形式

| 栈 | 单包/单模块形式 |
|---|---|
| npm workspaces | `npm test --workspace <pkg>` |
| pnpm | `pnpm --filter <pkg> test` |
| turbo | `turbo run test --filter=<pkg>...` |
| Go | `go test ./<module>/...`（每个 module 有独立 `go.mod`，需在该 module 内执行） |
| Rust | `cargo test -p <pkg>` |
| Python | `pytest <path>` |
| Gradle | `./gradlew :<module>:test` |
| Maven | `mvn -pl <module> test` |

先跑最小针对性命令（单测试文件/单用例），通过后再扩到包级、模块级。

## 时间预算

单条命令预计超过约 10 分钟即视为超预算。

- 先最小、再放大；不要一上来跑全量。
- 超预算的模块级/全量命令：只跑与改动相关的子集，并记录 `未跑全量：<命令>（原因/预计耗时）`。
- 禁止静默跳过，禁止硬跑到工具超时被截断——那会丢掉全部输出且无法判定状态。

统一用超时包装并落日志，日志放 `$WT` 内且不提交：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
cd "$WT"
set +e; timeout 600 <cmd> > "$WT/.pi-verify-<name>.log" 2>&1; RC=$?; set -e; echo "exit=$RC"
tail -40 "$WT/.pi-verify-<name>.log"
```

## flaky 判定（唯一允许的路径）

禁止靠推理宣布「这个失败是既有 flaky」。**唯一允许的路径是另建一次性 detached worktree**，
在未改动的 `origin/$BASE` 上复现同一条最小失败命令。
**禁止 `git stash push` / `checkout --detach` / `stash pop` 这条路线**——`stash pop` 冲突会让本次改动
卡在 stash 里、工作树状态不可信，后续任何结论都作废。

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${ROOT:?}" "${WT:?}" "${BASE:?}"
TMPWT="${WT}-baseline-$$"
git -C "$ROOT" worktree add --detach "$TMPWT" "origin/$BASE" \
  || { echo "STOP: 基线 worktree 建立失败"; exit 1; }
set +e                                  # 必须取回非零退出码，此窗口内关闭 -e
( cd "$TMPWT" && <失败的最小命令> ); BASE_EXIT=$?
set -e
git -C "$ROOT" worktree remove --force "$TMPWT"
echo "BASE_EXIT=$BASE_EXIT"
```

`BASE_EXIT` 非 0 → 既有失败/flaky，与本改动无关（已在 base 复现），可继续。
`BASE_EXIT` 为 0 → 由本改动引入，停止，不提交/推送。

## 无测试框架时

- 绝不编造测试结果，绝不写“已通过单元测试”。
- 给出可复现的人工步骤：命令 + 预期输出 + 实际输出。
- 这一事实写进 PR body 验证段，并在**计划确认时**就告知用户，不能拖到 Step 5 才说。

## 新增测试

验收标准可自动化且项目已有测试框架时，补一条覆盖该验收的测试，放到模块既有测试目录、沿用既有断言风格；否则在报告中写明未加测试的原因。禁止修改或删除既有测试来让验证变绿。

## required status checks

分支 ruleset 里的必需检查定义了本地至少要跑的集合：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${BASE:?}"
NWO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
gh ruleset check "$BASE" || true
gh api "repos/$NWO/rules/branches/$BASE" \
  --jq '[.[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context]' || true
```

其中与改动相关的 check，本地必须有对应命令跑过；无法本地复现的写入未验证项。

## 结束检查

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${WT:?}"
git -C "$WT" status --short
git -C "$WT" --no-pager diff --check
git -C "$WT" --no-pager diff --stat
git -C "$WT" --no-pager diff
```

`diff --check` 报行尾空白/冲突标记时先修再提交。确认 `status --short` 里没有 `.pi-verify-*.log`、`node_modules` 等非任务文件。

## 五态报告

每条命令必须落到以下之一，不允许只有“通过/失败”两态：

| 状态 | 含义 |
|---|---|
| 已运行 | 已执行并取得完整输出 |
| 通过 | 已运行且退出码 0 |
| 失败 | 已运行且退出码非 0（附关键输出与是否已在 base 复现） |
| 超预算未跑 | 明确判定超时间预算，附替代子集命令与原因 |
| 未运行 | 环境未就绪/工具缺失/无该命令，附原因 |

任一相关命令为 `失败` 且未证明与本改动无关时停止，不提交、不推送、不创建 PR。

## 产出物规则（migration / 生成代码 / lockfile）

- **migration**：`git -C "$WT" --no-pager log --oneline "origin/$BASE" -- <migrations目录>` 中已存在的
  文件视为**已发布**，只能新增不能修改。
  需要变更已发布 migration 的效果时：新增一个向前兼容的 migration，并在 PR body 单列兼容窗口与回滚路径。
- **生成代码**：只能通过项目的生成命令产出，禁止手改生成物。提交前重跑生成命令并确认无额外漂移。
  生成产出与预期不符时：报告工具版本差异，由用户决定升级工具或调整生成配置，不手改产物。
- **lockfile**：只有确实增删依赖时才允许变更，且必须与 `package.json`/`go.mod`/`Cargo.toml` 的改动
  一一对应。出现与依赖变更无关的漂移（工具版本差异）时：
  `git -C "$WT" checkout -- <lockfile>` 还原，不要提交。


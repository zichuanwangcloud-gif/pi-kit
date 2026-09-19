---
name: pr-verify
description: 对一个 PR、分支或 commit range 执行「完成声明 → 证据」的六节验证流程：把需求翻译成字面断言的验收表，追踪每条能力的入口→持久化→响应链路是否接通，用「撤掉实现、测试必须变红」的反验和独立上下文的对抗审查找缺陷，在生产量级数据与同机基线对比上做性能检查，按故障矩阵做极端条件验证，算爆炸半径并做黄金请求差分回归，最后产出每格只允许原始命令输出的证据包。用于“这个 PR 做完了吗”“怎么测这个改动”“有没有 bug/性能问题/极端情况会崩/会不会影响别的业务”“合并前给我一份验证清单”等请求。只审 GitHub PR 的正确性/安全三门用 `pr-audit`；需要回写 Linear 的验收用 `linear-pr-audit`。
compatibility: Requires a readable git checkout. Optional PR metadata requires a read-authenticated gh CLI. Test, build, load-test and fault-injection tooling are discovered from repository documentation and configuration; missing tooling degrades the corresponding section to BLOCKED, never to PASS. Independent-context verifiers use the runtime's subagent facility when present, otherwise a fresh session operated by the user.
allowed-tools: read bash invoke_skill
metadata:
  category: pull-request-verification
  portability: project-agnostic
---

# PR Verify：从「完成声明」到「证据包」

AI 生成代码的时代，风险单位从「写错的一行」变成「不实的一句完成声明」。本 Skill 把一个 PR 的完成声明拆成六节可机械验证的问题，每节产出的**结果格只能填命令的原始输出**，填不出来就是 `NOT-RUN`，永远不是 `PASS`。

默认只读：不 push、不修改 PR/Linear、不部署、不触碰主工作区。全部执行都在一次性 detached worktree 与用户指定的隔离环境里进行。它不修改实现、不修改既有测试；发现缺口只报告，修复交回用户。

六节：

| 节 | 回答的问题 | 参考 |
|---|---|---|
| A 验收表 | 这个 PR 到底声称了什么，哪些是猜的 | `references/acceptance-table.md` |
| B 链路接通 | 每条能力从入口到响应是否真的接上了 | `references/chain-trace.md` |
| C 缺陷 | 测试能不能红、独立审查能不能找到反例 | `references/revert-check.md`、`references/adversary-boundary.md` |
| D 性能 | 新引入的路径在生产量级数据与负载下相对基线退化多少 | `references/perf-check.md` |
| E 极端条件 | 故障矩阵逐格：不 panic、状态一致、自愈 | `references/fault-matrix.md` |
| F 爆炸半径 | 改动碰到了谁、黄金请求差分有没有非预期变化 | `references/blast-radius.md` |

输出统一按 `references/evidence-pack.md`。

## 三条结构性原则

这三条不是建议，是本 Skill 与「让 AI 自己说做完了」的全部区别。违反任何一条，报告无效。

1. **审的和写的不是同一个上下文。** B 节的链路追踪、C 节的对抗审查/边界枚举/反推需求，必须由**独立上下文**执行：运行时提供子代理工具时用它，输入**只有**验收表、diff、项目约定摘录三样，不给实施过程；没有子代理工具时，把对应 reference 里的提示词和这三样输入交给用户在新会话运行，本会话只接收结果。禁止本会话自己扮演验证者再自己采信。
2. **结果格只认原始输出。** 每一节的每一格，只能粘贴本 Skill 在本次运行中执行的命令输出（退出码、响应体、计划、样本序列），或用户交来的输出。没有输出的格填 `NOT-RUN`，并写明缺什么。`NOT-RUN`、`BLOCKED`、`SKIPPED` 都不是 `PASS`，不得凑数。
3. **「需要猜」栏非空就停。** A 节验收表里任何一条需求要靠猜才能变成字面断言，本 Skill 停下来问用户，不自行填补。猜出来的需求配上绿色测试，测的是 AI 自己发明的功能。

## 输入

```text
/skill:pr-verify 123
/skill:pr-verify https://github.com/org/repo/pull/123
/skill:pr-verify feature/x --base develop
/skill:pr-verify 123 --only defects,perf
/skill:pr-verify 123 --skip fault --test-cmd "make test-prod" --load-cmd "k6 run load.js"
```

参数：

| 参数 | 作用 |
|---|---|
| `<PR 编号\|URL\|分支\|range>` | 验证对象。裸数字按当前仓库 PR 编号；分支名与 `A..B` 直接当 git 对象 |
| `--base <ref>` | 显式基线。缺省顺序：PR 的 baseRef → 仓库文档声明的日常 PR base → 远程 HEAD → 询问 |
| `--only <节>` / `--skip <节>` | 节名 `acceptance,chain,defects,perf,fault,blast`。被 `--only` 排除或 `--skip` 的节记 `SKIPPED`。A 节不可跳过（其余节都以验收表为输入） |
| `--test-cmd` / `--build-cmd` | 生产形态的测试/构建命令。缺省从仓库文档与 CI 配置发现；两处不一致或都没有则询问 |
| `--load-cmd` | 压测命令；缺省时 D 节动态部分 `BLOCKED` |
| `--env <标识>` | 允许故障注入与压测的隔离环境标识；缺省时 E 节与 D 节动态部分 `BLOCKED` |

解析规则：未知参数、冲突开关、多个对象标识 → 停止询问，不猜。URL 必须指向当前 checkout 的仓库。

## 状态模型

| 状态 | 含义 |
|---|---|
| `PASS` | 该格有本次运行的原始输出，且输出满足该格写明的通过标准 |
| `FAIL` | 有原始输出，且不满足通过标准 |
| `BLOCKED` | 工具、环境、权限或数据缺失，跑不出输出 |
| `NOT-RUN` | 该节启用但此格没有执行到（含用户中止） |
| `SKIPPED` | 被 `--only`/`--skip` 排除 |

总体门禁：所有**启用**节的所有格均 `PASS` → `PASS`；任一 `FAIL` → `FAIL`；否则 `BLOCKED`。A 节「需要猜」栏非空时总体至多 `BLOCKED`。

## 执行期约定：参数固化（强制）

每次 `bash` 调用都是新 shell，变量、函数、`cd` 全部不跨调用。所有参数先写进 env 文件，每个片段首行 source **字面路径** `/tmp/pi-pr-verify-<ID>.env`（不是 `. "$ENVFILE"`——新 shell 里它是空串），再用 `: "${VAR:?}"` 断言本步之前已固化的变量。**不使用 `set -e`**：反验与基线对比要靶取回**非零**退出码，`set -e` 会在那一行中止。因此闸门一律 `cmd || { echo "STOP: ..."; exit 1; }`，「必须无命中」先收进变量再判空：`HIT=$(cmd || true); [ -z "$HIT" ] || { echo "STOP: ..."; exit 1; }`。探测与闸门分开写。所有 git 命令带 `-C`。

```bash
# 阶段一（Phase 0 开头，只写一次）
ID='<PR 编号或分支 slug，只含字母数字连字符>'
ROOT=$(git rev-parse --show-toplevel) || { echo "STOP: 不在 git 仓库内"; exit 1; }
ENVFILE="/tmp/pi-pr-verify-${ID}.env"
PACK=$(umask 077; mktemp -d "/tmp/pi-pr-verify-${ID}.XXXXXX")
cat > "$ENVFILE" <<EOF
export ID='$ID' ROOT='$ROOT' ENVFILE='$ENVFILE' PACK='$PACK'
export GIT_PAGER=cat GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
EOF
printf 'ENVFILE=%s PACK=%s\n' "$ENVFILE" "$PACK"
# 阶段二（Phase 0 冻结后追加；真实取值由下方片段算出）
cat >> "$ENVFILE" <<EOF
export BASE_REF='<base 分支>' BASE_OID='<base oid>' HEAD_REF='<head 分支或对象>' HEAD_OID='<head oid>'
export TEST_CMD='<生产形态测试命令>' BUILD_CMD='<生产形态构建命令>' SECTIONS='<启用节清单，逗号分隔>'
EOF
# 阶段三（各节现场追加）
cat >> "$ENVFILE" <<EOF
export WT_BASE='<base detached worktree>' WT_HEAD='<head detached worktree>' DIFF='<diff 文件>' TABLE='<验收表文件>'
export IMPL_FILES='<实现文件清单路径>' TEST_FILES='<测试文件清单路径>' CONVENTIONS='<项目约定摘录文件>'
export LOAD_CMD='<压测命令>' TARGET_ENV='<允许故障注入的隔离环境标识>' URL_BASE='<base 服务地址>' URL_HEAD='<head 服务地址>'
export GOLDEN_DIR='<黄金请求目录>' QUERY_LOG='<查询日志文件>' RUN_LABEL='<本次运行标签>'
EOF
```

上面三段是 env 文件的完整变量清单：任何片段用到的变量都必须出现在其中，写它的片段负责在算出值的同一次调用内 `cat >>`/`printf >>` 落盘。`IMPL_FILES`、`TEST_FILES` 是**文件路径**（每行一项），不是 bash 数组——数组无法 export。`PACK` 是证据包目录，每节的原始输出各自落一个文件，报告只引用文件名与关键行。

## Phase 0：预检与冻结

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ROOT:?}" "${ENVFILE:?}" "${PACK:?}"
git -C "$ROOT" status --short --branch | head -20
git -C "$ROOT" worktree list --porcelain
gh auth status >/dev/null 2>&1 && echo "gh: yes" || echo "gh: no"
for f in AGENTS.md CLAUDE.md CONTRIBUTING.md; do [ -f "$ROOT/$f" ] && echo "doc: $f"; done
```

1. 主工作区有未提交改动不是阻塞，但要登记；本 Skill 后续**只**在 detached worktree 里操作。
2. 冻结对象：PR 输入用 `gh pr view --json baseRefName,baseRefOid,headRefName,headRefOid,state,body`；分支/range 输入用 `git -C "$ROOT" rev-parse`。`state` 非 `OPEN` 停止。冻结值追加进 env 文件（阶段二）。
3. 发现生产形态命令：读仓库文档与 CI 配置（workflow 文件、Makefile、manifest scripts），找出 CI 实际执行的测试/构建命令**含 build tag、环境变量与构建模式**。本地惯用命令与 CI 命令不同（例如少了一个 tag、少了一个 profile）时**以 CI 的为准**并在报告登记差异——本地形态与生产形态不同是「本机通过、线上不通」的主要来源。找不到唯一命令 → 询问。
4. 项目约定摘录：从上述文档抽出与本 PR 相关的约定（目录落点、禁改区域、命名、鉴权中间件名等）写进 `$CONVENTIONS`，它是独立验证者拿到的三样输入之一。

建两个 detached worktree 并冻结 diff：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ROOT:?}" "${ID:?}" "${ENVFILE:?}" "${PACK:?}" "${BASE_OID:?}" "${HEAD_OID:?}"
WT_BASE="/tmp/pi-pr-verify-${ID}-base-$$"; WT_HEAD="/tmp/pi-pr-verify-${ID}-head-$$"
git -C "$ROOT" worktree add --detach "$WT_BASE" "$BASE_OID" || { echo "STOP: base worktree 建立失败"; exit 1; }
git -C "$ROOT" worktree add --detach "$WT_HEAD" "$HEAD_OID" || { echo "STOP: head worktree 建立失败"; exit 1; }
DIFF="$PACK/diff.patch"; git -C "$ROOT" diff "${BASE_OID}...${HEAD_OID}" > "$DIFF" || { echo "STOP: diff 生成失败"; exit 1; }
[ -s "$DIFF" ] || { echo "STOP: diff 为空，base/head 冻结有误"; exit 1; }
printf "export WT_BASE='%s' WT_HEAD='%s' DIFF='%s'\n" "$WT_BASE" "$WT_HEAD" "$DIFF" >> "$ENVFILE"
git -C "$ROOT" diff --name-only "${BASE_OID}...${HEAD_OID}" | grep -Ev '(^|/)(tests?|spec|__tests__)/|[._-](test|spec)\.[a-z]+$|_test\.go$' > "$PACK/impl-files.txt"
git -C "$ROOT" diff --name-only "${BASE_OID}...${HEAD_OID}" | grep -E  '(^|/)(tests?|spec|__tests__)/|[._-](test|spec)\.[a-z]+$|_test\.go$' > "$PACK/test-files.txt"
printf "export IMPL_FILES='%s' TEST_FILES='%s'\n" "$PACK/impl-files.txt" "$PACK/test-files.txt" >> "$ENVFILE"
wc -l "$PACK/impl-files.txt" "$PACK/test-files.txt"
```

两个 worktree 登记进报告的清理清单，由用户 `git worktree remove`；本 Skill 不自行删除。测试文件判别正则是启发式，B/C 节引用前让用户过目一眼清单，归类错误会让反验白跑。

## A 节：验收表

按 `references/acceptance-table.md` 把需求来源（PR 描述、Issue、需求文档、用户口述）翻译成「操作 → 输入 → 期望字面结果」三列表，另加「必须不做什么」负向行与「需要猜」栏。规则摘要：

- 期望列禁止出现「正确」「正常」「符合预期」；必须是具体数值、字符串、状态码、DOM 值或状态。
- 每行标来源 `需求/PR 描述/推断`。标 `推断` 的行进「需要猜」栏。
- **「需要猜」栏非空 → 立即停止询问用户**（原则 3）。用户裁决后把结论写回表，再继续。
- 验收表落盘为 `$TABLE`，后续各节只读它。

## B 节：链路接通

按 `references/chain-trace.md` 分两步：

1. **静态追链（独立上下文）**：对表里每一行，从入口追到持久化再追回响应，列出经过的每个函数 `文件:行`。任何一段找不到代码 → 该行标 `未接上`。追链者只拿验收表、diff、约定摘录，不拿 PR 描述。
2. **按表逐行真跑**：把每一行转成可执行断言（HTTP 用 curl 断言响应体字面值；UI 用项目既有 e2e 框架断言 `input.value`/文本/可见性），在 head worktree 起的服务上执行，原始输出落 `$PACK/chain-<行号>.out`。

通过标准：每行既有完整链路又有真跑输出且值与表一致。任一行 `未接上` 或值不符 → B 节 `FAIL`。

## C 节：缺陷

四个子项，缺一记 `NOT-RUN`：

1. **反验**（`references/revert-check.md`，脚本 `scripts/revert-check.sh`）：在 base worktree 上放入 head 的测试文件、不放实现，跑 `TEST_CMD`，**退出码必须非零**。为零说明测试恒真或测的是 base 已有行为，进入该 reference 的三分支定论。随后随机顺序跑 head 测试三遍看稳定性，并检查测试是否 mock 了 diff 面内的模块。
2. **对抗审查（独立上下文）**（`references/adversary-boundary.md`）：提示词是「假设一定有 bug，给出 5 个最可能出错的位置和能触发它的具体输入」。本 Skill 把这些输入真的跑一遍，输出落盘。
3. **边界矩阵（独立上下文）**：对每个新增输入字段枚举空/null/0/负数/最大值+1/超长/Unicode/空白/并发重复/时区边界，标出「没处理」的格；本 Skill 对「没处理」逐格真跑。
4. **鉴权、范围、反推需求**（同一 reference）：新路由 × 中间件 × 权限点 × 租户过滤四列表；diff 按「需求必需 / 顺手改的」二分；从代码反推「这段代码实现的需求是什么」与验收表对照，差异即漂移。

C 节 `PASS` 的条件：反验红、随机顺序三遍稳定、mock 面无命中、对抗输入与边界「没处理」格真跑无 `FAIL`、鉴权四列齐、无未说明的顺手改动、反推需求与表一致。

## D 节：性能

按 `references/perf-check.md`，先静态后动态：

1. **静态可疑点（独立上下文）**：列出 diff 新增/修改的所有数据库查询、循环内 IO、外部调用、加锁点、无界集合；循环内的查询直接记 `FAIL`（N+1），不用压。
2. **查询计数与执行计划**：在生产量级数据上（项目造数工具；没有 → `BLOCKED` 并写明缺什么）对每条查询取执行计划，看大表顺扫与行数估算偏差；记录一次请求发出的查询条数。
3. **基线对比压测**：`--load-cmd` 与 `--env` 齐备时，同机、同数据分别压 base 与 head，各 ≥10 轮、丢前 3 轮预热，比较 P95 相对变化 `Δ`：样本标准差 > 均值 30% → `BLOCKED`（噪声）；`Δ ≤ 5%` `PASS`；`5% < Δ ≤ 20%` `PASS` + Medium 发现；`Δ > 20%` `FAIL`。绝对阈值不在验证机上判定。压完观察资源是否回落基线（泄漏）。

## E 节：极端条件

按 `references/fault-matrix.md` 生成故障矩阵（DB 断连/慢、上游 5xx/超时/半截响应/非法载荷、缓存不可用、超大请求、客户端中途断开、同资源并发写、空表/首次运行/迁移跑在存量数据上、时钟边界、磁盘满）。**只对 `--env` 指定的隔离环境注入**，未指定 → 整节 `BLOCKED`；本 Skill 永不对共享或生产环境注入故障。

每格三条通过标准：不 panic/crash loop、状态一致（尤其涉及资金与计数的表）、故障移除后自愈。矩阵里与本 PR 无关的行标 `N/A` 并写原因，不得整节跳过。附一段 soak：正常负载持续 ≥30 分钟，资源曲线应平。

## F 节：爆炸半径与回归

按 `references/blast-radius.md`：

1. **引用方表**：每个被修改的函数/类型/表/共享组件/配置项 → 引用方 → 所属业务。可 `invoke_skill change-impact` 取得影响图，但结论仍由本节按表登记。
2. **黄金请求差分**（脚本 `scripts/golden-diff.sh`）：同一组请求分别打 base 与 head 服务，去噪后 diff 响应体；每条差异归为「本 PR 预期改动」或「回归」，前者须能在验收表里指到对应行。UI 改动加视觉回归。
3. **schema 与回滚**：有迁移的 PR 在类生产库副本上跑一遍，记录耗时、锁级别、可回滚性，以及**旧代码在新 schema 上能否运行**（蓝绿并存窗口）。可 `invoke_skill schema-migration-audit`。
4. **存量数据与默认值**：新功能对已有数据的行为、新配置项缺省时的行为、feature flag 默认态与 kill switch。
5. **依赖变化**：lockfile diff 里的新增包，逐个回答「仓库里是否已有同功能依赖」；不存在于注册表的包名直接 `FAIL`。

## Phase 7：证据包与收尾

按 `references/evidence-pack.md` 汇总。写报告前逐条硬检查：

- 每个 `PASS` 格能指到 `$PACK/` 下的一个输出文件与关键行。
- 独立上下文执行的四项（追链、对抗、边界、反推需求）报告里写明了执行方式（子代理 / 用户新会话）；本会话自己做的一律降为 `NOT-RUN`。
- 「需要猜」栏为空，或每条都有用户裁决记录。
- 清理清单列出 `$WT_BASE`、`$WT_HEAD` 与所有 `/tmp/pi-pr-verify-<ID>*` 产物，本 Skill 不删。
- 报告结尾的安全声明属实：未 push、未修改 PR/Issue、未部署、未触碰主工作区、未修改实现与既有测试。

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ROOT:?}" "${PACK:?}" "${WT_BASE:?}" "${WT_HEAD:?}"
git -C "$ROOT" status --porcelain | head -5
git -C "$WT_HEAD" status --porcelain | head -5
git -C "$WT_BASE" status --porcelain | head -5
ls "$PACK"
```

三个 `status` 里 head/base worktree 应只有本 Skill 登记过的临时文件（反验放入的测试文件、黄金请求输出），主工作区应与 Phase 0 一致。

## 与其他 Skill 的分工

- `pr-audit`：正确性/需求可追溯/安全三门的只读审计，不做反验与压测。本 Skill 的 C 节可引用其 Security 结论，但不替代它。
- `linear-pr-audit`：按 Linear 验收标准做可执行验收，且可推修复、回写 Linear。本 Skill 不依赖 Linear、不写任何外部系统。
- `change-impact` / `schema-migration-audit` / `api-contract-audit` / `test-gap`：F 节与 C 节可调用取材，但本 Skill 的每格结论仍以本次运行的原始输出为准，不转抄其 PASS。

## 立即停止并询问

- A 节「需要猜」栏非空。
- 生产形态测试命令无法唯一确定，或本地命令与 CI 命令不一致且文档未说明。
- 反验基线为绿且三分支无法定论。
- `--env` 指向的环境无法证明是隔离的（例如与共享数据库同一连接串）。
- 任何步骤要求修改实现、修改既有测试、push、评论 PR 或部署。

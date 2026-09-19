# 反重言强制程序

新写的测试变绿不是证据；**绿色 + 已证明的红色基线**才是证据。

> 由 SKILL.md 的 Phase 3.2、Phase 3.5、Phase 4 引用。

## 本文小节

- [本文件的执行前提](#本文件的执行前提)
- [基线 A：本 PR 应引入该能力](#基线-A：本-PR-应引入该能力)
- [基线 B：修复循环内](#基线-B：修复循环内)
- [基线通过时的处置](#基线通过时的处置)
- [无法构造失败基线](#无法构造失败基线)
- [Mock 禁区](#Mock-禁区)
- [证据列格式](#证据列格式)
- [回归保护回查](#回归保护回查)

三类测试在第一次运行就会变绿，与实现是否正确无关：

- **重言测试**：断言的是常量、自己刚算的表达式，或恒真条件。
- **断言自己 mock 的测试**：mock 返回 X，断言得到 X，被测代码根本没跑。
- **断言自己刚 seed 的数据**：写入 X 再读出 X，绕过了 AC 要求的业务路径。

因此每条 AC 的证据列必须携带**两个退出码**。只有一个 → `BLOCKED`。

## 本文件的执行前提

本文件依赖 `( cd "$X" && <cmd> ); EXIT=$?` 取回退出码，因此**不使用 `set -e`**——
`set -e` 会在 `<cmd>` 非零时立刻中止，永远走不到 `EXIT=$?`（已实测：整段在那一行退出，`EXIT` 从不
被赋值），两个退出码里的红色那个会被吞掉。每个片段首行 source **字面路径**并断言用到的每个变量
（`. "$ENVFILE"` 在新 shell 里等于 `. ""`，什么都不 source），闸门一律
`cmd || { echo "STOP: ..."; exit 1; }`：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${BASE_OID:?}" "${HEAD_OID:?}"
```

## 基线 A：本 PR 应引入该能力

在一次性 detached worktree 里对 `baseRefOid` 跑**同一条**测试命令，退出码必须非零。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}" "${BASE_OID:?}"
BASE_WT="/tmp/pi-baseline-pr-${PR}-$$"
git -C "$ROOT" worktree add --detach "$BASE_WT" "$BASE_OID" || { echo "STOP: 基线 worktree 建立失败"; exit 1; }
( cd "$BASE_WT" && <与 head 完全相同的测试命令> ); BASE_EXIT=$?
echo "基线 exit=$BASE_EXIT"
[ "$BASE_EXIT" -ne 0 ] || { echo "STOP: 基线通过，按下节三分支定论后才能继续"; exit 1; }
```

`$BASE_WT` 登记进报告的清理清单，由用户执行 `git worktree remove`；本 Skill 不自行删除。

测试文件本身放在仓库外（见 write-safety.md），两侧共用同一份文件，只换被测代码。
命令有任何差异（不同 flag、不同 rootDir、不同环境变量）→ 口径漂移，结论无效。

## 基线 B：修复循环内

本轮改了实现之后，必须确认「拿掉本轮修复，测试重新变红」。唯一允许的做法是**一次性 detached worktree**
指向本轮起始 oid：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ROOT:?}" "${PR:?}" "${ROUND_OID:?}" "${ROUND:?}"
B_WT="/tmp/pi-baseline-b-pr-${PR}-r${ROUND}-$$"
git -C "$ROOT" worktree add --detach "$B_WT" "$ROUND_OID" || { echo "STOP: 基线 B worktree 建立失败"; exit 1; }
( cd "$B_WT" && <与本轮完全相同的测试命令> ); B_EXIT=$?
echo "基线 B exit=$B_EXIT（本轮起始 oid=$ROUND_OID）"
[ "$B_EXIT" -ne 0 ] || { echo "STOP: 移除本轮修复后测试仍通过，测试未验证该修复"; exit 1; }
```

`$B_WT` 与 `$BASE_WT` 一样进清理清单，本 Skill 不删。

**禁止 `git stash push` / `checkout` / `stash pop` 这条路线。** `stash pop` 冲突时修复代码卡在 stash 里、
工作树处于不可信状态，后续任何结论都作废，而 detached worktree 从头到尾不碰 `$WT`。
同理禁止在 `$WT` 内 `git checkout <oid> -- <file>` 临时回退实现文件。

## 基线通过时的处置

基线**通过**有三种可能，必须三选一定论并写进报告，不许含糊放过：

| 可能 | 判据 | 处置 |
|---|---|---|
| (a) 测试无效 | 重言、断言自己的 mock、断言自己 seed 的数据 | 重写测试，本条 AC 维持未验证，不得记 `PASS` |
| (b) AC 在 base 上已成立，本 PR 越界声明 | 测试确实走了业务路径，base 代码本就满足，且本 PR 的 diff 与该 AC 无交集 | 记 `PASS(pre-existing)`，注明「本 PR 未涉及该 AC」，回查 Requirements |
| (c) AC 覆盖面宽于本 PR 需求 | 该 AC 由 base 既有能力与本 PR 改动**共同**满足：base 侧已能走通该断言，而本 PR 的 diff 确实落在该 AC 的实现路径上 | Requirements 不受影响；该 AC 可记 `PASS`，但必须在**未验证项**注明「基线未变红，原因是 AC 覆盖面宽于本 PR 需求」，并给出本 PR 改动与该 AC 的交集 `file:line` |

判 (b) 后必须回查 Requirements 门：该需求要么被错误挂到本 PR（越界声明），
要么本 PR 的真实改动对应着另一条未登记的需求。回查结果写进报告。

**(a) 不得进入 4/4**：测试缺陷，本条 AC 维持未验证，Acceptance 至多 `BLOCKED`。
**(b) 可以进入 4/4，但必须先回写门 2**：记 `PASS(pre-existing)` 计入分子，同时按仲裁表把该 `R_i`
判为「越界声明」或「漏项」并**重判 Requirements**；Requirements 未重判完成前不得计算总体门禁。
评级上限 A（已登记在 SKILL.md 上限清单）。
**(c) 可以进入 4/4**：Requirements 不受影响，未验证项注明基线未变红的原因。
(b) 与 (c) 的分界是机器判据而不是感觉：`git -C "$WT" diff --name-only "${BASE_OID}...${HEAD_OID}"`
与该 AC 的实现落点文件**是否有交集**——无交集是 (b)，有交集是 (c)。定不出交集就按 (a) 处理。

## 无法构造失败基线

纯配置断言、纯常量校验等**天然没有 base 红色基线**的情况，改用**哨兵反证**：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${TARGET:?}"      # TARGET：被断言的那个文件，现场赋值并追加进 env 文件
BAK="/tmp/pi-sentinel-backup-pr-${PR}-$$"
cp "$TARGET" "$BAK" || { echo "STOP: 备份失败"; exit 1; }
<故意把被断言的值改错> || { echo "STOP: 无法制造反例"; exit 1; }
( cd "$WT" && <测试命令> ); SENTINEL_EXIT=$?
cp "$BAK" "$TARGET" || { echo "STOP: 恢复失败，立即停止"; exit 1; }
[ "$SENTINEL_EXIT" -ne 0 ] || { echo "STOP: 改错值后测试仍通过，断言无效"; exit 1; }
```

恢复后必须 `git -C "$WT" status --porcelain` 确认干净，再继续。

## Mock 禁区

**禁止 mock 任何落在 `base...head` diff 面内的模块。** 那正是本 PR 要证明的代码，
mock 掉它等于断言 mock 自己。两个退出码**不能**替代本条：mock 存在而实现缺失时，
base 侧常因 import 失败或断言不成立而变红，红/绿于是对得上，而 PASS 依然是假的。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${PR:?}" "${TMP_TEST_DIR:?}" "${BASE_OID:?}" "${HEAD_OID:?}"
git -C "$WT" diff --name-only "${BASE_OID}...${HEAD_OID}" | sort > "/tmp/pi-diff-surface-pr-${PR}.txt"
grep -rEn "(jest\.mock|vi\.mock|sinon\.stub|patch\(|monkeypatch|gomock|unittest\.mock|mock\.patch)" \
  "$TMP_TEST_DIR" > "/tmp/pi-mock-targets-pr-${PR}.txt"
```

逐条比对 `pi-mock-targets-pr-<N>.txt` 里被 mock 的模块路径与 `pi-diff-surface-pr-<N>.txt`：
命中 → 重写测试，不得以「集成成本高」为由保留。
允许 mock 的只有 diff 面**之外**的边界：第三方 SDK、真实时钟、网络出口、支付/邮件通道。

## 证据列格式

```text
AC3 | 自动化测试 | `<命令>` 基线 exit=1 / 修复后 exit=0 | PASS
AC4 | 自动化测试 | `<命令>` 修复后 exit=0（基线缺失） | BLOCKED
```

两个退出码必须来自**同一条命令**在两个代码状态下的运行。

## 回归保护回查

临时验收测试不提交，因此合并后该 AC 的回归保护为**零**。它**不得**充当 Requirements 门的测试证据。

Acceptance 判 `PASS` 之后，逐条回查该 AC 在 PR 中是否有**已提交**的回归测试：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${WT:?}" "${BASE_OID:?}" "${HEAD_OID:?}"
git -C "$WT" diff --name-only "${BASE_OID}...${HEAD_OID}" \
  | grep -Ei '(^|/)(tests?|spec|__tests__)/|[._-](test|spec)\.[a-z]+$|_test\.go$'
```

按下表处置，**不得笼统降级**（本表是回查处置的唯一权威表，SKILL.md 只留指针）：

| 回查结果 | Requirements 该行 | 门 2 结论 |
|---|---|---|
| 有已提交且断言同一可观察行为的测试（须给出 `测试文件:行`） | 测试证据「成立」 | 不受影响 |
| 无，且该 AC 由本 Skill 本次修复引入 | 「缺失（审计者修复，回归保护为零）」 | Requirements 仍可 `PASS`，但**评级上限降为 A**，且「未验证项」逐条列出缺回归保护的 AC 与建议落地路径 |
| 无，且该 AC 在本 PR 提交前即已实现 | 「缺失」 | 记「部分」→ `FAIL` |

理由：由审计者修复的 AC 天生不可能有已提交测试（本 Skill 无权提交测试文件），把它判成 `FAIL` 会让
修复循环永远无法闭环——用**评级封顶 + 显式披露**替代门禁否决。回查必须给出行级对应关系，
只给文件名不成立；无法给出行级对应时按「无已提交回归测试」处理。

报告必须给出临时测试文件的**完整内容**，并附一句「建议将其落地进本 PR 或后续 PR」。
本 Skill 不提交这些文件，也不代替用户决定落点。

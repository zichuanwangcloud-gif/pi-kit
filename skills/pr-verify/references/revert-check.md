# C 节 · 反验——测试必须先证明自己能红

新写的测试变绿不是证据。AI 写的测试最大的问题不是覆盖率低，而是**恒真**：断言常量、断言自己的 mock、断言自己刚 seed 的数据、三个断言在任何实现下都成立。区分「测试有效」与「测试恒真」只有一个办法：拿掉实现，测试必须红。

> 由 SKILL.md 的 C 节第 1 项引用。脚本 `scripts/revert-check.sh` 是本节的机械形态。

## 本文小节

- [做法：base 树 + head 测试](#做法base-树--head-测试)
- [红的原因必须是断言](#红的原因必须是断言)
- [基线为绿时的三分支定论](#基线为绿时的三分支定论)
- [随机顺序三遍](#随机顺序三遍)
- [Mock 面检查](#mock-面检查)
- [无测试文件的 PR](#无测试文件的-pr)
- [禁止的做法](#禁止的做法)

## 做法：base 树 + head 测试

不是「在 head 上撤掉实现」，而是「在 base 上放入 head 的测试」——两个 detached worktree 已在 Phase 0 建好，实现文件一行不动：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${ENVFILE:?}"
bash "<本 Skill 目录>/scripts/revert-check.sh" "$ENVFILE"; echo "revert-check exit=$?"
```

`<本 Skill 目录>` 就是加载这份 SKILL.md 的目录（Pi 用 `/help installed` 可见路径；Claude Code 插件形态在插件目录的 `skills/pr-verify/`）。退出码：0 = PASS，1 = 需定论，2 = BLOCKED/无测试。脚本做的事：

1. 读 `$TEST_FILES`（Phase 0 生成），对每个 head 侧存在的测试文件 `git show HEAD_OID:path` 写进 `$WT_BASE` 同路径；
2. 在 `$WT_BASE` 跑 `TEST_CMD`，取退出码 `BASE_EXIT`；
3. 在 `$WT_HEAD` 跑**同一条** `TEST_CMD`，取 `HEAD_EXIT`；
4. 两个退出码与两份输出落 `$PACK/revert-check.out`；
5. 判定：`BASE_EXIT != 0 && HEAD_EXIT == 0` 才是 `PASS`。

`TEST_CMD` 必须是 Phase 0 确认的**生产形态**命令（带 CI 用的 tag/profile/环境变量）。裸命令可能根本没编译进被测代码，两边都绿。

证据格式：

```text
反验 | `<TEST_CMD>` | base+head 测试 exit=1 / head exit=0 | PASS
反验 | `<TEST_CMD>` | base+head 测试 exit=0 / head exit=0 | 见三分支定论
```

## 红的原因必须是断言

`BASE_EXIT != 0` 只是必要条件。打开 `$PACK/revert-check.out` 看 base 侧**为什么红**，三种情形分开记：

| base 侧输出 | 含义 | 记法 |
|---|---|---|
| 复制进来的测试有 `not ok` / `FAIL` / assertion 行，且失败点在该测试内 | 测试确实钉住了新行为 | `PASS` |
| 找不到 head **新增的实现模块**（`Cannot find module` / `undefined: X` / `cannot find package`），没有跑到断言 | 只证明「base 没有这个文件」，没证明断言会失败 | `PASS(weak-import)`，B 节链路必须覆盖同一断言的字面值 |
| 运行器/配置错误：命令用法错、依赖没装、编译不过、`TEST_CMD` 在 head 侧也红 | 不是测试红，是口径错 | `BLOCKED`，回 Phase 0 重新确认 CI 真实命令后重跑 |

典型误判：`node --test <目录>` 在 Node 22 上以 `MODULE_NOT_FOUND` 退出 1，两侧同红——脚本会报 `FAIL: head 自身测试不通过`，真正的问题是命令形态，不是 PR。`HEAD_EXIT != 0` 时先怀疑 `TEST_CMD`，再怀疑 PR。

## 基线为绿时的三分支定论

base 上跑 head 的测试居然通过，必须三选一写进报告，不许含糊放过：

| 分支 | 判据 | 处置 |
|---|---|---|
| (a) 测试恒真 | 断言常量、断言 mock 返回值、断言自己 seed 的数据、断言恒成立条件 | C 节 `FAIL`；报告逐个指出恒真断言的 `文件:行` |
| (b) 测的是 base 已有行为 | 测试确实走业务路径，但 diff 的实现文件与该测试断言的行为无交集 | 该测试不计入反验；回查 A 节——对应行要么越界声明，要么本 PR 真实改动没进表 |
| (c) 测试只覆盖了 PR 的一部分 | 测试走业务路径，diff 有交集，但断言的是 base 也满足的宽泛性质 | 记 `PASS(weak)`，报告写明「哪些 diff 行为没有能红的测试」，转 C 节第 2/3 项重点覆盖 |

(b) 与 (c) 的分界是机器判据：`git diff --name-only BASE...HEAD` 的实现文件与该测试 import/引用的模块**是否有交集**。定不出交集按 (a) 处理。

补充一个常见假象：head 测试在 base 上因为 **import 失败/编译失败**而红。这是「实现不存在」导致的红，不能证明断言有效——如果测试 mock 了被测模块，实现补上后同样绿。所以反验红了之后仍要做 Mock 面检查。

## 随机顺序三遍

AI 写的测试倾向共享包级变量与全局 fixture，顺序敏感、偶发 flaky。在 head 树随机顺序跑三遍：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${WT_HEAD:?}" "${TEST_CMD:?}" "${PACK:?}"
for i in 1 2 3; do
  ( cd "$WT_HEAD" && eval "$TEST_CMD <随机顺序参数>" ) > "$PACK/shuffle-$i.out" 2>&1; EXIT=$?
  echo "shuffle run $i exit=$EXIT"
done
```

随机顺序参数按框架：Go `-shuffle=on`、pytest `-p randomly`（已安装时）、Jest/Vitest `--randomize`/`--sequence.shuffle`、JUnit `junit.jupiter.testmethod.order.default`。框架不支持 → 记 `BLOCKED(no-shuffle)`，不伪报稳定。三遍任一非零 → `FAIL(flaky)`，附该遍输出里第一处失败。

## Mock 面检查

**禁止 mock 任何落在 diff 实现面内的模块**——那正是本 PR 要证明的代码，mock 掉它等于断言 mock 自己。

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${WT_HEAD:?}" "${TEST_FILES:?}" "${IMPL_FILES:?}" "${PACK:?}"
: > "$PACK/mock-hits.txt"
while IFS= read -r t; do
  [ -f "$WT_HEAD/$t" ] || continue
  grep -nE '(jest\.mock|vi\.mock|sinon\.(stub|mock)|monkeypatch|mock\.patch|patch\(|gomock|mockery|Mockito|createMock|NewMock)' "$WT_HEAD/$t" \
    | sed "s|^|$t:|" >> "$PACK/mock-hits.txt" || true
done < "$TEST_FILES"
wc -l < "$PACK/mock-hits.txt"
```

对 `mock-hits.txt` 每一行，人工比对被 mock 的模块路径是否出现在 `$IMPL_FILES`（或其导出符号）中。命中 → 该测试的反验结论作废，记 `FAIL(mock-in-diff)`。允许 mock 的只有 diff 面之外的边界：第三方 SDK、真实时钟、网络出口、支付/邮件通道。

## 无测试文件的 PR

`$TEST_FILES` 为空时脚本以 `exit 2` 退出并打印 `NO-TESTS`。处置：

- 该 PR 声称的能力（A 节正向行）若有任何一行是行为改动 → C 节第 1 项记 `FAIL(no-tests)`，报告建议按 B 节真跑脚本落地为回归测试；
- 纯文档/配置/重命名 PR → 记 `N/A`，写明理由。

不得因为「没有测试所以没法反验」就把这一格留空或写 `N/A`。

## 禁止的做法

- **禁止 `git stash` / `git checkout <oid> -- <file>` 在同一棵树上来回切换实现。** stash pop 冲突时修复代码卡在 stash 里，工作树进入不可信状态。两棵 detached worktree 从头到尾不碰主工作区。
- 禁止改 `TEST_CMD` 让基线变红（加 `-run` 收窄、去掉 tag）。两侧命令必须逐字相同，差异即口径漂移。
- 禁止修改测试文件让它在 base 上红。测试是 PR 的一部分，改了就不是在验这个 PR。
- 禁止用「CI 是绿的」替代反验。CI 只证明 head 上绿，不证明 base 上红。

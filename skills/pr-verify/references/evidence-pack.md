# 证据包：每格只认原始输出

证据包是本 Skill 的唯一产物。它的价值不在于结论，在于**每个结论都能指回一份命令输出**。合并者看的是输出，不是本 Skill 的判断。

> 由 SKILL.md 的 Phase 7 引用。

## 本文小节

- [文件布局](#文件布局)
- [报告模板](#报告模板)
- [结果格的填写规则](#结果格的填写规则)
- [完成前硬检查](#完成前硬检查)
- [清理清单](#清理清单)

## 文件布局

```text
$PACK/
  acceptance-table.md      A 节验收表（含已裁决的「需要猜」记录）
  diff.patch               冻结的 base...head diff
  impl-files.txt / test-files.txt
  conventions.md           项目约定摘录（独立验证者的输入之一）
  chain-<行>.out           B 节每行真跑输出
  revert-check.out         C 节反验两个退出码与输出
  shuffle-<n>.out          随机顺序三遍
  mock-hits.txt
  adversary-<n>.out / boundary-<字段>-<边界>.out / authz-<路由>.out / scope-split.md / reverse-spec.md
  verifier-<项>.prompt.md  交给独立上下文的完整输入（可复核独立性）
  query-count.out / explain-<n>.out / load-<side>-<n>.out
  fault-env.out / fault-F<n>.out / soak.out
  blast-radius.txt / golden/ / schema-<步>.out / deps-added.txt
  REPORT.md                下方模板
```

## 报告模板

```markdown
# PR Verify 报告：<对象> @ <HEAD_OID 前 8 位>
## 结论
- 总体：PASS / FAIL / BLOCKED
- 启用节：acceptance, chain, defects, perf, fault, blast（SKIPPED 的列出）
- Base/head：<BASE_REF>@<BASE_OID> … <HEAD_REF>@<HEAD_OID>
- 生产形态命令：TEST_CMD=`...`（来源：<CI 文件:行>）BUILD_CMD=`...`
- 独立上下文执行方式：追链=<子代理|用户新会话> 对抗=… 边界=… 反推=…

## A 验收表
<行数>行，其中负向 <n> 行；「需要猜」<n> 条，裁决记录见 acceptance-table.md

## B 链路接通
| 行 | 追链首尾 | 期望 | 实际 | 输出文件 | 状态 |
|---|---|---|---|---|---|

## C 缺陷
| 子项 | 命令/输入 | 关键输出 | 输出文件 | 状态 |
|---|---|---|---|---|
| 反验 | `TEST_CMD` | base+head测试 exit=1 / head exit=0 | revert-check.out | PASS |
| 随机顺序 | … | exit=0,0,0 | shuffle-*.out | PASS |
| Mock 面 | … | 0 hits in diff | mock-hits.txt | PASS |
| 对抗 #1..5 | <输入> | <预期现象 / 实际> | adversary-*.out | … |
| 边界 | <字段×边界> | … | boundary-*.out | … |
| 鉴权 | <路由> | 低权限 http=403 | authz-*.out | … |
| 范围二分 | — | 顺手改的 <n> 处 | scope-split.md | … |
| 反推需求 | — | 第三类差异 <n> | reverse-spec.md | … |

## D 性能
| 子项 | 关键输出 | 输出文件 | 状态 |
|---|---|---|---|
| 静态可疑点 | N+1: <n>, 无超时外调: <n> | — | … |
| 查询计数 | base=<n> head=<n> | query-count.out | … |
| 执行计划 | <查询>: Seq Scan on <表> rows est/act | explain-*.out | … |
| 基线对比 | base P95 样本 […] head P95 样本 […] Δ=<x>% σ/μ=<y>% | load-*.out | … |
| 资源回落 | mem/fd/conn 压前/压后/5min 后 | — | … |

## E 极端条件
| # | 故障 | 制造 | 现象（原始日志行） | 对账前/后 | 恢复耗时 | 状态 |
|---|---|---|---|---|---|---|

## F 爆炸半径
| 子项 | 关键输出 | 输出文件 | 状态 |
|---|---|---|---|

## 未决问题（需用户裁决）
- 范围二分「顺手改的」：…
- 「保守默认」行：…
- 验证者判断与真跑不符处：…

## 越界声明与漂移
- B 节 `diff 无关` 行：…
- 反推需求差异：…

## 清理清单
- git worktree remove <WT_BASE>
- git worktree remove <WT_HEAD>
- rm -rf /tmp/pi-pr-verify-<ID>*

## 安全声明
- 未 push、未修改 PR/Issue、未部署、未触碰主工作区；未修改实现与既有测试；故障注入仅针对 <TARGET_ENV>。
```

## 结果格的填写规则

1. `关键输出` 列只能是命令输出的**原文片段**（退出码、响应字段、计划行、样本序列）。「一致」「通过」「正常」不是输出。
2. `输出文件` 列必须指向 `$PACK/` 下真实存在的文件；报告写完后 `ls` 一遍核对。
3. 独立上下文执行的四项，`verifier-<项>.prompt.md` 必须存在，否则该项降 `NOT-RUN`——它是「验证者只拿了三样输入」的可复核证据。
4. `BLOCKED` 格必须写缺什么（工具名、环境、数据量级），让下一个人能补。
5. 同一格的期望值与实际值**并排**写，不只写结论。
6. 报告不引用 CI 结果作为任何格的证据；CI 是另一个系统的声明。

## 完成前硬检查

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${PACK:?}"
[ -s "$PACK/REPORT.md" ] || { echo "STOP: REPORT.md 未生成"; exit 1; }
MISSING=$(grep -oE '[a-zA-Z0-9_./-]+\.(out|txt|md|patch)' "$PACK/REPORT.md" | sort -u | while IFS= read -r f; do [ -e "$PACK/$f" ] || [ -e "$PACK/golden/$f" ] || echo "$f"; done)
[ -z "$MISSING" ] || { echo "STOP: 报告引用了不存在的输出文件:"; echo "$MISSING"; exit 1; }
HIT=$(grep -nE '^\|[^|]*\|[^|]*\|[^|]*(一致|正常|通过|符合预期)[^|]*\|' "$PACK/REPORT.md" || true)
[ -z "$HIT" ] || { echo "STOP: 关键输出列出现结论词而非原始输出:"; echo "$HIT"; exit 1; }
grep -c 'NOT-RUN' "$PACK/REPORT.md" || true
echo "report ok: $PACK/REPORT.md"
```

三个闸门依次是：报告存在、引用的输出文件都存在、关键输出列没有用结论词冒充输出。`NOT-RUN` 计数只打印不拦——它们合法，但总体门禁因此不能是 `PASS`。

## 清理清单

本 Skill 不删除任何东西。报告末尾列出两个 detached worktree 与所有 `/tmp/pi-pr-verify-<ID>*` 文件，由用户执行。原因：证据包本身就在里面，删了就没法复核。

# D 节：性能——先静态定位，再同机对比

盲压全站是浪费时间。性能验证只压 diff 引入的路径，且只报相对基线的变化——绝对阈值（「P95 < 200ms」）在验证机上永远判定不了，CPU、缓存、数据规模、后台负载全不同。

> 由 SKILL.md 的 D 节引用。输入：`$DIFF`、`$WT_BASE`、`$WT_HEAD`、`$LOAD_CMD`、`$TARGET_ENV`。

## 本文小节

- [静态可疑点（独立上下文）](#静态可疑点独立上下文)
- [查询计数](#查询计数)
- [执行计划](#执行计划)
- [数据量级](#数据量级)
- [基线对比压测](#基线对比压测)
- [资源回落](#资源回落)
- [判定](#判定)

## 静态可疑点（独立上下文）

提示词：

```text
列出这个 diff 新增或修改的：
1. 所有数据库查询（ORM 调用也算），给出 `文件:行`、命中的表、是否在循环体内、是否带分页/上限；
2. 所有循环体内的 IO（网络、文件、缓存）；
3. 所有对外部服务的调用及其超时设置（没有超时写「无」）；
4. 所有加锁/事务边界，及事务内是否有网络调用；
5. 所有可能无界增长的内存集合（切片/map/列表在循环里 append 且无上限）。
每项只写事实，不评价。
```

判定规则（不需要压测）：

| 发现 | 判定 |
|---|---|
| 循环体内的查询 | `FAIL`（N+1） |
| 查询无分页且表可增长 | `FAIL` |
| 外部调用无超时 | `FAIL` |
| 事务内有网络调用 | Medium 发现，进报告 |
| 无界集合 | Medium 发现，转 E 节超大输入行 |

## 查询计数

一次请求发出多少条 SQL，是最便宜、最不受机器噪声影响的性能指标。开项目的查询日志（ORM debug、数据库 `log_statement`、代理层日志），分别在 base 与 head 服务上打**同一个**请求各一次，数行：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${QUERY_LOG:?}" "${URL_BASE:?}" "${URL_HEAD:?}" "${PACK:?}"
: > "$QUERY_LOG"; curl -sS -o /dev/null "$URL_BASE<路径>"; sleep 1
BASE_Q=$(grep -cE '^(SELECT|INSERT|UPDATE|DELETE|WITH)|statement:' "$QUERY_LOG" || true)
: > "$QUERY_LOG"; curl -sS -o /dev/null "$URL_HEAD<路径>"; sleep 1
HEAD_Q=$(grep -cE '^(SELECT|INSERT|UPDATE|DELETE|WITH)|statement:' "$QUERY_LOG" || true)
printf 'queries base=%s head=%s\n' "$BASE_Q" "$HEAD_Q" | tee "$PACK/query-count.out"
```

`QUERY_LOG` 的路径与匹配模式按项目日志格式调整并写进报告。head 比 base 多出的条数若随结果集大小线性增长 → N+1，`FAIL`。

## 执行计划

对静态清单里的每条查询，在**生产量级数据**上取执行计划。PostgreSQL 为 `EXPLAIN (ANALYZE, BUFFERS)`，MySQL 为 `EXPLAIN ANALYZE`，其他引擎用其等价物。只看两件事：

1. 大表（行数 ≥ 10 万）上的全表扫描（`Seq Scan` / `type: ALL`）；
2. 行数估算与实际相差一个数量级以上（统计信息失效或条件不可索引）。

计划原文落 `$PACK/explain-<n>.out`。命中任一 → Medium 发现；命中且该查询在请求热路径上 → `FAIL`。

注意 `= ANY(array)` / `IN (...)` 大列表、函数包裹的列、隐式类型转换都会让复合索引失效，计划里表现为索引只用了前缀或退回顺扫。

## 数据量级

本地库几百行什么都测不出来。执行计划与压测都要求数据量接近生产：

- 项目有造数工具 → 用它灌到生产量级（百万到千万行，按项目实际），记录命令与最终行数；
- 没有 → 本节动态部分 `BLOCKED`，报告写明「缺造数工具，建议目标量级 N 行」，不用小数据集伪报。

只造主表不够：关联查询的卫星表也要到量级，否则 join 代价被低估。

## 基线对比压测

前提：`--load-cmd` 与 `--env` 齐备，且 `TARGET_ENV` 可证明隔离（独立数据库连接串、独立进程）。同一台机器、同一份数据、同一压测脚本，先压 base 再压 head，各 ≥10 轮，丢弃前 3 轮预热：

```bash
. /tmp/pi-pr-verify-<ID>.env; : "${LOAD_CMD:?}" "${URL_BASE:?}" "${URL_HEAD:?}" "${PACK:?}"
for side in base head; do
  TARGET="$URL_BASE"; [ "$side" = head ] && TARGET="$URL_HEAD"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do
    ( TARGET_URL="$TARGET" eval "$LOAD_CMD" ) > "$PACK/load-$side-$i.out" 2>&1; EXIT=$?
    echo "$side run $i exit=$EXIT"
  done
done
```

`LOAD_CMD` 应从环境变量 `TARGET_URL` 读目标地址（脚本自身负责），并在输出里给出 P50/P95/P99、错误率。本会话从第 4–13 轮各抽 P95 组成样本序列，计算两侧均值与标准差，再算 `Δ = (head_P95 − base_P95) / base_P95`：

| 观察 | 判定 |
|---|---|
| 任一侧标准差 > 均值 30% | `BLOCKED`——机器噪声过大，本机测不出结论 |
| `Δ ≤ 5%` | `PASS` |
| `5% < Δ ≤ 20%` | `PASS` + Medium 发现（写明幅度与建议的压测环境） |
| `Δ > 20%` | `FAIL` |
| head 错误率 > base 错误率 | `FAIL`，与 `Δ` 无关 |

**原始样本序列全部进报告**，只贴一个百分比不成立。压测工具（k6、vegeta、oha、wrk、hey、JMeter…）由项目或用户提供，本 Skill 不自动安装。

## 资源回落

压测同时记录 head 进程的内存、goroutine/线程数、fd 数、数据库连接数峰值；压完等待 5 分钟再记一次。任一指标不回落到压测前水位 ±10% → `FAIL(leak)`，附两次读数。读数命令按运行时（`/proc/<pid>/status`、运行时 metrics 端点、容器 stats）从项目文档确定。

## 判定

| 子项 | `PASS` 条件 |
|---|---|
| 静态可疑点 | 无 N+1、无无界查询、无无超时外调 |
| 查询计数 | head 条数 ≤ base 条数，或增量为常数且已说明 |
| 执行计划 | 热路径查询无大表顺扫、估算偏差 < 一个数量级 |
| 基线对比 | 噪声可接受且 `Δ ≤ 20%`，错误率不升 |
| 资源回落 | 全部指标回落 |

任一 `FAIL` → D 节 `FAIL`；动态部分因缺工具/环境/数据 `BLOCKED` 时，静态部分照常判定，D 节整体至多 `BLOCKED`。

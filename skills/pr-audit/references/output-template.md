# 完整档报告模板

完整档审计使用下面的模板输出。快速档不使用本模板，只输出 ≤10 行结论（门禁、每个启用 Gate 状态、阻断问题、建议）。

```markdown
# PR #123 审计报告

## 结论

**门禁：PASS | 建议：建议通过**

| Gate | 开关 | 状态 | 关键证据 |
|---|---:|---|---|
| Correctness | ON | PASS | unit/lint/typecheck ... |
| Requirements | OFF | DISABLED | 未计分 |
| Security | ON | PASS | threat review + scanner ... |

**通过计数：2/2 PASS**（Linear 关闭；若开启则应为 3/3）

## 审计对象
- PR：...
- Base：`branch@oid`
- Head：`branch@oid`
- 状态/是否 Draft：...
- 变更：N files, +A/-D
- 档位：完整档 / 快速档（升级原因：...）
- Linear：ON `TEAM-123` / OFF

## 阻断问题
<!-- 先按 Critical/High/Medium 排列；没有则写"无" -->
1. **[High][Correctness] 标题** — `file:line`
   - 触发：...
   - 影响：...
   - 证据：...
   - 修复方向：...

## Gate 1：Correctness
### 代码审阅
- ...
### 测试与静态验证
| 命令/CI | 结果 | 覆盖范围 | 证据/限制 |
|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED`：...

## Gate 2：Requirements
- 开关：ON/OFF
- Issue 与最终口径：...
### 需求追踪矩阵
| ID | 需求与来源 | 实现 | 测试 | 结论 |
|---|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED/DISABLED`：...

## Gate 3：Security
### 威胁审阅
- ...
### 扫描结果
| 工具 | 范围 | 结果 | 已验证发现/限制 |
|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED`：...

## 非阻断问题与改进建议
- [Low/Info] ...

## 未验证项
- ...

## 门禁依据
- 每个启用 Gate 为何是该状态：...
- 未缓解的 Medium 项及其处理要求：...
- 使门禁转为 PASS 所需动作（若当前非 PASS）：...

## 审计完整性
- 冻结 head：`oid`
- 最终 head：`oid`（一致/已漂移）
- 报告发布：仅 Pi 输出，未修改 PR/Linear
```

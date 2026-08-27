# 审计输出模板

Pi 输出的固定骨架。段落顺序与标题不得改动，无内容的段写「无」而不是删掉。

> 由 SKILL.md 的「输出模板」小节引用。

## 完整模板

```markdown
# PR #123 审计报告

## 结论

**门禁：PASS | 等级：A | 建议：建议通过**

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
- Linear：ON `TEAM-123` / OFF

## 阻断问题
<!-- 先按 Critical/High/Medium 排列；没有则写“无” -->
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
- 判定范围：静态存在性（实现/测试证据是否可指认）；验收标准的可执行验证见 `linear-pr-audit` 门 4
### 需求追踪矩阵
| ID | 需求与来源 | 实现 | 测试 | 结论 |
|---|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED/DISABLED`：...

## Gate 3：Security
### 仓库既有安全基线
| 既定模式 | 落点 | 适用场景 |
|---|---|---|
### 偏离与数据流发现
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

## 评级依据
- 为什么是 S/A/B/C/D/F：...
- 使评级提升所需动作：...

## 审计完整性
- 冻结 head：`oid`
- 最终 head：`oid`（一致/已漂移）
- 报告发布：仅 Pi 输出，未修改 PR/Linear
```

## 填写规则

- 「结论」行的门禁、等级、建议三者必须同时出现，且互相自洽。
- 「通过计数」必须写成 `实际 PASS 数/启用 Gate 数`，Linear 关闭时分母是 2。
- 每条发现都要带严重级、Gate、`file:line`、影响与依据；缺任一项的条目降为 `Info`。
- 疑似 secret 只写文件、行号与脱敏指纹，不复述完整值。
- 「未验证项」不能空着：没有未验证项就明确写「无」，这本身是评 `S` 的前提。
- 「审计完整性」的冻结 head 与最终 head 必须都是实际读到的 OID，不得复制粘贴。

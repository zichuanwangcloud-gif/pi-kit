# PR Audit 设计与评级

`pr-audit` 用于 PR 创建后的独立审计，目标不是再次实现需求，而是回答三个问题：

1. 改动在代码和自动化验证层面是否正确？
2. 可选地，改动是否完整覆盖 Linear 的最终需求口径？
3. 改动是否引入代码与依赖安全风险？

## 三个 Gate

### Correctness

同时检查：

- 完整 diff 和相关调用链
- 单元/回归测试的质量与覆盖意图
- 项目已有 lint、typecheck、compile/build
- CI 与本地证据是否一致

测试命令无法运行且没有等价 CI 证据时为 `BLOCKED`，不能因静态阅读“看起来正确”而 PASS。

### Requirements

由 `--linear on|off` 控制，默认关闭：

- `on`：读取正文、全部评论、附件和关键文档，建立“原子需求 → 实现 → 测试”矩阵。
- `off`：标记 `DISABLED`，不读取 Linear，也不参与 PASS 分母和评级扣分。

因此 Linear 开启要求 3/3 PASS；关闭要求其余 2/2 PASS。

### Security

由两部分组成：

- 针对变更面的人工威胁审阅
- 项目已有的 secret、SAST、dependency、IaC/container 扫描

不自动安装未知扫描器。项目明确要求的扫描器缺失时为 `BLOCKED`；项目未规定扫描器时可以基于人工审阅和现有可信工具 PASS，但因覆盖有限最高为 A。

## 状态与门禁

Gate 状态：`PASS`、`FAIL`、`BLOCKED`；Requirements 关闭时额外使用 `DISABLED`。

总体门禁不做平均分：

1. 任一启用 Gate FAIL → FAIL
2. 无 FAIL、任一启用 Gate BLOCKED → BLOCKED
3. 所有启用 Gate PASS → PASS

## 评级

| 等级 | 含义 |
|---|---|
| S | 所有启用 Gate 高质量通过，无警告或未验证项 |
| A | 所有启用 Gate 通过，只有低风险提示或有限覆盖 |
| B | 一个启用 Gate BLOCKED，其余 PASS |
| C | 多个 Gate BLOCKED，证据不足 |
| D | 存在有限、易修复的 FAIL，无高危安全问题 |
| F | 关键正确性/需求/安全失败，或多个 Gate FAIL |

只有 `PASS + S/A` 才建议通过。

## 只读边界

第一版默认且始终只在 Pi 输出：

- 不发布 PR comment/review
- 不修改 PR 状态
- 不回写 Linear
- 不提交或 push
- 不部署或发布

需要执行测试时使用冻结 PR head 的隔离 worktree，避免切换或污染用户主工作区。

## 常用入口

```text
/skill:pr-audit 123
/skill:pr-audit 123 --linear on
/skill:pr-audit https://github.com/org/repo/pull/123 --linear off
```

未传 `--linear` 等价于 `--linear off`。

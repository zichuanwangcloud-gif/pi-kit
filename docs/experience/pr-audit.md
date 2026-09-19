# PR Audit 设计与门禁

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
- `off`：标记 `DISABLED`，不读取 Linear，也不参与 PASS 分母。

因此 Linear 开启要求 3/3 PASS；关闭要求其余 2/2 PASS。

本 Gate 只回答**静态存在性**：每条原子需求有没有可指认的实现代码和对应测试证据，它不回答验收标准在冻结 head 上跑不跑得通。验收标准的**可执行**验证属于 `linear-pr-audit` 的第四门 Acceptance（门 4），它在这三门之上叠加，要求 4/4 PASS，并可用实测结论回写、推翻本门的静态判定。

### Security

由两部分组成：

- 针对变更面的人工威胁审阅
- 项目已有的 secret、SAST、dependency、IaC/container 扫描

不自动安装未知扫描器。项目明确要求的扫描器缺失时为 `BLOCKED`；项目未规定扫描器时可以基于人工审阅和现有可信工具 PASS，但必须在报告中声明扫描覆盖有限。

## 状态与门禁

Gate 状态：`PASS`、`FAIL`、`BLOCKED`；Requirements 关闭时额外使用 `DISABLED`。

总体门禁不做平均分：

1. 任一启用 Gate FAIL → FAIL
2. 无 FAIL、任一启用 Gate BLOCKED → BLOCKED
3. 所有启用 Gate PASS → PASS

## 合并建议

不再输出字母等级。早期版本的 S/A/B/C/D/F 与门禁高度冗余——B 与 C 的差别只是 BLOCKED 的数量，D/F 则完全由门禁推导，对合并决策没有增量信息。现在只输出门禁状态和阻断问题列表：

- `PASS` 且无未缓解的 Medium 发现 → 建议通过
- `BLOCKED` → 暂缓，补齐证据后重审
- `FAIL` → 不建议通过，修复后重审

审计质量通过「未验证项」和「扫描覆盖限制」两节如实披露，而不是压缩成一个字母。

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

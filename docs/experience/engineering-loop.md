# Engineering Loop 设计与使用经验

## 为什么不用 Claude Code Stop Hook 原样移植

Claude Code Ralph Loop 依靠 Stop Hook 拦截退出。Pi 提供 `agent_settled`，可在 Agent 的 retry、compaction 和 follow-up 全部结束后安全判断是否续跑：

```text
agent_settled → validator/promise/阻塞/上限/空转检查 → sendUserMessage(originalPrompt)
```

## v0.1 原则

- 单 Pi Session 只允许一个 Loop。
- 原 Prompt 每轮保持不变；上轮 validator 信息通过 `before_agent_start` 注入。
- Validator 优先于模型 promise。
- 没有 validator 时，promise 只代表模型声明，结束后必须人工复核。
- 用户普通输入、会话恢复、模型 abort/error、`<loop-blocked>` 都会暂停。
- 连续两轮 Git 指纹不变会暂停，避免空转烧 token。
- Validator 完整日志放到 `~/.pi/agent/state/engineering-loop/`，不污染仓库。
- 默认拒绝在 main/dev/test 启动。
- Loop 内阻止 push、PR、SSH、部署、reset --hard、clean 和 stash。

## 好 Prompt

任务应包含：

1. 唯一目标
2. 修改边界
3. 不变量
4. 可执行验证器
5. 阻塞时应询问的问题

示例：

```text
/loop "修复 gateway 默认分组解析。只修改 clouditera 命名空间；保持现有 OpenAI/Anthropic 行为；需要产品判断时输出 loop-blocked。" \
  --validator "cd apps/console-v2/backend && go test -tags=unit ./internal/clouditera/middleware/..." \
  --max-iterations 8
```

## 不适用情形

- 需求和验收不清晰
- 产品设计选择
- 生产事故和线上数据修改
- 发布、部署、迁移
- 需要人工视觉判断但没有自动化验收
- 任务跨度过大，不能拆成单一完成条件

## 已知限制

- v0.1 只在当前 Pi Session 的 `cwd` 工作，不自动创建/切换 worktree。
- 状态保存在 Pi Session entry 中，不支持多进程并发 Loop。
- 暂未主动触发 compact；长 Loop 应降低迭代上限并拆分任务。
- 成本统计取模型上报 usage；不同 Provider 的费用字段可能不完整。
- 外部操作拦截是额外防线，不替代 Git 分支保护和人工审查。

## 后续路线

- v0.2：上下文阈值 compact、预算/token 上限、场景模板、失败分类。
- v0.3：父 Pi 启动 worktree 内子 Pi RPC，实现后台与多 Loop。
- v0.4：与 Linear/PR/CI 状态机衔接，但 push/PR 仍需人工确认。

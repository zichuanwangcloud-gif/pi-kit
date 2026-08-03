# Engineering Loop 设计与使用经验

## 生命周期选择

依赖 Stop Hook 的循环机制不适合直接照搬到 Pi。Pi 提供 `agent_settled`，可以在 retry、compaction 和 follow-up 都结束后判断是否续跑：

```text
agent_settled → validator/promise/阻塞/上限/空转检查 → sendUserMessage(originalPrompt)
```

## 当前原则

- 单个 Pi Session 同时只允许一个 Loop。
- 原 prompt 每轮保持不变；上一轮 validator 信息由 `before_agent_start` 注入。
- Validator 优先于模型 promise。
- 没有 validator 时，promise 只代表模型声明，结束后必须人工复核。
- 用户普通输入、会话恢复、模型 abort/error、`<loop-blocked>` 都会暂停。
- 连续两轮 Git 指纹不变会暂停，避免空转消耗 token。
- Validator 完整日志保存到 `~/.pi/agent/state/engineering-loop/`，不污染项目。
- 默认拒绝在常见集成/发布分支（如 `main`、`master`、`develop`、`staging`）启动；目标仓库仍应提供自己的分支保护。
- Loop 内阻止 push、PR、SSH、部署、`reset --hard`、`clean` 和 `stash`。
- 写入限制在 Loop 启动目录；命令不能通过绝对路径或 `..` 离开该目录。

## 好 Prompt

任务宜包含：

1. 唯一目标
2. 修改边界
3. 不变量
4. 可执行验证器
5. 阻塞时应询问的问题

通用示例：

```text
/loop "修复请求解析的边界条件；只修改 parser 包；保持公开 API 行为；需要产品判断时输出 loop-blocked。" \
  --validator "npm test -- parser" \
  --max-iterations 8
```

Go 项目示例：

```text
/loop "修复缓存失效逻辑并补充回归测试" \
  --validator "go test ./internal/cache/..." \
  --max-iterations 6
```

命令只是示例，应以目标项目文档为准。

## 不适用情形

- 需求和验收不清晰
- 产品或架构方案选择
- 生产事故和线上数据修改
- 发布、部署或数据迁移
- 只能依赖人工视觉判断且没有自动验收
- 任务跨度过大，无法拆成单一完成条件

## 安全模型的边界

当前实现维护一组常见受保护分支名作为兜底，并阻断明显外部/破坏性命令。这不是完整沙箱，也不能自动理解每个组织的 Git 策略：

- 如果仓库使用其他受保护分支名，应依靠远程分支保护，并在项目说明中标明。
- Validator 是 shell 命令；启动前必须由用户审阅。
- 正则拦截是额外防线，不能替代最小权限凭据和代码审查。
- Loop 不应持有生产或部署凭据。

## 已知限制

- 只在当前 Pi Session 的 `cwd` 工作，不自动创建或切换 worktree。
- 状态保存在 Pi Session entry 中，不支持多进程并发 Loop。
- 暂未主动触发 compact；长任务应降低迭代上限并拆分。
- 成本统计依赖模型上报 usage，不同 provider 的字段可能不完整。
- 项目专属受保护分支尚不能通过命令参数配置；当前只提供常见名称的兜底集合。

## 后续方向

- 上下文阈值 compact、预算/token 上限和失败分类。
- 从项目配置加载额外受保护分支与允许的 validator 策略。
- 父 Pi 在 worktree 中启动子 Pi，实现后台和多 Loop。
- 与 Issue/PR/CI 状态机衔接，同时保留明确的外部操作授权边界。

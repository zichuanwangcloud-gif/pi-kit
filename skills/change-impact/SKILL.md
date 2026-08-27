---
name: change-impact
description: 分析分支、commit、PR 或拟议改动的影响半径，沿依赖、运行时入口、数据、配置、测试和运维边界建立证据图并给出风险与验证建议。用于“这个改动影响哪里”“回归范围”“谁会被影响”“改动风险评估”等请求。本 Skill 面向泛化的影响半径分析；只看 API 契约兼容性用 `api-contract-audit`，只看数据迁移用 `schema-migration-audit`，只看测试覆盖缺口用 `test-gap`，已开 PR 的完整合并门禁用 `pr-audit`。
compatibility: Requires a readable git checkout. Optional PR metadata requires a read-authenticated repository CLI; repository structure and commands are discovered at runtime.
allowed-tools: read bash
metadata:
  category: change-analysis
  portability: project-agnostic
---

# Change Impact

对已存在 diff 或清晰的拟议变更做只读影响分析。默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不修改代码/配置，不 checkout 覆盖用户工作。

## 输入

接受明确的 base/head SHA、commit range、PR、当前工作树 diff，或带目标符号/接口的拟议变更。多个候选或 base 不明确时询问。对拟议改动必须将推断标为“预测”，不能伪装成已存在 diff。

## 1. 探测约定与边界

读取适用 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、架构/测试/发布文档以及语言 manifest、workspace、构建和 CI 配置。识别 monorepo package、应用、库、服务、部署单元及 owner 规则；不预设固定目录或框架。

记录冻结 base/head、dirty 状态和分析范围。PR 元数据只用只读命令，先核实平台 CLI 语法。不得 fetch 后 checkout 主工作区；需要对象时使用安全 fetch/ref 或隔离 worktree。

## 2. 建立变更清单

用精确对象检查 name-status、stat、rename、submodule、binary 和完整 diff。按真实语义分类：

- public/internal API 与类型；
- 运行时代码、入口、权限和错误路径；
- schema/migration/持久化；
- 配置、flag、环境变量和默认值；
- 依赖/锁文件、生成物、构建/CI；
- UI/CLI 文案和行为；
- 测试/fixture/docs/observability；
- 删除、重命名和兼容 shim。

生成文件与源文件要追到生成规则；大文件或不可见对象明确列限制。

## 3. 双向影响追踪

从每个变更符号/路径向外查 consumers，也从运行时入口向内确认实际可达。使用仓库现有索引、language tooling、import/引用搜索、路由/注册表、配置和构建图；命令必须先从项目配置发现，不声称纯文本命中等同运行时依赖。

至少检查：

1. **编译/链接依赖**：import、调用者、实现者、泛型/类型消费者。
2. **运行时可达性**：route、command、event、job、plugin、DI、dynamic loading。
3. **数据影响**：读写者、索引、迁移顺序、缓存、消息 schema、保留策略。
4. **契约影响**：HTTP/RPC/event/CLI/config/public package 与下游。
5. **交付影响**：build graph、container/IaC、feature flag、rollout/rollback。
6. **用户影响**：角色、入口、可见行为、失败模式和地域/租户范围。
7. **验证影响**：相邻测试、集成/e2e、contract、migration 和监控。

搜索到的候选逐一标记 `DIRECT`、`TRANSITIVE`、`POTENTIAL/DYNAMIC` 或 `EXCLUDED`，并给排除理由。

## 4. 风险评分（定性）

不得用无依据的总分掩盖风险。每个影响项按 `High/Medium/Low`，说明：

- 可达用户/服务范围；
- breaking/数据不可逆/权限影响；
- 失败可检测性；
- rollback 难度；
- 测试和监控证据；
- 不确定性。

例如公共契约删除、不可逆数据转换、鉴权边界或无法独立回滚通常需重点标记，但最终以项目事实为准。

## 5. 可选只读验证

优先运行不会改变外部状态的现有 dependency graph、typecheck、dry-run、list-tests 或静态命令。先阅读脚本；可能生成文件/依赖时用隔离环境。不得安装未知工具，不运行发布、部署或生产查询。缺失依赖记 `BLOCKED`，静态追踪仍继续。

## Gate

- `PASS`：影响面已完整追踪，风险有对应验证覆盖，无阻断发现；
- `FAIL`：存在未受控的 breaking 影响、不可逆数据风险或无回滚路径的高风险项；
- `BLOCKED`：关键依赖图、消费者或运行时可达性证据缺失，无法可信判断。

## 输出

```markdown
# Change Impact 报告
## 结论
- Gate：PASS / FAIL / BLOCKED

## 范围与版本
- 类型：实际 diff / 拟议变更
- Base/head：...
- 项目约定证据：...

## 变更摘要
| 变更点 | 类型 | 位置 | 行为变化 |
|---|---|---|---|

## 影响图
| 受影响对象 | 关系 | 证据 | 用户/运行时结果 | 置信度 |
|---|---|---|---|---|

## 风险与兼容性
| 级别 | 风险 | 触发 | 回滚/检测 | 缓解 |
|---|---|---|---|---|

## 建议验证矩阵
| 范围 | 测试/检查（来自仓库） | 原因 | 当前状态 |
|---|---|---|---|

## 发布与观测注意项
- rollout/flag/migration/metrics/logs/alerts（适用项）

## 排除项与未知项
- 候选及排除证据；动态依赖、下游仓库或环境缺口

## 安全声明
- 只读分析；未修改代码、PR/Issue，未 push/部署。
```

## 完成检查

完整阅读 diff；使用精确版本；直接与传递影响分开；文本命中已验证可达性；用户、数据、契约、交付和测试面均评估；事实/推断/未知分开。

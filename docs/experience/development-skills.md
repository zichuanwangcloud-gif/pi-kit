# 通用开发 Skills：设计与使用经验

Pi Kit 在既有 `feature-trace`、`linear-to-pr`、`pr-audit` 和 Engineering Loop 之外，提供十个项目中立的开发审计/排障 Skill：

| Skill | 核心问题 | 主要产出 |
|---|---|---|
| `ci-triage` | CI 为什么失败或卡住？ | 冻结 run、首错、失败分类、根因置信度与下一步 |
| `review-resolver` | Review 意见是否成立、如何逐条解决？ | 意见清单、当前 head 证据、确认计划、可选本地修复 |
| `change-impact` | 改动会影响哪些消费者与交付面？ | 直接/传递影响图、风险与验证矩阵 |
| `test-gap` | 哪些行为没有有效回归保护？ | 行为—测试矩阵、断言质量和补测优先级 |
| `schema-migration-audit` | 迁移能否在真实发布拓扑中安全执行？ | 版本兼容、锁/数据/恢复门禁 |
| `api-contract-audit` | 契约是否破坏旧/新消费者？ | 契约 diff、消费者矩阵与迁移策略 |
| `release-readiness` | 冻结候选是否具备发布证据？ | GO/NO-GO/BLOCKED 多维门禁 |
| `dependency-upgrade` | 升级的 graph、breaking 和供应链风险是什么？ | 上游证据、lock 审计和升级验证计划 |
| `incident-triage` | 当前事件的范围、时间线和最可信假设是什么？ | 脱敏 handoff、假设表和未执行的缓解建议 |
| `pr-verify` | 这个 PR 的「完成」声明有多少能用原始输出证明？ | 字面验收表、Revert-check、边界/性能/故障/爆炸半径六节证据包 `REPORT.md`，验证者独立于实现者 |

## 共同架构

### 先探测、后执行

每个 Skill 都先读目标仓库适用的 `AGENTS.md`、`CLAUDE.md`、贡献/架构/runbook 文档，再从 manifest、CI、migration、schema、测试、发布配置中发现真实命令与约定。Skill 不预设：

- GitHub 或某一种 CI/incident 平台；
- `main`/`develop`、固定目录和 monorepo 工具；
- npm、Go、Python 等技术栈；
- OpenAPI、SQL、SemVer 或 Kubernetes；
- 目标仓库已安装 scanner、coverage 或 compatibility checker。

文档中的命令只用于安全的 Git/环境探测。项目命令必须能指向目标仓库中的来源；平台命令先通过文档或 `--help` 核实。这样可避免“看似专业但实际不存在”的命令。

### 冻结对象

CI run、PR head、commit range、release artifact 和 incident 时间窗口都可能漂移。报告记录精确 SHA/ID/digest/attempt/查询窗口，并在适用时收尾复核。旧 SHA 的绿色 CI 不能证明新候选通过，恢复也不能自动证明 incident 根因。

### 事实、推断与未知

共同输出约束：

- 事实引用真实 `file:line`、日志区间、run/commit/schema 或文档；
- 相关性不能冒充因果；
- 静态文本命中不能冒充运行时可达；
- 测试绿色不能冒充需求覆盖；
- checker 绿色不能替代契约、数据或安全语义审阅；
- 工具/依赖/权限缺失标 `BLOCKED` 或未验证，不能伪报 PASS。

## 统一安全边界

十个 Skill 默认：

1. 不 push、force push、提交或直推保护分支；
2. 不 comment/review/resolve/edit/merge PR，不修改 Linear/Issue；
3. 不触发、重跑、取消或批准 CI/CD；
4. 不发布、部署、回滚、变更 feature flag/config/云资源；
5. 不 reset/clean/stash、checkout 覆盖或生成/安装污染主工作区；
6. 不读取/复制 secret 与非必要 PII，不执行生产写命令；
7. 不自动安装未知工具或把网络失败解释为安全/质量通过。

测试、生成或扫描可能写本地文件时，使用冻结版本的隔离 worktree/沙箱，并先阅读脚本。依赖缺失时继续静态检查并记录限制。

### 唯一修改例外：review-resolver

`review-resolver` 默认仍是分析模式。修改任务代码需要四层闸门：

1. 用户明确要求修复（“看看 comments”不算）；
2. Skill 已展示逐条状态、拟改文件、方案和验证；
3. 用户在看到计划后确认；
4. 当前目录是非保护分支的隔离任务 worktree，dirty 改动归属明确。

任一缺失就只输出计划。计划确认只允许列出的本地任务代码修改，不授权 `git add/commit/push`、发布回复、resolve thread 或外部系统 mutation。范围扩大或 head 漂移需重新计划和确认。

`linear-to-pr` 的既有实现/push/PR 授权语义保持独立且不受这组默认边界改写。

## 组合使用

Skill 可按证据链组合，但上层必须自行汇总结论：

- CI 失败 → `ci-triage`；怀疑改动范围时补 `change-impact`；
- PR 发布前 → `test-gap` + 适用的 schema/API/dependency 审计；
- PR 开出后自称「完成」→ `pr-verify` 用独立验证者逐节跑证据，验收表有「需要猜」就停下来问，结果格填不出原始输出只能写 `NOT-RUN`；
- release candidate → `release-readiness` 汇总子报告，但未运行门禁不能写 PASS；
- incident → `incident-triage` 管理时间线/假设，只读调用变更或迁移审计，不自动执行缓解；
- review → `review-resolver` 的分析结论可引用其他只读 Skill，最终修改仍走自己的确认闸门。

## 可发现性与维护

- `/help development` 提供分类入口和安全边界；
- `/help installed` 动态显示实际加载的 Skill 与路径；
- README 提供场景索引；
- `docs/MIGRATION.md` 列安装和迁移检查；
- package metadata 的 `pi.skills` 继续指向整个 `skills/`，Pi 按 Agent Skills 规范递归发现。

结构测试校验十个目录、frontmatter 名称/描述、目录名一致、统一安全文案、review 修改闸门、帮助/README/迁移文档和 package metadata，同时保留既有 Skill 策略断言。

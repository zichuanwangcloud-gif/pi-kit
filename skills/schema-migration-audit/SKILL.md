---
name: schema-migration-audit
description: 审计数据库、事件、配置或其他持久化 schema 迁移的兼容性、数据安全、执行顺序、回滚、锁与发布风险，输出证据化门禁报告。用于“migration 安全吗”“schema 变更审查”“数据库发布风险”“迁移回滚评估”等请求。
compatibility: Requires a readable git checkout. Database engines, migration frameworks, dry-run commands, and deployment conventions are discovered from repository files; production access is neither required nor permitted by default.
allowed-tools: read bash
metadata:
  category: data-migration-audit
  portability: project-agnostic
---

# Schema Migration Audit

只读审计持久化 schema 与数据迁移。范围可包含关系数据库、NoSQL、事件/消息 schema、搜索索引、配置 schema 或应用自管格式；必须先从仓库确认类型，不能把 SQL 假设强加给所有项目。

默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不编辑 migration，不连接/查询生产，不执行 apply/up/down，不修改云资源。即使命令名含 `dry-run`，也要先确认实现确实无外部写入。

## 1. 冻结范围并探测约定

确定 base/head、PR 或 migration 文件。读取 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、数据/发布/runbook 文档，以及真实 migration 配置、schema 源、ORM/codegen、CI 和部署清单。

识别并记录：

- schema 权威来源与生成方向；
- migration 框架、版本/命名、事务语义和历史不可变规则；
- 实际引擎及支持版本；
- deploy 顺序、rolling/blue-green 能力、maintenance window；
- 数据量/分区/复制/备份证据是否存在；
- validation、rollback/roll-forward 和 owner。

若缺少引擎版本、数据规模或发布拓扑，不猜，标为风险/阻塞。

## 2. 完整阅读迁移链

比较 schema、migration、模型、查询、序列化、fixture、生成物和部署配置。不能只读新增 migration；检查前后相邻版本、重复编号、分支冲突、checksum/history 规则及应用代码何时开始读写新旧字段。

将每个操作分类：add/drop/rename/type change/constraint/index/backfill/data rewrite/format or event evolution，并记录是否可逆、是否幂等、失败后状态。

## 3. Expand/Contract 与兼容窗口

对每个 deploy 阶段建立版本矩阵：旧应用+旧 schema、旧应用+新 schema、新应用+新 schema，以及项目发布模型要求的其他组合。检查：

- 新字段是否 nullable/default；default 是否触发昂贵 rewrite；
- rename/drop 是否先双读/双写并经过弃用窗口；
- type/enum/constraint 收紧前是否验证与清洗旧数据；
- backfill 是否分批、可恢复、可观测、限速且不与应用竞争；
- index/constraint 构建的锁与 online/concurrent 语义；
- 事务边界是否被引擎支持，失败是否部分提交；
- replication lag、CDC、缓存、搜索、消息消费者和下游兼容；
- rollback 后新写数据是否丢失或旧版本无法读取；
- 删除前是否有使用量/查询证据，而不是仅 repo 搜索无命中。

SQL/ORM 关键字本身不证明风险大小；必须结合引擎版本和项目拓扑。

## 4. 数据正确性与安全

检查 uniqueness、foreign key、precision/timezone/encoding、NULL、default、排序/collation、主键、重复执行、批次边界、PII/retention/encryption/audit 权限。数据转换需有前置计数/校验、异常隔离、后置 reconciliation 和停止阈值。

不得执行生产 count、explain、lock 检查。只可建议由授权 operator 执行，并给出目标而非伪造结果。

## 5. 只读验证

从仓库发现已有 lint/validate/plan/render/checksum/test 命令，先读实现。仅运行确认不连接可写共享环境的命令；优先临时本地数据库/容器，但不得自动下载镜像或安装未知工具。命令不可安全执行则标 `BLOCKED`，继续静态审计。

执行生成/plan 后检查 git 状态；若意外产生文件立即停止，不删除用户内容，报告路径。绝不运行真实 `migrate up/down/apply` 对共享环境。

## Gate

- `PASS`：兼容顺序、数据校验、锁/容量、失败恢复和验证证据充分，无阻断发现；
- `FAIL`：存在明确数据丢失、不可兼容部署、未受控重写/锁、错误迁移链等；
- `BLOCKED`：关键引擎/规模/拓扑/命令证据缺失，无法可信判断。

发现分 `Critical/High/Medium/Low`，附触发、影响和缓解。不能以“有 down migration”代替可恢复证明。

## 输出

```markdown
# Schema Migration Audit
## 结论
- Gate：PASS / FAIL / BLOCKED
- Schema 类型/引擎/版本：...
- Base/head 与发布模型：...

## 操作清单
| 操作 | 位置 | 可逆/幂等 | 锁/数据影响 | 风险 |
|---|---|---|---|---|

## 版本兼容矩阵
| 应用版本 | Schema 阶段 | 读 | 写 | 结论 |
|---|---|---|---|---|

## 阻断发现
1. **[High] ...** — `file:line`（触发/影响/证据/缓解）

## 数据验证与恢复
- preflight、backfill、reconcile、roll-forward/rollback、停止阈值：...

## 执行与发布建议
1. 阶段、观测项、owner 和人工确认点

## 已运行检查与缺口
| 命令/证据 | 结果 | 限制 |
|---|---|---|

## 安全声明
- 未连接/修改生产，未 apply migration，未 push/修改 PR/Issue，未部署。
```

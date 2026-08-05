---
name: api-contract-audit
description: 审计 HTTP、RPC、事件、CLI 或库 API 变更的消费者兼容性、schema、错误语义、版本策略与契约测试，识别 breaking change 和 rollout 风险。用于“API 是否破坏兼容”“接口变更审查”“OpenAPI/事件契约审计”“SDK 兼容性”等请求。本 Skill 只做跨边界契约兼容性审计；泛化的改动影响面用 `change-impact`，数据层 schema 与迁移用 `schema-migration-audit`。
compatibility: Requires a readable git checkout. Contract formats, generators, compatibility checkers, and test commands are discovered from repository documentation and configuration.
allowed-tools: read bash
metadata:
  category: contract-audit
  portability: project-agnostic
---

# API Contract Audit

对公开或跨边界契约做只读审计。API 可是 HTTP/OpenAPI、GraphQL、RPC/IDL、事件/消息、CLI、插件接口或发布库；先探测真实边界，不假定协议。

默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不编辑 schema/代码，不重新发布 SDK，不调用写接口。生成器或 checker 只在仓库已有且确认本地安全时运行。

## 1. 确定契约与版本

冻结 base/head 或 PR。读取适用 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、API/versioning/deprecation/release 文档，以及 schema、路由/handler、serializer、client/SDK、fixture、contract tests、gateway 和生成配置。

确认 source of truth：code-first、schema-first 或多源；若 schema 与实现漂移，两者都作为发现，不能擅选一个为事实。识别消费者范围：本仓库、其他服务、公开客户、旧客户端、异步 consumer；无法访问的外部消费者列未知。

## 2. 提取契约 diff

比较精确版本，覆盖：

- endpoint/method/topic/command/symbol 增删改；
- request/response/event 字段、类型、required/nullability/default；
- enum/union/discriminator、pagination、ordering、filter；
- status/error code、错误 body、重试与幂等；
- auth/scope/tenant、rate limit、timeout；
- headers/metadata/content type/serialization；
- GraphQL nullability/input、RPC field number/reserved、event evolution；
- CLI flags/output/exit code；库 export/signature/semantic version；
- SDK/generated artifact 和文档示例。

协议特有检查只在适用时执行。例如 protobuf 删除字段需看 reserved；这不是所有 API 的固定要求。

## 3. 兼容性矩阵

至少评估项目 rollout 需要的组合：旧 consumer→新 provider、新 consumer→旧 provider、混合版本，以及 event replay/延迟消息。按 `Backward/Forward/Full/Breaking/Unknown` 标记并说明证据。

重点检查：

- optional→required、类型收窄、enum 新值对严格客户端的影响；
- 删除/重命名、默认值和 omission/null 语义；
- 宽松服务端与严格生成客户端的差异；
- 错误/状态码变化是否改变 retry/fallback；
- pagination/order 是否破坏游标或缓存；
- 双版本路由、deprecation 通知和 sunset；
- consumer-driven contract、schema registry 和 gateway 校验；
- 文档/schema/实现/SDK 是否同 commit 同步。

仓库搜索无消费者不证明没有外部消费者。

## 4. 安全与行为语义

检查鉴权是否默认拒绝、对象/租户级权限、敏感字段暴露、mass assignment、输入约束、错误泄露、幂等键、重放和 webhook 签名等与契约相关的风险。深入漏洞扫描可建议 `pr-audit`，本报告仍须说明契约安全面。

## 5. 只读验证

从仓库发现已有 schema lint、breaking-change checker、codegen check、contract/integration tests。先读脚本，不自动安装/下载工具，不调用部署或远程写 API。生成检查可能改文件时在隔离 worktree 运行并用 diff 验证；依赖缺失标 `BLOCKED`。

checker 通过不替代人工语义审计；工具未配置时不虚构命令。

## Gate

- `PASS`：适用版本组合兼容，或 breaking change 有明确版本/迁移策略与验证；
- `FAIL`：确认未管理的 breaking change、schema/实现漂移或高风险语义缺陷；
- `BLOCKED`：source of truth、consumer、版本或关键验证不可确认。

## 输出

```markdown
# API Contract Audit
## 结论
- Gate：PASS / FAIL / BLOCKED
- 契约类型与 source of truth：...
- Base/head：...

## 契约变更
| 元素 | Before | After | 消费者影响 | 兼容性 | 证据 |
|---|---|---|---|---|---|

## 版本/消费者矩阵
| Consumer | Provider | 结果 | 依据/未知 |
|---|---|---|---|

## 阻断发现
1. **[High][Breaking/Security] ...** — `file:line`

## Schema—实现—SDK—测试一致性
| 层面 | 状态 | 证据 |
|---|---|---|

## 迁移与发布建议
- version/deprecation/dual-read-write/rollout/rollback/observability

## 验证与限制
| 命令/证据 | 结果 | 限制 |
|---|---|---|

## 安全声明
- 只读；未发布 SDK、调用写接口、push、修改 PR/Issue 或部署。
```

---
name: release-readiness
description: 在发布前汇总范围、CI/测试、缺陷、契约、迁移、依赖、安全、运维、回滚和审批证据，给出 GO、NO-GO 或 BLOCKED 的只读发布就绪结论。用于“能不能发版”“release checklist”“上线前审计”“发布风险盘点”等请求。
compatibility: Requires a readable git checkout. Release metadata and CI status may require authenticated read-only platform CLIs; release conventions are discovered from repository documentation and configuration.
allowed-tools: read bash invoke_skill
metadata:
  category: release-audit
  portability: project-agnostic
---

# Release Readiness

对一个明确 release candidate（tag、commit、branch、PR 集合或 artifact digest）执行只读发布就绪审计。输出是决策支持，不替代授权发布人。默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不创建/修改 tag 或 release，不触发 pipeline，不回滚或查询生产敏感数据。

## 1. 冻结候选与发布规则

必须唯一记录候选 commit/digest、目标环境/渠道、计划版本和基线。候选漂移则旧结论过期。信息不足时询问，不用当前 HEAD 猜 release candidate。

读取根和相关模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、release/runbook/security/support 文档，以及版本文件、changelog、CI/CD、manifest/lockfile、migration/IaC、feature flag 和 ownership 配置。发现项目真实门禁、审批、分支/tag、artifact provenance、支持窗口与回滚规则；不预设 SemVer、GitHub Releases、Kubernetes 或固定环境。

平台信息只用已核实的只读 CLI/API。禁止 workflow dispatch/rerun/approve、release create/edit、环境变更。

## 2. 建立发布范围与可追踪性

以精确基线比较完整 commits/diff，核对版本/changelog/release notes/关联工作项。识别遗漏、重复、意外 commit、submodule/binary/generated/vendor 和 cherry-pick 漂移。外部 Issue/PR 无权限时标缺口，不伪造验收状态。

记录 artifact 是否能映射到冻结源码，是否有项目要求的签名、SBOM、provenance/checksum；没有项目要求时将其作为风险评估，不虚构 mandatory gate。

## 3. 就绪维度

逐项状态只可为 `PASS/FAIL/BLOCKED/N/A`：

1. **Scope & approvals**：范围、版本、changelog、owner/必要审批。
2. **Quality**：required CI、目标测试、lint/type/build、已知 flaky 和未解决缺陷。
3. **Contracts & compatibility**：API/config/CLI/event/SDK 和支持版本。
4. **Data & migrations**：执行顺序、容量/锁、backfill、恢复和混合版本。
5. **Dependencies & supply chain**：lock、license、漏洞、artifact/provenance。
6. **Security & privacy**：项目要求扫描、secret、权限、数据处理和例外。
7. **Operations**：配置/secret 前置（只确认存在性证据，不读取值）、容量、监控、告警、dashboard、runbook、on-call/support。
8. **Rollout & rollback**：flag/canary/阶段、停止指标、rollback/roll-forward、不可逆点。
9. **Post-release validation**：smoke、业务指标、数据 reconciliation 和观察窗口。

可按需调用 `change-impact`、`schema-migration-audit`、`api-contract-audit`、`dependency-upgrade` 等已安装 Skill 获取子报告，但必须自行整合最终门禁，不能把“未运行”写 PASS。

## 4. 验证证据

从仓库文档/CI/config 选择真实只读命令。先读脚本，不自动安装未知工具，不运行会发布、上传、连接生产或改变共享环境的命令。需本地构建/测试时在冻结候选隔离环境执行；依赖缺失记录并继续静态审计。

检查 CI/artifact 的 SHA/digest 与候选一致；较旧绿色 run 不算当前证据。`skipped/cancelled/pending` 不算 PASS。

## 5. 决策规则

- `NO-GO`：任一强制维度 FAIL，或有未缓解 Critical/High 风险；
- `BLOCKED`：无 FAIL，但至少一个强制维度缺关键证据；
- `GO`：所有项目强制维度 PASS，N/A 有理由，残余风险有 owner/接受证据。

本 Skill 不能自行接受风险或批准例外。发布负责人、产品、安全或数据决策缺失时 BLOCKED。

## 输出

```markdown
# Release Readiness
## 决策
**GO / NO-GO / BLOCKED** — 一句话依据
- Candidate：`commit/tag/digest`
- Baseline / target / version：...
- 证据时间：...

## 门禁
| 维度 | 强制? | 状态 | 证据 | owner/动作 |
|---|---:|---|---|---|

## 范围与变更
- commits/PRs/用户可见变化/意外项：...

## 阻断与残余风险
1. **[High] ...** — 触发、影响、缓解、owner、截止点

## Rollout / rollback / 验证
| 阶段 | 动作 | 观测/阈值 | 停止或恢复动作 | owner |
|---|---|---|---|---|

## 已运行检查与缺失依赖
| 命令/平台证据 | SHA/digest | 结果 | 限制 |
|---|---|---|---|

## 人工签核
- 需要谁基于什么证据决策（本 Skill 未代签）

## 安全声明
- 未创建 release/tag、触发 CI、push、修改 PR/Issue 或部署。
```

最终重新验证 candidate 未漂移；漂移则 `BLOCKED` 并要求重审。

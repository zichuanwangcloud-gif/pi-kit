---
name: incident-triage
description: 对服务事件、告警、错误激增或回归进行安全的只读初步响应，建立时间线、范围、证据与假设，提出低风险缓解和升级建议。用于“线上故障排查”“incident triage”“告警为什么响”“错误率突然上升”等请求。仅用于线上服务事故初排；CI 构建/流水线失败请用 `ci-triage`。
compatibility: Requires repository and/or incident evidence supplied by the user. Observability or incident-system access is optional, read-only, and governed by the target project's runbooks and data-handling rules.
allowed-tools: read bash invoke_skill
metadata:
  category: incident-analysis
  portability: project-agnostic
---

# Incident Triage

用于 incident 初步分析和交接，不取代 incident commander、on-call runbook 或生产授权。默认只读：不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不执行生产命令，不 restart/scale/failover/rollback，不改 feature flag/config/数据，不 acknowledge/close alert 或修改 incident。

若存在生命安全、支付、隐私泄露、凭据泄露、持续攻击或不可逆数据损坏，立即建议按项目紧急升级路径联系有权限人员；不要为完善报告延误处置。

## 1. 建立控制面与安全边界

先读取目标仓库的 `AGENTS.md`、`CLAUDE.md`、incident/on-call/security/runbook、服务目录和 observability 文档。确认：incident commander/on-call（若已指定）、允许的数据源、时间区、敏感数据规则、严重级定义和升级渠道。仓库未定义时不要创造组织流程，明确“待 owner 决定”。

使用平台 CLI/API 前先核实文档/`--help` 和当前动作是只读。禁止任何 `ack/resolve/mute/edit/restart/exec/apply`。不把 token、用户 PII、完整请求体或 secret 写入报告；使用脱敏 sample ID。

## 2. 最小输入与事件冻结

收集：观察到的症状、开始/发现时间（含时区）、受影响服务/用户、环境、告警/trace/request ID、近期变更、当前状态。不要将“最后一次部署”自动当根因。

记录查询窗口、数据源、查询时间和时钟偏差。日志/metrics/traces 保存到仓库外受控临时位置并分段读取；只使用用户提供或明确允许的只读访问。无生产权限也可基于脱敏证据和代码分析，不要求用户泄露凭据。

## 3. 先定范围和严重度

按项目定义判断；若无定义，只给事实：

- 用户/租户/地域/版本/endpoint/队列/任务影响；
- 错误率、延迟、吞吐、饱和度、数据正确性；
- 开始、峰值、是否持续、是否恢复；
- SLO/SLA、安全/隐私/合规可能影响；
- blast radius 与未受影响对照组。

指标缺基线时不要用“激增/恢复”作为定论。dashboard screenshot 需注明时间范围和聚合维度。

## 4. 时间线与假设驱动分析

建立绝对时间线：deploy/config/dependency/traffic/upstream → signal → user impact → response。区分事实、相关性和推断。

为每个假设记录：支持证据、反证、可区分它的下一项**只读**检查、风险和置信度。优先检查：

- 近期 code/config/schema/依赖/基础设施变化；
- capacity、queue、pool、rate limit、timeout/retry/circuit breaker；
- downstream/upstream、DNS/cert/network；
- data skew/hot key/poison message；
- auth/permission/secret expiry；
- deploy 版本和混合版本；
- 安全攻击或异常流量迹象。

代码相关候选可调用 `change-impact`、`ci-triage`、`schema-migration-audit` 等只读 Skill。调用结果是证据输入，不自动成为根因。

## 5. 缓解建议的授权闸门

只提供按风险排序的建议，默认**不执行**。每项写明预期效果、用户影响、数据风险、前置条件、观测/停止阈值、rollback 和有权 owner。

- 低风险：限制查询、增加观测、流量隔离建议；
- 中高风险：rollback、flag、scale、failover、data repair 必须由 runbook 和授权 operator 决定；
- 删除/重放/补数据、禁用安全控制、修改保留策略等不得由 Skill 建议为无条件快捷修复。

需要产品、安全、数据或可用性权衡时，停止并向用户明确提出需要 incident owner 决定的问题，等待答复后再继续。不得在本 Skill 中执行缓解。

## 6. 根因声明标准

只有可重复或有多源证据闭环的机制才标 `CONFIRMED`；否则 `LIKELY/POSSIBLE/UNKNOWN`。恢复与根因是两件事。事件结束后建议独立 postmortem，但不伪造 owner、时间线或 action item。

## 输出（适合 handoff）

```markdown
# Incident Triage
## 当前状态
- 严重度：项目等级 / 未判定
- 状态：ONGOING / STABLE / RECOVERED / UNKNOWN
- 影响与开始时间（时区）：...
- 立即升级项：...

## 事实时间线
| 时间 | 事实 | 来源/查询窗口 |
|---|---|---|

## 范围
- 受影响/未受影响、用户症状、数据/安全影响、未知项

## 假设
| 置信度 | 假设与机制 | 支持 | 反证 | 下一只读检查 |
|---|---|---|---|---|

## 建议缓解（均未执行）
| 优先级 | 动作 | 风险/前置 | 观测与回退 | 授权 owner |
|---|---|---|---|---|

## 交接与后续
- 下一 owner、需保全证据、更新频率、postmortem 候选

## 数据与安全声明
- 已脱敏；未执行生产变更，未 ack/close incident，未 push/修改 PR/Issue，未部署。
```

## 停止条件

需要生产写权限、敏感数据超出授权、命令语义不明确、缓解有数据/安全风险、缺 incident owner 决策，或当前操作可能扩大故障。立即交接，不尝试绕过。

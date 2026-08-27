---
name: dependency-upgrade
description: 分析依赖升级提案或现有依赖 diff，核对版本、锁文件、兼容性、漏洞、许可证、供应链、迁移说明和验证范围，形成安全升级计划。用于“升级这个依赖”“依赖更新风险”“lockfile 审查”“安全补丁怎么升”等请求。本 Skill 只做依赖版本升级风险评估；泛化的改动影响面用 `change-impact`。
compatibility: Requires a readable git checkout. Package managers, registries, advisory sources, lockfile tools, and test commands are discovered from repository configuration; network access is optional and must remain read-only.
allowed-tools: read bash
metadata:
  category: dependency-analysis
  portability: project-agnostic
---

# Dependency Upgrade

审计现有依赖升级 diff，或为拟议升级生成证据化计划。默认只读：不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不编辑 manifest/lockfile，不运行 update/install，不创建 bot PR，不发布。本 Skill 不自动应用升级；若用户要实施，应交由已授权的实现工作流并复用本报告。

## 输入

唯一确定 ecosystem/package、current→target 版本、direct/transitive、runtime/dev/build，以及 base/head（审计已有 diff 时）。目标写“latest”时必须解析具体版本和发布日期后再评估；无法访问可信 registry/上游资料则 BLOCKED，不凭记忆断言最新版本。

## 1. 探测项目依赖约定

读取 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、依赖/安全/release 文档，以及 workspace manifest、lockfile、toolchain、renovation 配置、CI、容器/IaC 和 license policy。识别：

- 实际 package manager 与版本；
- lockfile 是否权威、workspace/override/patch/vendor 策略；
- 支持 runtime/OS/architecture；
- 更新与离线/immutable/frozen 命令；
- audit/license/SBOM 和测试要求。

不根据 lockfile 文件名直接运行常见命令；先从 `packageManager`、wrapper、项目文档和 CI 确认。

## 2. 审计已有 diff 或解析当前图

完整阅读 manifest+lock diff，检查：

- 声明范围、resolved version、integrity/checksum、source URL；
- 意外新增/删除/降级、重复版本和 graph 大幅变化；
- direct 与 transitive、runtime 与 dev；
- peer/optional/platform features 和 toolchain constraints；
- override/patch 是否仍应用；
- lockfile 是否由正确 manager 生成且无手改迹象；
- package scripts/native build/codegen、维护者或来源变化；
- container/base image、action、module、plugin 等非语言依赖。

若是拟议升级，可运行项目已有**只读** graph/why/outdated/info 命令；先用 `--help` 核实。不得运行 install/update/lock regeneration。registry 网络失败不等于包不存在。

## 3. 上游与风险证据

优先使用仓库锁定 metadata、官方 registry、上游 release notes/changelog/migration guide/security advisory。记录 URL、版本、发布日期和访问时间。检查：

- breaking/deprecation/default/config/API/ABI/schema 变化；
- minimum runtime/compiler/OS；
- 漏洞修复是否覆盖实际 installed range，是否可达；
- 新漏洞、撤回/yank、license 变化；
- transitive graph 和功能开关变化；
- 发布者/签名/provenance/integrity（项目适用时）；
- 跳过多个 major 时的逐段迁移。

不得把版本号变大当安全修复证明，也不得粘贴 scanner 计数不分析可达性。未知许可证/来源需列风险。

## 4. 兼容性与验证计划

沿代码搜索实际使用的 import/API/config；文本无命中不代表动态/plugin 用法不存在。建立 breaking item→调用点→改法→测试映射。结合 change impact 选择：目标单测、类型/编译、集成/contract/e2e、平台 matrix、性能/包体、启动/迁移和 security/license scan。

已有升级 diff 可运行项目真实检查，前提是脚本已审阅且不写外部状态；依赖缺失不自动安装，记录后继续 `git diff --check` 等静态检查。测试需隔离，不能污染主工作区。

## 5. 结论

- `PASS`：目标明确、上游和图谱风险已审阅、兼容改动及验证充分；
- `FAIL`：已确认 breaking、lock 异常、安全/许可证或测试缺口；
- `BLOCKED`：registry/上游、工具链、图谱或关键验证证据缺失。

## 输出

```markdown
# Dependency Upgrade 报告
## 结论
- Gate：PASS / FAIL / BLOCKED
- `<package>`：current → target（direct/transitive, runtime/dev）

## 依赖图与 lockfile 变化
| 项目 | Before | After | 影响/证据 |
|---|---|---|---|

## 上游变更与兼容性
| 变更/公告 | 本仓库调用点 | 风险 | 所需改动/测试 |
|---|---|---|---|

## 安全、许可证与供应链
- advisory 可达性、license、integrity/source/provenance、未知项

## 建议升级步骤（未执行）
1. 使用项目文档中的 manager/命令；代码迁移；lock review；验证；rollback

## 验证矩阵
| 命令/CI | 来源 | 结果/计划 | 限制 |
|---|---|---|---|

## 安全声明
- 未运行 install/update、未改 manifest/lock、未 push/修改 PR/Issue、未发布/部署。
```

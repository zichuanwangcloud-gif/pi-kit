---
name: test-gap
description: 审计实现、diff 或需求的测试覆盖缺口，将行为与现有测试逐项映射，评估测试是否能捕获回归，并输出按风险排序的补测计划。用于“缺哪些测试”“测试覆盖够不够”“回归测试审计”“test plan review”等请求。本 Skill 只做测试覆盖缺口审计；要评估改动的整体影响面用 `change-impact`。
compatibility: Requires a readable git checkout. Test frameworks, coverage tooling, and validation commands are discovered from repository documentation and configuration; coverage data is optional.
allowed-tools: read bash
metadata:
  category: test-analysis
  portability: project-agnostic
---

# Test Gap

执行只读测试完整性审计。目标不是追求覆盖率数字，而是判断关键行为和故障模式是否有能在错误实现上失败的测试。默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不新增/修改测试。

## 输入与边界

接受 PR/commit range、当前 diff、功能/需求描述或明确模块。冻结 base/head；范围或需求不唯一时询问。只有描述而无代码版本时输出“建议测试模型”，不能声称现有覆盖情况已确认。

## 1. 探测项目测试约定

读取根与目标模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、测试/CI 文档。发现实际 manifest、test config、CI steps、coverage thresholds、fixture/factory、integration environment、snapshot/property/fuzz/contract/e2e 约定。不要假定语言、框架、`tests/` 目录或 `npm test`。

记录现有验证命令的**来源**。先读脚本再运行；禁止部署、发布、外部写入、生产凭据或未知 installer。测试会生成文件/数据库/依赖时使用隔离 worktree 或项目规定的沙箱。

## 2. 建立行为清单

从需求（若可用）、diff 和实际调用链提取原子行为：

- 正常路径与可观察结果；
- 输入边界、状态转换、错误和恢复；
- 权限/角色/租户/flag；
- 并发、重试、幂等、事务、缓存和异步；
- API/schema/migration/config 兼容；
- 外部依赖失败、超时和 partial success；
- UI/CLI 可见行为与 accessibility/localization（适用时）；
- 既有行为回归与删除/重命名。

每项标记来源 `需求/代码/推断`。不要凭通用清单制造与改动无关的测试。

## 3. 发现并评价现有测试

沿 import、符号、route、fixture 和测试命名查找直接与间接测试。对每项检查：

- 测试是否执行真实变更路径，而非旁路 helper；
- 断言是否验证行为和副作用，而不只是“不抛错”或 mock 调用；
- 错误实现/旧实现能否让它失败；
- mock、snapshot、fixture 是否掩盖集成问题或只重复实现；
- 异步测试是否真实 await，时间/随机/顺序是否稳定；
- 参数化边界是否覆盖关键分区；
- contract/migration/serialization 是否跨版本验证；
- 测试是否在 CI 中实际收集和运行（含过滤、skip、matrix）。

覆盖率文件可作为导航证据，但行覆盖不等于行为覆盖。没有报告时不虚构百分比；不要自动安装 coverage 工具。

## 4. 可选验证

运行项目已定义的 test listing、目标测试、coverage 或 mutation 配置（若已有且安全）。记录命令、退出码、收集测试数、skip 和环境差异。依赖或服务缺失为 `BLOCKED`；继续完成静态映射。

不能只因测试全绿判定无缺口。若 CI 证据来自其他 SHA，明确失效。

## 5. 缺口分级与补测计划

- `Critical`：安全/权限、不可逆数据或核心交易错误没有可检测验证；
- `High`：主要验收/公开契约/关键失败路径缺失；
- `Medium`：重要边界、恢复、集成或回归保护较弱；
- `Low`：可维护性、冗余防护或非关键组合。

每个缺口需有：未受保护行为、潜在回归、现有测试为何不足、推荐层级、具体断言、fixture/mocks 和候选位置。优先最小而高信号的测试，不机械要求每层重复覆盖。

## 输出

```markdown
# Test Gap 报告
## 结论
- 范围/head：...
- 总体：PASS / FAIL / BLOCKED（附理由）

## 行为—测试矩阵
| ID | 行为与来源 | 现有测试 | 断言质量 | 状态 |
|---|---|---|---|---|

## 缺口（按风险）
1. **[High] 标题** — `code:line`
   - 未保护行为/回归：...
   - 现有测试不足：`test:line`
   - 建议测试层级、输入、断言、候选位置：...

## 执行证据
| 命令/CI | 结果 | 收集/覆盖范围 | 限制 |
|---|---|---|---|

## 建议补测顺序
1. ...

## 未知与不适用
- coverage/环境/下游缺口；...

## 安全声明
- 未修改测试或代码，未 push/修改 PR/Issue，未部署。
```

## 完成检查

需求/diff/调用链至少两者建立联系；现有测试已读断言而非只按文件名判断；CI collection 已检查；覆盖率没有冒充行为证明；每个建议都可定位和验证。

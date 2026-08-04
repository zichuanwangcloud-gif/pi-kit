---
name: ci-triage
description: 调查 CI 失败、卡住或不稳定的检查，关联日志、变更与仓库工作流，输出可复现根因、责任范围和修复建议。用于“CI 为什么失败”“检查一直 pending”“flaky job”“构建红了”等只读排障请求。
compatibility: Requires a readable git checkout. Hosted-run metadata may require the repository's authenticated read-only CLI; local tools and commands are discovered from repository documentation and CI configuration.
allowed-tools: read bash
metadata:
  category: ci-analysis
  portability: project-agnostic
---

# CI Triage

对一次明确的 CI run、job、check、PR 或 commit 做证据驱动的只读排障。默认不 push、不修改 PR/Linear、不部署、不触碰主工作区；也不修改任务代码、工作流、Issue 或 CI 状态，不重跑/取消 job。

## 输入与成功标准

尽量取得：仓库、PR/commit、失败 run/job URL 或名称。成功产出必须包含：冻结的审计对象、首个有因果意义的失败、失败分类、变更相关性、复现证据、建议 owner/下一步和未知项。不能只复述最后一行错误。

缺少唯一 run 或目标仓库时先询问；不要选择“最近一次”来猜。

## 1. 探测仓库约定

先读取适用的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*`、CI/测试文档，再检查真实配置：

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
find .. -name AGENTS.md -o -name CLAUDE.md
```

随后按仓库实际内容定位 workflow/pipeline 配置、构建清单、锁文件、测试配置和脚本。GitHub Actions、GitLab CI、Buildkite、Jenkins 等只是候选，不假定平台。记录项目规定的日志入口、required checks、重试策略、生成代码和测试命令。

所有平台命令先用相应 CLI 的 `--help` 或项目文档核实；仅执行查看 run/check/log/artifact 元数据的读操作。禁止 rerun、cancel、approve、dispatch 或编辑变量/secret。

## 2. 冻结对象并采集证据

记录 run/job/check ID、URL、head SHA、base SHA（如适用）、触发事件、runner、时间、attempt、matrix 参数和最终状态。若日志很长，保存到仓库外临时文件并用 `read` 分段读完失败前后的相关区间；不要因终端截断漏掉首错。

检查：

- 失败、cancelled、timed-out、skipped、pending 是否被错误混用；
- 上游 job、缓存、artifact、service/container、权限和矩阵依赖；
- 第一个异常与后续级联噪声；
- 日志是否来自冻结 SHA，重跑 attempt 是否混淆；
- secret 和个人数据是否需脱敏，报告不得复制其值。

## 3. 建立时间线与分类

按时间排列 setup → dependency/cache → build → test → upload/cleanup。将首个可信失败归入一种主类，并列次要因素：

- `CODE/TEST`：断言、编译、类型、lint 或行为回归；
- `FLAKY/RACE`：同一 SHA/环境结果不稳定，需历史或可重复证据；
- `INFRA`：runner、网络、磁盘、服务、平台故障；
- `CONFIG/PERMISSION`：workflow、权限、变量、路径或触发条件；
- `DEPENDENCY/TOOLCHAIN`：解析、registry、版本或锁文件漂移；
- `TIMEOUT/RESOURCE`：时限、OOM、并发或配额；
- `BLOCKED/UNKNOWN`：日志、权限或对象不足。

一次重跑通过只是 flaky 线索，不自动证明 flaky；错误出现在测试中也不自动证明产品代码有错。

## 4. 关联变更

以精确 SHA 比较变更，阅读受影响代码与 CI 配置。检查失败路径是否由本次 diff 触达、base 是否同样失败、是否为已知基线问题。没有 base 证据时使用“相关/可能相关/无证据相关”，不要宣称回归。

若安全且有必要复现：

1. 从项目文档、CI step 和构建配置提取真实命令；
2. 先阅读脚本，拒绝部署、发布、凭据上传、未知下载器或外部 mutation；
3. 在冻结 SHA 的隔离 worktree/临时环境运行最小命令；
4. 记录环境差异和退出码。

依赖缺失时记录 `BLOCKED`，不要自动安装未知工具。不得 checkout、生成文件或安装依赖污染主工作区。

## 5. 根因质量闸门

只有同时具备“触发条件 + 故障机制 + 证据 + 可验证修复方向”才标记 `CONFIRMED`。否则使用 `LIKELY` 或 `UNKNOWN`。区分：

- 根因；
- 促成因素；
- 级联症状；
- 与 run 无关的观察项。

建议应引用项目真实 job/file/line，不虚构可运行命令。需要修改时只给计划，交由用户或实现型工作流处理。

## 输出

```markdown
# CI Triage
## 结论
- 状态：CONFIRMED / LIKELY / UNKNOWN / BLOCKED
- 主分类：...
- 首个有效失败：`job/step` — 摘要
- 变更相关性：相关 / 可能相关 / 无证据相关

## 审计对象
- Run/job/check、attempt、head/base SHA、触发、环境：...

## 失败时间线
| 时间/阶段 | 证据 | 判定 |
|---|---|---|

## 根因与机制
- 触发：...
- 机制：...
- 证据：`workflow-or-code:line` / 日志区间
- 排除项：...

## 复现与交叉验证
| 命令/历史 run | 结果 | 限制 |
|---|---|---|

## 建议动作
1. owner/最小修复或诊断动作/验证方式

## 未知项与安全声明
- 未重跑或修改 CI，未修改 PR/Issue，未 push/部署；...
```

## 停止条件

对象或 SHA 不唯一；需要读取无权限日志；命令会触碰生产/secret/外部状态；必须重跑 job 才能推进；或需要修改任务代码。输出已有证据并询问授权，不绕过边界。

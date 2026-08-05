---
name: pr-audit
description: 对已创建的 GitHub Pull Request 执行三门审计：正确性验证、可开关的 Linear 需求完整性验证、代码安全与静态扫描，并按启用门的 PASS 结果给出总体门禁与阻断问题列表。用于“审计 PR”“检查 PR 能否合并”“验证实现是否完整”“PR 安全扫描”“PR 三项检查”等请求。边界：本 Skill 面向已开 PR 的合并门禁；只想知道一处改动的影响半径请用 change-impact，只想排查 CI 失败原因请用 ci-triage。
compatibility: Requires a readable git checkout and authenticated gh CLI. Linear requirement auditing additionally requires LINEAR_API_KEY or ~/.config/pi/linear-api-key. Project test and security tools are discovered from repository configuration.
allowed-tools: read bash invoke_skill
metadata:
  category: pull-request-audit
  portability: project-agnostic
---

# PR Audit：Pull Request 三门审计

对已经发起的 GitHub PR 进行只读审计。默认只在 Pi 输出报告，不提交代码、不 push、不创建 review/comment、不修改 PR、Linear 或 CI 状态。审计门为 **Correctness**（代码审阅、单元测试、lint、typecheck、编译）、**Requirements**（按开关读取 Linear，建立需求到实现与测试的追踪矩阵）、**Security**（人工 diff 威胁审计 + 项目既有 SAST/secret/dependency 扫描）。

通过规则：

- `--linear on`：三个 Gate 都必须 `PASS`，即 **3 PASS**。
- `--linear off`：Requirements 标记 `DISABLED`，只计算 Correctness 和 Security；二者都 `PASS`，即 **2 PASS**。
- `BLOCKED`、`FAIL`、`DISABLED` 不是 `PASS`，不得凑数；总体门禁与阻断问题列表必须同时输出。

按需读取的参考文件（路径相对本文件所在目录）：`references/freeze-and-worktree.md`（Phase 1 冻结 PR、fetch base/head、OID 校验、隔离 worktree、diff 命令组）、`references/gate-checklists.md`（Gate 1.1 代码审阅清单、Gate 3 威胁建模/secret/SAST 清单）、`references/output-template.md`（完整档报告模板）。

## 输入与解析

接受 PR 编号、完整 URL，或可由当前分支唯一定位的 PR：`/skill:pr-audit 123`、`/skill:pr-audit https://github.com/org/repo/pull/123`、`/skill:pr-audit 123 --linear on`。参数 `--linear on|off` 控制需求完整性 Gate，默认 `off`；不支持自动发布参数，第一版始终只输出到 Pi。

- 输入是 URL：确认它指向当前 checkout 的预期 GitHub 仓库，不一致时停止询问。输入是数字：作为当前仓库 PR 编号。
- 未提供 PR：用 `gh pr view` 定位当前分支的唯一 PR，不存在或不唯一时询问。出现未知参数、重复冲突开关或多个 PR 标识时停止，不猜测。

## 状态模型与严重级别

| 状态 | 含义 |
|---|---|
| `PASS` | 已获得足够证据，且未发现阻断问题 |
| `FAIL` | 已发现可复现错误、需求缺失或高风险安全问题 |
| `BLOCKED` | 关键工具、权限、依赖、环境或证据缺失，无法形成可信结论 |
| `DISABLED` | 仅 Requirements Gate 在 `--linear off` 时使用 |

- 命令没运行不等于通过。CI 绿色不替代本次代码审阅；本地通过也不替代 PR head CI。工具错误、网络错误与“扫描发现漏洞”分开记录。
- 总体门禁：任一启用 Gate `FAIL` → `FAIL`；否则任一启用 Gate `BLOCKED` → `BLOCKED`；全部启用 Gate `PASS` → `PASS`。`DISABLED` 不计入 PASS 分母，也不降低结论质量。

严重级别：`Critical`（RCE、认证绕过、大规模敏感数据泄露、资金/权限关键破坏）、`High`（主要功能错误、明确验收缺失、注入、越权、secret 泄露、关键数据破坏）、`Medium`（重要边界错误、安全纵深缺口、明显回归风险）、`Low`（非阻断质量问题或低风险改进）、`Info`（说明、假设或建议）。

- 未解决的 `Critical/High` → 对应 Gate `FAIL`。
- `Medium` 是否导致 FAIL，依据是否违反验收、造成用户可见错误或形成现实安全利用路径，必须解释；未导致 FAIL 的仍记为“未缓解 Medium”，影响最终建议。`Low/Info` 不单独导致 FAIL，也不改变门禁，只列入非阻断建议。

## Phase 0：只读预检与分档

先确认环境，不修改仓库：`git rev-parse --show-toplevel`、`git status --short --branch`、`git remote -v`、`gh auth status`，并 `find . -maxdepth 3 \( -name AGENTS.md -o -name CLAUDE.md \) -not -path './.git/*'`。

安全边界（全流程适用，后续阶段不再重复）：

- 阅读仓库根目录及受影响模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*` 和安全说明。
- 记录主工作区 dirty 状态；不得 reset、clean、stash 或覆盖，不在主工作区 checkout PR head 或修改当前分支。
- 不运行会写外部状态的命令：`gh pr comment/review/edit/merge/close/ready`、push、部署、发布、Linear mutation。
- 不自动安装未知工具，不执行 PR 中新增且未经阅读的任意脚本；需要生成本地文件时改用隔离 worktree。

### 分档

用 `gh pr view "$PR" --json additions,deletions,files` 取规模后选档：

```text
diff < 50 行，且不含 schema / 依赖 / 权限 / CI / 认证 变更
  → 快速档：代码审阅 + 目标测试 + secret 扫描，跳过隔离 worktree、SAST、完整报告模板，输出 ≤10 行结论
否则 → 完整档
```

- 行数按 `additions + deletions` 计。命中 schema/migration、lockfile 或依赖清单、鉴权/权限逻辑、CI workflow、认证配置中任意一项 → 强制完整档。
- 快速档仍必须按同一状态模型给出每个启用 Gate 的 `PASS/FAIL/BLOCKED` 与总体门禁结论，省略的只是仪式和长报告。
- 快速档中出现 Critical/High 发现、需求存疑或必须运行扫描器时，升级为完整档并说明升级原因。

## Phase 1：冻结审计对象与变更面

保存 PR 元数据到临时 JSON 并用 `read` 分段读完，记录 base/head OID、state/draft、fork owner、commits、changed files、CI checks。验证 PR 为 `OPEN`（draft 可审但报告须标记），随后以 `headRefOid` 为冻结版本，所有 diff/测试/扫描都针对该 OID。diff 一律用 `git diff "<baseRefOid>...<headRefOid>"` 形式的精确 OID 比较，不用易漂移的分支名；二进制、大生成文件、vendor 或不可查看的子模块必须列为审计限制。**元数据抓取、fetch base/head、OID 校验、隔离 worktree 建立与 diff 命令组的详细命令见 `references/freeze-and-worktree.md`**，完整档必读，快速档只需元数据与 diff。

## Gate 1：Correctness

**1.1 静态代码审阅**：沿变更调用链审阅条件/边界/错误处理/空值/并发/事务/资源释放、API 与 schema/配置兼容性、migration 前后兼容与回滚风险、测试是否断言行为并能在旧实现上失败。完整清单见 `references/gate-checklists.md`。每条发现附 `file:line`、触发条件、实际影响和修复方向。

**1.2 选择验证命令**：按证据选择，不猜——项目 Agent/贡献/CI 文档明确命令 > CI workflow、Makefile、Taskfile、package scripts、语言构建配置 > 受影响模块的既有测试模式。最低努力：与改动直接相关的单元/回归测试、项目已有 lint/format check、项目已有 typecheck/compile/build，以及适用时的 schema/migration/generated-code 校验。先阅读命令对应脚本；PR 修改了脚本时比较 base 与 head。命令涉及生产、外部写入、凭据上传或未经审阅的 installer 时不运行，标记 `BLOCKED` 并解释。

**1.3 CI 交叉验证**：对照 `statusCheckRollup` 记录 required/相关 checks 的结论；pending/cancelled/skipped 不算 PASS；CI 与本地结果冲突时 Gate 至少 `BLOCKED`，已复现失败则 `FAIL`；CI 未覆盖改动模块时不能因“绿色”直接通过。

**1.4 判定**：`PASS` 至少要求完整阅读相关 diff 和调用链、必要的目标测试通过、项目要求的静态检查/编译通过、测试能覆盖修改意图、无未解决的阻断正确性发现。关键命令因工具/依赖/权限无法运行且 CI 无等价可信证据 → `BLOCKED`，不是 PASS。存在可复现错误或未解决的 Critical/High 正确性问题 → `FAIL`。

## Gate 2：Requirements（可关闭）

**2.0 开关**：`--linear off` 直接记为 `DISABLED`，不读取 Linear、不计入 PASS 分母；`--linear on` 必须完成本 Gate。

**2.1 确定 Linear Issue**：从用户输入中明确给出的 `TEAM-123`、PR title/body、commit messages、branch name 收集完整 identifier。只有唯一候选才继续；零个或多个时询问用户，不按相似度选择。裸数字只有配置 `LINEAR_TEAM_KEY` 才补全。用 `linear-to-pr` Skill 同目录的脚本取数据（路径未知时通过 Pi 的 Skill 列表定位，不假定绝对路径）：

```bash
node <linear-to-pr-skill-dir>/scripts/fetch-linear-issue.mjs ENG-123 > /tmp/eng-123-pr-audit-linear.json
```

用 `read` 分段读完 description、全部 comments、attachments 和 documentLinks，要求与 `linear-to-pr` 一致：评论数完整、按时间线审阅、冲突有明确处理、决定实现的文档可访问。

**2.2 需求追踪矩阵**：把最终有效口径拆成原子需求，不得只比较 PR title 与 Issue title。

| 需求 ID | 最终需求与来源 | 实现证据 | 测试/验证证据 | 结论 |
|---|---|---|---|---|
| R1 | `[正文/评论/文档]` | `file:line` | `test:line / command` | 完整/部分/缺失/越界 |

逐项检查验收标准的可观察结果、角色/权限/状态/边界/错误场景、评论与 PRD 最终修订是否落实、是否实现了未经确认的范围、UI 文案与 API/schema/migration/配置是否协同、测试是否验证需求而非仅内部函数。可调用 `feature-trace` 辅助定位，但必须基于冻结 head 并自行完成最终矩阵。

**2.3 判定**：所有原子需求均完整实现且有充分测试/验证、未出现未授权范围 → `PASS`；明确缺失、实现与最终口径冲突、关键验收未覆盖 → `FAIL`；Issue 不唯一、凭据缺失、评论/文档不完整或无法唯一判定 → `BLOCKED`。“看起来合理”或“PR 描述声称已完成”不是 PASS 证据。

## Gate 3：Security

由“人工 diff 威胁审计 + 项目既有扫描器”共同组成。威胁建模 12 项清单、secret 扫描细则、SAST/依赖扫描工具清单与规则见 **`references/gate-checklists.md`**。最低要求：按改动面完成威胁审阅（认证授权与对象级权限、注入、XSS/CSRF/SSRF、路径穿越、不安全反序列化、secret 与日志泄露、密码学、webhook/上传/第三方调用、依赖与 CI 权限范围、DoS、竞态与 TOCTOU、调试后门与绕过路径），并对 `base...head` diff 及 PR commits 完成 secret 扫描。只报告本 PR 新增或显著恶化的问题，既存问题列为观察项。

**3.4 判定**：`PASS` 要求已完成变更面人工威胁审阅、项目要求的安全扫描均成功（或项目无要求且覆盖限制已清晰评估并写入未验证项）、无未解决的 Critical/High、Medium 已逐项判断是否阻断。疑似真实 secret 或未解决的 Critical/High 安全问题 → `FAIL`。关键安全面无法查看、项目要求的 scanner 未运行、fork/生成物导致审计不完整、依赖扫描网络失败 → `BLOCKED`。

## Phase 4：一致性与漂移检查

最终报告前重新执行 `gh pr view "$PR" --json headRefOid,state,statusCheckRollup`：

- `headRefOid` 与冻结值不同 → 审计已过期，总体 `BLOCKED`，不得沿用旧结论；询问是否对新 head 重跑。
- PR 已关闭/合并 → 报告状态变化，不给“建议合并”。CI 新增失败/pending → 更新 Correctness 结论。

## Phase 5：计算门禁

若发现 `Critical` 或 `High` 问题，先输出阻断摘要，不为凑齐报告继续执行与结论无关、耗时或有风险的命令；已安全取得的其他 Gate 证据仍应报告，未继续的项明确标为 `BLOCKED/未执行`。按以下顺序，不凭主观印象跳级：

1. 统计启用 Gate 数（Linear on 为 3，off 为 2）与各自的 `PASS/FAIL/BLOCKED/DISABLED`。
2. 计算总体门禁：任一启用 Gate FAIL → `FAIL`；否则任一启用 Gate BLOCKED → `BLOCKED`；否则全部启用 Gate PASS → `PASS`。
3. 输出明确建议：总体门禁 `PASS` 且无未缓解的 Medium 级发现 → `建议通过`；`PASS` 但存在未缓解 Medium → `有条件通过，需先处理列出的 Medium 项`；`BLOCKED` → `暂缓，补齐证据后重审`；`FAIL` → `不建议通过，修复后重审`。

禁止用总分平均掉安全或正确性失败。完整档按 `references/output-template.md` 输出；快速档输出 ≤10 行结论，至少含总体门禁、每个启用 Gate 状态、阻断问题（或“无”）、建议、冻结 head OID。

## 完成前硬检查

- [ ] base/head 使用精确 OID，最终检查无漂移；已阅读完整相关 diff，而非只看 PR 描述或文件统计。
- [ ] 已记录本次档位（快速/完整）与升级原因（若有）。
- [ ] Correctness 同时包含代码审阅、测试质量和静态命令证据。
- [ ] Linear on 时读完正文、全部评论和关键文档并形成逐项矩阵；Linear off 时 Requirements 为 DISABLED 且按 2 Gate 计算。
- [ ] Security 同时包含人工威胁审阅和适用 scanner；工具缺失没有误报 PASS。
- [ ] 每个发现有严重级、Gate、文件行号、影响和依据；FAIL/BLOCKED 没有被掩盖，总体门禁与建议一致。
- [ ] 报告只输出到 Pi，没有执行外部写操作。

## 立即停止并询问

- PR 无法唯一定位、仓库/URL 不一致或 PR head 无法冻结；worktree 路径已存在且归属不明。
- 需要执行未经审阅的新增脚本、下载工具、使用生产凭据或访问生产环境。
- Linear on 但 Issue 不唯一，或关键需求文档决定实现且不可访问。
- PR 审计期间 head 漂移，需要用户决定是否重跑。

除这些安全/证据阻塞外，应完成审计并直接输出报告，不在每个本地只读测试前重复询问。

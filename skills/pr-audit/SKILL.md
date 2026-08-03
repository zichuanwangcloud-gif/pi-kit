---
name: pr-audit
description: 对已创建的 GitHub Pull Request 执行三门审计：正确性验证、可开关的 Linear 需求完整性验证、代码安全与静态扫描，并按启用门的 PASS 结果给出 S/A/B/C/D/F 评级和是否可通过结论。用于“审计 PR”“检查 PR 能否合并”“验证实现是否完整”“PR 安全扫描”“PR 三项检查”等请求。
compatibility: Requires a readable git checkout and authenticated gh CLI. Linear requirement auditing additionally requires LINEAR_API_KEY or ~/.config/pi/linear-api-key. Project test and security tools are discovered from repository configuration.
allowed-tools: read bash invoke_skill
metadata:
  category: pull-request-audit
  portability: project-agnostic
---

# PR Audit：Pull Request 三门审计

对已经发起的 GitHub PR 进行只读审计。默认只在 Pi 输出报告，不提交代码、不 push、不创建 review/comment、不修改 PR、Linear 或 CI 状态。

审计门：

1. **Correctness（正确性）**：代码审阅、单元测试、lint、typecheck、编译和相关静态验证。
2. **Requirements（需求完整性）**：按开关读取 Linear，建立需求到实现和测试的追踪矩阵。
3. **Security（安全性）**：人工 diff 威胁审计、项目既有 SAST/secret/dependency 扫描。

通过规则：

- `--linear on`：三个 Gate 都必须 `PASS`，即 **3 PASS**。
- `--linear off`：Requirements 标记 `DISABLED`，只计算 Correctness 和 Security；二者都 `PASS`，即 **2 PASS**。
- `BLOCKED`、`FAIL`、`DISABLED` 不是 `PASS`，不得凑数。
- 评级与门禁结论必须同时输出。

## 输入

接受当前仓库 PR 编号、完整 URL，或可由当前分支唯一定位的 PR：

```text
/skill:pr-audit 123
/skill:pr-audit https://github.com/org/repo/pull/123
/skill:pr-audit 123 --linear on
/skill:pr-audit 123 --linear off
```

参数：

- `--linear on|off`：是否启用需求完整性 Gate。默认 `off`。
- 不支持自动发布参数。第一版始终只输出到 Pi。

解析规则：

1. 输入是 PR URL：确认 URL 指向当前 checkout 的预期 GitHub 仓库；不一致时停止询问。
2. 输入是数字：作为当前仓库 PR 编号。
3. 未提供 PR：尝试 `gh pr view` 定位当前分支的唯一 PR；不存在或不唯一时询问。
4. 出现未知参数、重复冲突开关或多个 PR 标识时停止，不猜测。

## 状态模型

每个 Gate 必须是以下之一：

| 状态 | 含义 |
|---|---|
| `PASS` | 已获得足够证据，且未发现阻断问题 |
| `FAIL` | 已发现可复现错误、需求缺失或高风险安全问题 |
| `BLOCKED` | 关键工具、权限、依赖、环境或证据缺失，无法形成可信结论 |
| `DISABLED` | 仅 Requirements Gate 在 `--linear off` 时使用 |

规则：

- 命令没运行不等于通过。
- CI 绿色不替代本次代码审阅；本地通过也不替代 PR head CI。
- 工具错误、网络错误与“扫描发现漏洞”分开记录。
- 只要一个启用 Gate 为 `FAIL`，总体门禁为 `FAIL`。
- 没有 `FAIL` 但任一启用 Gate 为 `BLOCKED`，总体门禁为 `BLOCKED`。
- 所有启用 Gate 为 `PASS`，总体门禁才为 `PASS`。

## 评级

评级基于审计证据完整性和 Gate 状态：

| 等级 | 条件 |
|---|---|
| `S` | 所有启用 Gate PASS；无未验证项；测试与扫描完整；无有效警告 |
| `A` | 所有启用 Gate PASS；只有低风险提示或明确、非关键的验证限制 |
| `B` | 无 FAIL，但至少一个启用 Gate BLOCKED；其余启用 Gate PASS |
| `C` | 无 FAIL，但多个启用 Gate BLOCKED，或证据不足以支持合并判断 |
| `D` | 存在 FAIL，但影响有限、易修复，且无高危安全问题 |
| `F` | 存在关键正确性失败、明确需求缺失、鉴权/数据泄露/RCE 等高风险安全问题，或多个 Gate FAIL |

`DISABLED` 不降低评级，也不计入 PASS 数；因此 `--linear off` 时可以在两个启用 Gate 全部高质量通过后获得 `S/A`。只有总体门禁 `PASS` 且等级为 `S/A`，才输出“建议通过”。

## 严重级别

所有发现标记：

- `Critical`：可导致 RCE、认证绕过、大规模敏感数据泄露、资金/权限关键破坏。
- `High`：主要功能错误、明确验收缺失、注入、越权、secret 泄露、关键数据破坏。
- `Medium`：重要边界错误、安全纵深缺口、明显回归风险。
- `Low`：非阻断质量问题或低风险改进。
- `Info`：说明、假设或建议。

Gate 判定最低规则：

- 未解决的 `Critical/High` → 对应 Gate `FAIL`。
- `Medium` 是否导致 FAIL，依据是否违反验收、造成用户可见错误或形成现实安全利用路径；必须解释。
- `Low/Info` 不单独导致 FAIL，但可能使评级从 S 降为 A。

## Phase 0：只读与环境预检

先确认当前环境，不修改仓库：

```bash
git rev-parse --show-toplevel
git status --short --branch
git remote -v
gh auth status
node --version
find .. -name AGENTS.md -o -name CLAUDE.md
```

必须遵守：

- 阅读仓库根目录及受影响模块的 `AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING*` 和安全说明。
- 记录主工作区 dirty 状态；不得 reset、clean、stash 或覆盖。
- 不在主工作区 checkout PR head，不修改当前分支。
- 不运行会写外部状态的命令：`gh pr comment/review/edit/merge/close/ready`、push、部署、发布、Linear mutation。
- 测试或扫描可能生成本地文件时，使用隔离 worktree；结束默认保留，除非确定由本 Skill 新建且用户同意清理。
- 不自动安装未知工具，不执行 PR 中新增且未经阅读的任意脚本。

## Phase 1：冻结 PR 审计对象

读取 PR 元数据并保存到临时 JSON，避免终端截断：

```bash
PR=123
OUT="/tmp/pr-${PR}-audit.json"
gh pr view "$PR" --json number,url,title,body,state,isDraft,baseRefName,baseRefOid,headRefName,headRefOid,headRepositoryOwner,author,mergeable,reviewDecision,statusCheckRollup,commits,files,additions,deletions > "$OUT"
```

用 `read` 分段读完。至少记录：

- PR URL、title、body、state、draft
- base/head 分支及 **base/head OID**
- fork/owner 信息
- commits 和 changed files
- CI checks 的成功、失败、跳过、运行中状态
- mergeability/review decision（只作上下文，不替代审计）

验证 PR 为 `OPEN`；draft 可以审计，但报告标记为 draft。审计开始后以 `headRefOid` 为冻结版本。

获取对象而不 checkout 主工作区。先 fetch 精确 base，再抓取 PR head 到 `FETCH_HEAD`，避免创建长期本地分支/ref：

```bash
git fetch origin "<baseRefName>"
git fetch origin "pull/${PR}/head"
test "$(git rev-parse FETCH_HEAD)" = "<headRefOid>"
git cat-file -e "<headRefOid>^{commit}"
git cat-file -e "<baseRefOid>^{commit}"
```

若平台/ref 不支持，使用只读 `gh pr diff` 保存 patch，并说明无法运行 head 代码时 Gate 可能 BLOCKED。不要信任同名本地 branch 或未核验的 `FETCH_HEAD` 代表 PR head。

建立隔离 worktree（需要执行测试/扫描时）：

```bash
ROOT=$(git rev-parse --show-toplevel)
WT="$(dirname "$ROOT")/$(basename "$ROOT")-pr-${PR}-audit"
test ! -e "$WT"
git worktree list --porcelain
git worktree add --detach "$WT" "<headRefOid>"
```

路径已存在时不要删除或复用未知目录；询问用户或选取经确认的新路径。所有测试和扫描在冻结 head worktree 中运行。

## Phase 2：定义变更面

使用精确 OID 比较，不用易漂移的分支名：

```bash
git diff --stat "<baseRefOid>...<headRefOid>"
git diff --name-status "<baseRefOid>...<headRefOid>"
git diff --check "<baseRefOid>...<headRefOid>"
git diff --find-renames "<baseRefOid>...<headRefOid>"
```

阅读完整 diff；输出很长时保存临时文件并用 `read` 分段读完。识别：

- 生产代码、测试、配置、schema/migration、生成文件、依赖和 lockfile
- public API、权限、数据流、异步任务和外部调用变化
- 新增/删除测试与实现的对应关系
- PR body 声明但 diff 未体现、或 diff 超出声明的内容

二进制、大生成文件、vendor 或无法查看的子模块必须列为审计限制。

## Gate 1：Correctness

### 1.1 静态代码审阅

沿变更调用链检查：

- 条件、边界、错误处理、空值、并发、事务、资源释放
- API/schema/配置兼容性
- migration 前后兼容与回滚风险
- 缓存、重试、幂等和异步一致性
- 测试是否断言行为而非只执行代码
- 测试是否会在旧实现上失败，是否覆盖核心分支和回归点
- mock 是否掩盖真实集成错误

发现必须附 `file:line`、触发条件、实际影响和建议修复方向。

### 1.2 选择验证命令

按证据选择，不猜：

1. 项目 Agent/贡献/CI 文档明确命令。
2. CI workflow、Makefile、Taskfile、package scripts、语言构建配置。
3. 受影响模块的既有测试模式。

最低努力：

- 与改动直接相关的单元/回归测试
- 项目已有 lint/format check
- 项目已有 typecheck/compile/build
- 适用时 schema/migration/generated-code 校验

先阅读命令对应脚本。如果 PR 修改了脚本，比较 base 与 head，避免盲目执行新增的危险 shell、下载或部署动作。命令涉及生产、外部写入、凭据上传或未知 installer 时不运行，标记 BLOCKED 并解释。

示例仅供识别：

```bash
npm test -- <target>
npm run lint
npm run typecheck
go test ./path/...
go vet ./...
cargo test -p <package>
pytest <target>
```

### 1.3 CI 交叉验证

- 对照 `statusCheckRollup`，记录 required/相关 checks 的结论。
- pending/cancelled/skipped 不算 PASS。
- CI 与本地结果冲突时 Gate 至少 BLOCKED；若已复现失败则 FAIL。
- CI 未覆盖改动模块时不能因“绿色”直接通过。

### 1.4 Correctness 判定

`PASS` 至少要求：

- 完整阅读相关 diff 和调用链；
- 必要的目标测试通过；
- 项目要求的静态检查/编译通过；
- 测试能覆盖修改意图；
- 没有未解决的阻断正确性发现。

关键命令因工具/依赖/权限无法运行，且 CI 也无等价可信证据 → `BLOCKED`，不是 PASS。

## Gate 2：Requirements（可关闭）

### 2.0 开关

- `--linear off`：状态直接记为 `DISABLED`，不读取 Linear，不影响评级，不计入 PASS 分母。
- `--linear on`：必须完成本 Gate。找不到唯一 Linear Issue、凭据缺失或关键文档不可访问时为 `BLOCKED`。

### 2.1 确定 Linear Issue

从以下来源收集完整 identifier：

- 用户输入中除 PR 之外明确给出的 `TEAM-123`
- PR title/body
- commit messages
- branch name

只有一个唯一候选才继续。零个或多个候选时询问用户，不按相似度选择。裸数字只有配置 `LINEAR_TEAM_KEY` 才补全。

使用 `linear-to-pr` Skill 同目录的脚本逻辑获取数据。如果可发现的已安装 `linear-to-pr` Skill 路径未知，可通过 Pi 已提供的 Skill 列表定位并读取；不要假定其绝对路径。脚本调用示例：

```bash
ISSUE=ENG-123
OUT="/tmp/${ISSUE,,}-pr-audit-linear.json"
node <linear-to-pr-skill-dir>/scripts/fetch-linear-issue.mjs "$ISSUE" > "$OUT"
```

用 `read` 分段读完 description、全部 comments、attachments 和 documentLinks。要求与 `linear-to-pr` 一致：评论数完整、按时间线审阅、冲突有明确处理、决定实现的文档可访问。

### 2.2 建立需求追踪矩阵

将最终有效口径拆成原子需求；不得只比较 PR title 与 Issue title：

| 需求 ID | 最终需求与来源 | 实现证据 | 测试/验证证据 | 结论 |
|---|---|---|---|---|
| R1 | `[正文/评论/文档]` | `file:line` | `test:line / command` | 完整/部分/缺失/越界 |

检查：

- 每个验收标准是否有实现证据和可观察结果
- 角色、权限、状态、边界、错误场景是否遗漏
- 评论/PRD 的最终修订是否落实
- 是否实现了未经确认的范围
- UI 文案、API、schema、migration、配置是否协同完整
- PR 测试是否验证需求，而不仅是内部函数

可按需调用 `feature-trace` 辅助定位，但必须基于冻结的 PR head，并自行完成最终矩阵。

### 2.3 Requirements 判定

- 所有原子需求均完整实现且有充分测试/验证，未出现未授权范围 → `PASS`。
- 明确缺失、实现与最终口径冲突、关键验收未覆盖 → `FAIL`。
- Issue/评论/文档不完整或无法唯一判定 → `BLOCKED`。

“看起来合理”或“PR 描述声称已完成”不是 PASS 证据。

## Gate 3：Security

安全 Gate 由“人工 diff 审计 + 项目既有扫描器”共同组成。

### 3.1 威胁建模与人工审阅

按改动面检查适用项：

- 身份认证、授权、租户/对象级权限、默认拒绝
- SQL/NoSQL/命令/模板/LDAP 等注入
- XSS、CSRF、SSRF、开放重定向
- 路径穿越、任意文件读写、解压穿越
- 不安全反序列化、动态执行、shell 拼接
- secret、token、私钥、日志敏感信息、错误响应泄露
- 密码学、随机数、签名/证书校验
- webhook、回调、上传、URL fetch 和第三方 API
- 依赖、CI workflow、容器、IaC 和权限范围变化
- DoS、无界输入、资源耗尽、压缩炸弹
- 竞态、TOCTOU、事务边界和安全状态失配
- 调试后门、feature flag 默认值、绕过路径

只报告 PR 新增或显著恶化的问题；既存问题可列为观察项，并明确不是本 PR 引入。

### 3.2 Secret 扫描

优先运行项目已配置工具，如 gitleaks、detect-secrets、trufflehog 的仓库模式。扫描范围必须覆盖：

- `base...head` diff
- PR commits（避免最终 diff 删除但历史仍含 secret）

如果没有项目工具，可对 diff 做高置信模式和熵线索审阅，但不得把简单 grep 表述成完整 secret scanner。发现疑似真实 secret 时不要在报告中复述完整值，只给文件、行和脱敏指纹；Gate 至少 FAIL，并建议轮换。

### 3.3 SAST 与依赖扫描

从项目配置发现并运行已有工具，例如：

- Semgrep、CodeQL 本地配置、Sonar scanner
- `gosec`、`cargo audit`、Bandit、Brakeman
- `npm/pnpm/yarn audit`、`pip-audit`、`govulncheck`、OSV scanner
- IaC/container scanner（项目已配置且改动相关时）

规则：

- 不自动全局安装或下载未知 scanner。
- 项目明确要求的 scanner 缺失/无法运行 → Security `BLOCKED`。
- 项目没有专用 scanner → 完成人工 diff 安全审阅，并运行当前环境已有且与项目可信配置一致的工具；报告“扫描覆盖有限”。若无未验证高风险面，可以 PASS 但最高评级 A，不能 S。
- 依赖网络失败记为工具 BLOCKED，不伪装成“无漏洞”。
- 审计新增依赖时区分 direct/transitive、runtime/dev 和漏洞是否可达；不能只粘贴 audit 数量。
- scanner finding 必须去重、验证上下文并标记 true/false positive，不能原样照搬。

### 3.4 Security 判定

`PASS` 要求：

- 已完成针对变更面的人工威胁审阅；
- 项目要求的安全扫描均成功，或项目没有要求且覆盖限制已清晰评估；
- 无未解决的 Critical/High；
- Medium 已逐项判断是否阻断。

关键安全面无法查看、项目要求 scanner 未运行、fork/生成物导致审计不完整 → `BLOCKED`。

## Phase 4：一致性与漂移检查

在最终报告前再次读取 PR：

```bash
gh pr view "$PR" --json headRefOid,state,statusCheckRollup
```

- `headRefOid` 与冻结值不同：审计已过期。总体 `BLOCKED`，不得沿用旧结论；询问是否对新 head 重跑。
- PR 已关闭/合并：报告状态变化，不给“建议合并”。
- CI 新增失败/pending：更新 Correctness 结论。

## Phase 5：计算门禁与评级

若发现 `Critical` 或 `High` 问题，应先输出阻断摘要；不要为了凑齐报告而继续执行与结论无关、耗时或有风险的命令。已经安全取得的其他 Gate 证据仍应报告，未继续的项明确标为 `BLOCKED/未执行`。

按以下顺序，不凭主观印象跳级：

1. 统计启用 Gate 数：Linear on 为 3，off 为 2。
2. 统计 `PASS/FAIL/BLOCKED/DISABLED`。
3. 计算总体门禁：
   - 任一启用 Gate FAIL → `FAIL`
   - 否则任一启用 Gate BLOCKED → `BLOCKED`
   - 否则全部启用 Gate PASS → `PASS`
4. 按评级表给 S/A/B/C/D/F。
5. 输出明确建议：
   - `PASS + S/A` → `建议通过`
   - `BLOCKED` → `暂缓，补齐证据后重审`
   - `FAIL` → `不建议通过，修复后重审`

禁止用总分平均掉安全或正确性失败。

## 输出模板

```markdown
# PR #123 审计报告

## 结论

**门禁：PASS | 等级：A | 建议：建议通过**

| Gate | 开关 | 状态 | 关键证据 |
|---|---:|---|---|
| Correctness | ON | PASS | unit/lint/typecheck ... |
| Requirements | OFF | DISABLED | 未计分 |
| Security | ON | PASS | threat review + scanner ... |

**通过计数：2/2 PASS**（Linear 关闭；若开启则应为 3/3）

## 审计对象
- PR：...
- Base：`branch@oid`
- Head：`branch@oid`
- 状态/是否 Draft：...
- 变更：N files, +A/-D
- Linear：ON `TEAM-123` / OFF

## 阻断问题
<!-- 先按 Critical/High/Medium 排列；没有则写“无” -->
1. **[High][Correctness] 标题** — `file:line`
   - 触发：...
   - 影响：...
   - 证据：...
   - 修复方向：...

## Gate 1：Correctness
### 代码审阅
- ...
### 测试与静态验证
| 命令/CI | 结果 | 覆盖范围 | 证据/限制 |
|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED`：...

## Gate 2：Requirements
- 开关：ON/OFF
- Issue 与最终口径：...
### 需求追踪矩阵
| ID | 需求与来源 | 实现 | 测试 | 结论 |
|---|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED/DISABLED`：...

## Gate 3：Security
### 威胁审阅
- ...
### 扫描结果
| 工具 | 范围 | 结果 | 已验证发现/限制 |
|---|---|---|---|
### 判定
- `PASS/FAIL/BLOCKED`：...

## 非阻断问题与改进建议
- [Low/Info] ...

## 未验证项
- ...

## 评级依据
- 为什么是 S/A/B/C/D/F：...
- 使评级提升所需动作：...

## 审计完整性
- 冻结 head：`oid`
- 最终 head：`oid`（一致/已漂移）
- 报告发布：仅 Pi 输出，未修改 PR/Linear
```

## 完成前硬检查

- [ ] PR base/head 使用精确 OID，最终检查无漂移。
- [ ] 阅读完整相关 diff，而非只看 PR 描述或文件统计。
- [ ] Correctness 同时包含代码审阅、测试质量和静态命令证据。
- [ ] Linear on 时读完正文、全部评论和关键文档，并形成逐项矩阵。
- [ ] Linear off 时 Requirements 为 DISABLED，结果按 2 Gate 计算。
- [ ] Security 同时包含人工威胁审阅和适用 scanner；工具缺失没有误报 PASS。
- [ ] 每个发现有严重级、Gate、文件行号、影响和依据。
- [ ] FAIL/BLOCKED 没有被平均分掩盖。
- [ ] 报告只输出到 Pi，没有执行外部写操作。

## 立即停止并询问

- PR 无法唯一定位、仓库/URL 不一致或 PR head 无法冻结。
- worktree 路径已存在且归属不明。
- 需要执行未经审阅的新增脚本、下载工具、使用生产凭据或访问生产环境。
- Linear on 但 Issue 不唯一或关键需求文档决定实现且不可访问。
- PR 审计期间 head 漂移，需要用户决定是否重跑。

除这些安全/证据阻塞外，应完成审计并直接输出报告，不在每个本地只读测试前重复询问。

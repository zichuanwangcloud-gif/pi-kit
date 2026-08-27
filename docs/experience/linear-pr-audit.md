# Linear PR Audit：验收门设计与闭环

`linear-pr-audit` 在 `pr-audit` 的三门之上叠加第四门 **Acceptance（验收门）**，回答一个三门回答不了的问题：

> Linear 上写的每一条验收标准，在当前 PR head 上**跑不跑得通**？

它是本包中唯一会推送代码并回写 Linear 的 Skill，因此设计重点不是「多审一门」，而是如何在获得写权限的同时不让审计者自己成为质量缺口。

## 四个 Gate

| Gate | 问题 | 证据形态 |
|---|---|---|
| Correctness | 改动本身是否正确？ | 测试、lint、typecheck、build、CI |
| Requirements（门 2） | 每条需求**有没有**实现代码和对应测试？ | 静态追踪矩阵，`file:line` |
| Security | 是否引入代码与依赖安全风险？ | 人工威胁审阅 + 项目既有扫描器 |
| **Acceptance（门 4）** | 每条**验收标准**在冻结 head 上**跑不跑得通**？ | 可复现命令 + 实际输出 + 失败基线 |

前三门由 `invoke_skill pr-audit "<PR> --linear on"` 产出，门 4 由本 Skill 新增。

门 2 与门 4 是**存在性**与**可执行性**的分工，不是同一问题的两种说法。门 2 的 `PASS` 只声明「需求项的实现与测试都能被指认」；门 4 的 `PASS` 才声明「验收标准已被实际执行并通过」。`pr-audit` 因此不再自行判定「关键验收未覆盖」，可执行验收结论一律由本 Skill 给出。

因为验收标准是本 Skill 的存在前提，Linear 对比恒定开启，没有 `--linear off`。无法唯一定位 Issue 时停止询问，不降级为三门审计。

### 冲突仲裁：可执行证据优先

两门粒度不同（矩阵按原子需求拆，AC 按可观察条件拆），结论冲突是常态而非异常。**不能各记各的**——否则报告会同时印出「Requirements PASS」和「AC3 FAIL」：

| 门 2 结论 | 门 4 结论 | 仲裁 |
|---|---|---|
| 完整 | 对应 AC `FAIL` | 静态判定被实测推翻，该需求下调为「部分」，Requirements 重判 `FAIL` |
| 完整 | 对应 AC `BLOCKED`/`UNVERIFIABLE` | 下调为「部分」，Requirements 至多 `BLOCKED` |
| 缺失/部分 | 对应 AC `PASS` | 实测优先，但必须查清矩阵为何漏判；查清前不得因 AC 绿灯上调 |
| 无对应需求项 | AC 存在 | 门 2 漏项，补进矩阵后重判 |

每条 AC 必须标出对应的需求编号。标不出对应关系说明门 2 矩阵不完整，Requirements 记 `BLOCKED`。

## AC 状态模型

单条验收标准的状态比 Gate 状态细，因为「没通过」的原因决定了下一步该做什么：

| 状态 | 判定 |
|---|---|
| `PASS` | 有可复现执行证据，且已通过反重言基线 |
| `PASS(pre-existing)` | 该 AC 在 base 上已成立，本 PR 未涉及 |
| `PASS(partial)` | 自动化只覆盖该 AC 的一个子集，未覆盖项已枚举 |
| `PASS(waiver)` | 本质不可验证，且已获可核验的人工签核 |
| `FAIL` | 已执行，结果不符合验收标准 |
| `BLOCKED` | 本身可验证，但环境、凭据、依赖或 CI 缺失 |
| `UNVERIFIABLE` | 本质上无法在本环境验证 |

`FAIL` 与 `BLOCKED` 的区分决定了是否进入修复循环：`FAIL` 是代码问题，`BLOCKED` 是环境问题，把后者当前者会导致「修实现来治环境」。

`UNVERIFIABLE` 是最容易被滥用的状态，因此要求同时写明三项，缺一律按 `BLOCKED` 处理：为什么本质不可验证；已尝试过哪些替代手段（mock、stub、录制回放、契约测试）以及为什么不成立；需要谁在什么环境人工验证。真实第三方支付、线上流量与真实负载、特定终端/浏览器/OS、硬件、需真人主观判断的视觉一致性属于这一类；「我这台机器没装」不属于。

### 反重言基线

自动化测试 AC 的核心陷阱是：审计者自己写测试、自己判它通过。新写的测试第一次就绿，可能是因为实现正确，也可能是因为它断言的是常量、是自己 mock 的返回值、或是自己刚 seed 的数据。

因此 `PASS` 的证据不是一个退出码，而是**两个**：先证明该测试在修复前/base 上会红，再证明修复后会绿。基线缺失即不得记 `PASS`。这条规则不接受「代码显然对」的例外。

## 计数口径

比值可以被改写分母而变好看，所以口径要写死：

- **分母 = 拆分出的 AC 总条数，恒定不变。** `FAIL`、`BLOCKED`、`UNVERIFIABLE` 一律计入分母。
- **分子 = `PASS` + `PASS(waiver)` + `PASS(pre-existing)` + `PASS(partial)` 的条数。**
- 结论行固定写 `验收 <分子>/<分母> 通过`；分子小于分母时必须在括号内列出未过条目的状态分布。
- 任何情况下不得为了让比值好看而改写分母。

Gate 聚合：全部 AC 计入分子 → `PASS`；任一 `FAIL` → `FAIL`；否则 → `BLOCKED`。四个 Gate 都没有 `DISABLED`。

## Waiver 语义

waiver 是给「本质不可验证」的 AC 留的出口，不是给「懒得验」留的。它的可信度完全取决于签核不能由审计者代记：

- 签核人须用自己的 Linear 账号在该 Issue 下留评论，明确写出理由并声明接受该条未获可执行证据。
- 本 Skill 重新拉取 Issue，验证该评论存在、且作者不是当前 API key 对应的用户，把评论 URL 填进 waiver 表的签核凭证列。
- 找不到该评论时该 AC 维持 `UNVERIFIABLE`。**对话中的口头同意不构成签核**——会话不可被第三方核验。
- 签核人是 PR 作者本人时标注「作者自签」，评级上限降为 A。

存在 waiver 时报告照常发送，但结论行要写成 `验收 5/5 通过（其中 1 条 waiver）`，紧跟一行显式警示，并附独立的 waiver 记录小节。把 waiver 混进「全过」而不标注，是这个设计里最坏的失败模式。

## 通过规则与评级

- **四门都必须 `PASS`，即 4/4 PASS。**
- 任一 Gate `FAIL` → 总体 `FAIL`；无 `FAIL` 但任一 `BLOCKED` → 总体 `BLOCKED`；全部 `PASS` → 总体 `PASS`。
- 评级沿用 `pr-audit` 的 S/A/B/C/D/F 表。总体 `PASS` 蕴含无 FAIL 无 BLOCKED，因此只能落在 S/A。
- **评级上限为 A**（不得 S）的情形：存在 `PASS(waiver)`、`PASS(partial)` 或 `PASS(pre-existing)`；本次审计推送过任何 commit；仓库无 CI 覆盖；签核人为 PR 作者本人。
- 禁止用总分平均掉任何一门的失败。

「本次审计推送过 commit 即封顶 A」不是惩罚，而是事实陈述：那部分代码无人复核。

## 修复循环与 CI 等待

Acceptance 出现 `FAIL` 时进入修复循环，采用**分轮冻结**——每一轮有自己的冻结 oid，不沿用第一轮。

每轮的固定顺序：说明缺口 → 用户确认修复方案 → 在隔离 worktree 内改实现 → 三层本地复验 → 暂存期机器闸门 → 展示完整 staged diff 后推送 → 在 PR 上发披露评论 → **等待 CI 落定** → 重新冻结。

其中两步最容易被省掉，而省掉就会让整个循环失效：

**等待 CI 是硬要求。** 推送后 `statusCheckRollup` 必然是 pending。此时秒级重读等于把 Correctness 判成 `BLOCKED`，而 `BLOCKED` 不是 `PASS`，于是修复循环永远没有出口——推得越多，结论越差。必须显式等待到落定，并区分「仓库无 CI」与「CI 尚未启动」：前者是评级上限的输入，后者是继续等待的理由。等待超过 `--ci-timeout` 时记 Correctness `BLOCKED` 并停止，不用旧快照顶替。

**披露评论必须落在 PR 上，且每轮推送后立即发**，不等全部通过。理由很直接：本 Skill 推送的代码无人复核，而 reviewer 通常不看 Linear。报告最终发不出去，不构成不披露的理由。推送前还要检查一种危险组合——`dismiss_stale_reviews` 为 false 且 PR 已是 `APPROVED`：继续推送会让未经复核的代码带着旧 approval 进入可合并状态，此时停止询问。

修复范围边界：只改让**已声明的验收标准**成立所必需的实现代码。禁止修改或删除既有测试来让验收「通过」——既有测试与 AC 冲突是需求问题，不是代码问题，停止询问。性能未达标不进入循环，优化几乎必然超出「最小改动」边界。

## 自审隔离

审计者同时是修改者，所以隔离规则要比只读 Skill 更细。

**worktree 不能 checkout head 分支。** git 禁止同一分支在两个 worktree 同时 checkout，而本 Skill 的默认入口恰恰假设用户正站在该分支上。做法是创建审计专用本地分支指向冻结 oid，推送时用显式 refspec。用户站在 head 上不是异常，不得要求用户切走，也不得在主工作区 checkout。

**推送目标是 head 仓库的 head 分支，不是 `origin`。** `origin` 通常是 base 仓库，fork PR 推 `origin` 会推错仓库。可写性用机器判据（push 权限、`maintainerCanModify`、head 分支保护查询、`push --dry-run`）判定，**不按分支名硬判**——fork PR 的 head 常常就叫 `main` 且完全可推。不可写时降级为只读 patch 输出，不发送自测报告，不换路径绕过权限。

**临时验收测试不提交，也不依赖 ignore 机制隔离。** 一个已验证的事实：linked worktree 的 `info/exclude` 不生效，git 只读主仓库那一份，写入即污染主工作区。因此临时测试首选放在仓库外；框架强制树内时靠暂存期机器闸门兜底——断言暂存集合不含临时测试目录、不含既有测试文件、且等于已声明的实现文件清单。禁止 `git add -A/./-u` 与 `git commit -a`，失败即停止，不接受人工目视代替。

**新建 worktree 是空的**：没有依赖、没有数据库、没有服务。跑第一条 AC 之前要完成依赖安装、服务启动、迁移与 seed，否则全部 AC 会假性 `BLOCKED`。`.env` 只从 `.env.example` 或项目文档指定的本地模板生成，**绝不复用主工作区的 `.env`**。

**临时验收测试不得充当门 2 的测试证据。** 判定 Acceptance PASS 后要逐条回查该 AC 在 PR 中是否有已提交的回归测试；没有则门 2 该行测试证据记「缺失」。审计者写在 worktree 里、随后删掉的测试，对仓库的长期质量没有贡献。

## 外发与幂等

Linear 评论的可见范围通常大于私有仓库，而本 Skill 是整条链路上唯一把仓库内部数据外发的组件。发送前必须跑外发前脱敏：证据列只放命令、退出码、断言行、失败 diff 摘要，不贴原始日志、响应体或固件数据。

报告首行是幂等标记，承担两个必须分开的职责：含 oid 的**精确标记**防同一 head 重复发送；`PR-<N>:` **前缀**（尾部冒号必需，否则 `PR-123` 会匹配 `PR-1234`）识别同一 PR 的历史报告，命中时在标记行后插入「本报告取代旧报告」而不新发一份独立报告。

发送前先 `--dry-run`，确认 Issue 解析正确**且标记被识别**。标记未被识别（首行有 BOM、空行、缩进或代码围栏）说明查重是关闭的，必须先修正 body 首行。脚本报重复时不要强推。

**验收未全部 PASS 前不发送自测报告**，但必须在 Pi 输出完整交付物：验收现状表、已推送 commit 清单、每条未过 AC 的缺口块、续跑指引、清理清单。worktree、审计分支和临时测试一律保留，不因失败而清理——失败态的现场比整洁更有价值。

## 授权模型

验收计划闸门是唯一的确认点：用户确认一次，即授权后续验证、修复、推送、等待 CI、复验和回写全过程，**不得再为每一步重复询问**。即使首轮就 4/4 PASS、完全不需要修复，也必须先过闸门。

授权复述必须按开关生成，不得复述未启用的动作：`--no-post` 时明确写「本次不发送任何 Linear 评论」，只读降级时写「不推送任何 commit，产出 patch」。

任何确认都不包含：force push；推送受保护分支或 refspec 指向 base；合并/approve/ready/关闭 PR 或修改 PR title/body/base；修改 Linear 的状态、字段、标签或验收标准本身；部署、发布、访问生产环境；提交临时验收测试；修改或删除既有测试。

三门本身 `FAIL` 或 `BLOCKED` 时仍继续执行 Acceptance（诊断价值最高的部分），但必须在闸门第一行如实写出三门结论，并明确告知「即使 Acceptance 全过，总体门禁仍为 FAIL/BLOCKED，本次不会发送自测报告」。让用户在误以为能闭环的前提下授权，是无效授权。

## 常用入口

```text
/skill:linear-pr-audit 123 TEAM-456
/skill:linear-pr-audit https://github.com/org/repo/pull/123 TEAM-456
/skill:linear-pr-audit 123                             # 从 PR body / 分支名推断 identifier
/skill:linear-pr-audit 123 TEAM-456 --max-rounds 2 --ci-timeout 60
/skill:linear-pr-audit 123 TEAM-456 --no-post
```

- `--max-rounds N`：修复复验循环最大轮次，默认 `3`。用 `--max-rounds 1` 可只出一轮纯诊断。
- `--ci-timeout M`：每轮推送后等待 CI 落定的分钟数，默认 `45`。超时记 Correctness `BLOCKED`。
- `--no-post`：完成全部验证但不发送 Linear 评论，只在 Pi 输出报告并给出手动发送命令。

## references/ 分层

`SKILL.md` 只保留流程骨架、状态模型与闸门位置，长篇执行口径放在同目录 `references/`，由对应 Phase 引用：

| 文件 | 内容 |
|---|---|
| `write-safety.md` | 可写性判定、推送目标解析、worktree 隔离、PR 披露评论模板 |
| `ac-taxonomy.md` | 验收标准分型与各型默认验证方式、结论上限、必填限制项 |
| `anti-tautology.md` | 反重言基线的强制程序 |
| `rerun-scope.md` | 各门重跑口径、CI 等待规则、证据裁剪 |
| `report-templates.md` | 外发前脱敏、自测报告与未达标交付物模板、幂等标记格式 |

维护约束与 `linear-to-pr` 相同：`SKILL.md` 里的每个指针都必须存在，`references/` 下的每个文件都必须被引用。「什么时候必须停下来问」始终留在 `SKILL.md`，参考文件只承载「怎么做」。

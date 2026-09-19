# 报告模板与外发脱敏

外发前的强制脱敏程序，以及验收计划闸门、Linear 自测报告、缺口块、未达标交付物、幂等标记的固定格式。

> 由 SKILL.md 的 Phase 3.3、Phase 4、Phase 6 引用；PR 披露评论模板见 `write-safety.md`。

## 本文小节

- [验收计划闸门模板](#验收计划闸门模板)
- [外发前脱敏（强制）](#外发前脱敏（强制）)
- [Linear 自测报告模板](#Linear-自测报告模板)
- [人工签核（waiver）](#人工签核（waiver）)
- [六段式缺口块](#六段式缺口块)
- [未达标交付物模板](#未达标交付物模板)
- [写操作清单与指纹覆盖边界](#写操作清单与指纹覆盖边界)
- [幂等标记的两个职责](#幂等标记的两个职责)

## 验收计划闸门模板

Phase 3.3 输出给用户确认的那一份。逐项给全，缺项即闸门不成立：

```text
【TEAM-456 / PR #123 验收计划】
三门结论：Correctness PASS / Requirements PASS / Security PASS
推送目标：<head-nwo> 的 <headRefName>（可写性判据：permissions.push=true，无保护规则，dry-run 通过）
验收标准（N 条，含 <非功能 x> / <负向 y> / <异步 z>）：
- AC1 ... [来源] → R3 → 自动化测试（<框架>），落点 <临时测试路径>，基线 A
- AC2 ... [来源] → R5 → 可复现命令 `...`
worktree：<路径>（新建，审计专用分支 pi-acceptance/pr-123 指向冻结 oid）
临时测试隔离：<仓库外 /tmp 路径，或树内 .acceptance-tmp/ + 暂存期机器闸门>
已声明实现文件清单（DECLARED_FILES，本次修复只能改这些文件，且增删合计 ≤80 行）：<逐个列出>
最大复验轮次：3 ｜ CI 等待上限：45 分钟（timeout 包住 gh pr checks --watch）
预算估算：单轮 AC <T1> 分钟 + Correctness <T2> 分钟 + CI 至多 45 分钟 → 最坏 <总计> 分钟
授权复述：<按开关生成>
```

## 外发前脱敏（强制）

本 Skill 是整条链路上**唯一把仓库内部数据发到外部**的组件，而 Linear 的可见范围通常比私有仓库更宽。

**检测集合与硬闸门必须是同一份模式集合**，所以只定义一次，跑两次：一次用于人工改写前的定位，
一次作为发送前的硬闸门。

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${BODY:?}"                # BODY 由 Phase 6 用 mktemp 建立，umask 077
PAT_I=(                                    # 大小写不敏感
  '(api[_-]?key|secret|passwo?rd|token|bearer |authorization:|client[_-]secret)[^a-z0-9]{0,3}[=: ]'
  '(postgres|mysql|mongodb|redis|amqp)(\+srv)?://[^ ]+'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
  '\b(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)[0-9]{1,3}\.[0-9]{1,3}\b'
)
PAT_S=(                                    # 大小写敏感
  'BEGIN [A-Z ]*PRIVATE KEY'
  '\b(gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.)'
)
redaction_hits() {
  local f="$1" p h out=""
  for p in "${PAT_I[@]}"; do
    h=$(grep -nEi -e "$p" "$f" || true); [ -z "$h" ] || out="${out}[i] ${p}
${h}
"
  done
  for p in "${PAT_S[@]}"; do
    h=$(grep -nE -e "$p" "$f" || true); [ -z "$h" ] || out="${out}[s] ${p}
${h}
"
  done
  # 本机路径与用户名用固定串匹配：用户名可能含正则元字符，-E 会误判或漏判
  h=$(grep -nF -e "${HOME:-/nonexistent-home}" -e "$(whoami)" "$f" || true); [ -z "$h" ] || out="${out}[F] machine-path
${h}
"
  printf '%s' "$out"
}
redaction_hits "$BODY"                     # ① 改写前定位：有命中即先改写
```

改写规则：

| 命中类型 | 改写为 |
|---|---|
| 凭据、token、私钥 | `<redacted:token>` / `<redacted:private-key>` |
| 连接串 | `<redacted:dsn>` |
| 邮箱、内网 IP、主机名 | `<redacted:email>` / `<redacted:internal-ip>` |
| 需保留可比对性 | 8 位 sha256 指纹：`printf '%s' "$V" \| sha256sum \| cut -c1-8` |
| 本机路径 | 相对路径或 `<workspace>/...` |

- **拿不准是否真实凭据时，按真实处理**：脱敏 + 记一条 Security 发现 + 建议轮换。
- 证据列只允许：命令、退出码、断言行、失败 diff 摘要。
  **禁止**贴原始日志、HTTP 响应体、fixture 数据、数据库行。
- 负向 AC 的反讽规则：证明「日志里没有 PII」时**不得**把带 PII 的日志贴出来。
  只写「已注入哨兵 `<id>`，在 <已枚举 sink> 未命中，正对照命中」。

发送前的硬闸门——**同一个 `redaction_hits`，一条模式都不许少**。
函数和变量都**不跨 `bash` 调用**，所以本片段必须与上方 `PAT_I`/`PAT_S`/`redaction_hits` 的定义
**放在同一次 `bash` 调用内**，并先自证函数存在：

```bash
# 承接上一段，**同一次 `bash` 调用**：函数与数组都不跨调用，拆开就没有闸门。
# 首行的 source 与断言沿用上一段；这里再断言一次是因为 BODY 是唯一必须已固化的输入。
: "${BODY:?BODY 未固化：Phase 6 建立 BODY 后必须 printf 追加进 env 文件}"
command -v redaction_hits >/dev/null \
  || { echo "STOP: redaction_hits 未定义，闸门等于不存在，禁止发送"; exit 1; }
HITS=$(redaction_hits "$BODY")             # ② 发送前硬闸门
[ -z "$HITS" ] || { printf 'STOP: 仍有未脱敏命中，禁止发送：\n%s\n' "$HITS"; exit 1; }
```

**`HITS` 为空有两种原因：真的没命中，和检测器根本没跑。** 后者会让未脱敏报告直接外发，
所以 `command -v` 自证是闸门的一部分，不是可省的礼节。

**硬闸门的模式集合必须与上方检测集合逐条相同；任何只在检测里出现、不在闸门里出现的模式都是一条可外泄通道。**
闸门只复查凭据关键字、私钥和 token 三类时，DSN 连接串、邮箱、内网 IP/主机名、AWS `AKIA…`、
JWT `eyJ…` 和本机路径会全部通过闸门被发到 Linear——这是本 Skill 唯一的外发出口，没有第二道防线。
因此模式只能加不能减；新增一条检测就同时进入闸门（共用 `PAT_I`/`PAT_S`/固定串三段，天然同源）。

## Linear 自测报告模板

```markdown
<!-- pi-kit:linear-pr-audit:PR-<N>:<最终 head oid 前 12 位> -->
## 自测报告 · <ISSUE> · PR #<N>

**结论：验收 <分子>/<分母> 通过 | 门禁 <PASS|FAIL|BLOCKED> | 等级 <S|A|B|C|D|F>**

### 验收标准逐条结果
| # | 验收标准（来源） | 分型 | 验证方式 | 证据 | 结果 |
|---|---|---|---|---|---|
| AC1 | ...[正文] | 功能性 | 自动化测试 | `<命令>` 基线 exit=1 / 修复后 exit=0 | PASS |

### 四门状态
| Gate | 状态 | 关键证据 | 沿用轮次 |
|---|---|---|---|
| Correctness | PASS | 本地全量套件 / PR head CI（二选一写明）+ `gh pr checks` 的 bucket 明细原文 | 本轮 |
| Requirements | PASS | 需求追踪矩阵 | 第 1 轮 |
| Security | PASS | 四项机器判据均无命中 | 第 1 轮 |
| Acceptance | PASS | <分子>/<分母> | 本轮 |

### 复验轮次（每轮的 `HEAD_OID` / `ROUND_OID` 逐轮列出，不合并）
- 第 1 轮（`HEAD_OID`=`<oid>` / `ROUND_OID`=`<oid>`）：AC<n> FAIL — <缺口摘要> → 修复 `file:line`
- 第 2 轮（`HEAD_OID`=`<oid>` / `ROUND_OID`=`<oid>`）：<分子>/<分母> PASS
- CI：`wait_exit=<0|124>` ｜ `required_skipped=<无|名单>` ｜ bucket 明细：`<gh pr checks --json 输出原文>`

### 本次审计推送的修复 commit（没有则写“无”，让 reviewer 知道哪些改动出自审计者）
- `<sha>` <message> → AC<n>

### 人工签核（waiver）
| # | 验收标准 | 签核人 | 签核凭证 URL | 待谁在何环境复测 |
|---|---|---|---|---|

### 验证方式说明
- 临时验收测试只在隔离 worktree / 仓库外目录中运行，未提交进本 PR。路径与摘要：...
- 每条 AC 的基线来源：基线 A（base detached worktree 对照）/ 基线 B（本轮起始 oid detached worktree 对照）/ 哨兵反证

### 未验证项与限制
- `UNVERIFIABLE`：<为什么本质不可验证 / 已试替代手段 / 需谁在何环境验证>；未覆盖的 sink、兼容目标、a11y 准则
- 性能 AC：base P95 / head P95 / `Δ` / 样本标准差 / 判定阈值 / **原始样本序列**
- L2 影响面搜索若触发降级守卫：改动文件数、命中文件数、降级后的实际集合

### 审计元信息
- 冻结 head：`<最终 oid>` | base：`<baseRefOid>`
- PR：<url> | 状态：Ready / **Draft** | CI 结论：<全绿 / 失败 / pending / 无 CI 覆盖>
- 评级依据：<为什么是该等级，以及提升所需动作>
- 验证环境：OS `<>` / CPU `<>` / 内存 `<>` / runtime `<>` / build mode `<>` / 数据规模 `<>`
- 生成时间（UTC）：<ISO8601>
```

Draft PR：**默认不发送 Linear 评论**，只在 Pi 输出完整报告，并写明理由
「PR 仍为 Draft，作者尚未宣布可评审，自测报告不外发」。只有用户在 3.3 闸门处**明确要求**
「Draft 也发」时才发送，且必须保留下面这行警示：

```markdown
> ⚠ PR 仍为 Draft，本报告只说明验收标准在当前 head 上成立，不代表可以合并。
```

存在 waiver 时追加一行，且评级上限 A：

```markdown
> ⚠ 本报告含 <N> 条人工签核项，未获得可执行证据。
```

推送过修复 commit 时，同一份 commit 清单必须**同时**出现在 Linear 报告和 PR 披露评论里。

## 人工签核（waiver）

签核人须用**自己的** Linear 账号在该 Issue 下留一条逐字评论：

```text
AC<n> waiver: <理由>。我确认接受该条未获可执行证据。
```

本 Skill 用 `fetch-linear-issue.mjs` 重新拉取 Issue，验证该评论存在、且作者**不是**当前 API key
对应用户，再把该评论 URL 填进上面 waiver 表的「签核凭证」列。找不到该评论 → 该 AC 维持
`UNVERIFIABLE`，不得改判。对话里的口头同意、PR 里的 approve、聊天记录都**不构成签核**。

签核人是 PR 作者本人时，签核人列标注 `（作者自签）`，评级上限降为 **B**
（已登记进 SKILL.md 的上限清单），并在报告里紧跟一行：

```markdown
> ⚠ 本条 waiver 由 PR 作者本人签核，无第三方确认。
```

**waiver 必然跨两次调用**：签核评论在本次运行开始前不存在，本 Skill 无权代发。本轮只输出
「待签核清单 + 上面那句逐字评论模板 + 需要谁签」，该 AC 以 `UNVERIFIABLE` 收尾并按未达标交付物
输出全部产物，由用户在签核评论存在之后重新运行本 Skill。**禁止在运行内轮询等待人工签核**——
人不是可轮询的资源，那只会烧掉预算并把轮次耗尽。

## 六段式缺口块

Phase 4 步骤 1 对每条 `FAIL` 的 AC 输出这一块，未达标交付物里逐条复用同一格式：

```text
[FAIL] AC3：<验收标准原文> [来源]
- 缺什么：<能力/分支/校验/文案 具体缺失点> ｜ 缺在哪：`file:line`（或“完全缺失，应落在 file:line 附近”）
- 期望：<AC 要求的可观察结果> ｜ 实际：<执行得到的结果，附命令与输出片段>
- 修复方向：<落在哪些文件的改动方案> ｜ 影响范围：<会牵动的文件与调用链>
```

## 未达标交付物模板

达到 `--max-rounds`、用户叫停或命中停止条件时输出；**不发送 Linear 评论**，只本地输出。

```markdown
## 验收未达标 · <ISSUE> · PR #<N>

**当前：验收 <分子>/<分母> | 门禁 <FAIL|BLOCKED> | 轮次 <k>/<max>**

### 验收现状
| # | 验收标准 | 结果 | 卡在哪 |
|---|---|---|---|

### 已推送 commit
<!-- git log --oneline <第 1 轮 oid>..<最终 head> -->
- `<sha>` <message>

### 每条失败 AC 的缺口
<!-- 逐条套用上文 §六段式缺口块，不得压缩成一句话 -->

### 续跑指引
- worktree：`<路径>` | 审计分支：`pi-acceptance/pr-<N>`
- 临时测试文件全文：<逐个文件的完整内容>
- 续跑命令：`/skill:linear-pr-audit <N> <ISSUE> --max-rounds <k>`

### 清理清单（由用户执行，本 Skill 不删除任何东西）
- `git worktree remove <验收 worktree 路径>`、`git worktree remove <基线 worktree 路径>`
- `git branch -D pi-acceptance/pr-<N>`
- `rm -rf /tmp/pi-acceptance-pr-<N> /tmp/pi-ac-*-r*-pr-<N>.log /tmp/pi-linear-pr-audit-pr-<N>.env`
- `git remote remove <本次登记的临时 remote>`、`git update-ref -d refs/remotes/pi-head/pr-<N>`（若曾建立）
- 停止本次启动的服务：<进程 / 端口>
```

已推送 commit 清单非空 → PR 披露评论**已是必须**；Linear 报告被扣下不是跳过 PR 披露的理由。

## 写操作清单与指纹覆盖边界

两条输出路径（成功发送与未达标交付）都必须附这份清单，**指纹比对一致也要逐条列**。
隔离基线指纹（`git -C "$ROOT" status --porcelain=v1 | sha256sum`）只覆盖**主工作区的工作树文件状态**。
以下三类它完全看不见：

| 未被指纹覆盖 | 本次是否发生 | 还原命令 |
|---|---|---|
| 主工作区本地分支落后远端（本 Skill 推送所致） | 落后 `<n>` 个 commit / 未发生 | `git -C <主工作区> pull --ff-only`（**禁止** `--force` / `--force-with-lease`） |
| `.git/config` 变更（含 `extensions.*`、`worktree` 级配置） | 有 / 无 | 逐条 `git config --unset <key>` |
| 新增的 remote、本地分支与 `refs/remotes/*` | `<名单>` / 无 | `git remote remove <name>` / `git branch -D <name>` / `git update-ref -d <ref>` |

其余写操作照旧逐条列出并附还原命令：验收 worktree、基线 worktree、审计分支、临时文件与日志、
启动的服务、推送的 commit、PR 披露评论 URL、Linear 评论 URL。

## 幂等标记的两个职责

```text
精确标记：pi-kit:linear-pr-audit:PR-<N>:<oid 前 12 位>
PR 前缀：  pi-kit:linear-pr-audit:PR-<N>:
```

PR 披露评论走**另一个命名空间** `pi-kit:linear-pr-audit:disclosure:PR-<N>:<oid 前 12 位>`
（见 write-safety.md），两者不共用前缀，避免跨系统查重互相误命中。

1. **精确标记**防止同一 head 重复发送。命中 → 不再发送。
2. **PR 前缀**用于定位本 PR 的历史报告。**末尾冒号是强制的**：
   `"...PR-1234:aaa".includes("pi-kit:linear-pr-audit:PR-123")` 为 `true`，
   缺尾冒号会把 PR-1234 的报告误判成 PR-123 的。

前缀扫描不是脑内动作，用这条命令做（`--dry-run` 只查精确标记，不查前缀）：

```bash
. /tmp/pi-linear-pr-audit-pr-<PR>.env; : "${ISSUE:?}" "${PR:?}"
node <linear-to-pr-skill目录>/scripts/fetch-linear-issue.mjs "$ISSUE" \
  | jq -r --arg p "<!-- pi-kit:linear-pr-audit:PR-${PR}:" \
      '.comments[] | select(.body | startswith($p))
       | [.createdAt, (.user.displayName // .user.name // "?"), .url, (.body | split("\n")[0])] | @tsv'
```

`startswith` 而不是 `contains`：标记只在正文**第 1 行**才算标记，脚本侧的判定也是行 1 锚定。

前缀命中（旧 head 的报告已存在）→ 不要另发一条独立报告，在标记行后插入：

```markdown
> 本报告取代 <旧报告 URL>（旧 head `<oid>`，本次 head `<oid>`）
```

带精确标记的评论**作者不是本 Skill 使用的 API key 对应用户**时，说明标记是别人搬过去的，
不构成重复：**报告并停止**，绝不自行 `--allow-duplicate`。

不需要判断「正文是否带 `>` 引用前缀」：`bodyCarriesMarker` 以
`^<!--\s*<marker>\s*-->\s*$` 锚定**第 1 行**，被引用（`> <!-- ... -->`）或包在代码围栏里的标记
天然匹配不上，引用造成的假重复在脚本层已经不可能发生。

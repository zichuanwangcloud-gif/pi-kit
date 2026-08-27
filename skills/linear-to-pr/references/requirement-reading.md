# 需求读取：抓取校验、评论分层与来源分类

把 Linear Issue 读全、读准的机械步骤：抓取失败分类、评论分层协议、文档与附件来源分类、真实代码落点定位。

> 由 SKILL.md 的 Step 1、Step 1.1、Step 1.2、Step 1.5.a 引用。

## 本文小节

- [片段前提](#片段前提)
- [脚本输出与抓取失败分类](#脚本输出与抓取失败分类)
- [两种截断不是一回事](#两种截断不是一回事)
- [Issue 形态与状态闸门](#Issue-形态与状态闸门)
- [评论分层协议](#评论分层协议)
- [阅读顺序与冲突处理](#阅读顺序与冲突处理)
- [文档与附件来源分类](#文档与附件来源分类)
- [定位真实代码路径](#定位真实代码路径)
- [EARS 验收句式与六项自检](#EARS-验收句式与六项自检)

## 片段前提

参数模板见 SKILL.md §执行期约定：参数固化。那里是**唯一**的参数模板来源，本文件不重复给模板。
本文件片段一律以 `set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env` 开头，
并只断言该阶段已固化的变量——本文件全部落在 Step 1，可用 `ISSUE`、`ISSUE_LOWER`、`ROOT`、`OUT`，
**不得**断言 `BASE`/`BR`/`WT`（阶段二在 Step 2.c 才写）。

## 脚本输出与抓取失败分类

`scripts/fetch-linear-issue.mjs` 返回 `description`、按线程与时间排序的完整 `comments`、
`commentCount`、`requirementRelevantComments`、`documentLinks`、`attachments`、`branchName`、
`parent`/`children`/`relations`，以及分页完整性元数据。

| 错误 | 判定与处置 |
|---|---|
| `401` / `403` | API key 无效或已撤销 |
| `team ... is not visible` | key 属于其他 workspace 或该 team 私有。让用户确认 workspace 或提供有权限的 key。**不要**改用其他 team key 重试 |
| `issue not found`（team 可见） | 确认编号，issue 可能已归档。不选择相近 Issue |
| 网络 / 分页错误 | 报告并停止，不根据记忆补全 |

## 两种截断不是一回事

- `fetchMetadata.truncated` **只反映分页截断**（评论或附件翻页到上限就停），与正文长度无关。
- **正文截断单独标在 `comments[].bodyTruncated`**：脚本默认 `--max-comment-chars 4000`，
  超长评论的正文会被裁掉并打上该标记。所以抓取必须显式传 `--max-comment-chars 0`，
  再用 Step 1 的 `bodyTruncated` 闸门复核；只查 `fetchMetadata.truncated` 查不出正文丢失。
- 正文被截断时 `.body|length` 量到的是**截断后**长度，据此做的长度分层与「确认相关再读全文」
  全部失真——全文根本不在文件里。

## Issue 形态与状态闸门

Step 1.0 的机械步骤。先读出判定所需字段：

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${OUT:?}"
jq '{identifier, title, state, canceledAt, completedAt, parent,
     childCount: (.children|length), children,
     relations,        # 出向：本 Issue 阻塞谁，仅作上下文
     blockedBy}' "$OUT"   # 入向且仍未完成的前置，闸门只看这个
```

| 情况 | 动作 |
|---|---|
| `state.type` 为 `canceled` 或 `canceledAt` 非空 | 停止，报告状态并询问是否仍要实现 |
| `state.type` 为 `completed` 或 `completedAt` 非空 | 停止，确认是回归/补充改动还是拿错 identifier |
| `relations` 含 `duplicate` | 停止，展示 canonical issue 并询问以哪一个为准 |
| `children` 非空（parent issue） | 停止，列出全部子 issue 及状态，询问本次实现哪一个/哪几个。禁止只按 parent 正文实现 |
| `blockedBy` 非空 | 按 Step 2.a 栈式流程处理。该字段已由脚本过滤为「仍未完成的前置」，不要再自行判断状态 |
| `relations` 含 `type=="blocks"` | 说明**本 Issue 阻塞他人**，不是被阻塞。只登记进理解卡，不作为停止条件 |
| `parent` 非空 | 读取 parent 正文作为上下文（不含兄弟 issue 的范围），理解卡标注来源 `[父 Issue <identifier>]` |

以上都不命中才进入 Step 1.1。

## 评论分层协议

**评论量大时按分层协议读，不得因为量大就跳读，也不得一次性灌入全文。**

```bash
set -euo pipefail; . /tmp/pi-linear-to-pr-<issue-lower>.env
: "${OUT:?}"
jq -r '.commentCount, .fetchMetadata.complete, .fetchMetadata.humanCommentCount' "$OUT"
jq -r '.comments[] | "#\(.sequence) d\(.depth) [\(.user.name // .botActor.name // "bot")] \(.createdAt) len=\(.body|length) sig=\(.requirementSignals|join(",")) resolved=\(.resolvedAt // "-")"' "$OUT"
jq -r '.comments[] | select(.sequence >= 1 and .sequence <= 20) | "=== #\(.sequence) \(.user.name // "bot") \(.createdAt) ===\n\(.body)\n"' "$OUT"
```

第三条按需改 `select` 的区间分批读完，不得只读第一批就收工。

分层规则：

- **必须逐字读**：`requirementSignals` 非空的、含链接的、最早 3 条、最新 5 条、以及全部人类作者评论。
- **可只读索引行**：可判定为集成/机器人的评论。按数量汇总登记，例如
  「bot 评论 47 条（GitHub 同步/部署通知），未逐条读」。
- **超长评论**（`len > 4000`）先读首尾各 1500 字符定性，确认相关再读全文。该规则成立的前提是
  抓取时用了 `--max-comment-chars 0`、且 `bodyTruncated` 闸门已通过；否则全文不存在，规则不可执行。
- 上下文不足以按上述规则读完时**停止并报告**，不要静默降级为摘要。

## 阅读顺序与冲突处理

阅读顺序：先正文，再按 `threadRootId` 分组，组内按时间；跨组按线程首条时间排序。
已 `resolvedAt` 的线程标注为「已关闭讨论」，其结论不自动作为当前口径，
需在正文或未关闭线程中有对应落实。

冲突处理：列出双方摘要、作者、时间和来源。新评论只有明确覆盖证据时才作为候选最终口径；否则询问。
评论出现新范围但未明确纳入当前 Issue 时，作为范围疑问。

## 文档与附件来源分类

按来源分类，任何情况下不得凭标题、URL slug 或文件名推断内容：

- **Linear document**（`linear.app/*/document/*` 或正文内嵌引用）：脚本不抓取正文，列为缺口。
- **Linear 上传附件**（`uploads.linear.app`）：需鉴权且多为图片，视为不可读，只登记标题/类型/时间。
- **外部文档**（Figma / Notion / 语雀 / 飞书 / Google Docs）：默认视为登录墙。
- **凭据边界**：禁止把 `LINEAR_API_KEY` 带到 `api.linear.app` 以外的任何主机。

索取模板与三级降级处置见 `recovery.md` §不可读需求来源。

## 定位真实代码路径

Step 1.5.a 的机械步骤：

- 从项目真实入口追踪 route/command/event/job 到业务与数据/外部依赖。
- 有 UI 时确认路由/导航 → 实际渲染组件 → 用户可见字段。
- 存在旧版/新版、平台覆写、feature flag 或同名候选时，沿注册/import/config 判定实际生效路径。
- 可按需调用 `feature-trace`。未安装时自行完成，**最低产出三项**：入口、生效实现 `文件:行`、
  被排除的同名候选及排除理由。
- monorepo 中同时确定改动落在哪些 package，以及各自的 CODEOWNERS。

## EARS 验收句式与六项自检

Step 1.5.b 理解卡的两条硬要求。

**验收标准必须铸成 EARS 句式**（`[当<事件>时 / 如果<条件>那么 / 在<状态>期间]，系统应当<行为>`），
铸不出来即判定「不可验收」并计入缺口；含并列连词或两个以上动词短语的必须拆分，每条只留一个断言点。

六项自检，逐项写出通过/未通过，**缺口数 = 未通过项数**，不得凭感觉给数：

| # | 自检项 |
|---|---|
| ① | 期望明确（不只有现象） |
| ② | 正文/评论/附件/关键文档按 Step 1.1 / 1.2 覆盖完 |
| ③ | 冲突已解决 |
| ④ | 有可验证验收标准（EARS 句式成立） |
| ⑤ | 已定位唯一生效落点 |
| ⑥ | 已知触发条件 |

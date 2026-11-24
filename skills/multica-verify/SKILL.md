---
name: multica-verify
description: 对高风险 PR 做证据化验证，按验收表、链路、缺陷、爆炸半径四节给出只认原始输出的证据包，最后一行是【验证结论】PASS、FAIL 或 BLOCKED。
---

# Multica 证据验证

用在迁移、鉴权、多租户、计费、并发这类出错代价高的 PR 上。普通 PR 用 multica-audit 就够，两者不要叠加。
只读：不改实现、不改测试、不 push、不在 PR 上发评论。

## 平台约定（Multica）

- **无交互用户。** 只有通过 `multica issue comment add` 发出的评论对人可见；确切命令（含 `--parent`）以运行时指令为准，正文用 `--content-stdin` 加 heredoc 传入。
- 读上下文：`multica issue get <id> --output json`、`multica issue comment list <id> --output json`。
- 取代码：`multica repo checkout <url>`，URL 取自运行时的 Repositories 表。issue 未指明仓库且候选不止一个时，按阻塞处理。
- 只在需要人做决定或补材料时才提醒人（需澄清、阻塞、超出自己权限），常规结果不提醒。写法：`[@名字](mention://member/<user-id>)`，id 取自 issue 的创建人字段与 `multica workspace members --output json`；创建人是智能体或查不到 id 时写纯文本名字。
- **不写任何 `mention://agent/` 链接**，它会重新触发智能体；提到其他智能体只写名字。
- issue 状态按运行时指令处理，本 skill 不额外改状态。
- 一轮只发一条结果评论。结论行是评论的最后一行，写法必须与本文给出的完全一致，其后不得再有任何字符。
- 评论写结论和证据，不写过程；阻塞类评论不超过 8 行。

## 输入

issue 评论里最近的 `【PR】<链接>` 与规格评论里的验收标准。
用 `gh pr view <n> --json state,baseRefName,headRefName` 取得 base 与 head，不要假定 base 是哪个分支。
验证命令从仓库文档、CI 配置、清单文件里找，不假设技术栈。

## 四节

**A 验收表。** 把每条标准写成「操作 / 输入 / 期望字面结果」。哪条要靠猜才能写出字面结果，就列进「需要猜」，不要自己补。

**B 链路。** 每条标准从入口追到生效实现再追回输出，列出经过的 `文件:行`，然后在 head 上实际执行一次，贴输出。哪一段找不到代码或输出不符，该条 FAIL。

**C 缺陷。**
- 反验：在 base 上只放 PR 的测试、不放实现，跑测试，必须失败。贴退出码。通过了说明测试恒真，FAIL。PR 根本没有测试，也记 FAIL（没有回归保护）。
- 边界：对每个被改动的输入实际跑一遍空值、各种空白字符、0 与负数、超长、Unicode，对比 base 与 head 的输出。head 把 base 上正确的行为变错，FAIL。
- 鉴权：新增路由、权限点、租户过滤逐项核对；diff 不涉及时写「不涉及」并记 PASS。

**F 爆炸半径。** 被改的函数、类型、表有哪些调用方，各自是否被测试覆盖；有迁移时，旧代码能否在新 schema 上运行。

性能压测（D）与故障注入（E）需要隔离环境。没有就记 SKIPPED 并写「无隔离环境」，不要记成 BLOCKED 或 PASS。

## 状态

| 状态 | 含义 |
|---|---|
| PASS | 有本次运行的原始输出，且满足标准 |
| FAIL | 有原始输出，且不满足 |
| BLOCKED | 缺环境、权限或数据，跑不出输出 |
| NOT-RUN | 该做但没做到 |
| SKIPPED | 明确不做（D、E） |

只有 PASS 算通过。没跑就写没跑，不编输出。「文件太大」不是 BLOCKED 的理由。

## 结论

按顺序判，命中即止：

1. 任何一格 FAIL → `【验证结论】FAIL`
2. 有 BLOCKED、NOT-RUN，或「需要猜」非空 → `【验证结论】BLOCKED`
3. A、B、C、F 全部 PASS → `【验证结论】PASS`

最后一行只能是这三种写法之一，不加任何后缀。

## 评论格式

```markdown
## 验证证据包

PR：<链接>（`<head>` → `<base>`）

| 节 | 项 | 状态 | 证据 |
|---|---|---|---|
| A | 验收表 | | |
| B | 链路 | | |
| C | 反验 | | |
| C | 边界 | | |
| C | 鉴权 | | |
| D | 性能 | SKIPPED | 无隔离环境 |
| E | 故障注入 | SKIPPED | 无隔离环境 |
| F | 爆炸半径 | | |

### 失败与未决
每条写：现象、复现命令、原始输出。没有就写「无」。

【验证结论】FAIL
```

表格里放一句话证据，完整命令与输出放在「失败与未决」里，只贴与结论有关的部分。

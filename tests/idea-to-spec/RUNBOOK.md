# 运行手册

给执行评测的 agent（或人）看的操作步骤。协议定义在 `../EVAL-PROTOCOL.md`，本文件只讲怎么跑。

## 前置检查

```bash
cd /opt/pi-kit
node tests/idea-to-spec/selfcheck/checks.mjs   # linter 自检必须通过
ls tests/idea-to-spec/fixtures/cases          # 用例目录
```

## 单个用例的单次运行

一个用例 = 一个 slug，例如 `01-vague-performance`。目录里有 `public.md`（喂被测方）
和 `hidden.md`（喂需求方 agent）。

### 1. 起需求方 agent（常驻）

把 `hidden.md` 全文放进它的 prompt，加上 `EVAL-PROTOCOL.md` 里「角色二」的规则。
它是常驻的：被测方每提一轮问题，就把它这一轮的答案发回来。

### 2. 起被测方 agent

prompt 里只放 `public.md` 的 `trigger` 原文 + 「加载 `idea-to-spec` 并按其流程执行」+ 隔离禁令。
禁令必须完整列出以下来源（实测有 agent 绕过不完整的禁令）：

- 不得读取 `tests/`、`hidden`、`fixture`、`eval`、`case` 相关路径
- 不得看 git 历史（`git log`/`show`/`reflog`）
- **不得读取 `~/.claude/` 下的任何会话记录、历史、transcript、memory**（尤其 `history.jsonl`），
  也不得读任何其他 session 的对话记录
- 输入**只有** prompt 里给出的 trigger 与问答记录；不得用环境中任何其他线索推断用户意图

> 为什么单列第三条：实测有被测 agent 读了 `~/.claude/history.jsonl`，把宿主会话里用户的真实提问
> 当成自己的输入，产出了一份完全无关的 spec。文件系统层面无法真正隔离，只能靠禁令；
> 要彻底隔离需在容器或独立 HOME 下跑。

这两步如果用 subagent 实现，被测方与需求方必须是**两个独立 subagent**，不能共用一个上下文——
共用会让被测方看到 hidden，评测失效。

### 3. 循环提问直到 skill 产出 spec

```text
被测方一轮提问 → 需求方只答被问到的 → 把答案发回被测方 → 重复
```

终止条件：被测方按 skill 规则产出 spec，或 skill 判定停止/探查。

### 4. 机器检查

```bash
node tests/idea-to-spec/lib/spec-lint.mjs <产出的 spec>
```

任何 `[error]` 都要在报告里单列。

### 5. 评委打分

评委 agent 只给三样：`hidden.md`、spec 全文、linter 输出。**不给对话过程**。
按 `EVAL-PROTOCOL.md` 的四项指标打分，用固定 JSON 结构返回：

```json
{
  "case": "01-vague-performance",
  "recall": 0.0,
  "precision": 0.0,
  "scope": 0.0,
  "acceptability": 0.0,
  "hallucinations": ["<spec 里编造的具体断言>"],
  "missed": ["<没问出来的隐藏事实 K 编号>"],
  "notes": "<一句话>"
}
```

## 报告

每轮跑完，把结果汇总成 `docs/reports/idea-to-spec-eval-round-N.md`，包含：

- 四个指标的均值和每用例明细
- 幻觉清单（按用例）
- linter error 清单
- 本轮改了什么、下一轮打算改什么

## 每轮迭代

1. 跑完一轮全部用例，得到分数。
2. 读失败模式，改 `skills/idea-to-spec/`。
3. 重跑同一批用例。
4. 连续两轮加权总分变化 < 2% 且无新增 error → 停。

**反脆弱提醒**：改 skill 时不要只盯召回率。让 skill 学会把所有东西都标成 `[推断]` 能骗过召回率，
但会被准确率抓住（推断项超 1/3 时准确率封顶 0.6）。两个指标要一起看。

## 自动化跑测（推荐）

手工中继容易出错且吃上下文。用 workflow 编排，每轮的被测方与需求方都是全新 agent，
隔离由结构保证：

```js
// 见本仓 workflow 脚本 idea-to-spec-eval：
//   phase Dialogue：对每个用例，循环 MAX_ROUNDS 轮：
//     agent(被测方) → kind=questions|spec|stop → agent(需求方) → 追加 transcript
//   phase Judge：对产出的每份 spec，跑 linter + 评委打分
```

要点：
- 被测方 agent 的 prompt 里**只出现 public 的 trigger 和累计问答**，永不出现 hidden。
- 需求方 agent 每轮独立起，只拿 `hidden.md` 和本轮问题。
- 评委只拿 `hidden.md` + spec + linter 输出，**不看对话**。
- 沙箱 `/tmp/idea-eval/` 里只放 `skill/` 和各用例的 `public.md`，不含任何 hidden 文件，
  被测方即使乱翻也翻不到答案。

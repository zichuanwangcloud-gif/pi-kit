export const meta = {
  name: 'idea-to-spec-eval',
  description: 'Run the idea-to-spec golden set: per-case requester<->agent dialogue, then lint and judge each spec',
  phases: [
    { title: 'Dialogue', detail: 'multi-round dialogue per case; fresh agent + fresh requester each round' },
    { title: 'Judge', detail: 'lint the spec and score recall / precision / scope / acceptability' },
  ],
}

const CASES = args.cases
const MAX_ROUNDS = args.maxRounds ?? 4
const CASE_ROOT = '/opt/pi-kit/tests/idea-to-spec/fixtures/cases'
// Every run gets its own directory. The first baseline shared /tmp/idea-eval/<slug>/work/
// with other concurrent sessions on this machine and one spec was overwritten mid-run.
const RUN_ID = args.runId
const SANDBOX = `/tmp/idea-eval/${RUN_ID}`

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['questions', 'spec', 'stop'] },
    questions: { type: 'string' },
    spec_path: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['kind', 'questions', 'rationale'],
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    recall: { type: 'number' },
    precision: { type: 'number' },
    scope: { type: 'number' },
    acceptability: { type: 'number' },
    inferences_over_third: { type: 'boolean' },
    hallucinations: { type: 'array', items: { type: 'string' } },
    missed: { type: 'array', items: { type: 'string' } },
    lint_errors: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['recall', 'precision', 'scope', 'acceptability', 'inferences_over_third', 'hallucinations', 'missed', 'lint_errors', 'notes'],
}

function agentPrompt(slug, transcript, round) {
  return `你在一次 Agent Skill 评测中扮演**开发同学（被测方）**。第 ${round} 轮。

## 用户的原始输入
（见下方「本轮上下文」中的 trigger）

## 你能读什么
- 工作目录 \`${SANDBOX}/${slug}/work\`（写产物到这里）
- 业务仓库 \`${SANDBOX}/${slug}/repo\`（如果存在）——这是你要取证的代码
- skill 文件 \`${SANDBOX}/skill/\`（你要遵循的流程）

## 禁令（违反即本次运行作废）
**严禁**读取以下任何来源：
- \`/opt/pi-kit/tests/\` 下任何文件；任何名字含 hidden / fixture / eval / case 的文件
- 任何 git 历史（git log / show / reflog）
- \`~/.claude/\` 下任何会话记录、历史、transcript、memory（尤其 history.jsonl）
- 任何其他 session 的对话记录或上下文缓存

你的输入**只有**下面给出的 trigger 与问答记录。不得用环境中任何其他线索推断用户意图。
（实测教训：曾有 agent 读了 \`~/.claude/history.jsonl\`，把宿主会话里用户的真实提问当成了自己的输入。）

## 你要遵循的流程
严格遵循 \`/tmp/idea-eval/skill/SKILL.md\` 及其 \`references/\` 的流程。你是被测方，必须完全按它的规定行动。

## 本轮上下文
trigger: 见下方
已有对话记录（如果为空则是首轮）：
${transcript || '（尚无对话，这是首轮）'}

## 你的任务（第 ${round} 轮）
- 如果 skill 判定还需要问，返回 kind="questions"，questions 写你本轮要问的全部问题。
- 如果 skill 判定已经可以成文，写完整 spec 到 \`${SANDBOX}/${slug}/work/spec.md\`，返回 kind="spec"，spec_path 写该路径。
- 如果 skill 判定必须停止（缺关键信息无法继续），返回 kind="stop"，questions 写你要停下来问的事。

rationale 用一句话说明你的判断依据。严格遵守 skill 里「每轮最多 3 个问题」这类约束。`
}

function requesterPrompt(slug, questions) {
  return `你在一次评测中扮演**需求方**。开发同学向你提了问题，你只回答被问到的内容。

## 你的背景材料
读 \`${CASE_ROOT}/${slug}/hidden.md\`（只有你能看）。严格按其中「事实」表的**「可问性」**列作答：
- 「直接回答」→ 正常回答
- 「给出具体例子/选项/数量级后才回答」→ 若对方只是抽象地问，就给模糊回答（如「越快越好」「反正常见的吧」「最好快点」）；只有对方给出具体例子、选项或数量级时，才给出真取向
- 「需求方也不知道」→ 回答「我也不知道」
- 「只对特定角色」→ 回答「这个我定不了，得问 X」

「需求方立场」一节决定你的身份和口吻。

## 严格规则
1. **只回答被问到的问题。** 不主动补充、不提示遗漏、不列举事实清单、不主动说出对方没问的事实。
2. 回答简短，1–3 句，像真人聊天。保持 hidden 里描述的情绪和口吻。
3. 不出戏：不提评测、不提 fixture、不提自己在扮演角色、不用 Markdown 表格或编号。
4. 只能依据 hidden.md 回答。hidden 里没有的事，回答「这个我不清楚」。

## 开发同学的问题
${questions}

返回 answer 字段，写你的回复全文。`
}

// A correct refusal to write a spec (case 02: the literal request was already satisfied)
// is better than emitting a spec that treats a solution as the requirement. Scoring the
// refusal the same way as "produced nothing" rewards always emitting something, which is
// the opposite of what the skill should do — so refusals get their own questions.
const REFUSAL_SCHEMA = {
  type: 'object',
  properties: {
    correct_block: { type: 'number' },
    false_stop: { type: 'number' },
    reasoning: { type: 'string' },
    should_have_asked: { type: 'array', items: { type: 'string' } },
  },
  required: ['correct_block', 'false_stop', 'reasoning', 'should_have_asked'],
}

function refusalPrompt(slug, transcript, status) {
  return `你是一次 Agent Skill 评测的**评委**。被测方**没有产出 spec**，而是停下来提问或报告阻塞（status=${status}）。
判断这个「拒绝成文」是否正确。

## 材料
1. 隐藏需求（评分基准）：\`${CASE_ROOT}/${slug}/hidden.md\`
2. 被测方与需求方的对话记录：
${transcript}
3. 评分口径：\`/opt/pi-kit/tests/idea-to-spec/EVAL-PROTOCOL.md\`

## 判断（0.0–1.0）
- **correct_block**：停止的理由是否成立？对照 hidden 判断——
  这个用例是否**真的**信息不足、或**真的**存在「字面诉求已被满足/决策人不在场」这类应停条件？
  理由成立给高分；理由不成立（本该能继续收敛却停下）给低分。
- **false_stop**：是否**过早**罢手？如果再问一轮就能收敛，而它没有问，给高分。
  真的不该继续（例如该用例核心就是要求转成探查或确认清单）给低分。
- **should_have_asked**：它遗漏了哪些本可以问、且问了就能推进的问题（对照 hidden 的事实表）。
- **reasoning**：一句话说明判断依据。

注意：correct_block 高 + false_stop 低 = 教科书式的正确停止；两者都高 = 该停但停早了；
correct_block 低 = 错误的停止，应视为严重缺陷。`
}

function judgePrompt(slug, specPath) {
  return `你是一次 Agent Skill 评测的**评委**。只依据产物打分，不看对话过程。

## 材料
1. 隐藏需求（评分基准）：\`${CASE_ROOT}/${slug}/hidden.md\`
2. 被测方产出的 spec：\`${specPath}\`
3. 机器检查：先运行
   \`node /opt/pi-kit/tests/idea-to-spec/lib/spec-lint.mjs ${specPath}\`
   把输出里的每条 error 记进 lint_errors（格式 "CODE: 一句话"）。
4. 评分口径全文：\`/opt/pi-kit/tests/idea-to-spec/EVAL-PROTOCOL.md\`（读它的「评分口径」一节）

## 打分（0.0–1.0）
- **recall**：hidden「事实」表中被问出来**并正确写进 spec** 的比例。漏一个扣一个。
- **precision**：spec 里每条断言是否都能追溯到「用户/需求方明确确认」「代码取证」或标了 [推断]。
  无法追溯 = 幻觉，重罚。若 spec 中标注 [推断] 的条目超过 AC 总数 1/3，inferences_over_third 置 true 且 precision 封顶 0.6。
- **scope**：spec 的「范围外」是否与 hidden 一致；是否把「未知」类事实正确转成探查/未决，而不是编一个 AC。
- **acceptability**：AC 是否为 EARS 句式、带具体例子、无「快速/友好/合理」这类不可判定词汇。
- **hallucinations**：逐条列出 spec 里出现、但 hidden 中查无依据的**具体断言**（具体数值、列名、原因、接口、时间窗）。
  含糊表述不算；具体编造才算。每条附上它声称的来源。
- **missed**：列出没被问出来的 hidden 事实编号（K 编号 + 一句话）。

只依据材料判断，不要脑补。notes 用一句话说这个用例上最大的失败模式。`
}

phase('Dialogue')

const results = await parallel(CASES.map((slug) => async () => {
  let transcript = ''
  let specPath = null
  let status = 'exhausted'
  let rounds = 0

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    rounds = round
    const step = await agent(agentPrompt(slug, transcript, round), {
      label: `agent:${slug}:r${round}`,
      phase: 'Dialogue',
      schema: STEP_SCHEMA,
    })
    if (!step) { status = 'agent-failed'; break }

    if (step.kind === 'spec') {
      specPath = step.spec_path || `${SANDBOX}/${slug}/work/spec.md`
      status = 'spec'
      break
    }
    if (step.kind === 'stop') {
      status = 'stopped'
      transcript += `\n### 第 ${round} 轮\n被测方停止并询问：\n${step.questions}\n`
      break
    }

    const reply = await agent(requesterPrompt(slug, step.questions), {
      label: `requester:${slug}:r${round}`,
      phase: 'Dialogue',
      schema: REPLY_SCHEMA,
    })
    transcript += `\n### 第 ${round} 轮\n被测方提问：\n${step.questions}\n\n需求方回答：\n${reply ? reply.answer : '（无回答）'}\n`
  }

  return { slug, status, rounds, specPath, transcript }
}))

phase('Judge')

const judged = await parallel(
  results.filter(Boolean).map((run) => async () => {
    if (!run.specPath) {
      // No spec: score the refusal instead of dropping the case from the mean.
      const refusal = await agent(refusalPrompt(run.slug, run.transcript, run.status), {
        label: `judge-refusal:${run.slug}`,
        phase: 'Judge',
        schema: REFUSAL_SCHEMA,
      })
      return { ...run, judge: null, refusal }
    }
    const judge = await agent(judgePrompt(run.slug, run.specPath), {
      label: `judge:${run.slug}`,
      phase: 'Judge',
      schema: JUDGE_SCHEMA,
    })
    return { ...run, judge }
  }),
)

const clean = judged.filter(Boolean)
const scored = clean.filter((r) => r.judge)
const mean = (pick) => (scored.length ? scored.reduce((sum, r) => sum + pick(r), 0) / scored.length : 0)

return {
  cases: clean.map((r) => ({
    slug: r.slug,
    status: r.status,
    rounds: r.rounds,
    spec: r.status === 'spec',
    refusal: r.refusal ?? null,
    recall: r.judge?.recall ?? null,
    precision: r.judge?.precision ?? null,
    scope: r.judge?.scope ?? null,
    acceptability: r.judge?.acceptability ?? null,
    hallucinations: r.judge?.hallucinations ?? [],
    missed: r.judge?.missed ?? [],
    notes: r.judge?.notes ?? '',
  })),
  means: {
    recall: mean((r) => r.judge.recall),
    precision: mean((r) => r.judge.precision),
    scope: mean((r) => r.judge.scope),
    acceptability: mean((r) => r.judge.acceptability),
    weighted: mean((r) => r.judge.recall * 0.3 + r.judge.precision * 0.3 + r.judge.scope * 0.2 + r.judge.acceptability * 0.2),
  },
  producedSpec: scored.length,
  refused: clean.filter((r) => r.refusal).length,
  totalCases: clean.length,
  meanCorrectBlock: (() => {
    const rs = clean.filter((r) => r.refusal)
    return rs.length ? rs.reduce((sum, r) => sum + r.refusal.correct_block, 0) / rs.length : null
  })(),
}

export const meta = {
  name: 'idea-to-spec-judge-v2',
  description: 'Re-judge archived idea-to-spec specs: requester-fidelity audit, 3 transcript-aware judges per case, calibration on planted hallucinations',
  phases: [
    { title: 'Calibrate', detail: '3 judges on a spec with 4 planted hallucinations' },
    { title: 'Fidelity', detail: 'audit requester answers against hidden.md' },
    { title: 'Judge', detail: '3 independent transcript-aware judges per case' },
  ],
}

// v1 judges compared specs against hidden.md only and never saw the dialogue. Most of the
// "fabricated quotes" they reported had in fact been said by the requester agent, which had
// improvised beyond hidden.md — so requester drift was being billed to the skill. v2 gives
// judges the transcript and makes them classify every assertion, and the metrics are computed
// here from those classifications rather than taken as a subjective 0-1 score.

const ROOT = '/opt/pi-kit/tests/idea-to-spec'
const RUN = `${ROOT}/runs/${args.run}`
const CASES = args.cases
const JUDGES = args.judges ?? 3

const ASSERTION = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    claimed_source: { type: 'string' },
    verdict: { type: 'string', enum: ['faithful', 'skill_hallucination', 'requester_drift', 'mislabel'] },
    evidence: { type: 'string' },
  },
  required: ['text', 'claimed_source', 'verdict', 'evidence'],
}
const FACT = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['recorded', 'recorded_wrong', 'not_asked', 'requester_withheld', 'correctly_open'] },
    evidence: { type: 'string' },
  },
  required: ['id', 'status', 'evidence'],
}
const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    assertions: { type: 'array', items: ASSERTION },
    facts: { type: 'array', items: FACT },
    files_opened: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['assertions', 'facts', 'files_opened', 'notes'],
}
const FIDELITY_SCHEMA = {
  type: 'object',
  properties: {
    drift: {
      type: 'array',
      items: {
        type: 'object',
        properties: { round: { type: 'number' }, said: { type: 'string' }, why_not_grounded: { type: 'string' } },
        required: ['round', 'said', 'why_not_grounded'],
      },
    },
    withheld: { type: 'array', items: { type: 'string' } },
    answers_total: { type: 'number' },
  },
  required: ['drift', 'withheld', 'answers_total'],
}

function judgePrompt(c, k) {
  const repo = c.repo ? `- 桩仓库（代码取证的唯一依据）：\`${c.repo}\`` : '- 本用例没有桩仓库：spec 里任何「代码取证」断言都无法成立'
  return `你是 Agent Skill 评测的**评委 #${k}**。你与其他评委独立工作，不要猜测他们的结论。

## 材料
- 隐藏需求：\`${c.hidden}\`
- **对话记录**（被测方与需求方的全部问答）：\`${c.transcript}\`
- 被测产物 spec：\`${c.spec}\`
${repo}

## 任务一：逐条分类 spec 里的**具体断言**

只收具体断言：数值、阈值、时间窗、列名/文件名/接口名、代码行号、错误码、引号引起的「原话」、
「需求方确认/用户确认/开发者判断」这类带来源的结论。泛泛描述不收。每条给出 verdict：

| verdict | 判定 |
|---|---|
| \`faithful\` | 来源成立：对话里确有其事（引语逐字或几乎逐字可找到），或代码里确实如此 |
| \`skill_hallucination\` | **对话里没有、代码里也没有**，却被写成事实或「确认」——这才是 skill 的错 |
| \`requester_drift\` | 对话里需求方确实说了，但 hidden.md 里没有依据——是需求方模拟器即兴发挥，**不算 skill 的错** |
| \`mislabel\` | 内容属实但来源标错（例如代码里的事实标成「需求方确认」，或推断标成「原话」） |

**硬规则**：
- 每一条代码断言（\`文件:行\`、文件名、接口、行为）都必须**实际打开文件核对**，并把打开过的文件写进 files_opened。
  没打开就不能判 faithful。
- 判 skill_hallucination 前，必须在对话记录里搜索过关键词。evidence 写你搜了什么、没找到。
- 被测方「先自造选项再让需求方选」的情况：如果需求方确实选了，算 faithful；但若 spec 把它写成需求方主动提出，算 mislabel。

## 任务二：hidden 事实的召回状态

对 hidden.md「事实」表的每个 K 编号给出 status：
- \`recorded\`：被问出并正确写进 spec
- \`recorded_wrong\`：写进了但写错了（含被错误地列入范围外）
- \`not_asked\`：被测方从没问到这个方向（对话里找不到相关提问）——skill 的错
- \`requester_withheld\`：被测方问了，但需求方没按 hidden 给出该给的答案——模拟器的错
- \`correctly_open\`：未知/只对特定角色类事实，被正确列为未决、探查或确认清单

只依据材料，不要脑补。notes 一句话。`
}

function fidelityPrompt(c) {
  return `你在审计一次评测里**需求方模拟器**是否守规矩。它本应只依据 hidden.md 回答，hidden 里没有的事应答「这个我不清楚」。

- 隐藏需求：\`${c.hidden}\`
- 对话记录：\`${c.transcript}\`

逐条读「需求方回答」：
- drift：需求方说出的**具体内容**（数值、授权、新需求、新范围、技术偏好、引语）在 hidden.md 里找不到依据的，逐条列出（轮次 + 原文 + 为什么无据）。
  语气、情绪、复述被测方选项不算 drift。
- withheld：被测方明确问到、hidden 里也有、但需求方没给出（或给错）的事实 K 编号。
- answers_total：需求方回答的总轮数。`
}

const CAL = {
  slug: 'calibration-02',
  hidden: `${ROOT}/fixtures/cases/02-solution-that-exists-already/hidden.md`,
  transcript: `${ROOT}/calibration/planted-02.transcript.md`,
  spec: `${ROOT}/calibration/planted-02.spec.md`,
  repo: `${ROOT}/fixtures/cases/02-solution-that-exists-already/repo`,
}
const PLANTS = [
  { id: 'P1', keys: ['导三次'] },
  { id: 'P2', keys: ['1.5 秒', '1.5秒'] },
  { id: 'P3', keys: ['orders.ts:30'] },
  { id: 'P4', keys: ['orders_export'] },
]
// Native hallucination already present in the source spec (see ANSWER-KEY.md N1). Flagging it is
// correct, not a false positive — the first smoke run miscounted it because the script only knew
// about the planted items.
const NATIVE = [{ id: 'N1', keys: ['数据库直取', '人工从后台', '后台或数据库'] }]
const caught = (r, keys) =>
  !!r && r.assertions.some((a) => a.verdict !== 'faithful' && keys.some((k) => a.text.includes(k) || a.evidence.includes(k)))

phase('Calibrate')
const calRuns = (await parallel(Array.from({ length: JUDGES }, (_, i) => () =>
  agent(judgePrompt(CAL, i + 1), { label: `calibrate:j${i + 1}`, phase: 'Calibrate', schema: JUDGE_SCHEMA }),
))).filter(Boolean)
const calibration = calRuns.map((r, i) => ({
  judge: i + 1,
  caught: PLANTS.filter((p) => caught(r, p.keys)).map((p) => p.id),
  native: NATIVE.filter((p) => caught(r, p.keys)).map((p) => p.id),
  opened: r.files_opened.length,
  falsePositives: r.assertions.filter((a) => a.verdict === 'skill_hallucination'
    && ![...PLANTS, ...NATIVE].some((p) => p.keys.some((k) => a.text.includes(k) || a.evidence.includes(k)))).map((a) => a.text),
}))
log(`calibration: ${calibration.map((c) => `j${c.judge} ${c.caught.length}/4`).join(', ')}`)

const median = (xs) => {
  const s = xs.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b)
  if (!s.length) return null
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const metrics = (r) => {
  const a = r.assertions
  const n = a.length || 1
  const count = (v) => a.filter((x) => x.verdict === v).length
  const f = r.facts
  const skillable = f.filter((x) => x.status !== 'requester_withheld').length || 1
  return {
    assertions: a.length,
    skill_hallucination: count('skill_hallucination'),
    mislabel: count('mislabel'),
    requester_drift: count('requester_drift'),
    // precision charges the skill only for what it can be blamed for
    precision: 1 - (count('skill_hallucination') + 0.5 * count('mislabel')) / n,
    // recall excludes facts the simulator failed to give when asked
    recall: f.filter((x) => x.status === 'recorded' || x.status === 'correctly_open').length / skillable,
    not_asked: f.filter((x) => x.status === 'not_asked').map((x) => x.id),
    withheld: f.filter((x) => x.status === 'requester_withheld').map((x) => x.id),
  }
}

const caseInputs = CASES.map((slug) => ({
  slug,
  hidden: `${ROOT}/fixtures/cases/${slug}/hidden.md`,
  transcript: `${RUN}/transcripts/${slug}.md`,
  spec: `${RUN}/${slug}.spec.md`,
  repo: args.repoless?.includes(slug) ? null : `${ROOT}/fixtures/cases/${slug}/repo`,
}))

const perCase = await pipeline(
  caseInputs,
  (c) => agent(fidelityPrompt(c), { label: `fidelity:${c.slug}`, phase: 'Fidelity', schema: FIDELITY_SCHEMA })
    .then((fid) => ({ c, fid })),
  async ({ c, fid }) => {
    const runs = (await parallel(Array.from({ length: JUDGES }, (_, i) => () =>
      agent(judgePrompt(c, i + 1), { label: `judge:${c.slug}:j${i + 1}`, phase: 'Judge', schema: JUDGE_SCHEMA }),
    ))).filter(Boolean)
    const ms = runs.map(metrics)
    const pick = (k) => median(ms.map((m) => m[k]))
    const spread = (k) => {
      const v = ms.map((m) => m[k])
      return v.length ? Math.max(...v) - Math.min(...v) : null
    }
    return {
      slug: c.slug,
      judges: ms.length,
      precision: pick('precision'),
      recall: pick('recall'),
      skill_hallucination: pick('skill_hallucination'),
      mislabel: pick('mislabel'),
      requester_drift_judged: pick('requester_drift'),
      precision_spread: spread('precision'),
      recall_spread: spread('recall'),
      fidelity_drift: fid ? fid.drift.length : null,
      fidelity_withheld: fid ? fid.withheld : [],
      not_asked_per_judge: ms.map((m) => m.not_asked),
      drift_examples: fid ? fid.drift.slice(0, 4).map((d) => `r${d.round}: ${d.said}`) : [],
      hallucination_examples: runs.flatMap((r) => r.assertions.filter((a) => a.verdict === 'skill_hallucination').map((a) => a.text)).slice(0, 6),
    }
  },
)

const ok = perCase.filter(Boolean)
const avg = (k) => {
  const v = ok.map((x) => x[k]).filter((x) => typeof x === 'number')
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}
return {
  calibration,
  cases: ok,
  means: {
    precision: avg('precision'),
    recall: avg('recall'),
    skill_hallucination: avg('skill_hallucination'),
    requester_drift: avg('fidelity_drift'),
    precision_spread: avg('precision_spread'),
    recall_spread: avg('recall_spread'),
  },
}

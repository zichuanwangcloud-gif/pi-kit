#!/usr/bin/env node
// Deterministic checker for spec documents produced by the `idea-to-spec` skill.
//
// Why this exists: the skill's whole value claim is that its output is verifiable rather than
// plausible-sounding. Prose review cannot decide that — the failure mode is a spec that reads
// well and asserts things nobody confirmed. This checker makes the mechanical half of that
// claim executable: unlabelled assertions, adjective-only criteria, criteria with no example,
// orphan criteria, leftover placeholders, and a status that overstates readiness.
//
// It deliberately judges FORM, not truth. Whether an assertion matches the hidden requirement
// is what the evaluation harness and its reviewer agent are for. Everything here is a property
// of the document alone, so it is cheap, deterministic and safe to run in CI.

import { readFileSync } from "node:fs";

// --- vocabulary ---------------------------------------------------------------------------

// Adjective criteria. "Correct", "friendly", "fast" cannot be judged by anyone, so a criterion
// containing one is not acceptance criteria, however reasonable it sounds.
const VAGUE = [
	"快速", "较快", "友好", "合理", "良好", "用户友好", "流畅", "显著", "大幅", "优化",
	"尽快", "及时", "高效", "完善", "健壮", "美观", "舒适", "灵活", "稳定", "安全",
	"properly", "correctly", "friendly", "reasonably", "appropriately", "quickly",
	"fast", "robust", "seamless", "intuitive", "efficient", "optimized",
];

// Markers that legitimately excuse an assertion from the "confirmed" requirement.
const PROVENANCE = ["用户确认", "需求方确认", "开发者判断", "推断", "[推断]", "代码", "现状"];

// Placeholder residue: a spec that still carries these was never finished.
const PLACEHOLDERS = ["...", "TBD", "待补充", "后续完善", "同上", "<!--", "xxx", "XXX", "待定"];

// EARS has five forms. The baseline run showed the original pattern rejecting legitimate
// ones ("在任一语言下……不应当超出父容器"), so accept the whole family rather than one spelling:
//   ubiquitous  系统应当/不应当 <行为>
//   event       当 <事件> 时，……
//   state       在 <状态>（期间/下/时），……
//   option      如果 <条件>，那么……
//   unwanted    如果 <条件>，那么系统不应当……
const EARS_PATTERN = /(?:当[^，,]{1,60}(?:时|后|前)|如果[^，,]{1,60}那么|在[^，,]{1,60}(?:期间|下|时|内)|系统(?:应当|不应|应|必须|不得|不)|(?:应当|不应当|不得|必须))/;

// --- parsing -------------------------------------------------------------------------------

function sections(markdown) {
	const out = new Map();
	let current = null;
	for (const line of markdown.split(/\r?\n/)) {
		const heading = line.match(/^##\s+(.+?)\s*$/);
		if (heading) {
			current = heading[1];
			out.set(current, []);
			continue;
		}
		if (current) out.get(current).push(line);
	}
	return out;
}

function tableRows(lines) {
	const rows = [];
	for (const line of lines) {
		if (!line.trim().startsWith("|")) continue;
		const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
		if (!cells.length) continue;
		if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue; // separator
		rows.push(cells);
	}
	return rows;
}

function stripComments(text) {
	return text.replace(/<!--[\s\S]*?-->/g, "");
}

// An exploration spec answers questions instead of shipping behaviour, so it legitimately has no
// 「验收标准」/「反向推演」 sections. Judging it by the functional structure produced four
// meaningless errors on the baseline run; detect it and swap in the checks that apply.
function isExploration(sections, raw) {
	const status = (sections.get("__preamble__") ?? []).join("\n");
	if (/状态[:：]\s*探查/.test(status)) return true;
	const first = raw.split(/\r?\n/).find((line) => line.startsWith("#")) ?? "";
	if (/^#\s*探查/.test(first)) return true;
	return sections.has("待回答的问题");
}

// --- checks --------------------------------------------------------------------------------

function checkAcceptanceCriteria(sections, findings) {
	const lines = sections.get("验收标准");
	if (!lines) {
		findings.push({ level: "error", code: "AC-SECTION-MISSING", message: "缺少「验收标准」段" });
		return;
	}
	const rows = tableRows(lines);
	if (!rows.length) {
		findings.push({ level: "error", code: "AC-TABLE-MISSING", message: "「验收标准」段没有表格行" });
		return;
	}
	const header = rows[0].map((cell) => cell.replace(/\s/g, ""));
	if (!header.includes("EARS句式") && !header.some((cell) => cell.includes("EARS"))) {
		findings.push({ level: "warn", code: "AC-HEADER", message: "「验收标准」表头缺少 EARS 句式列" });
	}
	const body = rows.slice(1);
	if (!body.length) {
		findings.push({ level: "error", code: "AC-EMPTY", message: "「验收标准」表只有表头" });
	}
	const goals = new Set(
		[...(sections.get("目标结果") ?? []).join("\n").matchAll(/\bG\d+\b/g)].map((m) => m[0]),
	);
	for (const cells of body) {
		const id = cells[0] ?? "?";
		const criterion = cells[1] ?? "";
		const goal = cells[2] ?? "";
		const example = cells[3] ?? "";
		const source = cells[4] ?? "";

		if (!criterion.trim()) {
			findings.push({ level: "error", code: "AC-EMPTY-CELL", message: `${id} 没有内容` });
			continue;
		}
		if (!EARS_PATTERN.test(criterion)) {
			findings.push({
				level: "error",
				code: "AC-NOT-EARS",
				message: `${id} 不是 EARS 句式：${criterion.slice(0, 40)}`,
			});
		}
		for (const word of VAGUE) {
			if (criterion.includes(word)) {
				findings.push({
					level: "error",
					code: "AC-VAGUE",
					message: `${id} 用了不可判定的词「${word}」：${criterion.slice(0, 40)}`,
				});
				break;
			}
		}
		// A criterion with no example is not yet a test case, so nobody can agree on it.
		if (example.replace(/[—\-\s]/g, "").length < 6) {
			findings.push({ level: "error", code: "AC-NO-EXAMPLE", message: `${id} 没有具体例子` });
		}
		if (!goal.match(/\bG\d+\b/)) {
			findings.push({ level: "error", code: "AC-ORPHAN", message: `${id} 没有支撑的目标结果（孤儿 AC）` });
		} else if (goals.size && !goals.has(goal.match(/\bG\d+\b/)[0])) {
			findings.push({
				level: "error",
				code: "AC-DANGLING-GOAL",
				message: `${id} 引用了不存在的目标结果 ${goal}`,
			});
		}
		// Provenance: an assertion that is neither confirmed, nor inferred, nor backed by code
		// is the shape a hallucination takes. This is the check that earns its keep.
		if (!PROVENANCE.some((mark) => source.includes(mark))) {
			findings.push({
				level: "error",
				code: "AC-NO-PROVENANCE",
				message: `${id} 的来源「${source}」没有标明确认/推断/代码任一来源`,
			});
		}
	}
}

function checkNegativeCriterion(sections, findings) {
	const rows = tableRows(sections.get("验收标准") ?? []).slice(1);
	const hasNegative = rows.some((cells) => /不应当|不得|拒绝|保持原状|提示|报错|不受影响/.test(cells[1] ?? ""));
	if (!hasNegative) {
		findings.push({
			level: "warn",
			code: "AC-NO-NEGATIVE",
			message: "没有负向/边界 AC；若确实不存在须写明理由",
		});
	}
}

function checkReverseReasoning(sections, findings) {
	const text = (sections.get("反向推演") ?? []).join("\n");
	if (!text.trim()) {
		findings.push({ level: "error", code: "REVERSE-MISSING", message: "缺少「反向推演」段" });
		return;
	}
	// Each answer must be dispositioned, not necessarily in one blessed wording. The baseline
	// run flagged a spec that wrote "已由 AC3 覆盖" / "无法补成 AC，理由…" — those ARE
	// dispositions, so accept the equivalent phrasings.
	if (!/已补|补成|补\s*AC|列入范围外|归入范围外|范围外|已由\s*AC\d*\s*覆盖|由\s*AC\d+\s*覆盖|已覆盖|写成\s*AC|转为\s*AC/.test(text)) {
		findings.push({
			level: "error",
			code: "REVERSE-UNPROCESSED",
			message: "反向推演没有说明每个答案的处置（补 AC / 已由某 AC 覆盖 / 列入范围外）",
		});
	}
}

function checkReverseReasoningBacking(sections, findings) {
	const text = (sections.get("反向推演") ?? []).join("\n");
	// "It cannot happen" is only an answer when something backs it.
	if (/不会/.test(text) && !/文件:行|`[^`]+:\d+|代码|实测|复现/.test(text)) {
		findings.push({
			level: "warn",
			code: "REVERSE-UNBACKED",
			message: "反向推演答「不会」但没有给出依据（代码位置或复现）",
		});
	}
}

function checkSelfCheck(sections, findings) {
	const rows = tableRows(sections.get("八项自检") ?? []).slice(1);
	if (!rows.length) {
		findings.push({ level: "error", code: "SELFCHECK-MISSING", message: "缺少「八项自检」表" });
		return;
	}
	if (rows.length !== 8) {
		findings.push({
			level: "error",
			code: "SELFCHECK-COUNT",
			message: `八项自检只有 ${rows.length} 行`,
		});
	}
	const unresolved = rows.filter((cells) => /未通过/.test(cells.join(" "))).length;
	const text = (sections.get("八项自检") ?? []).join("\n");
	const declared = text.match(/缺口数[:：]\s*(\d+)/);
	if (!declared) {
		findings.push({ level: "error", code: "SELFCHECK-GAPS", message: "没有写出缺口数" });
		return unresolved;
	}
	if (Number(declared[1]) !== unresolved) {
		findings.push({
			level: "error",
			code: "SELFCHECK-GAPS-MISMATCH",
			message: `缺口数写的是 ${declared[1]}，实际未通过 ${unresolved} 项`,
		});
	}
	return unresolved;
}

function checkStatus(sections, findings, gaps, exploration) {
	const text = (sections.get("__preamble__") ?? []).join("\n");
	const status = text.match(/状态[:：]\s*(可开工|待需求方确认|草稿|探查)/);
	if (!status) {
		findings.push({ level: "error", code: "STATUS-MISSING", message: "文档头没有状态标记" });
		return;
	}
	const value = status[1];
	// Open questions may be a table or a plain bullet list; count either shape.
	const openQuestions = (sections.get("未决问题") ?? [])
		.filter((line) => /^\s*(?:\||-|\*)\s/.test(line) && /\bQ\d+\b/.test(line)).length;
	const checklist = (sections.get("需求方确认清单") ?? [])
		.filter((line) => /^\s*-\s*\[\s\]/.test(line)).length;

	if (value === "可开工") {
		if (gaps > 0) {
			findings.push({
				level: "error",
				code: "STATUS-OVERSTATED",
				message: `状态标「可开工」但自检有 ${gaps} 个缺口`,
			});
		}
		if (checklist > 0) {
			findings.push({
				level: "error",
				code: "STATUS-OVERSTATED-CHECKLIST",
				message: `状态标「可开工」但需求方确认清单还有 ${checklist} 条未确认`,
			});
		}
		if (openQuestions > 0) {
			findings.push({
				level: "error",
				code: "STATUS-OVERSTATED-OPEN",
				message: `状态标「可开工」但还有 ${openQuestions} 条未决问题`,
			});
		}
	}
}

function checkPlaceholders(sections, findings, raw) {
	const body = stripComments(raw);
	for (const token of PLACEHOLDERS) {
		if (body.includes(token)) {
			findings.push({
				level: "error",
				code: "PLACEHOLDER",
				message: `残留占位符「${token}」`,
			});
		}
	}
}

function checkScopeAndConstraints(sections, findings) {
	if (!(sections.get("范围外") ?? []).join("").trim()) {
		findings.push({ level: "error", code: "SCOPE-MISSING", message: "缺少「范围外」段（边界未画出）" });
	}
	const constraints = (sections.get("约束（非功能）") ?? []).join("\n");
	if (!constraints.trim()) {
		findings.push({ level: "warn", code: "CONSTRAINTS-MISSING", message: "缺少「约束（非功能）」段" });
	} else if (!/不相关|无关/.test(constraints) && !/ms|毫秒|秒|条|%|次|并发|兼容|权限|迁移|日志/.test(constraints)) {
		findings.push({
			level: "warn",
			code: "CONSTRAINTS-VAGUE",
			message: "约束段既没有可判定的值，也没有写明「不相关」",
		});
	}
}

function checkExploration(sections, findings) {
	const questions = tableRows(sections.get("待回答的问题") ?? []).slice(1);
	if (!questions.length) {
		findings.push({
			level: "error",
			code: "EXPLORE-NO-QUESTIONS",
			message: "探查型 spec 缺少「待回答的问题」表",
		});
	} else {
		for (const cells of questions) {
			const id = cells[0] ?? "?";
			if (!(cells[2] ?? "").trim()) {
				findings.push({ level: "error", code: "EXPLORE-NO-METHOD", message: `${id} 没有写回答方式` });
			}
			if (!(cells[3] ?? "").trim()) {
				findings.push({ level: "error", code: "EXPLORE-NO-CRITERION", message: `${id} 没有写判定标准` });
			}
		}
	}
	// A time box is what makes an exploration safe to start; without one it is open-ended work.
	const all = [...sections.values()].flat().join("\n");
	if (!/时间盒|timebox|人日|天内|周内|小时/.test(all)) {
		findings.push({ level: "error", code: "EXPLORE-NO-TIMEBOX", message: "探查型 spec 没有时间盒" });
	}
	// The result must say what happens next, or the exploration leads nowhere.
	if (!/结论\s*→\s*下一步|下一步|结论与下一步/.test(all)) {
		findings.push({
			level: "error",
			code: "EXPLORE-NO-NEXT-STEP",
			message: "探查型 spec 没有「结论 → 下一步」映射",
		});
	}
}

// --- entry point ---------------------------------------------------------------------------

/**
 * @param {string} markdown a spec produced by idea-to-spec
 * @returns {{findings: Array<{level: string, code: string, message: string}>, summary: object}}
 */
export function lintSpec(markdown) {
	const findings = [];
	const preamble = markdown.split(/^##\s/m)[0];
	const doc = sections(markdown);
	doc.set("__preamble__", preamble.split(/\r?\n/));

	const exploration = isExploration(doc, markdown);
	if (exploration) {
		checkExploration(doc, findings);
	} else {
		checkAcceptanceCriteria(doc, findings);
		checkNegativeCriterion(doc, findings);
		checkReverseReasoning(doc, findings);
		checkReverseReasoningBacking(doc, findings);
	}
	const gaps = checkSelfCheck(doc, findings) ?? 0;
	checkStatus(doc, findings, gaps, exploration);
	checkPlaceholders(doc, findings, markdown);
	if (!exploration) checkScopeAndConstraints(doc, findings);

	const errors = findings.filter((f) => f.level === "error");
	const warnings = findings.filter((f) => f.level === "warn");
	const acCount = tableRows(doc.get("验收标准") ?? []).slice(1).length;
	// A single score so iteration rounds can be compared without arguing about weighting.
	const score = Math.max(0, 100 - errors.length * 10 - warnings.length * 3);
	return {
		findings,
		summary: { errors: errors.length, warnings: warnings.length, acCount, score, gaps },
	};
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
	const file = process.argv[2];
	if (!file) {
		console.error("usage: spec-lint.mjs <spec.md>");
		process.exit(2);
	}
	const { findings, summary } = lintSpec(readFileSync(file, "utf8"));
	for (const finding of findings) console.log(`[${finding.level}] ${finding.code}: ${finding.message}`);
	console.log(
		`errors=${summary.errors} warnings=${summary.warnings} ac=${summary.acCount} gaps=${summary.gaps} score=${summary.score}`,
	);
	process.exit(summary.errors ? 1 : 0);
}

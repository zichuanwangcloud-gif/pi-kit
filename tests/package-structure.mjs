import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Policy assertions match prose that authors re-wrap freely. Compare with whitespace
// collapsed so a line break inside a required phrase is not a false failure.
const flat = (text) => text.replace(/\s+/gu, " ");
const carries = (content, rule) => flat(content).includes(flat(rule));
const developmentSkills = [
	"ci-triage",
	"review-resolver",
	"change-impact",
	"test-gap",
	"schema-migration-audit",
	"api-contract-audit",
	"release-readiness",
	"dependency-upgrade",
	"incident-triage",
];
const required = [
	"package.json",
	"README.md",
	"extensions/kit-help.ts",
	"extensions/skill-runner.ts",
	"extensions/engineering-loop/index.ts",
	"extensions/engineering-loop/parser.ts",
	"extensions/engineering-loop/types.ts",
	"extensions/engineering-loop/utils.ts",
	"skills/feature-trace/SKILL.md",
	"skills/linear-to-pr/SKILL.md",
	"skills/linear-to-pr/scripts/fetch-linear-issue.mjs",
	"skills/linear-to-pr/scripts/update-issue-state.mjs",
	"skills/pr-audit/SKILL.md",
	"skills/linear-pr-audit/SKILL.md",
	"skills/linear-pr-audit/scripts/post-linear-comment.mjs",
	...developmentSkills.map((name) => `skills/${name}/SKILL.md`),
	"docs/CONTRIBUTING.md",
	"docs/MIGRATION.md",
	"docs/experience/pr-audit.md",
	"docs/experience/linear-pr-audit.md",
	"docs/experience/development-skills.md",
];

for (const path of required) await access(resolve(root, path), constants.R_OK);

const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!manifest.keywords?.includes("pi-package")) throw new Error("package.json is missing pi-package keyword");
if (!manifest.keywords?.includes("ci-triage") || !manifest.keywords?.includes("incident-response")) {
	throw new Error("package.json metadata does not advertise the development workflows");
}
if (!manifest.pi?.extensions?.length || !manifest.pi?.skills?.length) throw new Error("Pi resource manifest is incomplete");
if (!manifest.pi.skills.includes("./skills")) throw new Error("Pi manifest must discover the project-neutral skills directory");
if (manifest.pi.extensions.some((path) => /cloudrouter/i.test(path))) {
	throw new Error("Pi extension manifest contains a project-specific name");
}

function frontmatter(content, path) {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error(`${path} is missing Agent Skills frontmatter`);
	const values = new Map();
	for (const line of match[1].split(/\r?\n/)) {
		const field = line.match(/^([a-z][a-z0-9-]*):\s*(.*)$/);
		if (field) values.set(field[1], field[2].trim());
	}
	return values;
}

for (const name of developmentSkills) {
	const path = `skills/${name}/SKILL.md`;
	const content = await readFile(resolve(root, path), "utf8");
	const fields = frontmatter(content, path);
	const skillName = fields.get("name");
	const description = fields.get("description") ?? "";
	if (skillName !== name || basename(dirname(path)) !== skillName) {
		throw new Error(`${path} frontmatter name must match its directory`);
	}
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) || skillName.length > 64) {
		throw new Error(`${path} has an invalid Agent Skills name`);
	}
	if (!description || description.length > 1024) throw new Error(`${path} has an invalid description`);
	if (!fields.get("compatibility") || !fields.get("allowed-tools")) {
		throw new Error(`${path} must document compatibility and allowed tools`);
	}
	const requiredPolicies = [
		[/不[^。\n]{0,20}push/i, "no push"],
		[/不[^。\n]{0,40}(?:修改|改)[^。\n]{0,20}PR/i, "no PR mutation"],
		[/不[^。\n]{0,20}部署/i, "no deploy"],
		[/主工作区/, "do not touch the primary workspace"],
	];
	for (const [pattern, label] of requiredPolicies) {
		if (!pattern.test(content)) throw new Error(`${path} is missing safety policy: ${label}`);
	}
	if (name !== "review-resolver" && /allowed-tools:.*\b(?:edit|write)\b/.test(content)) {
		throw new Error(`${path} must remain read-only`);
	}
}

const reviewResolver = await readFile(resolve(root, "skills/review-resolver/SKILL.md"), "utf8");
for (const rule of ["默认模式是**只读分析**", "用户确认计划", "隔离任务分支/worktree", "不授权 push"]) {
	if (!carries(reviewResolver, rule)) throw new Error(`review-resolver is missing edit gate: ${rule}`);
}

const linearSkill = await readFile(resolve(root, "skills/linear-to-pr/SKILL.md"), "utf8");
const requiredAutoPrRules = [
	"自动提交、普通 push 当前任务分支",
	"创建到已确认 base 的 PR",
	"不得停下重复询问",
	"不要自动 merge、approve 或 ready",
];
for (const rule of requiredAutoPrRules) {
	if (!carries(linearSkill, rule)) throw new Error(`linear-to-pr is missing auto-PR rule: ${rule}`);
}

// Status writeback: these three invariants regress silently if someone
// "simplifies" the matching rule, drops the opt-out, or widens the grant.
const requiredStatusRules = [
	"type=started",
	"--no-status",
	"回写 Linear 评论",
];
for (const rule of requiredStatusRules) {
	if (!linearSkill.includes(rule)) throw new Error(`linear-to-pr is missing status rule: ${rule}`);
}

// The read-only fetch path must stay mutation-free: pr-audit promises it never
// runs a Linear mutation, and that promise is only verifiable at file level.
const fetchScript = await readFile(resolve(root, "skills/linear-to-pr/scripts/fetch-linear-issue.mjs"), "utf8");
if (/\bmutation\b|issueUpdate/.test(fetchScript)) {
	throw new Error("fetch-linear-issue.mjs must stay read-only; put mutations in update-issue-state.mjs");
}
const stateScript = await readFile(resolve(root, "skills/linear-to-pr/scripts/update-issue-state.mjs"), "utf8");
if (!/issueUpdate/.test(stateScript) || !/"started"/.test(stateScript)) {
	throw new Error("update-issue-state.mjs must set the issue to its team's started state via issueUpdate");
}

const prAuditSkill = await readFile(resolve(root, "skills/pr-audit/SKILL.md"), "utf8");
const requiredAuditRules = [
	"三个 Gate 都必须 `PASS`，即 **3 PASS**",
	"二者都 `PASS`，即 **2 PASS**",
	"第一版始终只输出到 Pi",
	"不自动安装未知工具",
	"S/A/B/C/D/F",
];
for (const rule of requiredAuditRules) {
	if (!carries(prAuditSkill, rule)) throw new Error(`pr-audit is missing policy: ${rule}`);
}
if (/^allowed-tools:.*\b(?:edit|write)\b/m.test(prAuditSkill)) {
	throw new Error("pr-audit must stay read-only; acceptance writeback belongs to linear-pr-audit");
}

const linearPrAuditPath = "skills/linear-pr-audit/SKILL.md";
const linearPrAuditSkill = await readFile(resolve(root, linearPrAuditPath), "utf8");
const linearPrAuditFields = frontmatter(linearPrAuditSkill, linearPrAuditPath);
if (linearPrAuditFields.get("name") !== "linear-pr-audit") {
	throw new Error(`${linearPrAuditPath} frontmatter name must match its directory`);
}
for (const field of ["description", "compatibility", "allowed-tools"]) {
	if (!linearPrAuditFields.get(field)) throw new Error(`${linearPrAuditPath} is missing ${field}`);
}
const requiredLinearPrAuditRules = [
	// Four-gate accounting: Acceptance is never optional and never averaged away.
	"四门都必须 `PASS`，即 **4/4 PASS**",
	// Self-certification guards: the auditor may fix code, but may not move the goalposts.
	"禁止修改或删除既有测试",
	"临时验收测试不提交",
	"本次审计推送的修复 commit",
	// Write-boundary guards.
	"禁止 force push",
	"无法 push 时降级为只读 patch 输出",
	"不部署",
	"不触碰主工作区",
	// Report gating and idempotency.
	"验收未全部 PASS 前不发送自测报告",
	"post-linear-comment.mjs",
	"pi-kit:linear-pr-audit:",
];
for (const rule of requiredLinearPrAuditRules) {
	if (!carries(linearPrAuditSkill, rule)) throw new Error(`linear-pr-audit is missing policy: ${rule}`);
}
// PR #2 removed the letter grade scale as redundant with gate status. Kept instead, because
// linear-pr-audit uses the grade CEILING as its disclosure channel for "passed, with caveats"
// (waiver -> A, author self-signed -> B, auditor pushed commits -> A). Gate status alone is
// binary and cannot carry that. The scale is asserted present above; do not re-add a ban here.

// PR #2 enforced a 150/180-line trunk here. Raised to the universal 500-line check above,
// deliberately: the Agent Skills budget anchor is 500 (Anthropic best practices, the agentskills.io
// spec, and Cursor rules all converge there), and an adversarial audit of the hardening pass
// required specific load-bearing rules to stay INLINE in the trunk rather than in references/ --
// the gate form, the mock-in-diff-surface ban, "absolute thresholds must not be judged on the audit
// machine", and the grade-ceiling list. A 150-line trunk cannot hold those. The audit also found
// that the MANDATORY-read reference set grew faster than the trunk shrank, so more aggressive
// extraction is not automatically cheaper. Revisit by observing which references a real run opens.

// Portability and shell-compatibility regressions caught in review.
for (const path of [...developmentSkills, "feature-trace", "linear-to-pr", "pr-audit", "linear-pr-audit"]) {
	const files = [`skills/${path}/SKILL.md`];
	for (const file of files) {
		const content = await readFile(resolve(root, file), "utf8");
		// Only executable code counts. Prose and inline-code MENTIONS of a banned construct are how
		// the skill documents the ban, and a line that forbids a pattern necessarily contains it.
		// So: scan inside ```bash fences only, with trailing comments stripped.
		const code = [...content.matchAll(/^```bash\n([\s\S]*?)^```/gm)]
			.flatMap((m) => m[1].split(/\r?\n/))
			.map((line) => line.replace(/#.*$/, ""))
			.join("\n");
		if (/find\s+\.\.\s/.test(code)) {
			throw new Error(`${file} scans the parent directory; scope discovery to the current repository`);
		}
		if (/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code)) {
			throw new Error(`${file} uses bash 4+ case conversion; use tr for portability`);
		}
		if (/loop-blocked/.test(content)) {
			throw new Error(`${file} emits <loop-blocked>, which only the engineering-loop extension parses; ask the user directly`);
		}
	}
}

const discoverabilityFiles = ["README.md", "docs/MIGRATION.md", "docs/experience/development-skills.md", "extensions/kit-help.ts"];
for (const path of discoverabilityFiles) {
	const content = await readFile(resolve(root, path), "utf8");
	for (const name of developmentSkills) {
		if (!content.includes(name)) throw new Error(`${path} does not advertise ${name}`);
	}
}
const help = await readFile(resolve(root, "extensions/kit-help.ts"), "utf8");
if (!help.includes('case "development"') || !help.includes("/help development")) {
	throw new Error("/help is missing the development skills topic");
}

// Progressive disclosure: a SKILL.md may delegate detail to `references/*.md`. Every such
// pointer must resolve, every reference file must be substantive, and all of them are held to
// the same portability rules as the skills themselves.
const skillsDir = resolve(root, "skills");
const skillNames = (await readdir(skillsDir, { withFileTypes: true }))
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.sort();

const referenceFiles = [];
for (const name of skillNames) {
	const skillPath = `skills/${name}/SKILL.md`;
	const content = await readFile(resolve(root, skillPath), "utf8");

	let present = [];
	try {
		present = (await readdir(resolve(skillsDir, name, "references")))
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	// Pointers written as `references/foo.md` or bare `foo.md` inside a references sentence.
	const cited = new Set(
		[...content.matchAll(/references\/([a-z0-9-]+\.md)/gu)].map((match) => match[1]),
	);
	for (const file of cited) {
		if (!present.includes(file)) {
			throw new Error(`${skillPath} cites references/${file}, which does not exist`);
		}
	}

	// Official Agent Skills budget: keep the SKILL.md body under 500 lines and move detail into
	// references/. Three independent sources converge on this number, so enforce it rather than
	// rediscovering the drift later.
	const bodyLines = content.split(/\r?\n/).length;
	if (bodyLines > 500) {
		throw new Error(`${skillPath} is ${bodyLines} lines; keep the body under 500 and move detail into references/`);
	}

	for (const file of present) {
		const path = `skills/${name}/references/${file}`;
		const body = await readFile(resolve(root, path), "utf8");
		if (body.split(/\r?\n/).length < 20) {
			throw new Error(`${path} is too thin to justify a separate reference file`);
		}
		if (!cited.has(file)) {
			throw new Error(`${path} is never referenced from ${skillPath}; it would never be loaded`);
		}
		referenceFiles.push(path);
	}
}

const portableFiles = [
	...new Set([
		...required.filter((path) => /^(README|package\.json|extensions|skills|docs)/.test(path)),
		...referenceFiles,
		"docs/experience/engineering-loop.md",
		"docs/experience/linear-to-pr.md",
		"docs/experience/pi-extension-notes.md",
	]),
];
const forbiddenProjectBindings = [
	[/CloudRouter/i, "legacy repository name"],
	[/clouditera/i, "legacy project namespace"],
	[/\/opt\/CloudRouter/i, "legacy absolute repository path"],
	[/团队 key 固定为\s*`?CR`?/i, "fixed Linear team key"],
	[/\/(?:opt|home|Users)\/[a-z0-9._-]+\//i, "absolute machine-specific path"],
];
for (const path of portableFiles) {
	const content = await readFile(resolve(root, path), "utf8");
	for (const [pattern, label] of forbiddenProjectBindings) {
		if (pattern.test(content)) throw new Error(`${path} contains ${label}: ${pattern}`);
	}
}

console.log(
	`Package structure OK (${required.length} required files; ${developmentSkills.length} development skills, ${referenceFiles.length} reference files, portability, safety, auto-PR, and PR-audit policies verified)`,
);

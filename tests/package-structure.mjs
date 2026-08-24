import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
	"skills/pr-audit/SKILL.md",
	"skills/linear-pr-audit/SKILL.md",
	"skills/linear-pr-audit/scripts/post-linear-comment.mjs",
	...developmentSkills.map((name) => `skills/${name}/SKILL.md`),
	"docs/CONTRIBUTING.md",
	"docs/MIGRATION.md",
	"docs/experience/pr-audit.md",
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
	if (!reviewResolver.includes(rule)) throw new Error(`review-resolver is missing edit gate: ${rule}`);
}

const linearSkill = await readFile(resolve(root, "skills/linear-to-pr/SKILL.md"), "utf8");
const requiredAutoPrRules = [
	"自动提交、普通 push 当前任务分支",
	"创建到已确认 base 的 PR",
	"不得停下重复询问",
	"不要自动 merge、approve 或 ready",
];
for (const rule of requiredAutoPrRules) {
	if (!linearSkill.includes(rule)) throw new Error(`linear-to-pr is missing auto-PR rule: ${rule}`);
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
	if (!prAuditSkill.includes(rule)) throw new Error(`pr-audit is missing policy: ${rule}`);
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
	if (!linearPrAuditSkill.includes(rule)) throw new Error(`linear-pr-audit is missing policy: ${rule}`);
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

const portableFiles = [
	...new Set([
		...required.filter((path) => /^(README|package\.json|extensions|skills|docs)/.test(path)),
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
];
for (const path of portableFiles) {
	const content = await readFile(resolve(root, path), "utf8");
	for (const [pattern, label] of forbiddenProjectBindings) {
		if (pattern.test(content)) throw new Error(`${path} contains ${label}: ${pattern}`);
	}
}

console.log(
	`Package structure OK (${required.length} required files; ${developmentSkills.length} development skills, portability, safety, auto-PR, and PR-audit policies verified)`,
);

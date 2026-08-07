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
	"skills/linear-to-pr/scripts/update-issue-state.mjs",
	"skills/pr-audit/SKILL.md",
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
];
for (const rule of requiredAuditRules) {
	if (!prAuditSkill.includes(rule)) throw new Error(`pr-audit is missing policy: ${rule}`);
}
if (/S\/A\/B\/C\/D\/F/.test(prAuditSkill)) {
	throw new Error("pr-audit must not reintroduce the letter grade scale; gates and blocking findings are the verdict");
}

// Progressive disclosure: the two largest skills keep a self-sufficient trunk and
// move long-form command listings and templates into references/.
const progressiveSkills = [
	{ name: "pr-audit", maxLines: 150 },
	{ name: "linear-to-pr", maxLines: 180 },
];
for (const { name, maxLines } of progressiveSkills) {
	const trunk = await readFile(resolve(root, `skills/${name}/SKILL.md`), "utf8");
	// Match wc -l: a trailing newline terminates the last line, it does not start a new one.
	const lines = trunk.replace(/\r?\n$/, "").split(/\r?\n/).length;
	if (lines > maxLines) {
		throw new Error(`skills/${name}/SKILL.md is ${lines} lines; keep the trunk under ${maxLines} and move detail into references/`);
	}
	if (!/references\//.test(trunk)) {
		throw new Error(`skills/${name}/SKILL.md must point at its references/ files`);
	}
	for (const match of trunk.matchAll(/references\/([a-z0-9-]+\.md)/g)) {
		await access(resolve(root, `skills/${name}/references/${match[1]}`), constants.R_OK);
	}
}

// Portability and shell-compatibility regressions caught in review.
for (const path of [...developmentSkills, "feature-trace", "linear-to-pr", "pr-audit"]) {
	const files = [`skills/${path}/SKILL.md`];
	for (const file of files) {
		const content = await readFile(resolve(root, file), "utf8");
		if (/find\s+\.\.\s/.test(content)) {
			throw new Error(`${file} scans the parent directory; scope discovery to the current repository`);
		}
		if (/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(content)) {
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

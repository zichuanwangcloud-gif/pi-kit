import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
	"docs/CONTRIBUTING.md",
	"docs/MIGRATION.md",
	"docs/experience/pr-audit.md",
];

for (const path of required) await access(resolve(root, path), constants.R_OK);
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!manifest.keywords?.includes("pi-package")) throw new Error("package.json is missing pi-package keyword");
if (!manifest.pi?.extensions?.length || !manifest.pi?.skills?.length) throw new Error("Pi resource manifest is incomplete");
if (manifest.pi.extensions.some((path) => /cloudrouter/i.test(path))) {
	throw new Error("Pi extension manifest contains a project-specific name");
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

const portableFiles = [
	"README.md",
	"package.json",
	"extensions/kit-help.ts",
	"extensions/engineering-loop/index.ts",
	"skills/feature-trace/SKILL.md",
	"skills/linear-to-pr/SKILL.md",
	"skills/linear-to-pr/scripts/fetch-linear-issue.mjs",
	"skills/pr-audit/SKILL.md",
	"docs/CONTRIBUTING.md",
	"docs/MIGRATION.md",
	"docs/experience/engineering-loop.md",
	"docs/experience/linear-to-pr.md",
	"docs/experience/pi-extension-notes.md",
	"docs/experience/pr-audit.md",
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

console.log(`Package structure OK (${required.length} required files; portability, auto-PR, and PR-audit policies verified)`);

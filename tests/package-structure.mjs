import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const required = [
	"package.json",
	"README.md",
	"extensions/cloudrouter-help.ts",
	"extensions/skill-runner.ts",
	"extensions/engineering-loop/index.ts",
	"extensions/engineering-loop/parser.ts",
	"extensions/engineering-loop/types.ts",
	"extensions/engineering-loop/utils.ts",
	"skills/feature-trace/SKILL.md",
	"skills/linear-to-pr/SKILL.md",
	"skills/linear-to-pr/scripts/fetch-linear-issue.mjs",
	"docs/MIGRATION.md",
];

for (const path of required) await access(resolve(root, path), constants.R_OK);
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (!manifest.keywords?.includes("pi-package")) throw new Error("package.json is missing pi-package keyword");
if (!manifest.pi?.extensions?.length || !manifest.pi?.skills?.length) throw new Error("Pi resource manifest is incomplete");

const linearSkill = await readFile(resolve(root, "skills/linear-to-pr/SKILL.md"), "utf8");
const requiredAutoPrRules = [
	"自动提交并推送功能分支",
	"自动创建到 dev 的 PR",
	"不得再询问“是否 push/是否创建 PR”",
	"不要自动合并、approve 或 ready PR",
];
for (const rule of requiredAutoPrRules) {
	if (!linearSkill.includes(rule)) throw new Error(`linear-to-pr is missing auto-PR rule: ${rule}`);
}
const forbiddenLegacyRules = ["确认可以执行外部动作后", "需要 push、建 PR、回写 Linear"];
for (const rule of forbiddenLegacyRules) {
	if (linearSkill.includes(rule)) throw new Error(`linear-to-pr contains legacy confirmation rule: ${rule}`);
}

console.log(`Package structure OK (${required.length} required files; auto-PR policy verified)`);

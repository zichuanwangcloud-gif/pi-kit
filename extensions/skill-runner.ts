import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const TOOL_MAX_BYTES = 50 * 1024;
const TOOL_MAX_LINES = 2000;

type LoadedSkill = {
	command: SlashCommandInfo;
	name: string;
	path: string;
	baseDir: string;
	body: string;
	disableModelInvocation: boolean;
};

function skillName(command: SlashCommandInfo): string {
	return command.name.replace(/^skill:/, "");
}

function normalizeSkillName(name: string): string {
	return name.trim().replace(/^\/?skill:/, "");
}

function getSkills(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.sort((a, b) => skillName(a).localeCompare(skillName(b)));
}

function findSkill(pi: ExtensionAPI, requestedName: string): SlashCommandInfo | undefined {
	const normalized = normalizeSkillName(requestedName);
	return getSkills(pi).find((command) => skillName(command) === normalized);
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
	const text = content.replace(/^\uFEFF/, "");
	const match = text.match(/^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)/);
	if (!match) return { frontmatter: "", body: text.trim() };

	return {
		frontmatter: match[1],
		body: text.slice(match[0].length).trim(),
	};
}

function modelInvocationDisabled(frontmatter: string): boolean {
	return /^disable-model-invocation:\s*(?:true|"true"|'true')\s*(?:#.*)?$/im.test(frontmatter);
}

function loadSkill(command: SlashCommandInfo): LoadedSkill {
	const path = command.sourceInfo.path;
	const content = readFileSync(path, "utf8");
	const { frontmatter, body } = splitFrontmatter(content);

	return {
		command,
		name: skillName(command),
		path,
		// sourceInfo.baseDir describes the discovery root, which can be several
		// directories above SKILL.md. Skill-relative scripts/assets always resolve
		// from the directory containing SKILL.md.
		baseDir: dirname(path),
		body,
		disableModelInvocation: modelInvocationDisabled(frontmatter),
	};
}

function buildSkillContent(skill: LoadedSkill, task?: string): string {
	const block = `<skill name="${skill.name}" location="${skill.path}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
	const trimmedTask = task?.trim();
	return trimmedTask ? `${block}\n\n${trimmedTask}` : block;
}

function parseInvocation(input: string): { name: string; task?: string } | undefined {
	const match = input.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { name: match[1], task: match[2]?.trim() || undefined };
}

function availableSkillNames(pi: ExtensionAPI, includeModelDisabled = true): string[] {
	return getSkills(pi)
		.filter((command) => {
			if (includeModelDisabled) return true;
			try {
				return !loadSkill(command).disableModelInvocation;
			} catch {
				return false;
			}
		})
		.map(skillName);
}

export default function skillRunner(pi: ExtensionAPI) {
	pi.registerCommand("skills", {
		description: "选择并执行一个已加载的 Skill；用法：/skills [name] [task]",
		getArgumentCompletions(prefix) {
			if (/\s/.test(prefix.trim())) return null;
			const normalizedPrefix = normalizeSkillName(prefix);
			const items = getSkills(pi)
				.map((command) => ({
					value: skillName(command),
					label: skillName(command),
					description: command.description,
				}))
				.filter((item) => item.value.startsWith(normalizedPrefix));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			let invocation = parseInvocation(args);

			if (!invocation) {
				const skills = getSkills(pi);
				if (skills.length === 0) {
					ctx.ui.notify("当前没有加载任何 Skill", "warning");
					return;
				}
				if (!ctx.hasUI) {
					ctx.ui.notify(`可用 Skills：${skills.map(skillName).join(", ")}`, "info");
					return;
				}

				const selected = await ctx.ui.select("选择要执行的 Skill", skills.map(skillName));
				if (!selected) return;
				const task = await ctx.ui.input(`传给 ${selected} 的任务（可留空）`, "描述要完成的任务");
				if (task === undefined) return;
				invocation = { name: selected, task: task.trim() || undefined };
			}

			const command = findSkill(pi, invocation.name);
			if (!command) {
				const available = availableSkillNames(pi);
				ctx.ui.notify(
					`未找到 Skill：${invocation.name}${available.length ? `；可用：${available.join(", ")}` : ""}`,
					"error",
				);
				return;
			}

			try {
				const skill = loadSkill(command);
				const content = buildSkillContent(skill, invocation.task);
				if (ctx.isIdle()) {
					pi.sendUserMessage(content);
				} else {
					pi.sendUserMessage(content, { deliverAs: "followUp" });
					ctx.ui.notify(`已排队执行 Skill：${skill.name}`, "info");
				}
			} catch (error) {
				ctx.ui.notify(
					`读取 Skill 失败：${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.registerTool({
		name: "invoke_skill",
		label: "Invoke Skill",
		description:
			"Load and invoke a Pi skill relevant to the current task. The skill must already be discovered by Pi. Skills marked disable-model-invocation can only be run explicitly by the user with /skills.",
		promptSnippet: "Load and invoke an available Pi skill by name",
		promptGuidelines: [
			"Use invoke_skill when an available Pi skill provides a specialized workflow for the current task.",
		],
		parameters: Type.Object({
			name: Type.String({ description: "Skill name, for example pdf-tools or brave-search" }),
			task: Type.Optional(Type.String({ description: "Task or arguments to pass to the skill" })),
		}),
		async execute(_toolCallId, params) {
			const command = findSkill(pi, params.name);
			if (!command) {
				const available = availableSkillNames(pi, false);
				throw new Error(
					`Skill not found: ${params.name}. Model-invocable skills: ${available.join(", ") || "(none)"}`,
				);
			}

			const skill = loadSkill(command);
			if (skill.disableModelInvocation) {
				throw new Error(`Skill ${skill.name} requires explicit user invocation via /skills ${skill.name}`);
			}

			const content = buildSkillContent(skill, params.task);
			const bytes = Buffer.byteLength(content, "utf8");
			const lines = content.split(/\r?\n/).length;
			if (bytes > TOOL_MAX_BYTES || lines > TOOL_MAX_LINES) {
				throw new Error(
					`Skill ${skill.name} is too large for a tool result (${bytes} bytes, ${lines} lines). Run it explicitly with /skills ${skill.name}.`,
				);
			}

			return {
				content: [{ type: "text", text: content }],
				details: {
					skill: skill.name,
					path: skill.path,
					task: params.task,
				},
			};
		},
	});
}

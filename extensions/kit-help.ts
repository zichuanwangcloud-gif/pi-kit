import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const HELP_TOPICS = ["overview", "installed", "skills", "linear", "loop", "roadmap", "safety"] as const;
type HelpTopic = (typeof HELP_TOPICS)[number];

type HelpSection = { title: string; lines: string[] };
type HelpCardData = {
	topic: HelpTopic;
	title: string;
	sections: HelpSection[];
	paths?: string[];
	createdAt: number;
};

const ROADMAP: Array<{ name: string; command: string; purpose: string }> = [
	{
		name: "仓库策略配置",
		command: "（规划中）",
		purpose: "从项目配置加载受保护分支、默认 PR base、分支命名和允许的验证器。",
	},
	{
		name: "Worktree 管理器",
		command: "/worktrees、/worktree-create、/worktree-clean（规划中）",
		purpose: "显示 worktree、dirty 状态、基线、关联 PR，并提供确认后的安全清理。",
	},
	{
		name: "Issue 开发控制台",
		command: "/issue、/issue-resume（规划中）",
		purpose: "展示需求理解卡、开发进度、worktree、测试和 PR 状态。",
	},
	{
		name: "智能验证",
		command: "/verify [changed|package|repo]（规划中）",
		purpose: "根据项目配置和 Git diff 选择测试、构建、lint 与代码生成检查。",
	},
	{
		name: "PR/CI 助手",
		command: "/pr、/pr-check、/ci（规划中）",
		purpose: "检查 PR base/head、CI、review comments、Issue 链接和验证说明。",
	},
];

function commandLine(command: SlashCommandInfo): string {
	return `/${command.name}${command.description ? ` — ${command.description}` : ""}`;
}

function loadedSkills(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi.getCommands().filter((command) => command.source === "skill").sort((a, b) => a.name.localeCompare(b.name));
}

function extensionCommands(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi.getCommands().filter((command) => command.source === "extension").sort((a, b) => a.name.localeCompare(b.name));
}

function customTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools());
	return pi
		.getAllTools()
		.filter((tool) => tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk")
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => ({ ...tool, active: active.has(tool.name) }));
}

function installedSections(pi: ExtensionAPI): HelpSection[] {
	const commands = extensionCommands(pi);
	const skills = loadedSkills(pi);
	const tools = customTools(pi);
	return [
		{ title: `扩展命令（${commands.length}）`, lines: commands.length ? commands.map(commandLine) : ["暂无扩展命令。"] },
		{
			title: `Skills（${skills.length}）`,
			lines: skills.length
				? skills.map((skill) => `${commandLine(skill)}\n  路径：${skill.sourceInfo.path}`)
				: ["暂无已加载 Skill。将 SKILL.md 放入 Pi Skill 目录后执行 /reload。"],
		},
		{
			title: `扩展工具（${tools.length}）`,
			lines: tools.length ? tools.map((tool) => `${tool.active ? "●" : "○"} ${tool.name} — ${tool.description}`) : ["暂无扩展工具。"],
		},
	];
}

function buildCard(pi: ExtensionAPI, topic: HelpTopic): HelpCardData {
	const skills = loadedSkills(pi);
	const paths = [...extensionCommands(pi), ...skills]
		.map((command) => command.sourceInfo.path)
		.filter((path, index, all) => path && all.indexOf(path) === index);

	switch (topic) {
		case "installed":
			return { topic, title: "Pi 已安装能力", sections: installedSections(pi), paths, createdAt: Date.now() };
		case "skills":
			return {
				topic,
				title: "Pi Skill 使用帮助",
				sections: [
					{
						title: "调用",
						lines: [
							"/skills — 交互选择 Skill 并输入任务。",
							"/skills <name> <task> — 通过调度扩展执行。",
							"/skill:<name> <task> — 使用 Pi 原生 Skill 命令。",
							"模型也可调用 invoke_skill 加载匹配的 Skill。",
						],
					},
					{
						title: "安装位置",
						lines: [
							"全局：~/.pi/agent/skills/<name>/SKILL.md 或 ~/.agents/skills/<name>/SKILL.md",
							"项目：<repo>/.pi/skills/ 或 <repo>/.agents/skills/（项目必须受信任）",
							"临时：pi --skill /path/to/skill；安装或修改后执行 /reload。",
						],
					},
					{ title: `当前已加载（${skills.length}）`, lines: skills.length ? skills.map(commandLine) : ["暂无。"] },
				],
				paths: skills.map((skill) => skill.sourceInfo.path),
				createdAt: Date.now(),
			};
		case "linear":
			return {
				topic,
				title: "Linear → PR 工作流",
				sections: [
					{
						title: "入口",
						lines: [
							"/skill:linear-to-pr ENG-123 --base develop",
							"/skills linear-to-pr ENG-123 --base develop",
							"完整 identifier 最可靠；裸数字需要 LINEAR_TEAM_KEY。",
						],
					},
					{
						title: "项目适配",
						lines: [
							"Skill 不预设团队 key、仓库名称、base、分支前缀、worktree 根目录或测试命令。",
							"优先使用显式 --base，其次读取项目说明和远程证据；有歧义时询问。",
						],
					},
					{
						title: "需求硬闸门",
						lines: [
							"按时间顺序阅读正文、全部评论、附件和决定实现的需求文档。",
							"评论未读完、关键文档不可访问或冲突未解决时禁止开工。",
						],
					},
					{
						title: "授权与安全",
						lines: [
							"理解卡和计划确认后，验证成功即自动提交、普通 push 任务分支并创建到已确认 base 的 PR。",
							"不 force push，不直推保护分支，不自动 merge/approve/ready、回写 Issue 或部署。",
						],
					},
				],
				paths: skills.filter((skill) => skill.name === "skill:linear-to-pr").map((skill) => skill.sourceInfo.path),
				createdAt: Date.now(),
			};
		case "loop":
			return {
				topic,
				title: "Engineering Loop",
				sections: [
					{
						title: "启动",
						lines: [
							'/loop "任务" --validator "验证命令" --max-iterations 10',
							'/loop "任务" --completion-promise DONE --max-iterations 5',
							"优先使用项目提供的 validator；没有 validator 时必须人工复核。",
						],
					},
					{
						title: "管理",
						lines: ["/loop-status", "/loop-pause", "/loop-resume", "/loop-cancel"],
					},
					{
						title: "安全边界",
						lines: [
							"在任务分支/worktree 中启动；常见保护分支会被拒绝。",
							"Loop 阻止 push、PR、SSH、部署和破坏性 Git 操作，并限制写入启动目录。",
							"需要人工判断时输出 <loop-blocked>问题</loop-blocked>。",
						],
					},
				],
				createdAt: Date.now(),
			};
		case "roadmap":
			return {
				topic,
				title: "Pi Kit 路线图",
				sections: [
					{ title: "说明", lines: ["以下均为规划能力，不代表已安装。用 /help installed 查看真实清单。"] },
					...ROADMAP.map((item) => ({ title: item.name, lines: [item.command, item.purpose] })),
				],
				createdAt: Date.now(),
			};
		case "safety":
			return {
				topic,
				title: "通用开发安全速查",
				sections: [
					{
						title: "先确认项目约定",
						lines: [
							"读取 AGENTS.md、CLAUDE.md、贡献指南、远程默认分支和 PR 规则。",
							"不要假定所有项目都使用同一个 base、分支流向或测试命令。",
						],
					},
					{
						title: "禁止事项",
						lines: [
							"禁止 force push、直推已确认保护分支，以及擅自 reset/clean/stash 用户改动。",
							"需求、真实落点、base 或测试状态不清时停止询问。",
						],
					},
					{
						title: "外部动作",
						lines: [
							"自动 push/PR 只在相应 Skill 的理解卡和计划确认后生效。",
							"合并、审批、Issue 回写、发布和部署需要单独授权。",
						],
					},
				],
				createdAt: Date.now(),
			};
		case "overview":
		default:
			return {
				topic: "overview",
				title: "Pi Kit 帮助中心",
				sections: [
					{
						title: "常用入口",
						lines: [
							"/help installed — 当前命令、Skill 和扩展工具。",
							"/help skills — Skill 安装和调用。",
							"/help linear — 通用 Linear 到 PR 工作流。",
							"/help loop — Engineering Loop。",
							"/help safety — 项目中立的安全规则。",
							"/help roadmap — 规划能力。",
						],
					},
					{
						title: "项目中立原则",
						lines: [
							"Pi Kit 不预设业务仓库、团队 key、默认分支、技术栈和目录结构。",
							"先读取目标项目说明；无法从证据唯一判断时询问用户。",
						],
					},
					{
						title: "动态清单",
						lines: [
							`当前检测到 ${extensionCommands(pi).length} 个扩展命令、${skills.length} 个 Skill、${customTools(pi).length} 个扩展工具。`,
							"运行 /help installed 查看来源。",
						],
					},
				],
				createdAt: Date.now(),
			};
	}
}

function normalizeTopic(input: string): HelpTopic | undefined {
	const value = input.trim().toLowerCase() || "overview";
	const aliases: Record<string, HelpTopic> = { all: "installed", commands: "installed", skill: "skills", plugins: "roadmap", git: "safety" };
	const normalized = aliases[value] ?? value;
	return HELP_TOPICS.includes(normalized as HelpTopic) ? (normalized as HelpTopic) : undefined;
}

export default function kitHelp(pi: ExtensionAPI) {
	pi.registerEntryRenderer<HelpCardData>("pi-kit-help", (entry, { expanded }, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!data) {
			box.addChild(new Text(theme.fg("error", "帮助内容不可用"), 0, 0));
			return box;
		}
		box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
		for (const section of data.sections) {
			box.addChild(new Text(`\n${theme.fg("mdHeading", theme.bold(section.title))}`, 0, 0));
			for (const line of section.lines) box.addChild(new Text(`  ${theme.fg("text", line)}`, 0, 0));
		}
		if (expanded && data.paths?.length) {
			box.addChild(new Text(`\n${theme.fg("dim", "来源路径")}`, 0, 0));
			for (const path of data.paths) box.addChild(new Text(theme.fg("dim", `  ${path}`), 0, 0));
		}
		box.addChild(new Text(`\n${theme.fg("dim", "提示：使用 /help <topic> 切换主题；展开可查看来源路径。")}`, 0, 0));
		return box;
	});

	pi.registerCommand("help", {
		description: "Pi Kit 帮助中心；用法：/help [installed|skills|linear|loop|safety|roadmap]",
		getArgumentCompletions(prefix) {
			const items = HELP_TOPICS.filter((topic) => topic.startsWith(prefix.trim().toLowerCase())).map((topic) => ({ value: topic, label: topic }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const topic = normalizeTopic(args);
			if (!topic) {
				ctx.ui.notify(`未知帮助主题：${args.trim()}；可用：${HELP_TOPICS.join(", ")}`, "warning");
				return;
			}
			pi.appendEntry<HelpCardData>("pi-kit-help", buildCard(pi, topic));
		},
	});
}

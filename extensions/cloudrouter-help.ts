import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const HELP_TOPICS = ["overview", "installed", "skills", "linear", "loop", "roadmap", "safety"] as const;
type HelpTopic = (typeof HELP_TOPICS)[number];

type HelpSection = {
	title: string;
	lines: string[];
};

type HelpCardData = {
	topic: HelpTopic;
	title: string;
	sections: HelpSection[];
	paths?: string[];
	createdAt: number;
};

const ROADMAP: Array<{ name: string; command: string; purpose: string }> = [
	{
		name: "Git 分支保护",
		command: "（规划中）",
		purpose: "拦截向 main/dev/test 直推、force push、受保护分支提交及危险 reset/clean。",
	},
	{
		name: "Worktree 管理器",
		command: "/worktrees、/worktree-create、/worktree-clean（规划中）",
		purpose: "管理 Linear worktree、dirty 状态、分支基线、关联 PR 和安全清理。",
	},
	{
		name: "Linear 开发控制台",
		command: "/linear、/linear-resume（规划中）",
		purpose: "展示需求理解卡、开发进度、worktree、测试及 PR 状态。",
	},
	{
		name: "智能验证",
		command: "/verify [changed|backend|frontend]（规划中）",
		purpose: "根据 Git diff 自动选择 Go、Ent、Wire、migration、前端和 overlay 验证。",
	},
	{
		name: "PR/CI 助手",
		command: "/pr、/pr-check、/ci（规划中）",
		purpose: "检查 PR base/head、CI 失败、review comments、Linear 链接和验证说明。",
	},
	{
		name: "Skill 管理增强",
		command: "/skills-check、/skills-info（规划中）",
		purpose: "检查 Skill frontmatter、依赖、兼容性、来源冲突和最近调用。",
	},
];

function commandLine(command: SlashCommandInfo): string {
	return `/${command.name}${command.description ? ` — ${command.description}` : ""}`;
}

function loadedSkills(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill")
		.sort((a, b) => a.name.localeCompare(b.name));
}

function extensionCommands(pi: ExtensionAPI): SlashCommandInfo[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "extension")
		.sort((a, b) => a.name.localeCompare(b.name));
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
		{
			title: `扩展命令（${commands.length}）`,
			lines: commands.length > 0 ? commands.map(commandLine) : ["暂无扩展命令。"],
		},
		{
			title: `Skills（${skills.length}）`,
			lines:
				skills.length > 0
					? skills.map((skill) => `${commandLine(skill)}\n  路径：${skill.sourceInfo.path}`)
					: ["暂无已加载 Skill。将 SKILL.md 放到 ~/.pi/agent/skills/<name>/ 后执行 /reload。"],
		},
		{
			title: `扩展工具（${tools.length}）`,
			lines:
				tools.length > 0
					? tools.map((tool) => `${tool.active ? "●" : "○"} ${tool.name} — ${tool.description}`)
					: ["暂无扩展工具。"],
		},
	];
}

function buildCard(pi: ExtensionAPI, topic: HelpTopic): HelpCardData {
	const skills = loadedSkills(pi);
	const paths = [
		...extensionCommands(pi).map((command) => command.sourceInfo.path),
		...skills.map((skill) => skill.sourceInfo.path),
	].filter((path, index, all) => path && all.indexOf(path) === index);

	switch (topic) {
		case "installed":
			return {
				topic,
				title: "Pi 已安装能力",
				sections: installedSections(pi),
				paths,
				createdAt: Date.now(),
			};

		case "skills":
			return {
				topic,
				title: "Pi Skill 使用帮助",
				sections: [
					{
						title: "调用",
						lines: [
							"/skills — 交互选择 Skill 并输入任务。",
							"/skills <name> <task> — 通过 Skill 调度扩展执行。",
							"/skill:<name> <task> — 使用 Pi 原生 Skill 命令。",
							"模型也可以调用 invoke_skill 自动加载适合当前任务的 Skill。",
						],
					},
					{
						title: "安装位置",
						lines: [
							"全局：~/.pi/agent/skills/<name>/SKILL.md",
							"项目：<repo>/.pi/skills/<name>/SKILL.md（项目必须受信任）",
							"临时：pi --skill /path/to/skill",
							"安装或修改后执行 /reload。",
						],
					},
					{
						title: `当前已加载（${skills.length}）`,
						lines: skills.length > 0 ? skills.map(commandLine) : ["暂无。"],
					},
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
						title: "当前入口",
						lines: [
							"/skills linear-to-pr CR-1170",
							"/skill:linear-to-pr CR-1170",
							"自然语言：按 Linear CR-1170 开发并提 PR。",
						],
					},
					{
						title: "流程",
						lines: [
							"读取 Linear 正文、全部评论、附件和 PRD/原型链接 → 输出评论时间线与冲突清单 → 输出需求理解卡 → 用户确认一次 → 从 origin/dev 创建隔离 worktree → 实现与验证 → 自动提交并推送功能分支 → 自动创建到 dev 的 PR。",
						],
					},
					{
						title: "评论与 PRD 硬闸门",
						lines: [
							"评论区可能包含产品 PRD、验收标准和对正文的修订，必须按时间顺序审阅全部评论，不能只读关键词命中的候选评论。",
							"正文、评论或 PRD 冲突时必须列出双方来源；没有明确覆盖证据就询问用户，禁止静默采用任一版本。",
							"关键私有文档无法访问、评论未读完或冲突未解决时禁止开工。",
						],
					},
					{
						title: "Linear 凭据",
						lines: [
							"配置 LINEAR_API_KEY，或将 API Key 保存到 ~/.config/pi/linear-api-key（权限 600）。",
							"不要把 API Key 发进聊天或提交到仓库。",
						],
					},
					{
						title: "自动 PR 与安全约束",
						lines: [
							"确认需求理解卡和实施计划后，即授权 Skill 在验证完成后自动提交、推送 feature/fix 分支并创建到 dev 的 PR，不再二次询问。",
							"自动化不包括合并/approve/ready PR、回写 Linear、部署、force push 或直推 main/dev/test。",
							"主工作区有改动时不清理、不 stash、不覆盖；需求或真实落点不清时必须停下来询问。",
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
							"推荐使用 validator；没有 validator 时，promise 只代表模型声明，必须人工复核。",
						],
					},
					{
						title: "管理",
						lines: [
							"/loop-status — 显示状态、迭代、Token、成本和 validator 日志。",
							"/loop-pause — 暂停；/loop-resume — 恢复；/loop-cancel — 取消但保留代码和日志。",
						],
					},
					{
						title: "安全边界",
						lines: [
							"必须在 feature/fix worktree 中启动；v0.1 拒绝 main/dev/test。",
							"Loop 内阻止 push、PR、SSH、部署、reset --hard、clean 和 stash。",
							"需要人工判断时输出 <loop-blocked>问题</loop-blocked>，Loop 会暂停。",
							"用户普通输入、会话恢复、模型错误或连续空转也会自动暂停。",
						],
					},
				],
				createdAt: Date.now(),
			};

		case "roadmap":
			return {
				topic,
				title: "CloudRouter Pi 插件路线图",
				sections: [
					{
						title: "说明",
						lines: ["以下均为规划能力，不代表命令已经安装。用 /help installed 查看真正可用的命令。"],
					},
					...ROADMAP.map((item) => ({
						title: item.name,
						lines: [item.command, item.purpose],
					})),
				],
				createdAt: Date.now(),
			};

		case "safety":
			return {
				topic,
				title: "CloudRouter 开发安全速查",
				sections: [
					{
						title: "分支流向",
						lines: [
							"feature/* 或 fix/* → PR → dev；dev → test；test → PR → main。",
							"hotfix/* 只能从 main 分叉并 PR 回 main，之后同步回 dev。",
						],
					},
					{
						title: "禁止事项",
						lines: [
							"禁止直接 push main/dev/test；禁止对受保护分支 force push；禁止在 test 上开发；禁止擅自 reset/clean/stash 用户改动。",
						],
					},
					{
						title: "Linear 开发",
						lines: [
							"必须基于最新 origin/dev 创建隔离 worktree；需求期望或真实落点不清时停止；理解卡确认后自动 push 功能分支并建 dev PR；回写 Linear、合并/approve/ready PR 仍需单独确认。",
						],
					},
				],
				createdAt: Date.now(),
			};

		case "overview":
		default:
			return {
				topic: "overview",
				title: "CloudRouter Pi 帮助中心",
				sections: [
					{
						title: "常用入口",
						lines: [
							"/help installed — 查看当前真正已安装的命令、Skill 和扩展工具。",
							"/help skills — Skill 安装、调用和当前列表。",
							"/help linear — Linear 编号到 dev PR 的工作流。",
							"/help loop — Engineering Loop 使用和安全边界。",
							"/help safety — CloudRouter 分支与操作安全规则。",
							"/help roadmap — 后续建议开发的插件能力。",
						],
					},
					{
						title: "当前核心能力",
						lines: [
							"Skill 调度：/skills 或 invoke_skill。",
							"Linear 一条龙：linear-to-pr Skill。",
							"帮助中心：/help [topic]。",
						],
					},
					{
						title: "查看动态清单",
						lines: [
							`当前检测到 ${extensionCommands(pi).length} 个扩展命令、${skills.length} 个 Skill、${customTools(pi).length} 个扩展工具。`,
							"运行 /help installed 获取名称、描述和来源。",
						],
					},
				],
				createdAt: Date.now(),
			};
	}
}

function normalizeTopic(input: string): HelpTopic | undefined {
	const value = input.trim().toLowerCase() || "overview";
	const aliases: Record<string, HelpTopic> = {
		all: "installed",
		commands: "installed",
		skill: "skills",
		plugins: "roadmap",
		git: "safety",
	};
	const normalized = aliases[value] ?? value;
	return HELP_TOPICS.includes(normalized as HelpTopic) ? (normalized as HelpTopic) : undefined;
}

export default function cloudRouterHelp(pi: ExtensionAPI) {
	pi.registerEntryRenderer<HelpCardData>("cloudrouter-help", (entry, { expanded }, theme) => {
		const data = entry.data;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!data) {
			box.addChild(new Text(theme.fg("error", "帮助内容不可用"), 0, 0));
			return box;
		}

		box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
		for (const section of data.sections) {
			box.addChild(new Text(`\n${theme.fg("mdHeading", theme.bold(section.title))}`, 0, 0));
			for (const line of section.lines) {
				box.addChild(new Text(`  ${theme.fg("text", line)}`, 0, 0));
			}
		}

		if (expanded && data.paths?.length) {
			box.addChild(new Text(`\n${theme.fg("dim", "来源路径")}`, 0, 0));
			for (const path of data.paths) box.addChild(new Text(theme.fg("dim", `  ${path}`), 0, 0));
		}
		box.addChild(new Text(`\n${theme.fg("dim", "提示：使用 /help <topic> 切换主题；展开工具输出可查看来源路径。")}`, 0, 0));
		return box;
	});

	pi.registerCommand("help", {
		description: "CloudRouter Pi 帮助中心；用法：/help [installed|skills|linear|loop|safety|roadmap]",
		getArgumentCompletions(prefix) {
			const items = HELP_TOPICS.filter((topic) => topic.startsWith(prefix.trim().toLowerCase())).map((topic) => ({
				value: topic,
				label: topic,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const topic = normalizeTopic(args);
			if (!topic) {
				ctx.ui.notify(`未知帮助主题：${args.trim()}；可用：${HELP_TOPICS.join(", ")}`, "warning");
				return;
			}
			pi.appendEntry<HelpCardData>("cloudrouter-help", buildCard(pi, topic));
		},
	});
}

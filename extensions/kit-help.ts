import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const HELP_TOPICS = ["overview", "installed", "skills", "development", "linear", "audit", "loop", "roadmap", "safety"] as const;
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
		case "development":
			return {
				topic,
				title: "通用开发审计与排障 Skills",
				sections: [
					{
						title: "CI、Review 与影响面",
						lines: [
							"/skill:ci-triage <run|job|PR> — 定位首个有效 CI 失败与根因。",
							"/skill:review-resolver <PR|comments> — 验证审查意见并形成解决计划。",
							"/skill:change-impact <range|PR|提案> — 追踪直接与传递影响。",
							"/skill:test-gap <range|功能> — 建立行为—测试矩阵并排序补测。",
							"/skill:pr-verify <PR|range> [--only 节名] — 六节独立验证：字面验收表、链路贯通、revert-check、边界、性能基线、故障矩阵、爆炸半径。",
						],
					},
					{
						title: "契约、数据与依赖",
						lines: [
							"/skill:schema-migration-audit <range|PR> — 审计迁移兼容、锁、数据与恢复。",
							"/skill:api-contract-audit <range|PR> — 审计 API/事件/CLI/库契约兼容。",
							"/skill:dependency-upgrade <package|range> — 审计升级、lock 与供应链风险。",
						],
					},
					{
						title: "发布与事件",
						lines: [
							"/skill:release-readiness <candidate> — 汇总发布门禁并给出 GO/NO-GO/BLOCKED。",
							"/skill:incident-triage <incident evidence> — 只读建立影响、时间线与假设。",
						],
					},
					{
						title: "统一安全边界",
						lines: [
							"十项能力默认只读：不 push、不修改 PR/Linear、不部署、不触碰主工作区。",
							"只有 review-resolver 可在用户明确要求修复、展示计划并获确认后修改隔离任务代码。",
							"上述确认仍不授权 push、发布 review 回复、resolve thread 或其他外部写操作。",
						],
					},
				],
				paths: skills
					.filter((skill) => ["ci-triage", "review-resolver", "change-impact", "test-gap", "schema-migration-audit", "api-contract-audit", "release-readiness", "dependency-upgrade", "incident-triage", "pr-verify"].includes(skill.name.replace(/^skill:/, "")))
					.map((skill) => skill.sourceInfo.path),
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
							"/skill:linear-to-pr ENG-123 --dry-run — 只出审阅卡、理解卡和计划，不建 worktree、不改代码。",
							"/skill:linear-to-pr ENG-123 --no-pr / --no-status / --state-name — 做到提交并 push 任务分支为止，PR 文本只输出不创建。",
							"/skill:linear-to-pr ENG-123 --worktree-root <path> — 指定 worktree 存放根目录。",
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
							"先过形态/状态闸门：已取消/已完成、duplicate、含子 issue 的 parent、被前置阻塞时停止询问。",
							"评论量大时分层读：需求信号/链接/最早最新/人类评论逐字读，bot 评论按类汇总登记。",
							"评论未读完、关键文档不可访问或冲突未解决时禁止开工。",
						],
					},
					{
						title: "执行与恢复",
						lines: [
							"每次 bash 调用都是新 shell：计划确认后把参数固化成常量文件，之后每段先 source 再断言非空。",
							"git 命令一律带 -C，推送只用显式 refspec，不依赖上一次调用里赋的变量。",
							"重跑同一 Issue 先做断点检测：判定为本次残留即自动恢复；归属不明则停止，不自行删除。",
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
		case "audit":
			return {
				topic,
				title: "PR 审计：三门与验收闭环",
				sections: [
					{
						title: "入口",
						lines: [
							"/skill:pr-audit 123",
							"/skill:pr-audit 123 --linear on",
							"/skill:linear-pr-audit 123 TEAM-456",
							"/skill:linear-pr-audit 123 TEAM-456 --max-rounds 2 — 限制修复复验轮次（默认 3）。",
							"/skill:linear-pr-audit 123 TEAM-456 --ci-timeout 60 — 每轮等 CI 落定的分钟数（默认 45）。",
							"/skill:linear-pr-audit 123 TEAM-456 --no-post — 全部验证照做，但不发送 Linear 评论。",
							"pr-audit 默认 --linear off；只在 Pi 输出，不发布 PR comment/review。",
						],
					},
					{
						title: "Gate",
						lines: [
							"Correctness：代码审阅、单测、lint、typecheck、编译和 CI 证据。",
							"Requirements：可选读取 Linear 全部需求，建立需求→实现→测试矩阵。",
							"Requirements 只判静态存在性（有没有实现和测试），不判验收跑不跑得通。",
							"Security：人工威胁审阅以及项目已有 secret/SAST/依赖扫描。",
							"Acceptance（仅 linear-pr-audit）：逐条验收标准用测试或可复现命令实际跑通。",
							"Acceptance 的 PASS 需要两个退出码：先证明测试在修复前会红，再证明修复后变绿。",
						],
					},
					{
						title: "通过与评级",
						lines: [
							"Linear 开启要求 3/3 PASS；关闭时 Requirements=DISABLED，其余要求 2/2 PASS。",
							"linear-pr-audit 恒定四门，要求 4/4 PASS 才回写自测报告。",
							"分母恒为拆出的 AC 总条数，不得改写；waiver 需签核人自己在 Linear 留评论，评级上限降为 A。",
							"同时输出 PASS/FAIL/BLOCKED 门禁和 S/A/B/C/D/F 等级；只有 PASS + S/A 建议通过。",
						],
					},
					{
						title: "写操作边界",
						lines: [
							"pr-audit 全程只读。",
							"linear-pr-audit 需用户确认验收计划一次，之后可修实现、推送修复、发送 Linear 评论；",
							"每轮推送后立即在 PR 上发披露评论，并等 CI 落定后才重算 Correctness；",
							"仍不 force push、不改 PR 状态、不提交临时验收测试、不修改既有测试。",
						],
					},
				],
				paths: skills
					.filter((skill) => ["skill:pr-audit", "skill:linear-pr-audit"].includes(skill.name))
					.map((skill) => skill.sourceInfo.path),
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
							"十个通用开发审计/排障 Skill 默认不 push、不改 PR/Linear、不部署、不触碰主工作区。",
							"review-resolver 仅在明确修改授权、计划展示并确认、隔离任务工作区三项都满足后修改任务代码。",
							"linear-to-pr 的既有确认闸门可授权任务分支 push/PR；合并、审批、Issue 回写、发布和部署仍需单独授权。",
							"linear-pr-audit 的验收计划确认可授权修实现、推送修复到 PR head 分支和发送 Linear 自测报告；force push、改 PR 状态、提交临时验收测试和修改既有测试始终禁止。",
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
							"/help development — 十个通用开发审计与排障 Skill。",
							"/help linear — 通用 Linear 到 PR 工作流。",
							"/help audit — PR 正确性、需求和安全三门审计。",
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
		description: "Pi Kit 帮助中心；用法：/help [installed|skills|development|linear|audit|loop|safety|roadmap]",
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

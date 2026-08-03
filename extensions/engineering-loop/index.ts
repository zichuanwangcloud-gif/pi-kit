import { resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseLoopArguments } from "./parser.ts";
import type { EngineeringLoopState, LoopCardData } from "./types.ts";
import {
	addAssistantUsage,
	assistantText,
	blockedReason,
	currentBranch,
	emptyUsage,
	exactPromise,
	gitFingerprint,
	latestAssistantEntry,
	loopSystemPrompt,
	runValidator,
} from "./utils.ts";

const STATE_ENTRY = "engineering-loop-state";
const CARD_ENTRY = "engineering-loop-card";
const COMMON_PROTECTED_BRANCHES = new Set([
	"main",
	"master",
	"trunk",
	"dev",
	"develop",
	"test",
	"staging",
	"production",
]);
const EXTERNAL_OR_DESTRUCTIVE = [
	/\bgit\s+push\b/i,
	/\bgit\s+(?:reset\s+--hard|clean\b|stash\b)/i,
	/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
	/\bgh\s+pr\s+(?:create|merge|close|ready|review)\b/i,
	/\b(?:ssh|scp|sftp|rsync)\b/i,
	/\bkubectl\b/i,
	/\bhelm\b/i,
	/\b(?:docker(?:-compose)?|docker\s+compose)\b[^\n]*(?:\bup\b|\bdown\b|\brestart\b|\brm\b)/i,
	/\b(?:deploy|release|publish)(?:\.sh|\s)/i,
];
const CWD_ESCAPE = /(?:^|[;&|]\s*)cd\s+(?:\/(?!tmp(?:\/|\s|$))|\.\.(?:\/|\s|$)|~(?:\/|\s|$))/i;

function cloneState(state: EngineeringLoopState): EngineeringLoopState {
	return JSON.parse(JSON.stringify(state)) as EngineeringLoopState;
}

function isInside(root: string, target: string): boolean {
	const normalizedRoot = resolve(root);
	const normalizedTarget = resolve(root, target.replace(/^@/, ""));
	return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function referencedPathOutside(root: string, command: string): string | undefined {
	const matches = command.matchAll(/(?:^|[\s"'=;&|])(@?\/(?:home|opt|workspace|workspaces)\/[^\s"';&|]+)/gi);
	for (const match of matches) {
		const path = match[1].replace(/[),]+$/, "");
		if (!isInside(root, path)) return path;
	}
	return undefined;
}

function stateLabel(state: EngineeringLoopState): string {
	return `loop ${state.status} ${state.iteration}/${state.maxIterations}`;
}

export default function engineeringLoop(pi: ExtensionAPI) {
	let state: EngineeringLoopState | undefined;
	let processingSettled = false;
	let sessionStarted = false;

	function persist(next: EngineeringLoopState): void {
		next.updatedAt = Date.now();
		state = cloneState(next);
		pi.appendEntry<EngineeringLoopState>(STATE_ENTRY, state);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!state || ["completed", "cancelled", "failed", "maxed"].includes(state.status)) {
			ctx.ui.setStatus("engineering-loop", undefined);
			ctx.ui.setWidget("engineering-loop", undefined);
			return;
		}
		const color = state.status === "active" ? "accent" : "warning";
		ctx.ui.setStatus("engineering-loop", ctx.ui.theme.fg(color, stateLabel(state)));
		ctx.ui.setWidget(
			"engineering-loop",
			[
				`${state.status === "active" ? "🔄" : "⏸"} Engineering Loop ${state.id}: ${state.iteration}/${state.maxIterations}`,
				`目标：${state.prompt.length > 140 ? `${state.prompt.slice(0, 137)}...` : state.prompt}`,
				state.lastValidator
					? `Validator: exit ${state.lastValidator.exitCode} · ${state.lastValidator.logPath}`
					: state.validator
						? `Validator: ${state.validator}`
						: `Promise: ${state.completionPromise}`,
			],
			{ placement: "aboveEditor" },
		);
	}

	function appendCard(): void {
		if (state) pi.appendEntry<LoopCardData>(CARD_ENTRY, { state: cloneState(state) });
	}

	function transition(ctx: ExtensionContext, status: EngineeringLoopState["status"], reason: string): void {
		if (!state) return;
		state.status = status;
		state.exitReason = reason;
		persist(state);
		updateStatus(ctx);
		appendCard();
	}

	pi.registerEntryRenderer<LoopCardData>(CARD_ENTRY, (entry, { expanded }, theme) => {
		const loop = entry.data?.state;
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!loop) return new Text(theme.fg("error", "Engineering Loop 状态不可用"), 0, 0);
		const statusColor = loop.status === "completed" ? "success" : loop.status === "active" ? "accent" : "warning";
		box.addChild(new Text(theme.fg(statusColor, theme.bold(`Engineering Loop · ${loop.status}`)), 0, 0));
		box.addChild(new Text(`ID: ${loop.id}\n分支: ${loop.branch}\n迭代: ${loop.iteration}/${loop.maxIterations}\n目标: ${loop.prompt}`, 0, 0));
		if (loop.validator) box.addChild(new Text(`Validator: ${loop.validator}`, 0, 0));
		if (loop.lastValidator) {
			box.addChild(
				new Text(
					`上次验证: exit ${loop.lastValidator.exitCode}\n日志: ${loop.lastValidator.logPath}`,
					0,
					0,
				),
			);
		}
		box.addChild(
			new Text(
				`Token: ${loop.usage.totalTokens.toLocaleString()} · Cost: $${loop.usage.cost.toFixed(4)} · 空转: ${loop.stagnantIterations}/${loop.maxStagnantIterations}`,
				0,
				0,
			),
		);
		if (loop.exitReason) box.addChild(new Text(`原因: ${loop.exitReason}`, 0, 0));
		if (expanded && loop.lastValidator) {
			box.addChild(new Text(theme.fg("dim", `\nstdout tail:\n${loop.lastValidator.stdoutTail}`), 0, 0));
			box.addChild(new Text(theme.fg("dim", `\nstderr tail:\n${loop.lastValidator.stderrTail}`), 0, 0));
		}
		return box;
	});

	pi.on("session_start", (event, ctx) => {
		sessionStarted = true;
		const latest = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data);
		state = latest?.type === "custom" ? (latest.data as EngineeringLoopState) : undefined;
		if (state?.status === "active") {
			state.status = "paused";
			state.exitReason = event.reason === "reload" ? "扩展重载后安全暂停；请检查状态并执行 /loop-resume" : "会话恢复后安全暂停；请执行 /loop-resume";
			persist(state);
		}
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (event) => {
		if (!sessionStarted || !state || state.status !== "active") return;
		state.status = "paused";
		state.exitReason = `会话关闭（${event.reason}），Loop 已安全暂停`;
		persist(state);
	});

	pi.on("input", (event, ctx) => {
		if (event.source === "extension" || !state || state.status !== "active") return { action: "continue" as const };
		state.status = "paused";
		state.exitReason = "检测到用户输入，自动暂停，避免继续使用旧目标";
		persist(state);
		updateStatus(ctx);
		ctx.ui.notify("Engineering Loop 已自动暂停；确认新要求后运行 /loop-resume", "warning");
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", (event) => {
		if (!state || state.status !== "active") return;
		return { systemPrompt: `${event.systemPrompt}\n\n${loopSystemPrompt(state)}` };
	});

	pi.on("tool_call", (event) => {
		if (!state || state.status !== "active") return;
		if (event.toolName === "bash") {
			const command = String((event.input as { command?: unknown }).command ?? "");
			if (EXTERNAL_OR_DESTRUCTIVE.some((pattern) => pattern.test(command))) {
				return {
					block: true,
					reason: "Engineering Loop 默认禁止 push、PR、SSH、部署及破坏性 Git 操作。请先结束 Loop，再由用户确认。",
				};
			}
			if (CWD_ESCAPE.test(command)) {
				return {
					block: true,
					reason: `Engineering Loop 禁止通过 cd 离开启动目录 ${state.cwd}；请使用启动目录内的相对路径。`,
				};
			}
			const outsidePath = referencedPathOutside(state.cwd, command);
			if (outsidePath) {
				return {
					block: true,
					reason: `Engineering Loop 禁止命令引用启动目录之外的绝对路径：${outsidePath}`,
				};
			}
		}
		if (event.toolName === "write" || event.toolName === "edit") {
			const path = String((event.input as { path?: unknown }).path ?? "");
			if (path && !isInside(state.cwd, path)) {
				return { block: true, reason: `Engineering Loop 禁止写出启动目录：${state.cwd}` };
			}
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (!state || state.status !== "active" || processingSettled) return;
		const entry = latestAssistantEntry(ctx);
		if (!entry || entry.type !== "message" || entry.id === state.lastProcessedAssistantEntryId) return;
		processingSettled = true;
		try {
			const branch = await currentBranch(pi, state.cwd);
			if (!branch || branch !== state.branch || COMMON_PROTECTED_BRANCHES.has(branch)) {
				transition(ctx, "paused", `Git 分支已从 ${state.branch} 变为 ${branch || "未知"}，安全暂停`);
				return;
			}
			state.lastProcessedAssistantEntryId = entry.id;
			state.lastAssistantText = assistantText(entry.message);
			addAssistantUsage(state, entry.message);

			if (entry.message.role === "assistant" && ["error", "aborted", "length"].includes(entry.message.stopReason)) {
				transition(ctx, "paused", `模型停止原因：${entry.message.stopReason}${entry.message.errorMessage ? ` — ${entry.message.errorMessage}` : ""}`);
				return;
			}

			const blocker = blockedReason(state.lastAssistantText);
			if (blocker) {
				transition(ctx, "paused", `等待人工处理：${blocker}`);
				return;
			}

			state.lastValidator = await runValidator(pi, ctx, state);
			const validatorPassed = state.lastValidator?.exitCode === 0 && !state.lastValidator.killed;
			const promisePassed = exactPromise(state.lastAssistantText, state.completionPromise);

			if ((state.validator && validatorPassed) || (!state.validator && promisePassed)) {
				transition(
					ctx,
					"completed",
					state.validator ? "validator 通过，Loop 完成" : "检测到 completion promise；未配置 validator，请人工复核",
				);
				return;
			}

			if (state.iteration >= state.maxIterations) {
				transition(ctx, "maxed", `达到最大迭代次数 ${state.maxIterations}，完成条件仍未满足`);
				return;
			}

			const fingerprint = await gitFingerprint(pi, state.cwd);
			if (fingerprint && state.lastGitFingerprint === fingerprint) state.stagnantIterations += 1;
			else state.stagnantIterations = 0;
			state.lastGitFingerprint = fingerprint;
			if (state.stagnantIterations >= state.maxStagnantIterations) {
				transition(ctx, "paused", `连续 ${state.stagnantIterations} 轮 Git 状态无变化，判定空转`);
				return;
			}

			state.iteration += 1;
			persist(state);
			updateStatus(ctx);
			pi.sendUserMessage(state.prompt);
		} catch (error) {
			transition(ctx, "failed", `Loop 控制器错误：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			processingSettled = false;
		}
	});

	pi.registerCommand("loop", {
		description:
			'启动 Engineering Loop；/loop "task" --validator "command" [--max-iterations 10] [--completion-promise DONE]',
		handler: async (args, ctx) => {
			if (state && ["active", "paused"].includes(state.status)) {
				ctx.ui.notify(`已有 Loop ${state.id}（${state.status}）；请先 /loop-cancel`, "warning");
				return;
			}
			let options;
			try {
				options = parseLoopArguments(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			const branch = await currentBranch(pi, ctx.cwd);
			if (!branch) {
				ctx.ui.notify("Engineering Loop v0.1 只能在 Git 仓库中运行", "error");
				return;
			}
			if (COMMON_PROTECTED_BRANCHES.has(branch)) {
				ctx.ui.notify(`当前分支是受保护分支 ${branch}；请进入 feature/fix worktree 后启动 Loop`, "error");
				return;
			}
			const confirmed = ctx.hasUI
				? await ctx.ui.confirm(
						"启动 Engineering Loop？",
						`分支: ${branch}\n目录: ${ctx.cwd}\n最大迭代: ${options.maxIterations}\nValidator: ${options.validator ?? "无"}\nPromise: ${options.completionPromise ?? "无"}\n\nLoop 内会阻止 push、PR、SSH、部署和破坏性 Git 操作。`,
					)
				: true;
			if (!confirmed) return;

			const now = Date.now();
			state = {
				version: 1,
				id: `loop-${new Date(now).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`,
				sessionId: ctx.sessionManager.getSessionId(),
				cwd: ctx.cwd,
				branch,
				status: "active",
				prompt: options.prompt,
				iteration: 1,
				maxIterations: options.maxIterations,
				validator: options.validator,
				validatorTimeoutMs: options.validatorTimeoutMs,
				completionPromise: options.completionPromise,
				maxStagnantIterations: options.maxStagnantIterations,
				stagnantIterations: 0,
				lastGitFingerprint: await gitFingerprint(pi, ctx.cwd),
				usage: emptyUsage(),
				startedAt: now,
				updatedAt: now,
			};
			persist(state);
			updateStatus(ctx);
			pi.sendUserMessage(state.prompt);
		},
	});

	pi.registerCommand("loop-status", {
		description: "显示当前 Engineering Loop 状态（不调用模型）",
		handler: async (_args, ctx) => {
			if (!state) {
				ctx.ui.notify("当前会话没有 Engineering Loop", "info");
				return;
			}
			appendCard();
		},
	});

	pi.registerCommand("loop-pause", {
		description: "暂停当前 Engineering Loop",
		handler: async (_args, ctx) => {
			if (!state || state.status !== "active") {
				ctx.ui.notify("没有正在运行的 Engineering Loop", "info");
				return;
			}
			transition(ctx, "paused", "用户手动暂停");
		},
	});

	pi.registerCommand("loop-resume", {
		description: "恢复已暂停的 Engineering Loop",
		handler: async (_args, ctx) => {
			if (!state || state.status !== "paused") {
				ctx.ui.notify("没有可恢复的 Engineering Loop", "info");
				return;
			}
			if (state.cwd !== ctx.cwd) {
				ctx.ui.notify(`Loop 启动目录为 ${state.cwd}，当前目录为 ${ctx.cwd}，拒绝恢复`, "error");
				return;
			}
			const branch = await currentBranch(pi, ctx.cwd);
			if (branch !== state.branch || COMMON_PROTECTED_BRANCHES.has(branch)) {
				ctx.ui.notify(`Loop 启动分支为 ${state.branch}，当前分支为 ${branch || "未知"}，拒绝恢复`, "error");
				return;
			}
			state.status = "active";
			state.exitReason = undefined;
			state.stagnantIterations = 0;
			persist(state);
			updateStatus(ctx);
			pi.sendUserMessage(state.prompt);
		},
	});

	pi.registerCommand("loop-cancel", {
		description: "取消当前 Engineering Loop；保留代码和状态记录",
		handler: async (_args, ctx) => {
			if (!state || !["active", "paused"].includes(state.status)) {
				ctx.ui.notify("没有可取消的 Engineering Loop", "info");
				return;
			}
			transition(ctx, "cancelled", "用户取消；代码和 validator 日志均保留");
		},
	});
}

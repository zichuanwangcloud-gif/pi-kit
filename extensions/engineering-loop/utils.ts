import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { EngineeringLoopState, LoopUsage, ValidatorResult } from "./types.ts";

const LOG_TAIL_CHARS = 12_000;

export function emptyUsage(): LoopUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

export function assistantText(message: AgentMessage | undefined): string {
	if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

export function addAssistantUsage(state: EngineeringLoopState, message: AgentMessage | undefined): void {
	if (!message || message.role !== "assistant" || !("usage" in message) || !message.usage) return;
	state.usage.input += message.usage.input ?? 0;
	state.usage.output += message.usage.output ?? 0;
	state.usage.cacheRead += message.usage.cacheRead ?? 0;
	state.usage.cacheWrite += message.usage.cacheWrite ?? 0;
	state.usage.totalTokens += message.usage.totalTokens ?? 0;
	state.usage.cost += message.usage.cost?.total ?? 0;
}

export function exactPromise(text: string, promise: string | undefined): boolean {
	if (!promise) return false;
	const matches = [...text.matchAll(/<promise>([\s\S]*?)<\/promise>/gi)];
	return matches.some((match) => match[1].replace(/\s+/g, " ").trim() === promise.replace(/\s+/g, " ").trim());
}

export function blockedReason(text: string): string | undefined {
	const match = text.match(/<loop-blocked>([\s\S]*?)<\/loop-blocked>/i);
	return match?.[1].trim() || undefined;
}

export async function currentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await pi.exec("git", ["branch", "--show-current"], { cwd, timeout: 10_000 });
	if (result.code !== 0) return "";
	return result.stdout.trim();
}

export async function gitFingerprint(pi: ExtensionAPI, cwd: string): Promise<string | undefined> {
	const result = await pi.exec("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, timeout: 30_000 });
	if (result.code !== 0) return undefined;
	const head = await pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
	if (head.code !== 0) return undefined;
	return createHash("sha256").update(`${head.stdout.trim()}\n${result.stdout}`).digest("hex");
}

export async function runValidator(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: EngineeringLoopState,
): Promise<ValidatorResult | undefined> {
	if (!state.validator) return undefined;
	const result = await pi.exec("bash", ["-lc", state.validator], {
		cwd: state.cwd,
		timeout: state.validatorTimeoutMs,
		signal: ctx.signal,
	});
	const logDir = join(homedir(), ".pi", "agent", "state", "engineering-loop", state.sessionId, state.id);
	await mkdir(logDir, { recursive: true });
	const logPath = join(logDir, `validator-${state.iteration}.log`);
	await writeFile(
		logPath,
		`$ ${state.validator}\n\n[stdout]\n${result.stdout}\n\n[stderr]\n${result.stderr}\n\n[exit]\n${result.code}\n`,
		"utf8",
	);
	return {
		command: state.validator,
		exitCode: result.code,
		killed: result.killed,
		stdoutTail: result.stdout.slice(-LOG_TAIL_CHARS),
		stderrTail: result.stderr.slice(-LOG_TAIL_CHARS),
		logPath,
		finishedAt: Date.now(),
	};
}

export function latestAssistantEntry(ctx: ExtensionContext) {
	return [...ctx.sessionManager.getBranch()]
		.reverse()
		.find((entry) => entry.type === "message" && entry.message.role === "assistant");
}

export function loopSystemPrompt(state: EngineeringLoopState): string {
	const validator = state.lastValidator
		? `\n上轮 validator：${state.lastValidator.command}\n退出码：${state.lastValidator.exitCode}\nstdout 尾部：\n${state.lastValidator.stdoutTail}\nstderr 尾部：\n${state.lastValidator.stderrTail}\n完整日志：${state.lastValidator.logPath}`
		: "";
	return `
Engineering Loop ${state.id}，迭代 ${state.iteration}/${state.maxIterations}。
继续完成同一个任务。先检查已有文件、Git diff 和上轮验证反馈，不要从零重复分析。
需要产品判断、凭据、网络权限或无法安全继续时，输出 <loop-blocked>原因和需要用户回答的问题</loop-blocked>，扩展会暂停。
禁止在 Loop 内 push、创建/合并 PR、SSH、部署、force/reset/clean/stash 或修改受保护分支。
${state.completionPromise ? `只有任务真实完成时才输出 <promise>${state.completionPromise}</promise>。` : ""}
${state.validator ? "validator 是完成的权威依据；即使输出 promise，只要 validator 失败就不得视为完成。" : "没有 validator，completion promise 只是模型声明，结束后必须人工复核。"}
${validator}
`.trim();
}

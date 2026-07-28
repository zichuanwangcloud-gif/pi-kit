import type { StartLoopOptions } from "./types.ts";

const DEFAULT_MAX_ITERATIONS = 10;
const DEFAULT_VALIDATOR_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_STAGNANT = 2;
const MAX_ITERATIONS_CAP = 50;
const UNSAFE_VALIDATOR_PATTERNS: Array<[RegExp, string]> = [
	[/\bgit\s+push\b/i, "validator 不能执行 git push"],
	[/\bgit\s+(?:reset\s+--hard|clean\b|stash\b)/i, "validator 不能执行破坏性 Git 操作"],
	[/\brm\s+(?:-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i, "validator 不能执行递归强制删除"],
	[/\bgh\s+pr\s+(?:create|merge|close|ready|review)\b/i, "validator 不能修改 PR"],
	[/\b(?:ssh|scp|sftp|rsync)\b/i, "validator 不能访问远程主机"],
	[/\b(?:kubectl|helm)\b/i, "validator 不能操作集群"],
	[/\b(?:deploy|release|publish)(?:\.sh|\s)/i, "validator 不能执行部署/发布"],
	[/\b(?:docker(?:-compose)?|docker\s+compose)\b[^\n]*(?:\bup\b|\bdown\b|\brestart\b|\brm\b)/i, "validator 不能修改 Docker 运行状态"],
];

function validateValidator(command: string): void {
	for (const [pattern, message] of UNSAFE_VALIDATOR_PATTERNS) {
		if (pattern.test(command)) throw new Error(message);
	}
}

function tokenize(input: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	for (const char of input.trim()) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}

	if (escaped) throw new Error("参数末尾存在未完成的转义符");
	if (quote) throw new Error(`参数存在未闭合的引号：${quote}`);
	if (current) tokens.push(current);
	return tokens;
}

function requireValue(tokens: string[], index: number, option: string): string {
	const value = tokens[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} 缺少参数`);
	return value;
}

function integer(value: string, option: string, minimum: number, maximum: number): number {
	if (!/^\d+$/.test(value)) throw new Error(`${option} 必须是整数`);
	const parsed = Number(value);
	if (parsed < minimum || parsed > maximum) throw new Error(`${option} 必须在 ${minimum}-${maximum} 之间`);
	return parsed;
}

export function parseLoopArguments(input: string): StartLoopOptions {
	const tokens = tokenize(input);
	const promptParts: string[] = [];
	let maxIterations = DEFAULT_MAX_ITERATIONS;
	let validator: string | undefined;
	let validatorTimeoutMs = DEFAULT_VALIDATOR_TIMEOUT_MS;
	let completionPromise: string | undefined;
	let maxStagnantIterations = DEFAULT_MAX_STAGNANT;

	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index];
		switch (token) {
			case "--max-iterations":
				maxIterations = integer(requireValue(tokens, index, token), token, 1, MAX_ITERATIONS_CAP);
				index += 1;
				break;
			case "--validator":
				validator = requireValue(tokens, index, token).trim();
				index += 1;
				break;
			case "--validator-timeout": {
				const seconds = integer(requireValue(tokens, index, token), token, 1, 3600);
				validatorTimeoutMs = seconds * 1000;
				index += 1;
				break;
			}
			case "--completion-promise":
				completionPromise = requireValue(tokens, index, token).trim();
				index += 1;
				break;
			case "--max-stagnant":
				maxStagnantIterations = integer(requireValue(tokens, index, token), token, 1, 10);
				index += 1;
				break;
			default:
				if (token.startsWith("--")) throw new Error(`未知参数：${token}`);
				promptParts.push(token);
		}
	}

	const prompt = promptParts.join(" ").trim();
	if (!prompt) throw new Error("缺少 Loop 任务描述");
	if (validator) validateValidator(validator);
	if (!validator && !completionPromise) {
		throw new Error("必须提供 --validator 或 --completion-promise，避免无完成条件循环");
	}

	return {
		prompt,
		maxIterations,
		validator,
		validatorTimeoutMs,
		completionPromise,
		maxStagnantIterations,
	};
}

export type LoopStatus = "active" | "paused" | "completed" | "cancelled" | "failed" | "maxed";

export interface ValidatorResult {
	command: string;
	exitCode: number;
	killed: boolean;
	stdoutTail: string;
	stderrTail: string;
	logPath: string;
	finishedAt: number;
}

export interface LoopUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface EngineeringLoopState {
	version: 1;
	id: string;
	sessionId: string;
	cwd: string;
	branch: string;
	status: LoopStatus;
	prompt: string;
	iteration: number;
	maxIterations: number;
	validator?: string;
	validatorTimeoutMs: number;
	completionPromise?: string;
	maxStagnantIterations: number;
	stagnantIterations: number;
	lastGitFingerprint?: string;
	lastProcessedAssistantEntryId?: string;
	lastAssistantText?: string;
	lastValidator?: ValidatorResult;
	usage: LoopUsage;
	startedAt: number;
	updatedAt: number;
	exitReason?: string;
}

export interface StartLoopOptions {
	prompt: string;
	maxIterations: number;
	validator?: string;
	validatorTimeoutMs: number;
	completionPromise?: string;
	maxStagnantIterations: number;
}

export interface LoopCardData {
	state: EngineeringLoopState;
}

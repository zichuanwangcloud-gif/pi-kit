/**
 * Usage Meter Extension
 *
 * 在页脚状态栏实时显示上下文占用（tokens/窗口/百分比）与会话累计成本，
 * 并提供 /usage 命令输出按模型分组的 token 用量详情卡片。
 *
 * 数据来源：
 * - 上下文占用：ctx.getContextUsage()（最近一次 assistant usage + 尾部消息估算）
 * - 累计用量：message_end 事件中 assistant 消息的 usage 逐条累加；
 *   session_start 时从当前分支历史重建，/resume 后数据不丢失。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

const STATUS_KEY = "usage-meter";
const CARD_ENTRY = "pi-kit-usage-card";

/** AssistantMessage.usage 的结构化子集；字段全部按可选处理以保持防御性。 */
type MessageUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	totalTokens?: number;
	cost?: { total?: number };
};

type UsageBuckets = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning: number;
	totalTokens: number;
	cost: number;
};

type ModelStats = UsageBuckets & { requests: number };

type SessionStats = {
	requests: number;
	totals: UsageBuckets;
	models: Map<string, ModelStats>;
};

type UsageCardRow = {
	model: string;
	requests: number;
	input: string;
	output: string;
	cache: string;
	total: string;
	cost: string;
};

type UsageCardData = {
	title: string;
	contextLine: string;
	rows: UsageCardRow[];
	totals: UsageCardRow;
	cacheHitRate: string;
	createdAt: number;
};

function emptyBuckets(): UsageBuckets {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0, cost: 0 };
}

function emptyStats(): SessionStats {
	return { requests: 0, totals: emptyBuckets(), models: new Map() };
}

function addUsage(stats: SessionStats, modelKey: string, usage: MessageUsage): void {
	let model = stats.models.get(modelKey);
	if (!model) {
		model = { requests: 0, ...emptyBuckets() };
		stats.models.set(modelKey, model);
	}
	stats.requests += 1;
	model.requests += 1;
	for (const buckets of [stats.totals, model]) {
		buckets.input += usage.input ?? 0;
		buckets.output += usage.output ?? 0;
		buckets.cacheRead += usage.cacheRead ?? 0;
		buckets.cacheWrite += usage.cacheWrite ?? 0;
		buckets.reasoning += usage.reasoning ?? 0;
		buckets.totalTokens += usage.totalTokens ?? 0;
		buckets.cost += usage.cost?.total ?? 0;
	}
}

/** 从当前分支历史重建累计用量，使 /resume、/fork 后统计连续。 */
function rebuildStats(ctx: ExtensionContext): SessionStats {
	const stats = emptyStats();
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant" || !("usage" in message) || !message.usage) continue;
		addUsage(stats, `${message.provider}/${message.model}`, message.usage);
	}
	return stats;
}

function formatTokens(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
	return `${Math.round(value)}`;
}

function formatCost(value: number): string {
	if (value > 0 && value < 0.0001) return "<$0.0001";
	return `$${value.toFixed(4)}`;
}

/** 缓存命中率：cacheRead 占全部输入侧 token（input + cacheRead）的比例。 */
function cacheHitRate(totals: UsageBuckets): string {
	const denominator = totals.input + totals.cacheRead;
	if (denominator <= 0) return "--";
	return `${((totals.cacheRead / denominator) * 100).toFixed(1)}%`;
}

function buildStatus(ctx: ExtensionContext, stats: SessionStats): string {
	const theme = ctx.ui.theme;
	const usage = ctx.getContextUsage();
	let contextPart: string;
	if (!usage || usage.tokens === null || usage.percent === null) {
		// compaction 后、下一次 LLM 响应前 tokens 未知
		const window = usage ? formatTokens(usage.contextWindow) : "--";
		contextPart = theme.fg("dim", `ctx --/${window}`);
	} else {
		const percent = Math.round(usage.percent);
		const color = percent >= 90 ? "error" : percent >= 70 ? "warning" : "accent";
		contextPart = theme.fg(color, `ctx ${formatTokens(usage.tokens)}/${formatTokens(usage.contextWindow)} (${percent}%)`);
	}
	const sep = theme.fg("dim", " · ");
	const totalsPart = theme.fg("dim", `Σ${formatTokens(stats.totals.totalTokens)}`);
	const costPart = theme.fg("dim", formatCost(stats.totals.cost));
	return `⛁ ${contextPart}${sep}${totalsPart}${sep}${costPart}`;
}

function buildContextLine(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage) return "当前上下文占用未知。";
	const window = formatTokens(usage.contextWindow);
	if (usage.tokens === null || usage.percent === null) {
		return `上下文窗口 ${window}；占用量未知（compaction 后等待下一次模型响应）。`;
	}
	return `上下文 ${formatTokens(usage.tokens)}/${window}（${usage.percent.toFixed(1)}%）。`;
}

function toRow(model: string, stats: ModelStats): UsageCardRow {
	return {
		model,
		requests: stats.requests,
		input: formatTokens(stats.input),
		output: formatTokens(stats.output),
		cache: `${formatTokens(stats.cacheRead)}/${formatTokens(stats.cacheWrite)}`,
		total: formatTokens(stats.totalTokens),
		cost: formatCost(stats.cost),
	};
}

function buildCard(ctx: ExtensionContext, stats: SessionStats): UsageCardData {
	const rows = [...stats.models.entries()]
		.sort((a, b) => b[1].cost - a[1].cost)
		.map(([model, modelStats]) => toRow(model, modelStats));
	return {
		title: "Token 用量详情",
		contextLine: buildContextLine(ctx),
		rows,
		totals: toRow("合计", { requests: stats.requests, ...stats.totals }),
		cacheHitRate: cacheHitRate(stats.totals),
		createdAt: Date.now(),
	};
}

export default function usageMeter(pi: ExtensionAPI) {
	let stats = emptyStats();
	let lastStatus: string | undefined;

	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const text = buildStatus(ctx, stats);
		if (text === lastStatus) return; // 数值未变化时不重复写入，避免状态栏闪烁
		lastStatus = text;
		ctx.ui.setStatus(STATUS_KEY, text);
	};

	pi.on("session_start", async (_event, ctx) => {
		stats = rebuildStats(ctx);
		lastStatus = undefined;
		refresh(ctx);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant" && "usage" in message && message.usage) {
			addUsage(stats, `${message.provider}/${message.model}`, message.usage);
		}
		refresh(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => refresh(ctx));
	pi.on("model_select", async (_event, ctx) => refresh(ctx));
	pi.on("session_compact", async (_event, ctx) => refresh(ctx));

	pi.registerEntryRenderer<UsageCardData>(CARD_ENTRY, (entry, { expanded }, theme) => {
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		const data = entry.data;
		if (!data) {
			box.addChild(new Text(theme.fg("error", "用量数据不可用"), 0, 0));
			return box;
		}
		box.addChild(new Text(theme.fg("accent", theme.bold(data.title)), 0, 0));
		box.addChild(new Text(`\n${theme.fg("mdHeading", theme.bold("上下文"))}`, 0, 0));
		box.addChild(new Text(`  ${theme.fg("text", data.contextLine)}`, 0, 0));
		box.addChild(new Text(`\n${theme.fg("mdHeading", theme.bold(`按模型统计（${data.rows.length}）`))}`, 0, 0));
		if (data.rows.length === 0) {
			box.addChild(new Text(`  ${theme.fg("dim", "暂无 assistant 用量记录。")}`, 0, 0));
		}
		for (const row of data.rows) {
			box.addChild(new Text(`  ${theme.fg("text", theme.bold(row.model))} ${theme.fg("dim", `(${row.requests} 次请求)`)}`, 0, 0));
			box.addChild(
				new Text(`    ${theme.fg("dim", `in ${row.input} · out ${row.output} · cache ${row.cache} · total ${row.total} · ${row.cost}`)}`, 0, 0),
			);
		}
		box.addChild(new Text(`\n${theme.fg("mdHeading", theme.bold("合计"))}`, 0, 0));
		box.addChild(
			new Text(
				`  ${theme.fg("text", `${data.totals.requests} 次请求 · in ${data.totals.input} · out ${data.totals.output} · cache ${data.totals.cache} · total ${data.totals.total} · ${data.totals.cost}`)}`,
				0,
				0,
			),
		);
		box.addChild(new Text(`  ${theme.fg("dim", `缓存命中率 ${data.cacheHitRate}`)}`, 0, 0));
		if (expanded) {
			box.addChild(new Text(`\n${theme.fg("dim", "说明")}`, 0, 0));
			box.addChild(new Text(theme.fg("dim", "  统计范围为当前会话分支的全部 assistant 响应，含缓存读写 token。"), 0, 0));
			box.addChild(new Text(theme.fg("dim", "  cache 列为 cacheRead/cacheWrite；命中率 = cacheRead / (input + cacheRead)。"), 0, 0));
			box.addChild(new Text(theme.fg("dim", "  状态栏：⛁ 上下文占用 · 会话累计 token · 会话累计成本。"), 0, 0));
		}
		box.addChild(new Text(`\n${theme.fg("dim", "提示：状态栏实时显示上下文占用与成本；展开卡片查看口径说明。")}`, 0, 0));
		return box;
	});

	pi.registerCommand("usage", {
		description: "显示本会话 token 用量、上下文占用和成本详情卡片",
		handler: async (_args, ctx) => {
			pi.appendEntry<UsageCardData>(CARD_ENTRY, buildCard(ctx, stats));
		},
	});
}

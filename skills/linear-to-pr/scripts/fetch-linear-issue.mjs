#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const API_URL = "https://api.linear.app/graphql";
const DEFAULT_TEAM = process.env.LINEAR_TEAM_KEY?.trim().toUpperCase() ?? "";
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;

const REQUIREMENT_SIGNALS = [
	["prd", /\bprd\b|产品需求文档|需求文档|产品文档|需求详情/i],
	["expectation", /期望|预期|应该|应当|希望|目标|expected|desired/i],
	["acceptance", /验收|验收标准|完成标准|acceptance|definition of done|\bdod\b/i],
	["revision", /改为|调整为|修正|更正|以.+为准|不再|取消|最终方案|最终结论|更新方案|instead|supersed|override/i],
	["reproduction", /复现|复现步骤|操作步骤|触发条件|操作路径|repro/i],
	["prototype", /原型|设计稿|交互稿|figma|mockup|prototype/i],
	["scope", /范围|包含|不包含|暂不|本期|下期|scope/i],
	["decision", /结论|确认|定稿|决定|方案[一二三四五A-Ea-e]|decision/i],
];

const DOCUMENT_HINT = /\bprd\b|产品|需求|验收|规格|方案|设计|原型|文档|spec|requirement|design|prototype|figma|notion|yuque|语雀|feishu|lark|docs\.google/i;

function usage(message) {
	if (message) console.error(`Error: ${message}`);
	console.error("Usage: fetch-linear-issue.mjs <TEAM-123|123|#123>");
	console.error("Bare numbers require LINEAR_TEAM_KEY, for example LINEAR_TEAM_KEY=ENG.");
	process.exit(2);
}

function parseIdentifier(input) {
	const value = input.trim();
	const full = value.match(/^([A-Za-z][A-Za-z0-9_-]*)-(\d+)$/);
	if (full) {
		const team = full[1].toUpperCase();
		const number = Number(full[2]);
		return { team, number, identifier: `${team}-${number}` };
	}

	const bare = value.match(/^#?(\d+)$/);
	if (bare) {
		if (!DEFAULT_TEAM) {
			usage("a bare Linear issue number requires LINEAR_TEAM_KEY; otherwise pass a full identifier such as ENG-123");
		}
		const number = Number(bare[1]);
		return { team: DEFAULT_TEAM, number, identifier: `${DEFAULT_TEAM}-${number}` };
	}

	usage(`invalid Linear identifier: ${input}`);
}

async function readKeyFile(path) {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw new Error(`cannot read Linear API key file ${path}: ${error.message}`);
	}
}

async function resolveApiKey() {
	if (process.env.LINEAR_API_KEY?.trim()) return process.env.LINEAR_API_KEY.trim();

	const configuredPath = process.env.LINEAR_API_KEY_FILE?.trim();
	if (configuredPath) {
		const key = await readKeyFile(resolve(configuredPath.replace(/^~(?=\/)/, homedir())));
		if (key) return key;
	}

	return readKeyFile(resolve(homedir(), ".config/pi/linear-api-key"));
}

function authHeader(apiKey) {
	// Linear personal API keys are sent directly, without a Bearer prefix.
	return apiKey.replace(/^Bearer\s+/i, "").trim();
}

async function graphql(apiKey, query, variables) {
	let response;
	try {
		response = await fetch(API_URL, {
			method: "POST",
			headers: {
				Authorization: authHeader(apiKey),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ query, variables }),
		});
	} catch (error) {
		throw new Error(`Linear request failed: ${error.message}`);
	}

	const text = await response.text();
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new Error(`Linear returned non-JSON response (HTTP ${response.status})`);
	}

	if (!response.ok) {
		const details = payload?.errors?.map((error) => error.message).join("; ") || response.statusText;
		throw new Error(`Linear HTTP ${response.status}: ${details}`);
	}
	if (payload.errors?.length) {
		throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
	}

	return payload.data;
}

const ISSUE_QUERY = `
query IssueForPi($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 2) {
    nodes {
      id
      identifier
      number
      title
      description
      priority
      priorityLabel
      url
      createdAt
      updatedAt
      completedAt
      canceledAt
      state { id name type }
      team { id key name }
      assignee { id name email }
      creator { id name email }
      project { id name }
      labels(first: 100) { nodes { id name color } }
    }
  }
}`;

const COMMENTS_QUERY = `
query IssueCommentsForPi($issueId: String!, $after: String, $first: Int!) {
  issue(id: $issueId) {
    comments(first: $first, after: $after) {
      nodes {
        id
        body
        createdAt
        updatedAt
        url
        user { id name email }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ATTACHMENTS_QUERY = `
query IssueAttachmentsForPi($issueId: String!, $after: String, $first: Int!) {
  issue(id: $issueId) {
    attachments(first: $first, after: $after) {
      nodes {
        id
        title
        url
        subtitle
        sourceType
        createdAt
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function fetchAllConnection(apiKey, { issueId, query, field }) {
	const nodes = [];
	let after = null;
	let pagesFetched = 0;

	while (true) {
		if (pagesFetched >= MAX_PAGES) {
			throw new Error(`${field} pagination exceeded ${MAX_PAGES} pages; refusing to return an incomplete timeline`);
		}

		const data = await graphql(apiKey, query, { issueId, after, first: PAGE_SIZE });
		const connection = data?.issue?.[field];
		if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
			throw new Error(`Linear returned an invalid ${field} connection`);
		}

		nodes.push(...connection.nodes);
		pagesFetched += 1;

		if (!connection.pageInfo.hasNextPage) {
			return { nodes, pagesFetched, complete: true };
		}

		const nextCursor = connection.pageInfo.endCursor;
		if (!nextCursor || nextCursor === after) {
			throw new Error(`Linear ${field} pagination cursor did not advance; refusing to return incomplete data`);
		}
		after = nextCursor;
	}
}

function requirementSignals(body) {
	return REQUIREMENT_SIGNALS.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
}

function extractUrls(text) {
	if (!text) return [];
	const matches = text.match(/https?:\/\/[^\s<>"'\]}]+/gi) ?? [];
	return [...new Set(matches.map((url) => url.replace(/[),.;:!?，。；：！？]+$/u, "")))];
}

function normalizeComments(rawComments) {
	return [...rawComments]
		.sort((a, b) => {
			const byCreatedAt = String(a.createdAt).localeCompare(String(b.createdAt));
			return byCreatedAt || String(a.id).localeCompare(String(b.id));
		})
		.map((comment, index) => {
			const body = comment.body ?? "";
			const signals = requirementSignals(body);
			return {
				sequence: index + 1,
				id: comment.id,
				body,
				createdAt: comment.createdAt,
				updatedAt: comment.updatedAt,
				url: comment.url ?? "",
				links: extractUrls(body),
				requirementSignals: signals,
				isRequirementRelevant: signals.length > 0,
				user: comment.user ? { id: comment.user.id, name: comment.user.name, email: comment.user.email } : null,
			};
		});
}

function normalizeAttachments(rawAttachments) {
	return [...rawAttachments]
		.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)))
		.map((attachment) => ({
			id: attachment.id,
			title: attachment.title,
			url: attachment.url,
			subtitle: attachment.subtitle,
			sourceType: attachment.sourceType,
			createdAt: attachment.createdAt,
		}));
}

function buildDocumentLinks(issue, comments, attachments) {
	const links = new Map();

	function add(url, source, context = "", title = "") {
		if (!url) return;
		let entry = links.get(url);
		if (!entry) {
			entry = { url, isPotentialPrd: false, titles: [], sources: [] };
			links.set(url, entry);
		}
		if (title && !entry.titles.includes(title)) entry.titles.push(title);
		entry.isPotentialPrd ||= DOCUMENT_HINT.test(`${url} ${title} ${context}`);
		entry.sources.push(source);
	}

	for (const url of extractUrls(issue.description ?? "")) {
		add(url, { type: "description" }, issue.description ?? "");
	}
	for (const comment of comments) {
		for (const url of comment.links) {
			add(
				url,
				{
					type: "comment",
					sequence: comment.sequence,
					commentId: comment.id,
					author: comment.user?.name ?? "unknown",
					createdAt: comment.createdAt,
				},
				comment.body,
			);
		}
	}
	for (const attachment of attachments) {
		add(
			attachment.url,
			{ type: "attachment", attachmentId: attachment.id, createdAt: attachment.createdAt },
			`${attachment.subtitle ?? ""} ${attachment.sourceType ?? ""}`,
			attachment.title ?? "",
		);
	}

	return [...links.values()];
}

function normalizeIssue(issue, commentResult, attachmentResult) {
	const comments = normalizeComments(commentResult.nodes);
	const attachments = normalizeAttachments(attachmentResult.nodes);
	const documentLinks = buildDocumentLinks(issue, comments, attachments);

	return {
		fetchMetadata: {
			fetchedAt: new Date().toISOString(),
			commentsComplete: commentResult.complete,
			commentPagesFetched: commentResult.pagesFetched,
			attachmentsComplete: attachmentResult.complete,
			attachmentPagesFetched: attachmentResult.pagesFetched,
		},
		id: issue.id,
		identifier: issue.identifier,
		number: issue.number,
		title: issue.title,
		description: issue.description ?? "",
		priority: issue.priority,
		priorityLabel: issue.priorityLabel ?? "",
		url: issue.url,
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
		completedAt: issue.completedAt,
		canceledAt: issue.canceledAt,
		state: issue.state ? { id: issue.state.id, name: issue.state.name, type: issue.state.type } : null,
		team: issue.team ? { id: issue.team.id, key: issue.team.key, name: issue.team.name } : null,
		assignee: issue.assignee ? { id: issue.assignee.id, name: issue.assignee.name, email: issue.assignee.email } : null,
		creator: issue.creator ? { id: issue.creator.id, name: issue.creator.name, email: issue.creator.email } : null,
		project: issue.project ? { id: issue.project.id, name: issue.project.name } : null,
		labels: issue.labels?.nodes?.map((label) => ({ id: label.id, name: label.name, color: label.color })) ?? [],
		commentCount: comments.length,
		comments,
		requirementRelevantComments: comments
			.filter((comment) => comment.isRequirementRelevant)
			.map((comment) => ({
				sequence: comment.sequence,
				id: comment.id,
				createdAt: comment.createdAt,
				author: comment.user?.name ?? "unknown",
				requirementSignals: comment.requirementSignals,
			})),
		attachmentCount: attachments.length,
		attachments,
		documentLinks,
	};
}

async function main() {
	if (process.argv.length !== 3 || ["-h", "--help"].includes(process.argv[2])) {
		usage(process.argv.length === 3 ? undefined : "expected exactly one issue identifier");
	}

	const parsed = parseIdentifier(process.argv[2]);
	const apiKey = await resolveApiKey();
	if (!apiKey) {
		throw new Error(
			"Linear API key is not configured. Set LINEAR_API_KEY, LINEAR_API_KEY_FILE, or create ~/.config/pi/linear-api-key with mode 600.",
		);
	}

	const data = await graphql(apiKey, ISSUE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = data?.issues?.nodes ?? [];
	if (issues.length === 0) throw new Error(`Linear issue not found: ${parsed.identifier}`);
	if (issues.length > 1) throw new Error(`Linear returned multiple issues for ${parsed.identifier}`);

	const issue = issues[0];
	const [commentResult, attachmentResult] = await Promise.all([
		fetchAllConnection(apiKey, { issueId: issue.id, query: COMMENTS_QUERY, field: "comments" }),
		fetchAllConnection(apiKey, { issueId: issue.id, query: ATTACHMENTS_QUERY, field: "attachments" }),
	]);

	process.stdout.write(`${JSON.stringify(normalizeIssue(issue, commentResult, attachmentResult), null, 2)}\n`);
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

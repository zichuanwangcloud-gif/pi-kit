#!/usr/bin/env node

// Fetch one Linear issue with its full comment timeline, attachments and derived
// requirement/document signals, as a single JSON document on stdout.
//
// Public CLI contract (documented in ../SKILL.md):
//   node fetch-linear-issue.mjs ENG-123 > out.json
// Top-level keys description / comments / commentCount / requirementRelevantComments /
// documentLinks / attachments / fetchMetadata are always present in the default (full) preset.

import {
	DEFAULT_MAX_PAGES,
	DEFAULT_PAGE_SIZE,
	EXIT,
	LinearError,
	byCreatedAt,
	describeGraphqlError,
	emit,
	fetchAllConnection,
	graphql,
	help,
	isEntrypoint,
	nowIso,
	parseIdentifier,
	resolveApiKey,
	runCli,
	safeArg,
} from "./lib-linear.mjs";

export const MAX_PAGES = DEFAULT_MAX_PAGES; // 40 pages x 50 = 2000 comments; see --max-comments.
export const METADATA_BYTE_CAP = 4096;
export const PRD_WINDOW_RADIUS = 200;
export const DEFAULT_MAX_COMMENT_CHARS = 4000;

export const REQUIREMENT_SIGNALS = [
	["prd", /\bprd\b|产品需求文档|需求文档|产品文档|需求详情/i],
	["expectation", /期望|预期|应该|应当|希望|目标|expected|desired/i],
	["acceptance", /验收|验收标准|完成标准|acceptance|definition of done|\bdod\b/i],
	["revision", /改为|调整为|修正|更正|以.+为准|不再|取消|最终方案|最终结论|更新方案|instead|supersed|override/i],
	["reproduction", /复现|复现步骤|操作步骤|触发条件|操作路径|repro/i],
	["prototype", /原型|设计稿|交互稿|figma|mockup|prototype/i],
	["scope", /范围|包含|不包含|暂不|本期|下期|scope/i],
	["decision", /结论|确认|定稿|决定|方案[一二三四五A-Ea-e]|decision/i],
];

// Kept for compatibility with the previous single-regex heuristic.
export const DOCUMENT_HINT =
	/\bprd\b|产品|需求|验收|规格|方案|设计|原型|文档|spec|requirement|design|prototype|figma|notion|yuque|语雀|feishu|lark|docs\.google/i;

export const DOCUMENT_SIGNALS = [
	["prd", /\bprd\b|产品需求|需求文档|产品文档/i],
	["requirement", /需求|规格|spec\b|requirement/i],
	["acceptance", /验收|完成标准|acceptance/i],
	["design", /设计|方案|原型|交互稿|design|prototype|figma|mockup/i],
	["docHost", /notion\.so|yuque\.com|语雀|feishu\.cn|larksuite|docs\.google|confluence|sharepoint|\.pdf(?:$|[?#])/i],
	["docWord", /文档|\bdocs?\b|wiki/i],
];

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|heic)(?:$|[?#])/i;
const LINEAR_UPLOADS_PREFIX = "https://uploads.linear.app/";

const PR_URL_PATTERNS = [
	{ provider: "github", pattern: /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i },
	{ provider: "gitlab", pattern: /^https?:\/\/[^/\s]+\/(.+?)\/-\/merge_requests\/(\d+)/i },
];

const HELP_TEXT = `Usage: fetch-linear-issue.mjs <TEAM-123|123|#123> [options]

Emits one JSON document describing a Linear issue, its comment timeline, attachments and
derived requirement/document signals.

Options:
  --fields <preset|csv>      Trim the output. Presets: meta, scope, links, reqs, full (default full).
                             A comma-separated list of top-level keys also works.
  --compact                  Emit single-line JSON instead of 2-space indented JSON.
  --max-comments <n>         Keep only the newest n comments plus every requirement-relevant one.
                             0 (default) keeps all; the count dropped is reported as commentsOmitted.
  --max-comment-chars <n>    Truncate each comment body to n characters (default ${DEFAULT_MAX_COMMENT_CHARS}, 0 disables).
  --include-emails           Include user email addresses. Omitted by default to limit PII.
  -h, --help                 Print this help on stdout and exit 0.

Environment:
  LINEAR_API_KEY             Personal API key. Or LINEAR_API_KEY_FILE, or ~/.config/pi/linear-api-key (mode 600).
  LINEAR_TEAM_KEY            Team key used to expand bare issue numbers, for example ENG.
  LINEAR_TIMEOUT_MS          Per-request timeout, default 30000.
  LINEAR_MAX_ATTEMPTS        Max attempts per request, default 5.
  SOURCE_DATE_EPOCH          Pins fetchMetadata.fetchedAt for reproducible output.

Exit codes: 0 ok, 2 usage, 3 not found, 4 auth, 5 rate limit, 6 network, 7 graphql, 1 unknown.
Failures print {"ok":false,"code":...,"message":...} on stderr.`;

const CORE_FIELDS = ["fetchMetadata", "id", "identifier", "number", "title", "url", "archived"];
const META_FIELDS = [
	"branchName",
	"priority",
	"priorityLabel",
	"estimate",
	"dueDate",
	"createdAt",
	"updatedAt",
	"startedAt",
	"triagedAt",
	"completedAt",
	"canceledAt",
	"archivedAt",
	"slaBreachesAt",
	"customerTicketCount",
	"integrationSourceType",
	"state",
	"team",
	"assignee",
	"creator",
	"project",
	"projectMilestone",
	"cycle",
	"labels",
];
const SCOPE_FIELDS = ["description", "parent", "children", "relations", "inverseRelations", "blockedBy"];
const LINK_FIELDS = ["attachmentCount", "attachments", "linkedPullRequests", "embeddedImages", "documentLinks"];
const REQ_FIELDS = ["description", "commentCount", "comments", "requirementRelevantComments"];

export const FIELD_PRESETS = {
	meta: [...CORE_FIELDS, ...META_FIELDS],
	scope: [...CORE_FIELDS, ...META_FIELDS, ...SCOPE_FIELDS],
	links: [...CORE_FIELDS, ...META_FIELDS, ...LINK_FIELDS],
	reqs: [...CORE_FIELDS, ...META_FIELDS, ...REQ_FIELDS],
	full: null, // null => keep everything
};

const ISSUE_FRAGMENT_FIELDS = "id identifier title url state { id name type }";

const ISSUE_QUERY = `
query IssueForPi($teamKey: String!, $number: Float!) {
  issues(
    filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }
    first: 2
    includeArchived: true
  ) {
    nodes {
      id
      identifier
      number
      title
      description
      branchName
      url
      priority
      priorityLabel
      estimate
      dueDate
      createdAt
      updatedAt
      startedAt
      triagedAt
      completedAt
      canceledAt
      archivedAt
      slaBreachesAt
      customerTicketCount
      integrationSourceType
      state { id name type position }
      team { id key name }
      assignee { id name displayName email }
      creator { id name displayName email }
      project { id name url state startDate targetDate }
      projectMilestone { id name targetDate }
      cycle { id number name startsAt endsAt }
      labels(first: 100) { nodes { id name color } }
      parent { ${ISSUE_FRAGMENT_FIELDS} }
      children(first: 100) { nodes { ${ISSUE_FRAGMENT_FIELDS} } }
      relations(first: 50) { nodes { id type relatedIssue { ${ISSUE_FRAGMENT_FIELDS} } } }
      inverseRelations(first: 50) { nodes { id type issue { ${ISSUE_FRAGMENT_FIELDS} } } }
    }
  }
}`;

// Probe used only to tell "issue does not exist" apart from "this key cannot see the team".
const TEAM_PROBE_QUERY = `
query TeamProbeForPi($key: String!) {
  teams(filter: { key: { eq: $key } }, first: 1) {
    nodes { id key name }
  }
}`;

const COMMENTS_QUERY = `
query IssueCommentsForPi($issueId: String!, $after: String, $first: Int!) {
  issue(id: $issueId) {
    comments(first: $first, after: $after, orderBy: createdAt) {
      nodes {
        id
        body
        createdAt
        updatedAt
        resolvedAt
        url
        parent { id }
        user { id name displayName email }
        botActor { id name type }
        externalUser { id name }
        resolvingUser { id name }
        reactions { emoji }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const ATTACHMENTS_QUERY = `
query IssueAttachmentsForPi($issueId: String!, $after: String, $first: Int!) {
  issue(id: $issueId) {
    attachments(first: $first, after: $after, orderBy: createdAt) {
      nodes {
        id
        title
        url
        subtitle
        sourceType
        groupBySource
        metadata
        createdAt
        updatedAt
        creator { id name displayName email }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function parseArgs(argv) {
	const options = {
		identifier: "",
		fields: "full",
		compact: false,
		maxComments: 0,
		maxCommentChars: DEFAULT_MAX_COMMENT_CHARS,
		includeEmails: false,
		wantHelp: false,
	};

	const positionals = [];
	let sentinel = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (sentinel) {
			positionals.push(arg);
			continue;
		}
		if (arg === "--") {
			sentinel = true;
			continue;
		}
		switch (arg) {
			case "-h":
			case "--help":
				options.wantHelp = true;
				return options;
			case "--compact":
				options.compact = true;
				break;
			case "--include-emails":
				options.includeEmails = true;
				break;
			case "--fields":
			case "--max-comments":
			case "--max-comment-chars": {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) {
					throw new LinearError("USAGE", `${arg} requires a value`);
				}
				if (arg === "--fields") options.fields = value;
				else if (arg === "--max-comments") options.maxComments = nonNegativeInt(arg, value);
				else options.maxCommentChars = nonNegativeInt(arg, value);
				index += 1;
				break;
			}
			default:
				if (arg.startsWith("-") && arg !== "-") throw new LinearError("USAGE", `unknown option: ${safeArg(arg)}`);
				positionals.push(arg);
		}
	}

	if (positionals.length === 0) throw new LinearError("USAGE", "missing issue identifier");
	if (positionals.length > 1) throw new LinearError("USAGE", "expected exactly one issue identifier");
	options.identifier = positionals[0];
	return options;
}

function nonNegativeInt(flag, value) {
	if (!/^\d{1,9}$/.test(String(value).trim())) {
		throw new LinearError("USAGE", `${flag} expects a non-negative integer, got ${safeArg(value)}`);
	}
	return Number(String(value).trim());
}

export function requirementSignals(body) {
	return REQUIREMENT_SIGNALS.filter(([, pattern]) => pattern.test(body)).map(([name]) => name);
}

export function documentSignals(text) {
	return DOCUMENT_SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

export function extractUrls(text) {
	if (!text) return [];
	const matches = String(text).match(/https?:\/\/[^\s<>"'\]}]+/gi) ?? [];
	return [...new Set(matches.map((url) => url.replace(/[),.;:!?，。；：！？]+$/u, "")))];
}

export function contextWindow(text, url, radius = PRD_WINDOW_RADIUS) {
	const haystack = String(text ?? "");
	if (!haystack) return "";
	const index = haystack.indexOf(url);
	if (index < 0) return haystack.slice(0, radius * 2);
	return haystack.slice(Math.max(0, index - radius), Math.min(haystack.length, index + url.length + radius));
}

/**
 * Order comments so replies follow their parent in chronological thread order, while still
 * returning one flat array (agents read the timeline linearly). Iterative to survive deep chains.
 */
export function threadComments(raw) {
	const all = [...(raw ?? [])].sort(byCreatedAt);
	const present = new Set(all.map((comment) => comment?.id).filter((id) => typeof id === "string" && id));
	const childrenOf = new Map();
	const roots = [];

	for (const comment of all) {
		const parentId = comment?.parent?.id ?? null;
		if (parentId && parentId !== comment?.id && present.has(parentId)) {
			if (!childrenOf.has(parentId)) childrenOf.set(parentId, []);
			childrenOf.get(parentId).push(comment);
		} else {
			roots.push(comment);
		}
	}

	const ordered = [];
	const visited = new Set();

	const walk = (root) => {
		const stack = [{ comment: root, depth: 0, threadId: root?.id ?? "" }];
		while (stack.length) {
			const frame = stack.pop();
			const id = frame.comment?.id;
			if (id && visited.has(id)) continue;
			if (id) visited.add(id);
			ordered.push({ comment: frame.comment, depth: frame.depth, threadId: frame.threadId, sequence: ordered.length + 1 });
			const children = childrenOf.get(id) ?? [];
			for (let index = children.length - 1; index >= 0; index -= 1) {
				stack.push({ comment: children[index], depth: frame.depth + 1, threadId: frame.threadId });
			}
		}
	};

	for (const root of roots) walk(root);
	// A parent cycle would leave nodes unvisited; surface them rather than silently dropping data.
	for (const comment of all) if (!comment?.id || !visited.has(comment.id)) walk(comment);
	return ordered;
}

function person(entity, includeEmails) {
	if (!entity) return null;
	const value = {
		id: entity.id ?? null,
		name: entity.name ?? entity.displayName ?? null,
	};
	if (Object.prototype.hasOwnProperty.call(entity, "displayName")) value.displayName = entity.displayName ?? null;
	value.email = includeEmails ? (entity.email ?? null) : null;
	return value;
}

function truncateBody(body, maxChars) {
	if (!maxChars || maxChars <= 0 || body.length <= maxChars) {
		return { body, truncated: false, originalChars: body.length };
	}
	const marker = `\n\n[truncated: showing ${maxChars} of ${body.length} characters; re-run with --max-comment-chars 0 for the full body]`;
	return { body: `${body.slice(0, maxChars)}${marker}`, truncated: true, originalChars: body.length };
}

export function normalizeComments(rawComments, options = {}) {
	const includeEmails = options.includeEmails === true;
	const maxChars = options.maxCommentChars ?? DEFAULT_MAX_COMMENT_CHARS;

	return threadComments(rawComments).map(({ comment, depth, threadId, sequence }) => {
		const fullBody = typeof comment?.body === "string" ? comment.body : "";
		const signals = requirementSignals(fullBody);
		const { body, truncated, originalChars } = truncateBody(fullBody, maxChars);
		const parentId = comment?.parent?.id ?? null;
		const botActor = comment?.botActor ?? null;

		return {
			sequence,
			depth,
			threadId,
			threadRootId: parentId ?? comment?.id ?? null,
			isReply: Boolean(parentId),
			parentId,
			id: comment?.id ?? null,
			body,
			bodyTruncated: truncated,
			bodyChars: originalChars,
			createdAt: comment?.createdAt ?? null,
			updatedAt: comment?.updatedAt ?? null,
			resolvedAt: comment?.resolvedAt ?? null,
			isResolved: Boolean(comment?.resolvedAt),
			resolvingUser: person(comment?.resolvingUser, includeEmails),
			url: comment?.url ?? "",
			links: extractUrls(fullBody),
			requirementSignals: signals,
			isRequirementRelevant: signals.length > 0,
			user: person(comment?.user, includeEmails),
			botActor: botActor ? { id: botActor.id ?? null, name: botActor.name ?? null, type: botActor.type ?? null } : null,
			externalUser: comment?.externalUser
				? { id: comment.externalUser.id ?? null, name: comment.externalUser.name ?? null }
				: null,
			isBot: Boolean(botActor),
			reactions: Array.isArray(comment?.reactions)
				? [...new Set(comment.reactions.map((reaction) => reaction?.emoji).filter(Boolean))]
				: [],
		};
	});
}

/** Keep the newest N comments plus every requirement-relevant one; report what was dropped. */
export function limitComments(comments, maxComments) {
	if (!maxComments || maxComments <= 0 || comments.length <= maxComments) {
		return { comments, commentsOmitted: 0 };
	}
	const keep = new Set();
	for (const comment of comments.slice(-maxComments)) keep.add(comment.sequence);
	for (const comment of comments) if (comment.isRequirementRelevant) keep.add(comment.sequence);
	const kept = comments.filter((comment) => keep.has(comment.sequence));
	return { comments: kept, commentsOmitted: comments.length - kept.length };
}

function capMetadata(metadata) {
	if (metadata === null || metadata === undefined) {
		return { metadata: null, metadataTruncated: false, metadataBytes: 0 };
	}
	let serialized;
	try {
		serialized = JSON.stringify(metadata);
	} catch {
		return { metadata: null, metadataTruncated: true, metadataBytes: 0 };
	}
	const bytes = Buffer.byteLength(serialized ?? "", "utf8");
	if (bytes <= METADATA_BYTE_CAP) return { metadata, metadataTruncated: false, metadataBytes: bytes };
	return { metadata: null, metadataTruncated: true, metadataBytes: bytes };
}

export function normalizeAttachments(rawAttachments, options = {}) {
	const includeEmails = options.includeEmails === true;
	return [...(rawAttachments ?? [])].sort(byCreatedAt).map((attachment) => {
		const capped = capMetadata(attachment?.metadata ?? null);
		return {
			id: attachment?.id ?? null,
			title: attachment?.title ?? null,
			url: attachment?.url ?? null,
			subtitle: attachment?.subtitle ?? null,
			sourceType: attachment?.sourceType ?? null,
			groupBySource: attachment?.groupBySource ?? null,
			metadata: capped.metadata,
			metadataTruncated: capped.metadataTruncated,
			metadataBytes: capped.metadataBytes,
			createdAt: attachment?.createdAt ?? null,
			updatedAt: attachment?.updatedAt ?? null,
			creator: person(attachment?.creator, includeEmails),
		};
	});
}

function matchPrUrl(url) {
	for (const { provider, pattern } of PR_URL_PATTERNS) {
		const match = String(url ?? "").match(pattern);
		if (!match) continue;
		if (provider === "github") {
			return { provider, owner: match[1], repo: match[2].replace(/\.git$/i, ""), number: Number(match[3]) };
		}
		return { provider, owner: match[1], repo: match[1].split("/").pop() ?? match[1], number: Number(match[2]) };
	}
	return null;
}

/**
 * Derive the PR<->issue link that linear-pr-audit needs to confirm it is auditing the right PR.
 * Both the attachment URL and its Linear-populated metadata are consulted.
 */
export function deriveLinkedPullRequests(attachments) {
	const found = new Map();

	for (const attachment of attachments ?? []) {
		const sourceType = String(attachment?.sourceType ?? "");
		const metadata = attachment?.metadata && typeof attachment.metadata === "object" ? attachment.metadata : {};
		const candidates = [attachment?.url, metadata.url, metadata.htmlUrl, metadata.html_url].filter(
			(value) => typeof value === "string" && value,
		);

		for (const candidate of candidates) {
			const parsed = matchPrUrl(candidate);
			if (!parsed) continue;
			const isVcsSource = /github|gitlab/i.test(sourceType) || sourceType === "";
			if (!isVcsSource) continue;
			const key = `${parsed.provider}:${parsed.owner}/${parsed.repo}#${parsed.number}`;
			if (found.has(key)) continue;
			const status = metadata.status ?? metadata.state ?? null;
			found.set(key, {
				key,
				provider: parsed.provider,
				owner: parsed.owner,
				repo: parsed.repo,
				number: parsed.number,
				url: candidate,
				title: typeof metadata.title === "string" ? metadata.title : (attachment?.title ?? null),
				status: typeof status === "string" ? status : null,
				merged: typeof status === "string" ? /^merged$/i.test(status) : null,
				draft: typeof metadata.draft === "boolean" ? metadata.draft : null,
				branch: typeof metadata.branch === "string" ? metadata.branch : null,
				sourceType: sourceType || null,
				attachmentId: attachment?.id ?? null,
				createdAt: attachment?.createdAt ?? null,
			});
			break;
		}
	}

	return [...found.values()];
}

export function extractEmbeddedImages(texts) {
	const images = new Map();

	const add = (url) => {
		const clean = String(url ?? "").trim().replace(/[),.;:!?]+$/u, "");
		if (!/^https?:\/\//i.test(clean)) return;
		if (images.has(clean)) return;
		images.set(clean, { url: clean, requiresAuth: clean.startsWith(LINEAR_UPLOADS_PREFIX) });
	};

	for (const text of texts ?? []) {
		const body = typeof text === "string" ? text : "";
		if (!body) continue;
		for (const match of body.matchAll(/!\[[^\]]*\]\(\s*(<?)([^\s)>]+)\1[^)]*\)/g)) add(match[2]);
		for (const match of body.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match[1]);
		for (const url of extractUrls(body)) {
			if (IMAGE_EXTENSION.test(url) || url.startsWith(LINEAR_UPLOADS_PREFIX)) add(url);
		}
	}

	return [...images.values()];
}

export function buildDocumentLinks(issue, comments, attachments) {
	const links = new Map();

	function add(url, source, context = "", title = "") {
		if (!url) return;
		let entry = links.get(url);
		if (!entry) {
			entry = { url, isPotentialPrd: false, prdScore: 0, prdSignals: [], titles: [], sources: [] };
			links.set(url, entry);
		}
		if (title && !entry.titles.includes(title)) entry.titles.push(title);

		// Score against a bounded window around the URL, not the whole document: a 40 KB
		// description containing the word "需求" once must not mark every link a PRD.
		const window = contextWindow(context, url);
		const signals = documentSignals(`${url} ${title} ${window}`);
		for (const signal of signals) if (!entry.prdSignals.includes(signal)) entry.prdSignals.push(signal);
		entry.prdScore = entry.prdSignals.length;
		entry.isPotentialPrd = entry.prdScore > 0;

		const key = `${source.type}|${source.commentId ?? source.attachmentId ?? ""}`;
		if (!entry.sources.some((existing) => `${existing.type}|${existing.commentId ?? existing.attachmentId ?? ""}` === key)) {
			entry.sources.push(source);
		}
	}

	const description = issue?.description ?? "";
	for (const url of extractUrls(description)) add(url, { type: "description" }, description);

	for (const comment of comments ?? []) {
		for (const url of comment.links ?? []) {
			add(
				url,
				{
					type: "comment",
					sequence: comment.sequence,
					commentId: comment.id,
					author: comment.user?.name ?? comment.botActor?.name ?? "unknown",
					createdAt: comment.createdAt,
				},
				comment.body,
			);
		}
	}

	for (const attachment of attachments ?? []) {
		add(
			attachment.url,
			{ type: "attachment", attachmentId: attachment.id, createdAt: attachment.createdAt },
			`${attachment.subtitle ?? ""} ${attachment.sourceType ?? ""} ${attachment.title ?? ""}`,
			attachment.title ?? "",
		);
	}

	return [...links.values()];
}

function shortIssue(node) {
	if (!node) return null;
	return {
		id: node.id ?? null,
		identifier: node.identifier ?? null,
		title: node.title ?? null,
		url: node.url ?? null,
		state: node.state ? { id: node.state.id ?? null, name: node.state.name ?? null, type: node.state.type ?? null } : null,
	};
}

const OPEN_STATE = (node) => !["completed", "canceled"].includes(String(node?.state?.type ?? "").toLowerCase());

/** Inbound `blocks` relations whose source issue is still open. */
export function deriveBlockedBy(inverseRelations) {
	return (inverseRelations ?? [])
		.filter((relation) => String(relation?.type ?? "").toLowerCase() === "blocks")
		.map((relation) => ({ relationId: relation?.id ?? null, issue: shortIssue(relation?.issue) }))
		.filter((entry) => entry.issue && OPEN_STATE(entry.issue));
}

/** Keep only the requested top-level keys. Core identity keys are always retained. */
export function selectFields(document, fields) {
	const spec = String(fields ?? "full").trim();
	if (!spec || spec === "full") return document;

	let keys;
	if (Object.prototype.hasOwnProperty.call(FIELD_PRESETS, spec)) {
		keys = FIELD_PRESETS[spec];
		if (keys === null) return document;
	} else {
		const requested = spec
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);
		if (requested.length === 0) throw new LinearError("USAGE", `--fields is empty; expected a preset or a comma-separated list`);
		const unknown = requested.filter((key) => !Object.prototype.hasOwnProperty.call(document, key));
		if (unknown.length === requested.length) {
			throw new LinearError(
				"USAGE",
				`--fields matched no known key: ${safeArg(spec)}. Presets: ${Object.keys(FIELD_PRESETS).join(", ")}`,
			);
		}
		keys = [...CORE_FIELDS, ...requested];
	}

	const allow = new Set(keys);
	const trimmed = {};
	for (const [key, value] of Object.entries(document)) if (allow.has(key)) trimmed[key] = value;
	trimmed.fetchMetadata = { ...trimmed.fetchMetadata, fields: spec };
	return trimmed;
}

export function normalizeIssue(issue, commentResult, attachmentResult, options = {}) {
	const includeEmails = options.includeEmails === true;
	const allComments = normalizeComments(commentResult.nodes, {
		includeEmails,
		maxCommentChars: options.maxCommentChars,
	});
	const { comments, commentsOmitted } = limitComments(allComments, options.maxComments);
	const attachments = normalizeAttachments(attachmentResult.nodes, { includeEmails });
	const documentLinks = buildDocumentLinks(issue, comments, attachments);
	const linkedPullRequests = deriveLinkedPullRequests(attachments);
	const embeddedImages = extractEmbeddedImages([issue?.description ?? "", ...allComments.map((comment) => comment.body)]);

	const relations = (issue?.relations?.nodes ?? []).map((relation) => ({
		id: relation?.id ?? null,
		type: relation?.type ?? null,
		direction: "outbound",
		issue: shortIssue(relation?.relatedIssue),
	}));
	const inverseRelations = (issue?.inverseRelations?.nodes ?? []).map((relation) => ({
		id: relation?.id ?? null,
		type: relation?.type ?? null,
		direction: "inbound",
		issue: shortIssue(relation?.issue),
	}));

	const partialErrors = [...(commentResult.errors ?? []), ...(attachmentResult.errors ?? [])];
	const warnings = [];
	if (commentResult.truncated) {
		warnings.push(
			`comment pagination stopped after ${commentResult.pages} pages (~${commentResult.nodes.length} comments); the timeline is incomplete. Narrow the payload with --max-comments <n> or read the issue in Linear.`,
		);
	}
	if (attachmentResult.truncated) {
		warnings.push(`attachment pagination stopped after ${attachmentResult.pages} pages; the attachment list is incomplete.`);
	}

	const botCommentCount = allComments.filter((comment) => comment.isBot).length;

	const document = {
		fetchMetadata: {
			fetchedAt: nowIso(),
			complete: commentResult.complete && attachmentResult.complete,
			pages: commentResult.pages + attachmentResult.pages,
			truncated: commentResult.truncated || attachmentResult.truncated,
			commentsOmitted,
			partialErrors,
			warnings,
			humanCommentCount: allComments.length - botCommentCount,
			botCommentCount,
			totalCommentCount: allComments.length,
			maxPages: MAX_PAGES,
			// Retained for compatibility with the pre-hardening output shape.
			commentsComplete: commentResult.complete,
			commentPagesFetched: commentResult.pages,
			attachmentsComplete: attachmentResult.complete,
			attachmentPagesFetched: attachmentResult.pages,
		},
		id: issue?.id ?? null,
		identifier: issue?.identifier ?? null,
		number: issue?.number ?? null,
		title: issue?.title ?? null,
		branchName: issue?.branchName ?? null,
		url: issue?.url ?? null,
		archived: Boolean(issue?.archivedAt),
		description: issue?.description ?? "",
		priority: issue?.priority ?? null,
		priorityLabel: issue?.priorityLabel ?? "",
		estimate: issue?.estimate ?? null,
		dueDate: issue?.dueDate ?? null,
		createdAt: issue?.createdAt ?? null,
		updatedAt: issue?.updatedAt ?? null,
		startedAt: issue?.startedAt ?? null,
		triagedAt: issue?.triagedAt ?? null,
		completedAt: issue?.completedAt ?? null,
		canceledAt: issue?.canceledAt ?? null,
		archivedAt: issue?.archivedAt ?? null,
		slaBreachesAt: issue?.slaBreachesAt ?? null,
		customerTicketCount: issue?.customerTicketCount ?? null,
		integrationSourceType: issue?.integrationSourceType ?? null,
		state: issue?.state
			? {
					id: issue.state.id ?? null,
					name: issue.state.name ?? null,
					type: issue.state.type ?? null,
					position: issue.state.position ?? null,
				}
			: null,
		team: issue?.team ? { id: issue.team.id ?? null, key: issue.team.key ?? null, name: issue.team.name ?? null } : null,
		assignee: person(issue?.assignee, includeEmails),
		creator: person(issue?.creator, includeEmails),
		project: issue?.project
			? {
					id: issue.project.id ?? null,
					name: issue.project.name ?? null,
					url: issue.project.url ?? null,
					state: issue.project.state ?? null,
					startDate: issue.project.startDate ?? null,
					targetDate: issue.project.targetDate ?? null,
				}
			: null,
		projectMilestone: issue?.projectMilestone
			? {
					id: issue.projectMilestone.id ?? null,
					name: issue.projectMilestone.name ?? null,
					targetDate: issue.projectMilestone.targetDate ?? null,
				}
			: null,
		cycle: issue?.cycle
			? {
					id: issue.cycle.id ?? null,
					number: issue.cycle.number ?? null,
					name: issue.cycle.name ?? null,
					startsAt: issue.cycle.startsAt ?? null,
					endsAt: issue.cycle.endsAt ?? null,
				}
			: null,
		labels: (issue?.labels?.nodes ?? []).map((label) => ({
			id: label?.id ?? null,
			name: label?.name ?? null,
			color: label?.color ?? null,
		})),
		parent: shortIssue(issue?.parent),
		children: (issue?.children?.nodes ?? []).map(shortIssue),
		relations,
		inverseRelations,
		blockedBy: deriveBlockedBy(issue?.inverseRelations?.nodes ?? []),
		commentCount: comments.length,
		comments,
		requirementRelevantComments: comments
			.filter((comment) => comment.isRequirementRelevant)
			.map((comment) => ({
				sequence: comment.sequence,
				id: comment.id,
				createdAt: comment.createdAt,
				author: comment.user?.name ?? comment.botActor?.name ?? "unknown",
				requirementSignals: comment.requirementSignals,
				threadRootId: comment.threadRootId,
				isReply: comment.isReply,
				resolvedAt: comment.resolvedAt,
			})),
		attachmentCount: attachments.length,
		attachments,
		linkedPullRequests,
		embeddedImages,
		documentLinks,
	};

	return document;
}

/** Tell "the issue number does not exist" apart from "this API key cannot see the team". */
async function explainMissingIssue(apiKey, parsed) {
	let visible = false;
	try {
		const probe = await graphql(apiKey, TEAM_PROBE_QUERY, { key: parsed.team });
		visible = (probe.data?.teams?.nodes ?? []).length > 0;
	} catch (error) {
		if (error instanceof LinearError && error.code === "AUTH") throw error;
		// A probe failure must not mask the original miss; fall back to NOT_FOUND.
		return new LinearError("NOT_FOUND", `Linear issue not found: ${parsed.identifier}`);
	}
	if (visible) {
		return new LinearError(
			"NOT_FOUND",
			`Linear issue not found: ${parsed.identifier}. Team ${parsed.team} is visible to this API key, so issue number ${parsed.number} either does not exist or was permanently deleted.`,
		);
	}
	return new LinearError(
		"AUTH",
		`Linear team ${parsed.team} is not visible to this API key (wrong workspace, or a private team you have not been added to). The identifier ${parsed.identifier} may well be correct.`,
	);
}

async function main(secret) {
	const options = parseArgs(process.argv.slice(2));
	if (options.wantHelp) {
		help(HELP_TEXT);
		return;
	}

	const parsed = parseIdentifier(options.identifier);
	const apiKey = await resolveApiKey();
	secret.key = apiKey;

	const issueResult = await graphql(apiKey, ISSUE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = issueResult.data?.issues?.nodes ?? [];
	if (issues.length === 0) throw await explainMissingIssue(apiKey, parsed);
	if (issues.length > 1) {
		throw new LinearError("CONFLICT", `Linear returned multiple issues for ${parsed.identifier}; refusing to guess`);
	}

	const issue = issues[0];
	const [commentResult, attachmentResult] = await Promise.all([
		fetchAllConnection(apiKey, {
			query: COMMENTS_QUERY,
			variables: { issueId: issue.id },
			field: "comments",
			pick: (data) => data?.issue?.comments,
			pageSize: DEFAULT_PAGE_SIZE,
			maxPages: MAX_PAGES,
		}),
		fetchAllConnection(apiKey, {
			query: ATTACHMENTS_QUERY,
			variables: { issueId: issue.id },
			field: "attachments",
			pick: (data) => data?.issue?.attachments,
			pageSize: DEFAULT_PAGE_SIZE,
			maxPages: MAX_PAGES,
		}),
	]);

	const document = normalizeIssue(issue, commentResult, attachmentResult, options);
	for (const error of issueResult.errors ?? []) document.fetchMetadata.partialErrors.push(describeGraphqlError(error));
	emit(selectFields(document, options.fields), { compact: options.compact });
}

export { EXIT, HELP_TEXT };

if (isEntrypoint(import.meta.url)) await runCli(main);

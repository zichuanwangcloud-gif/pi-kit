#!/usr/bin/env node

// Posts (or updates) one Markdown comment on a Linear issue, idempotently.
//
// Public CLI contract (documented in ../SKILL.md):
//   node post-linear-comment.mjs "$ISSUE" --body-file report.md [--dry-run]
//
// Idempotency rests on an HTML marker comment on line 1 of the body, for example
//   <!-- pi-kit:linear-pr-audit:<pr-id> -->
// Unguarded posting requires an explicit --allow-duplicate.

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
	DEFAULT_PAGE_SIZE,
	EXIT,
	LinearError,
	deterministicUuid,
	emit,
	fetchAllConnection,
	graphql,
	help,
	isEntrypoint,
	parseIdentifier,
	resolveApiKey,
	runCli,
	safeArg,
	sha256Hex,
} from "./lib-linear.mjs";

export const DEFAULT_MAX_BYTES = 60_000;
export const DEFAULT_MARKER_SCAN_PAGES = 20;
export const MARKER_PATTERN = /^<!--\s*(pi-kit:[^\s>]+)\s*-->\s*$/;

const HELP_TEXT = `Usage: post-linear-comment.mjs <TEAM-123|123|#123> --body-file <path> [options]

Posts one Markdown comment to a Linear issue. Idempotent: a marker comment on line 1 of the
body (for example "<!-- pi-kit:linear-pr-audit:123 -->") is used to detect an earlier post.

Options:
  --body-file <path>       Markdown file to post as the comment body (required, must be a regular file)
  --marker <id>            Idempotency marker; prepended to the body when absent.
                           Defaults to the <!-- pi-kit:... --> marker already on line 1.
  --update                 Update the existing marked comment instead of skipping it.
                           Reports "unchanged" when the body is already identical.
  --allow-duplicate        Post without any duplicate guard. Required when there is no marker.
  --marker-scan-pages <n>  Pages of comments to scan newest-first for the marker (default ${DEFAULT_MARKER_SCAN_PAGES}).
  --max-bytes <n>          Reject bodies larger than n UTF-8 bytes (default ${DEFAULT_MAX_BYTES}).
  --truncate               Truncate an oversized body instead of failing.
  --dry-run                Resolve the issue and run the duplicate check without writing.
  --compact                Emit single-line JSON.
  --                       End of options; the next argument is the issue identifier.
  -h, --help               Print this help on stdout and exit 0.

Environment:
  LINEAR_API_KEY           Personal API key. Or LINEAR_API_KEY_FILE, or ~/.config/pi/linear-api-key (mode 600).
  LINEAR_TEAM_KEY          Team key used to expand bare issue numbers, for example ENG.

Output is always a single JSON envelope on stdout with keys:
  ok, action, marker, bodyBytes, bodyLimitBytes, bodySha256, markerScanComplete,
  comment, existingComment, issue
action is one of: created, updated, unchanged, would-create, would-update, would-skip, skipped.

Exit codes: 0 ok, 2 usage, 3 not found, 4 auth, 5 rate limit, 6 network, 7 graphql,
8 marker conflict, 9 body too large, 1 unknown.
Failures print {"ok":false,"code":...,"message":...} on stderr.`;

const ISSUE_QUERY = `
query IssueForPiComment($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 2) {
    nodes { id identifier title url }
  }
}`;

// Backward pagination (last/before) walks newest-first, so a marker written moments ago is
// found on page 1 instead of after scanning years of history.
// $issueId must be ID! here: the IDComparator on the comments filter rejects String!.
const COMMENTS_QUERY = `
query IssueCommentsForPiComment($issueId: ID!, $before: String, $last: Int!) {
  comments(filter: { issue: { id: { eq: $issueId } } }, before: $before, last: $last, orderBy: createdAt) {
    pageInfo { hasPreviousPage startCursor }
    nodes { id url body createdAt updatedAt }
  }
}`;

const COMMENT_CREATE = `
mutation PiKitCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url createdAt updatedAt }
  }
}`;

const COMMENT_UPDATE = `
mutation PiKitCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment { id url createdAt updatedAt }
  }
}`;

export function parseArgs(argv) {
	const options = {
		identifier: "",
		bodyFile: "",
		marker: "",
		update: false,
		allowDuplicate: false,
		markerScanPages: DEFAULT_MARKER_SCAN_PAGES,
		maxBytes: DEFAULT_MAX_BYTES,
		truncate: false,
		dryRun: false,
		compact: false,
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
			case "--allow-duplicate":
				options.allowDuplicate = true;
				break;
			case "--update":
				options.update = true;
				break;
			case "--truncate":
				options.truncate = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--compact":
				options.compact = true;
				break;
			case "--body-file":
			case "--marker":
			case "--marker-scan-pages":
			case "--max-bytes": {
				const value = argv[index + 1];
				if (value === undefined || value.startsWith("--")) throw new LinearError("USAGE", `${arg} requires a value`);
				if (arg === "--body-file") options.bodyFile = value;
				else if (arg === "--marker") options.marker = value.trim();
				else if (arg === "--marker-scan-pages") options.markerScanPages = positiveInt(arg, value);
				else options.maxBytes = positiveInt(arg, value);
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
	if (!options.bodyFile) throw new LinearError("USAGE", "missing --body-file");
	return options;
}

function positiveInt(flag, value) {
	const raw = String(value).trim();
	if (!/^\d{1,9}$/.test(raw) || Number(raw) <= 0) {
		throw new LinearError("USAGE", `${flag} expects a positive integer, got ${safeArg(value)}`);
	}
	return Number(raw);
}

/** Strip a UTF-8 BOM and normalise CRLF so byte counts and hashes are stable across platforms. */
export function normalizeBody(raw) {
	return String(raw ?? "")
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function firstLine(body) {
	return normalizeBody(body).split("\n", 1)[0] ?? "";
}

/**
 * True only when line 1 IS the marker comment. A substring match anywhere would let a quoted
 * marker inside a code block ("`<!-- pi-kit:x -->`") masquerade as a real prior post.
 */
export function bodyCarriesMarker(body, marker) {
	if (!marker) return false;
	const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^<!--\\s*${escaped}\\s*-->\\s*$`).test(firstLine(body));
}

/** The marker declared on line 1 of the body, if any. */
export function detectMarker(body) {
	return firstLine(body).match(MARKER_PATTERN)?.[1] ?? "";
}

/**
 * Ensure the body carries `marker` on line 1.
 * A different marker already sitting on line 1 is a CONFLICT: silently stacking two markers
 * would break the idempotency scan for both of them.
 */
export function applyMarker(body, marker) {
	const normalized = normalizeBody(body);
	if (!marker) return normalized;
	if (bodyCarriesMarker(normalized, marker)) return normalized;

	const existing = detectMarker(normalized);
	if (existing && existing !== marker) {
		throw new LinearError(
			"CONFLICT",
			`comment body already declares marker "${existing}" on line 1 but --marker requested "${marker}"; refusing to stack markers`,
		);
	}
	return `<!-- ${marker} -->\n\n${normalized}`;
}

/** Enforce the byte budget, truncating only when explicitly allowed. */
export function enforceBodySize(body, maxBytes, allowTruncate) {
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes <= maxBytes) return { body, bodyBytes: bytes, truncated: false };
	if (!allowTruncate) {
		throw new LinearError(
			"TOO_LARGE",
			`comment body is ${bytes} bytes, over the ${maxBytes}-byte limit. Shorten it, raise --max-bytes, or pass --truncate.`,
		);
	}

	const notice = "\n\n[truncated by pi-kit: body exceeded the byte limit]";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(notice, "utf8"));
	// Slice on a byte boundary, then drop any partial trailing code point.
	const head = Buffer.from(body, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD$/, "");
	const truncatedBody = `${head}${notice}`;
	return { body: truncatedBody, bodyBytes: Buffer.byteLength(truncatedBody, "utf8"), truncated: true };
}

async function readBodyFile(path) {
	const absolute = resolve(path);
	let info;
	try {
		info = await stat(absolute);
	} catch (error) {
		if (error?.code === "ENOENT") throw new LinearError("USAGE", `--body-file does not exist: ${absolute}`);
		throw new LinearError("USAGE", `cannot read --body-file ${absolute}: ${error?.message ?? String(error)}`);
	}
	if (!info.isFile()) throw new LinearError("USAGE", `--body-file must be a regular file: ${absolute}`);
	return normalizeBody(await readFile(absolute, "utf8"));
}

async function resolveIssue(apiKey, parsed) {
	const result = await graphql(apiKey, ISSUE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = result.data?.issues?.nodes ?? [];
	if (issues.length === 0) throw new LinearError("NOT_FOUND", `Linear issue not found: ${parsed.identifier}`);
	if (issues.length > 1) {
		throw new LinearError("CONFLICT", `Linear returned multiple issues for ${parsed.identifier}; refusing to guess`);
	}
	return issues[0];
}

/**
 * Scan comments newest-first for the marker.
 * Returns { comment, complete } — `complete: false` means the scan hit the page cap, so
 * "no duplicate found" is not authoritative and the caller must not claim it is.
 */
export async function findMarkedComment(apiKey, issueId, marker, maxPages) {
	let hit = null;
	const result = await fetchAllConnection(apiKey, {
		query: COMMENTS_QUERY,
		variables: { issueId },
		field: "comments",
		pick: (data) => data?.comments,
		pageSize: DEFAULT_PAGE_SIZE,
		maxPages,
		backward: true,
		onPage: (page) => {
			// Newest-first within the page too, so the most recent marked comment wins.
			for (const comment of [...page].reverse()) {
				if (typeof comment?.body === "string" && bodyCarriesMarker(comment.body, marker)) {
					hit = comment;
					return true;
				}
			}
			return false;
		},
	});

	return { comment: hit, complete: Boolean(hit) || result.complete, pages: result.pages, scanned: result.nodes.length };
}

function envelope(fields) {
	return {
		ok: fields.ok !== false,
		action: fields.action,
		marker: fields.marker || null,
		bodyBytes: fields.bodyBytes ?? 0,
		bodyLimitBytes: fields.bodyLimitBytes ?? DEFAULT_MAX_BYTES,
		bodySha256: fields.bodySha256 ?? null,
		bodyTruncated: fields.bodyTruncated === true,
		markerScanComplete: fields.markerScanComplete ?? null,
		comment: fields.comment ?? null,
		existingComment: fields.existingComment ?? null,
		issue: fields.issue ?? null,
		// Retained for compatibility with the pre-hardening output shape.
		posted: fields.action === "created" || fields.action === "updated",
		skipped: fields.skipped ?? null,
	};
}

function commentView(comment) {
	if (!comment) return null;
	return {
		id: comment.id ?? null,
		url: comment.url ?? null,
		createdAt: comment.createdAt ?? null,
		updatedAt: comment.updatedAt ?? null,
	};
}

async function main(secret) {
	const options = parseArgs(process.argv.slice(2));
	if (options.wantHelp) {
		help(HELP_TEXT);
		return;
	}

	const parsed = parseIdentifier(options.identifier);
	const rawBody = await readBodyFile(options.bodyFile);
	if (!rawBody.trim()) throw new LinearError("USAGE", `comment body file is empty: ${options.bodyFile}`);

	const marker = options.marker || detectMarker(rawBody);
	if (!marker && !options.allowDuplicate) {
		throw new LinearError(
			"USAGE",
			"no idempotency marker found. Put a <!-- pi-kit:... --> line at the top of the body, pass --marker <id>, or opt into unguarded posting with --allow-duplicate.",
		);
	}

	const markedBody = applyMarker(rawBody, marker);
	const sized = enforceBodySize(markedBody, options.maxBytes, options.truncate);
	const body = sized.body;
	const base = {
		marker,
		bodyBytes: sized.bodyBytes,
		bodyLimitBytes: options.maxBytes,
		bodySha256: sha256Hex(body),
		bodyTruncated: sized.truncated,
	};

	const apiKey = await resolveApiKey();
	secret.key = apiKey;

	const issue = await resolveIssue(apiKey, parsed);
	const target = { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };

	let existing = null;
	let markerScanComplete = null;
	if (marker && !options.allowDuplicate) {
		const scan = await findMarkedComment(apiKey, issue.id, marker, options.markerScanPages);
		existing = scan.comment;
		markerScanComplete = scan.complete;
	}

	const existingBody = typeof existing?.body === "string" ? normalizeBody(existing.body) : null;
	const identical = existingBody !== null && existingBody === body;

	if (existing && !options.update) {
		emit(
			envelope({
				...base,
				action: options.dryRun ? "would-skip" : "skipped",
				skipped: "duplicate-marker",
				markerScanComplete,
				existingComment: commentView(existing),
				issue: target,
			}),
			{ compact: options.compact },
		);
		return;
	}

	if (existing && identical) {
		emit(
			envelope({
				...base,
				action: "unchanged",
				markerScanComplete,
				comment: commentView(existing),
				existingComment: commentView(existing),
				issue: target,
			}),
			{ compact: options.compact },
		);
		return;
	}

	if (options.dryRun) {
		emit(
			envelope({
				...base,
				action: existing ? "would-update" : "would-create",
				skipped: "dry-run",
				markerScanComplete,
				existingComment: commentView(existing),
				issue: target,
			}),
			{ compact: options.compact },
		);
		return;
	}

	if (existing) {
		const result = await graphql(apiKey, COMMENT_UPDATE, { id: existing.id, input: { body } }, { mutation: true });
		const updated = result.data?.commentUpdate;
		if (!updated?.success || !updated.comment?.id) {
			throw new LinearError("GRAPHQL", "Linear reported the comment was not updated");
		}
		emit(
			envelope({
				...base,
				action: "updated",
				markerScanComplete,
				comment: commentView(updated.comment),
				existingComment: commentView(existing),
				issue: target,
			}),
			{ compact: options.compact },
		);
		return;
	}

	// A deterministic id makes a retried mutation idempotent server-side: if the first attempt
	// actually landed before the socket died, the retry collides instead of double-posting.
	const commentId = deterministicUuid(issue.id, marker, body);
	const result = await graphql(
		apiKey,
		COMMENT_CREATE,
		{ input: { id: commentId, issueId: issue.id, body } },
		{ mutation: true },
	);
	const created = result.data?.commentCreate;
	if (!created?.success || !created.comment?.id) {
		throw new LinearError("GRAPHQL", "Linear reported the comment was not created");
	}

	emit(
		envelope({
			...base,
			action: "created",
			markerScanComplete,
			comment: commentView(created.comment),
			issue: target,
		}),
		{ compact: options.compact },
	);
}

export { EXIT, HELP_TEXT };

if (isEntrypoint(import.meta.url)) await runCli(main);

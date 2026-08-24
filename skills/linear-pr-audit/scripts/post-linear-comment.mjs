#!/usr/bin/env node

// Posts one Markdown comment to a Linear issue.
//
// Credential resolution, auth header shape and GraphQL error handling intentionally
// mirror ../../linear-to-pr/scripts/fetch-linear-issue.mjs. That script exports nothing,
// so the helpers are duplicated here rather than imported across skill boundaries.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const API_URL = "https://api.linear.app/graphql";
const DEFAULT_TEAM = process.env.LINEAR_TEAM_KEY?.trim().toUpperCase() ?? "";
const PAGE_SIZE = 50;
const MAX_PAGES = 1000;
const MARKER_PATTERN = /^<!--\s*(pi-kit:[^\s>]+)\s*-->\s*$/;

function usage(message) {
	if (message) console.error(`Error: ${message}`);
	console.error("Usage: post-linear-comment.mjs <TEAM-123|123|#123> --body-file <path> [options]");
	console.error("");
	console.error("Options:");
	console.error("  --body-file <path>   Markdown file to post as the comment body (required)");
	console.error("  --marker <id>        Idempotency marker; defaults to a leading <!-- pi-kit:... --> line");
	console.error("  --allow-duplicate    Post even when the marker already exists on the issue");
	console.error("  --dry-run            Resolve the issue and check for duplicates without posting");
	console.error("");
	console.error("Bare numbers require LINEAR_TEAM_KEY, for example LINEAR_TEAM_KEY=ENG.");
	process.exit(2);
}

function parseArgs(argv) {
	const options = { identifier: "", bodyFile: "", marker: "", allowDuplicate: false, dryRun: false };

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "-h":
			case "--help":
				usage();
				break;
			case "--body-file":
			case "--marker": {
				const value = argv[index + 1];
				if (!value || value.startsWith("--")) usage(`${arg} requires a value`);
				if (arg === "--body-file") options.bodyFile = value;
				else options.marker = value;
				index += 1;
				break;
			}
			case "--allow-duplicate":
				options.allowDuplicate = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				if (arg.startsWith("-")) usage(`unknown option: ${arg}`);
				if (options.identifier) usage("expected exactly one issue identifier");
				options.identifier = arg;
		}
	}

	if (!options.identifier) usage("missing issue identifier");
	if (!options.bodyFile) usage("missing --body-file");
	return options;
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
	// Linear can answer HTTP 200 with a populated errors array; never treat that as success.
	if (payload.errors?.length) {
		throw new Error(`Linear GraphQL error: ${payload.errors.map((error) => error.message).join("; ")}`);
	}

	return payload.data;
}

const ISSUE_QUERY = `
query IssueForPiComment($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 2) {
    nodes {
      id
      identifier
      title
      url
    }
  }
}`;

const COMMENTS_QUERY = `
query IssueCommentsForPiComment($issueId: String!, $after: String, $first: Int!) {
  comments(filter: { issue: { id: { eq: $issueId } } }, after: $after, first: $first) {
    pageInfo { hasNextPage endCursor }
    nodes { id url body createdAt }
  }
}`;

const COMMENT_CREATE = `
mutation PiKitCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url createdAt }
  }
}`;

async function resolveIssue(apiKey, parsed) {
	const data = await graphql(apiKey, ISSUE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = data?.issues?.nodes ?? [];
	if (issues.length === 0) throw new Error(`Linear issue not found: ${parsed.identifier}`);
	if (issues.length > 1) throw new Error(`Linear returned multiple issues for ${parsed.identifier}`);
	return issues[0];
}

async function findMarkedComment(apiKey, issueId, marker) {
	let after = null;
	for (let page = 0; page < MAX_PAGES; page += 1) {
		const data = await graphql(apiKey, COMMENTS_QUERY, { issueId, after, first: PAGE_SIZE });
		const connection = data?.comments;
		if (!connection?.nodes) throw new Error("Linear returned an invalid comments connection");

		const hit = connection.nodes.find((comment) => typeof comment.body === "string" && comment.body.includes(marker));
		if (hit) return hit;

		if (!connection.pageInfo?.hasNextPage) return null;
		const next = connection.pageInfo.endCursor;
		if (!next || next === after) {
			throw new Error("Linear comment pagination cursor did not advance; refusing to claim the marker is absent");
		}
		after = next;
	}
	throw new Error(`comment pagination exceeded ${MAX_PAGES} pages; refusing to claim the marker is absent`);
}

function detectMarker(body, override) {
	if (override) return override;
	const firstLine = body.split(/\r?\n/, 1)[0] ?? "";
	return firstLine.match(MARKER_PATTERN)?.[1] ?? "";
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const parsed = parseIdentifier(options.identifier);

	const body = await readFile(resolve(options.bodyFile), "utf8");
	if (!body.trim()) throw new Error(`comment body file is empty: ${options.bodyFile}`);

	const apiKey = await resolveApiKey();
	if (!apiKey) {
		throw new Error(
			"Linear API key is not configured. Set LINEAR_API_KEY, LINEAR_API_KEY_FILE, or create ~/.config/pi/linear-api-key with mode 600.",
		);
	}

	const issue = await resolveIssue(apiKey, parsed);
	const marker = detectMarker(body, options.marker);

	let duplicate = null;
	if (marker && !options.allowDuplicate) {
		duplicate = await findMarkedComment(apiKey, issue.id, marker);
	}

	const target = { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url };

	if (duplicate) {
		console.log(
			JSON.stringify(
				{
					posted: false,
					skipped: "duplicate-marker",
					marker,
					existingComment: { id: duplicate.id, url: duplicate.url, createdAt: duplicate.createdAt },
					issue: target,
				},
				null,
				2,
			),
		);
		return;
	}

	if (options.dryRun) {
		console.log(
			JSON.stringify(
				{ posted: false, skipped: "dry-run", marker: marker || null, bodyBytes: Buffer.byteLength(body, "utf8"), issue: target },
				null,
				2,
			),
		);
		return;
	}

	const data = await graphql(apiKey, COMMENT_CREATE, { input: { issueId: issue.id, body } });
	const result = data?.commentCreate;
	if (!result?.success || !result.comment?.id) {
		throw new Error("Linear reported the comment was not created");
	}

	console.log(
		JSON.stringify(
			{
				posted: true,
				marker: marker || null,
				comment: { id: result.comment.id, url: result.comment.url, createdAt: result.comment.createdAt },
				issue: target,
			},
			null,
			2,
		),
	);
}

main().catch((error) => {
	// Never echo the API key or the raw request; only the failure reason.
	console.error(`Error: ${error.message}`);
	process.exit(1);
});

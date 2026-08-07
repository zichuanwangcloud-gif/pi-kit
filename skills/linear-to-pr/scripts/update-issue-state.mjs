#!/usr/bin/env node

// Sets a Linear issue to its team's "started" workflow state.
//
// This is the only script in Pi Kit that mutates external state. It is kept
// separate from fetch-linear-issue.mjs on purpose: pr-audit promises it never
// runs a Linear mutation, and that promise is verifiable by grepping the file
// it invokes. Adding a flag to the read-only script would downgrade a
// file-level guarantee to an argv-level one.
//
// Exactly one mutation per run. Never retries, never falls back to a second
// candidate state, never moves an issue backwards out of a later started
// column, and never reopens a completed or canceled issue.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const API_URL = "https://api.linear.app/graphql";
const DEFAULT_TEAM = process.env.LINEAR_TEAM_KEY?.trim().toUpperCase() ?? "";
const STATE_PAGE_SIZE = 100;

// Linear workflow state categories. Lowercase and case-sensitive; note the
// US spelling of "canceled".
const STARTED = "started";
const TERMINAL_TYPES = new Set(["completed", "canceled"]);

function usage(message) {
	if (message) console.error(`Error: ${message}`);
	console.error('Usage: update-issue-state.mjs <TEAM-123|123|#123> [--state-name "<workflow state name>"]');
	console.error("Bare numbers require LINEAR_TEAM_KEY, for example LINEAR_TEAM_KEY=ENG.");
	console.error("Sets the issue to its team's started state. Use --state-name only to override the automatic choice.");
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

function parseArgs(argv) {
	let identifier = "";
	let stateName = "";

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") usage();
		if (arg === "--state-name") {
			const value = argv[index + 1];
			if (!value || value.startsWith("--")) usage("--state-name requires a workflow state name");
			if (stateName) usage("--state-name was passed more than once");
			stateName = value.trim();
			index += 1;
			continue;
		}
		if (arg.startsWith("--state-name=")) {
			if (stateName) usage("--state-name was passed more than once");
			stateName = arg.slice("--state-name=".length).trim();
			if (!stateName) usage("--state-name requires a workflow state name");
			continue;
		}
		if (arg.startsWith("-")) usage(`unknown flag: ${arg}`);
		if (identifier) usage("expected exactly one issue identifier");
		identifier = arg;
	}

	if (!identifier) usage("expected exactly one issue identifier");
	return { identifier, stateName };
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

const ISSUE_STATE_QUERY = `
query PiIssueStateContext($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 2) {
    nodes {
      id
      identifier
      url
      state { id name type }
      team { id key name }
    }
  }
}`;

const TEAM_STATES_QUERY = `
query PiTeamWorkflowStates($teamKey: String!, $first: Int!) {
  workflowStates(filter: { team: { key: { eq: $teamKey } } }, first: $first) {
    nodes { id name type position }
  }
}`;

const SET_STATE_MUTATION = `
mutation PiSetIssueState($issueId: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: { stateId: $stateId }) {
    success
    issue {
      id
      identifier
      url
      state { id name type }
    }
  }
}`;

function stateSummary(state) {
	if (!state) return null;
	return { id: state.id, name: state.name, type: state.type };
}

// Picks the target started state. Ordering is fixed and documented in
// references/git-workflow.md; changing it changes skill behaviour.
function selectTargetState(states, stateName) {
	const candidates = states
		.filter((state) => state.type === STARTED)
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id)));

	if (stateName) {
		const wanted = stateName.toLowerCase();
		const hit = candidates.find((state) => state.name.trim().toLowerCase() === wanted);
		// An explicit name that does not exist is a usage error, not a licence
		// to pick something else: honouring a different state is worse than
		// doing nothing.
		if (!hit) return { candidates, target: null, rule: "explicit-name-not-found" };
		return { candidates, target: hit, rule: "explicit-name" };
	}

	if (candidates.length === 0) return { candidates, target: null, rule: "no-started-state" };
	if (candidates.length === 1) return { candidates, target: candidates[0], rule: "only-candidate" };

	// The leftmost started column is structurally the entry point of the
	// started band; later columns (In Review, Ready to Merge) sit to its right
	// precisely because their position is greater. This holds regardless of
	// what the column is named, in any language.
	return { candidates, target: candidates[0], rule: "lowest-position" };
}

function report(payload) {
	process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function candidateList(candidates, targetId) {
	return candidates.map((state) => ({
		id: state.id,
		name: state.name,
		position: state.position,
		selected: state.id === targetId,
	}));
}

async function main() {
	const { identifier: rawIdentifier, stateName } = parseArgs(process.argv.slice(2));
	const parsed = parseIdentifier(rawIdentifier);

	const apiKey = await resolveApiKey();
	if (!apiKey) {
		throw new Error(
			"Linear API key is not configured. Set LINEAR_API_KEY, LINEAR_API_KEY_FILE, or create ~/.config/pi/linear-api-key with mode 600.",
		);
	}

	// Re-read the issue rather than trusting an earlier fetch: the user may
	// have spent a long time reviewing requirements before confirming.
	const issueData = await graphql(apiKey, ISSUE_STATE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = issueData?.issues?.nodes ?? [];
	if (issues.length === 0) throw new Error(`Linear issue not found: ${parsed.identifier}`);
	if (issues.length > 1) throw new Error(`Linear returned multiple issues for ${parsed.identifier}`);

	const issue = issues[0];
	const from = stateSummary(issue.state);
	const base = { identifier: issue.identifier, url: issue.url, from };

	// Query the issue's own team, not LINEAR_TEAM_KEY: that variable is only a
	// default for bare numbers and may name a different team.
	const teamKey = issue.team?.key ?? parsed.team;
	const statesData = await graphql(apiKey, TEAM_STATES_QUERY, { teamKey, first: STATE_PAGE_SIZE });
	const states = statesData?.workflowStates?.nodes ?? [];

	const { candidates, target, rule } = selectTargetState(states, stateName);

	if (rule === "explicit-name-not-found") {
		report({
			...base,
			applied: false,
			reason: "explicit-name-not-found",
			to: null,
			requestedStateName: stateName,
			startedCandidates: candidateList(candidates, null),
			selectionRule: rule,
		});
		console.error(
			`Error: no workflow state named "${stateName}" of type ${STARTED} in team ${teamKey}; state left unchanged`,
		);
		process.exit(2);
	}

	if (!target) {
		report({
			...base,
			applied: false,
			reason: "no-started-state",
			to: null,
			startedCandidates: [],
			selectionRule: rule,
		});
		return;
	}

	const candidateReport = candidateList(candidates, target.id);

	if (from && TERMINAL_TYPES.has(from.type)) {
		report({
			...base,
			applied: false,
			reason: "terminal-state",
			to: null,
			startedCandidates: candidateReport,
			selectionRule: rule,
		});
		return;
	}

	if (from?.type === STARTED) {
		// Already started. Do not move the issue, and in particular never drag
		// it back from a later column such as In Review: that would destroy
		// human-entered signal and notify the whole team.
		report({
			...base,
			applied: false,
			reason: from.id === target.id ? "already-target" : "already-started",
			to: null,
			startedCandidates: candidateReport,
			selectionRule: rule,
		});
		return;
	}

	const result = await graphql(apiKey, SET_STATE_MUTATION, { issueId: issue.id, stateId: target.id });
	const update = result?.issueUpdate;
	if (!update?.success) {
		throw new Error(`Linear did not apply the state change for ${issue.identifier}`);
	}

	report({
		...base,
		applied: true,
		reason: "applied",
		to: stateSummary(update.issue?.state) ?? stateSummary(target),
		startedCandidates: candidateReport,
		selectionRule: rule,
	});
}

main().catch((error) => {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});

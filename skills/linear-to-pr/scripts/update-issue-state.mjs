#!/usr/bin/env node

// Sets a Linear issue to its team's "started" workflow state.
//
// This is the only script in Pi Kit that mutates external state. It is kept
// separate from fetch-linear-issue.mjs on purpose: pr-audit promises it never
// runs a Linear mutation, and that promise is verifiable by grepping the file
// it invokes. Adding a flag to the read-only script would downgrade a
// file-level guarantee to an argv-level one.
//
// Exactly one mutation per run. Never falls back to a second candidate state,
// never moves an issue backwards out of a later started column, and never
// reopens a completed or canceled issue.
//
// Public CLI contract (documented in ../SKILL.md Step 2.6 and
// ../references/pr-output.md "Issue 状态回写"):
//   node update-issue-state.mjs "$ISSUE" [--state-name "<workflow state name>"]
//
// stdout is always one JSON document; the caller reads `applied`, `reason` and `to.name`.
// The PROCESS exit code is deliberately coarser than lib-linear's EXIT map, because Step 2.6
// branches on exactly three values and the middle one carries a "keep going" instruction:
//   0  the run completed; read the stdout document
//   1  the state was not updated, but the caller CONTINUES (no retry, no fallback state)
//   2  bad arguments; fix them and re-run once
// The precise machine-readable cause is not lost: it is the `code` field of the stderr
// envelope ({"ok":false,"code":"AUTH",...}), which uses the shared EXIT names. Do not widen
// the process codes to the full 3..9 range without also updating SKILL.md, or the only write
// path in the pack starts returning codes its caller has no rule for.

import {
	EXIT,
	LinearError,
	emit,
	fail,
	fetchAllConnection,
	graphql,
	help,
	installStdoutGuard,
	isEntrypoint,
	parseIdentifier,
	redact,
	resolveApiKey,
	safeArg,
} from "./lib-linear.mjs";

export const STATE_PAGE_SIZE = 100;

// Linear workflow state categories. Lowercase and case-sensitive; note the
// US spelling of "canceled".
const STARTED = "started";
const TERMINAL_TYPES = new Set(["completed", "canceled"]);

const HELP_TEXT = `Usage: update-issue-state.mjs <TEAM-123|123|#123> [--state-name "<workflow state name>"]

Sets one Linear issue to its team's started workflow state. This is the only Pi Kit script that
writes to Linear: it touches the state field and nothing else (no comment, no title, no assignee,
no priority, no labels, no estimate).

Target selection: the ${STARTED}-type state with the lowest position. Already started (including
later columns such as In Review) is left alone and never dragged backwards; completed/canceled is
left alone; a team with no ${STARTED} candidate is reported as a gap, never invented.

Options:
  --state-name <name>        Override the automatic choice. The name must match a ${STARTED}-type
                             state of the issue's team, case-insensitively; anything else is a
                             usage error rather than a licence to pick a different state.
  -h, --help                 Print this help on stdout and exit 0.

Environment:
  LINEAR_API_KEY             Personal API key. Or LINEAR_API_KEY_FILE, or ~/.config/pi/linear-api-key (mode 600).
  LINEAR_TEAM_KEY            Team key used to expand bare issue numbers, for example ENG.
  LINEAR_TIMEOUT_MS          Per-request timeout, default 30000.
  LINEAR_MAX_ATTEMPTS        Max attempts per request, default 5.

Output is always one JSON document on stdout with keys:
  identifier, url, from, applied, reason, to, startedCandidates, selectionRule
  (plus requestedStateName when --state-name was passed)
reason is one of: applied, already-target, already-started, terminal-state, no-started-state,
explicit-name-not-found.

Exit codes: 0 ok (read applied/reason/to.name from stdout); 1 state not updated, the caller
continues without retrying or substituting a state; 2 bad arguments, fix and re-run once.
Failures also print {"ok":false,"code":...,"message":...} on stderr, where code is one of
USAGE, NOT_FOUND, AUTH, RATE_LIMIT, NETWORK, GRAPHQL, CONFLICT, UNKNOWN.`;

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

// Paginated through the shared connection walker: a team with more workflow states than one page
// must not silently hide the lowest-position started column behind a truncated list.
const TEAM_STATES_QUERY = `
query PiTeamWorkflowStates($teamKey: String!, $first: Int!, $after: String) {
  workflowStates(filter: { team: { key: { eq: $teamKey } } }, first: $first, after: $after) {
    nodes { id name type position }
    pageInfo { hasNextPage endCursor }
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

/**
 * Collapse a lib-linear EXIT name onto the 0/1/2 process contract documented above.
 * USAGE stays 2 so the caller knows to fix argv and re-run; every other failure is 1,
 * which SKILL.md reads as "state not updated, continue the workflow".
 */
export function processExitCode(code) {
	if (code === "OK") return EXIT.OK;
	if (code === "USAGE") return EXIT.USAGE;
	return EXIT.UNKNOWN;
}

export function parseArgs(argv) {
	const options = { identifier: "", stateName: "", wantHelp: false };
	let sawStateName = false;

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "-h" || arg === "--help") {
			options.wantHelp = true;
			return options;
		}
		if (arg === "--state-name") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--")) {
				throw new LinearError("USAGE", "--state-name requires a workflow state name");
			}
			if (sawStateName) throw new LinearError("USAGE", "--state-name was passed more than once");
			options.stateName = value.trim();
			if (!options.stateName) throw new LinearError("USAGE", "--state-name requires a workflow state name");
			sawStateName = true;
			index += 1;
			continue;
		}
		if (arg.startsWith("--state-name=")) {
			if (sawStateName) throw new LinearError("USAGE", "--state-name was passed more than once");
			options.stateName = arg.slice("--state-name=".length).trim();
			if (!options.stateName) throw new LinearError("USAGE", "--state-name requires a workflow state name");
			sawStateName = true;
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") throw new LinearError("USAGE", `unknown flag: ${safeArg(arg)}`);
		if (options.identifier) throw new LinearError("USAGE", "expected exactly one issue identifier");
		options.identifier = arg;
	}

	if (!options.identifier) throw new LinearError("USAGE", "expected exactly one issue identifier");
	return options;
}

function stateSummary(state) {
	if (!state) return null;
	return { id: state.id ?? null, name: state.name ?? null, type: state.type ?? null };
}

// Picks the target started state. Ordering is fixed and documented in
// references/git-workflow.md; changing it changes skill behaviour.
export function selectTargetState(states, stateName) {
	const candidates = (states ?? [])
		.filter((state) => state?.type === STARTED)
		.sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id)));

	if (stateName) {
		const wanted = stateName.trim().toLowerCase();
		const hit = candidates.find((state) => String(state.name ?? "").trim().toLowerCase() === wanted);
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

function candidateList(candidates, targetId) {
	return candidates.map((state) => ({
		id: state.id,
		name: state.name,
		position: state.position,
		selected: state.id === targetId,
	}));
}

/**
 * Resolve the issue, decide, and write at most once.
 *
 * Returns { payload, failure }. `payload` is the stdout document in every outcome — the caller
 * must emit it even when `failure` is set, because a non-applied run still has to report
 * `from` and `startedCandidates` for the closing summary. `failure` is a LinearError to raise
 * AFTER emitting (currently only the explicit-name miss, which is a usage error).
 */
export async function updateIssueState(apiKey, parsed, options = {}) {
	const stateName = String(options.stateName ?? "").trim();

	// Re-read the issue rather than trusting an earlier fetch: the user may
	// have spent a long time reviewing requirements before confirming.
	const issueResult = await graphql(apiKey, ISSUE_STATE_QUERY, { teamKey: parsed.team, number: parsed.number });
	const issues = issueResult.data?.issues?.nodes ?? [];
	if (issues.length === 0) throw new LinearError("NOT_FOUND", `Linear issue not found: ${parsed.identifier}`);
	if (issues.length > 1) {
		throw new LinearError("CONFLICT", `Linear returned multiple issues for ${parsed.identifier}; refusing to guess`);
	}

	const issue = issues[0];
	const from = stateSummary(issue.state);
	const base = { identifier: issue.identifier, url: issue.url, from };

	// Query the issue's own team, not LINEAR_TEAM_KEY: that variable is only a
	// default for bare numbers and may name a different team.
	const teamKey = issue.team?.key ?? parsed.team;
	const walk = await fetchAllConnection(apiKey, {
		query: TEAM_STATES_QUERY,
		variables: { teamKey },
		field: "workflowStates",
		pageSize: STATE_PAGE_SIZE,
	});
	if (!walk.complete) {
		// Fail closed: a partial list could be missing the real lowest-position started column,
		// and picking the wrong column on a write path is worse than not writing.
		throw new LinearError(
			"GRAPHQL",
			`could not read the complete workflow-state list for team ${teamKey}; refusing to choose a target state from a partial list`,
		);
	}

	const { candidates, target, rule } = selectTargetState(walk.nodes, stateName);

	if (rule === "explicit-name-not-found") {
		return {
			payload: {
				...base,
				applied: false,
				reason: "explicit-name-not-found",
				to: null,
				requestedStateName: stateName,
				startedCandidates: candidateList(candidates, null),
				selectionRule: rule,
			},
			failure: new LinearError(
				"USAGE",
				`no workflow state named ${safeArg(stateName)} of type ${STARTED} in team ${teamKey}; state left unchanged`,
			),
		};
	}

	if (!target) {
		return {
			payload: {
				...base,
				applied: false,
				reason: "no-started-state",
				to: null,
				startedCandidates: [],
				selectionRule: rule,
			},
			failure: null,
		};
	}

	const candidateReport = candidateList(candidates, target.id);

	if (from && TERMINAL_TYPES.has(from.type)) {
		return {
			payload: {
				...base,
				applied: false,
				reason: "terminal-state",
				to: null,
				startedCandidates: candidateReport,
				selectionRule: rule,
			},
			failure: null,
		};
	}

	if (from?.type === STARTED) {
		// Already started. Do not move the issue, and in particular never drag
		// it back from a later column such as In Review: that would destroy
		// human-entered signal and notify the whole team.
		return {
			payload: {
				...base,
				applied: false,
				reason: from.id === target.id ? "already-target" : "already-started",
				to: null,
				startedCandidates: candidateReport,
				selectionRule: rule,
			},
			failure: null,
		};
	}

	// RETRY POLICY -- read before "fixing" this in either direction.
	//
	// This mutation inherits the shared transport's retry/backoff, and that is CORRECT here.
	// `issueUpdate(id, { stateId })` is idempotent: it assigns an absolute value to one field, so
	// replaying it after a timeout or a 429 converges on the same state. The dangerous case is a
	// CREATE -- post-linear-comment.mjs cannot blindly retry `commentCreate`, because a request
	// that landed just before the socket died would produce a second comment; it therefore passes a
	// deterministic mutation id so a replay collides instead of double-posting. No such trick is
	// needed for an absolute field write, and disabling retry here would be a strict downgrade: a
	// transient 429 on the only write in the pack would silently leave the issue in Backlog.
	//
	// Two boundaries keep that reasoning true, so preserve them:
	//   1. `stateId` is captured BEFORE the first attempt. A retry must never re-select a target.
	//   2. We only get here when the issue was not already started, and every retry writes the
	//      same stateId, so the worst case of a late-landing replay is a no-op re-write.
	// Widening this script to any non-idempotent mutation (a comment, an attachment, a duplicate
	// of an entity) invalidates all of the above -- use a deterministic id or opt out explicitly.
	const result = await graphql(apiKey, SET_STATE_MUTATION, { issueId: issue.id, stateId: target.id }, { mutation: true });
	const update = result.data?.issueUpdate;
	if (!update?.success) {
		throw new LinearError("GRAPHQL", `Linear did not apply the state change for ${issue.identifier}`);
	}

	return {
		payload: {
			...base,
			applied: true,
			reason: "applied",
			to: stateSummary(update.issue?.state) ?? stateSummary(target),
			startedCandidates: candidateReport,
			selectionRule: rule,
		},
		failure: null,
	};
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

	const { payload, failure } = await updateIssueState(apiKey, parsed, { stateName: options.stateName });
	// The report goes out first in every outcome: a caller that must "continue anyway" still
	// needs `from` and `startedCandidates` for its closing summary.
	emit(payload);
	if (failure) throw failure;
}

/**
 * Local driver instead of lib-linear's runCli: identical envelope and redaction, but the process
 * exit code is collapsed onto the documented 0/1/2 surface (see the header comment).
 */
async function run(entry) {
	installStdoutGuard();
	const secret = { key: "" };
	try {
		await entry(secret);
	} catch (error) {
		const code = error instanceof LinearError ? error.code : "UNKNOWN";
		const raw = error instanceof Error ? error.message : String(error ?? "");
		fail(code, redact(raw, secret.key));
		process.exitCode = processExitCode(code);
	}
}

export { EXIT, HELP_TEXT, run };

if (isEntrypoint(import.meta.url)) await run(main);

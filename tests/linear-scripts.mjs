// Unit + stubbed-transport tests for the two Linear skill scripts.
//
// No network, no external dependencies: globalThis.fetch is replaced with a queue of canned
// responses. Wired into `npm run check` via `npm run test:linear`.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LIB_A = resolve(root, "skills/linear-to-pr/scripts/lib-linear.mjs");
const LIB_B = resolve(root, "skills/linear-pr-audit/scripts/lib-linear.mjs");

// Keep retries and self-throttling instant; the code paths are still exercised.
process.env.LINEAR_RETRY_BASE_MS = "0";
process.env.LINEAR_THROTTLE_MS = "0";
delete process.env.LINEAR_TEAM_KEY;
delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;

const lib = await import(`file://${LIB_A}`);
const fetchScript = await import(`file://${resolve(root, "skills/linear-to-pr/scripts/fetch-linear-issue.mjs")}`);
const postScript = await import(`file://${resolve(root, "skills/linear-pr-audit/scripts/post-linear-comment.mjs")}`);

const {
	EXIT,
	LinearError,
	assertTlsSane,
	authHeader,
	byCreatedAt,
	deterministicUuid,
	fail,
	fetchAllConnection,
	graphql,
	nowIso,
	parseIdentifier,
	redact,
	safeArg,
} = lib;

const KEY = "lin_api_TESTKEY0123456789abcdef";
const CONTROL = String.fromCharCode(0);

/* ------------------------------------------------------------------ harness */

const failures = [];
let passed = 0;

async function test(name, fn) {
	try {
		await fn();
		passed += 1;
	} catch (error) {
		failures.push({ name, error });
	}
}

function throwsWithCode(code, fn) {
	try {
		fn();
	} catch (error) {
		assertLinearError(error, code);
		return error;
	}
	throw new Error(`expected a LinearError(${code}) but nothing was thrown`);
}

// The two lib-linear.mjs copies are separate module instances, so `instanceof` across them is
// false by design. Assert on the structural contract instead.
function assertLinearError(error, code) {
	assert.equal(error?.name, "LinearError", `expected a LinearError, got ${error?.name ?? error}`);
	assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
	assert.equal(typeof error.exitCode, "number", "LinearError must carry a numeric exitCode");
}

async function rejectsWithCode(code, fn) {
	try {
		await fn();
	} catch (error) {
		assertLinearError(error, code);
		return error;
	}
	throw new Error(`expected a rejected LinearError(${code}) but the call resolved`);
}

function response({ status = 200, body = {}, headers = {} } = {}) {
	const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
	return {
		status,
		ok: status >= 200 && status < 300,
		statusText: `stub ${status}`,
		headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
		text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
	};
}

/** Install a fetch stub driven by a queue. Entries may be responses, Errors, or functions. */
function stubFetch(queue) {
	const calls = [];
	const original = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		const call = { url, init, variables: JSON.parse(init.body).variables, headers: init.headers };
		calls.push(call);
		const next = queue.shift();
		if (next === undefined) throw new Error(`fetch stub exhausted after ${calls.length} calls`);
		if (next instanceof Error) throw next;
		if (typeof next === "function") return next(call);
		return response(next);
	};
	return {
		calls,
		restore() {
			globalThis.fetch = original;
		},
	};
}

function transientError(name, code) {
	const error = new Error(`${name} ${code ?? ""}`.trim());
	if (name) error.name = name;
	if (code) error.code = code;
	return error;
}

const connectionBody = (nodes, pageInfo) => ({ data: { comments: { nodes, pageInfo } } });

/* ----------------------------------------------------- D1: drift guard */

await test("D1 lib-linear.mjs is byte-identical across both skill script dirs", () => {
	const a = readFileSync(LIB_A);
	const b = readFileSync(LIB_B);
	assert.ok(a.equals(b), `lib-linear.mjs copies differ (${a.length} vs ${b.length} bytes); regenerate with cp`);
	assert.ok(a.length > 0, "lib-linear.mjs is empty");
});

await test("D1 each skill's scripts import only within its own directory", () => {
	for (const file of [
		"skills/linear-to-pr/scripts/fetch-linear-issue.mjs",
		"skills/linear-pr-audit/scripts/post-linear-comment.mjs",
		"skills/linear-to-pr/scripts/lib-linear.mjs",
	]) {
		const source = readFileSync(resolve(root, file), "utf8");
		// Match real import/export-from statements only, not the word "from" inside prose.
		for (const match of source.matchAll(/^(?:(?:import|export)\b.*|\}\s*)from\s+"([^"]+)";?\s*$/gm)) {
			const target = match[1];
			if (target.startsWith("node:")) continue;
			assert.ok(target.startsWith("./"), `${file} imports ${target}, which escapes the skill directory`);
		}
		assert.ok(!/from\s+"\.\.\//.test(source), `${file} imports from a parent directory`);
	}
});

/* ------------------------------------------------- D2: parseIdentifier */

await test("D2 parseIdentifier accepts TEAM-123", () => {
	assert.deepEqual(parseIdentifier("ENG-123"), { team: "ENG", number: 123, identifier: "ENG-123" });
	assert.deepEqual(parseIdentifier("  eng-7  "), { team: "ENG", number: 7, identifier: "ENG-7" });
});

await test("D2 parseIdentifier expands bare numbers only with a team key", () => {
	assert.deepEqual(parseIdentifier("123", { teamKey: "eng" }), { team: "ENG", number: 123, identifier: "ENG-123" });
	throwsWithCode("USAGE", () => parseIdentifier("123"));
	const error = throwsWithCode("USAGE", () => parseIdentifier("123"));
	assert.match(error.message, /LINEAR_TEAM_KEY/);
});

await test("D2 parseIdentifier accepts #123 and reads LINEAR_TEAM_KEY from the environment", () => {
	process.env.LINEAR_TEAM_KEY = "ops";
	try {
		assert.deepEqual(parseIdentifier("#42"), { team: "OPS", number: 42, identifier: "OPS-42" });
	} finally {
		delete process.env.LINEAR_TEAM_KEY;
	}
});

await test("D2 parseIdentifier rejects oversized and non-positive issue numbers", () => {
	throwsWithCode("USAGE", () => parseIdentifier("ENG-99999999999999999999"));
	throwsWithCode("USAGE", () => parseIdentifier("ENG-9007199254740993"));
	throwsWithCode("USAGE", () => parseIdentifier("ENG-0"));
	throwsWithCode("USAGE", () => parseIdentifier("0", { teamKey: "ENG" }));
	// The boundary must still work.
	assert.equal(parseIdentifier("ENG-1").number, 1);
});

await test("D2 parseIdentifier rejects hostile argv and never echoes control characters", () => {
	const hostile = `ENG-1${CONTROL}\n$(rm -rf /)`;
	const error = throwsWithCode("USAGE", () => parseIdentifier(hostile));
	assert.match(error.message, /control characters/);
	assert.ok(!error.message.includes(CONTROL), "error message leaked a NUL byte");
	assert.ok(!error.message.includes("\n"), "error message leaked a newline");
	throwsWithCode("USAGE", () => parseIdentifier(""));
	throwsWithCode("USAGE", () => parseIdentifier("ENG 123; whoami"));
});

await test("D2 safeArg quotes, de-controls and caps untrusted argv", () => {
	assert.equal(safeArg("plain"), '"plain"');
	const rendered = safeArg(`a${CONTROL}b`);
	assert.ok(!rendered.includes(CONTROL));
	assert.equal(rendered, '"a\\ufffdb"'.replace("\\ufffd", String.fromCharCode(0xfffd)));
	const long = safeArg("x".repeat(500));
	assert.ok(long.length <= lib.SAFE_ARG_MAX, `safeArg returned ${long.length} chars`);
});

/* -------------------------------------------------------- D3: redact */

await test("D3 redact removes the exact key and any lin_api_/lin_oauth_ pattern", () => {
	const secret = "sk-not-a-linear-shape-but-still-secret-0001";
	assert.equal(redact(`failed with ${secret} twice ${secret}`, secret), "failed with [REDACTED_LINEAR_KEY] twice [REDACTED_LINEAR_KEY]");
	assert.equal(redact("bad key lin_api_AbC123 here", ""), "bad key [REDACTED_LINEAR_KEY] here");
	assert.equal(redact("lin_oauth_zzz999", ""), "[REDACTED_LINEAR_KEY]");
	assert.equal(redact(`Bearer ${secret}`, secret), "Bearer [REDACTED_LINEAR_KEY]");
	// A Bearer-prefixed configured key scrubs both the prefixed and bare forms.
	assert.ok(!redact(`sent Bearer ${secret}`, `Bearer ${secret}`).includes(secret));
	assert.equal(redact("nothing to hide", KEY), "nothing to hide");
	assert.ok(!redact(`boom ${KEY}`, KEY).includes(KEY));
});

/* ---------------------------------------------------- D4: authHeader */

await test("D4 authHeader rejects CR, LF and non-ASCII keys without echoing them", () => {
	assert.equal(authHeader("lin_api_good123"), "lin_api_good123");
	assert.equal(authHeader("Bearer lin_api_good123"), "lin_api_good123");
	assert.equal(authHeader("  lin_api_good123\n"), "lin_api_good123", "a trailing newline should be trimmed, not rejected");

	for (const bad of ["lin_api_a\nb", "lin_api_a\rb", "lin_api_a b", "lin_api_ü", `lin_api_a${CONTROL}b`, "", "   "]) {
		const error = throwsWithCode("AUTH", () => authHeader(bad));
		assert.match(error.message, /printf %s/, "the AUTH message must carry the re-save fix");
		assert.ok(!error.message.includes(bad.trim()) || bad.trim() === "", "authHeader leaked the key material");
	}
});

/* ------------------------------------------------- D5: marker logic */

await test("D5 normalizeBody strips a BOM and normalises CRLF", () => {
	const bom = String.fromCharCode(0xfeff);
	assert.equal(postScript.normalizeBody(`${bom}hello\r\nworld\r`), "hello\nworld\n");
	assert.equal(postScript.detectMarker(`${bom}<!-- pi-kit:audit:1 -->\r\nbody`), "pi-kit:audit:1");
	assert.ok(postScript.bodyCarriesMarker(`${bom}<!-- pi-kit:audit:1 -->\r\nbody`, "pi-kit:audit:1"));
});

await test("D5 bodyCarriesMarker is anchored to line 1 and rejects quoted false positives", () => {
	const marker = "pi-kit:linear-pr-audit:99";
	assert.ok(postScript.bodyCarriesMarker(`<!-- ${marker} -->\n\nreport`, marker));
	assert.ok(postScript.bodyCarriesMarker(`<!--${marker}-->`, marker));

	// A marker quoted inside a code fence, or appearing on a later line, is NOT a prior post.
	assert.equal(postScript.bodyCarriesMarker(`prose\n<!-- ${marker} -->`, marker), false, "line-2 marker must not match");
	assert.equal(postScript.bodyCarriesMarker("`<!-- " + marker + " -->`", marker), false, "quoted marker must not match");
	assert.equal(postScript.bodyCarriesMarker(`text <!-- ${marker} --> tail`, marker), false, "inline marker must not match");
	assert.equal(postScript.bodyCarriesMarker(`<!-- ${marker} --> trailing`, marker), false);
	assert.equal(postScript.bodyCarriesMarker(`<!-- ${marker}x -->`, marker), false, "prefix marker must not match");
	assert.equal(postScript.bodyCarriesMarker(`<!-- ${marker} -->`, ""), false);
});

await test("D5 applyMarker prepends a missing marker and refuses to stack a different one", () => {
	const marker = "pi-kit:linear-pr-audit:7";
	assert.equal(postScript.applyMarker("report body", marker), `<!-- ${marker} -->\n\nreport body`);
	// Idempotent: applying twice must not double the marker.
	const once = postScript.applyMarker("report body", marker);
	assert.equal(postScript.applyMarker(once, marker), once);
	// A quoted marker on line 2 does not count as present, so the real marker is still prepended.
	const quoted = "prose\n`<!-- " + marker + " -->`";
	assert.equal(postScript.applyMarker(quoted, marker), `<!-- ${marker} -->\n\n${quoted}`);
	// No marker requested: body passes through normalised only.
	assert.equal(postScript.applyMarker("a\r\nb", ""), "a\nb");

	throwsWithCode("CONFLICT", () => postScript.applyMarker("<!-- pi-kit:other:1 -->\n\nbody", marker));
});

await test("D5 enforceBodySize fails closed unless --truncate is given", () => {
	const body = "x".repeat(200);
	assert.deepEqual(postScript.enforceBodySize(body, 500, false), { body, bodyBytes: 200, truncated: false });
	const error = throwsWithCode("TOO_LARGE", () => postScript.enforceBodySize(body, 100, false));
	assert.match(error.message, /--truncate/);

	const truncated = postScript.enforceBodySize(body, 100, true);
	assert.equal(truncated.truncated, true);
	assert.ok(truncated.bodyBytes <= 100, `truncated body is ${truncated.bodyBytes} bytes, over the 100-byte limit`);
	assert.match(truncated.body, /truncated by pi-kit/);

	// Multi-byte input must not be cut mid code point.
	const wide = postScript.enforceBodySize("需求".repeat(200), 120, true);
	assert.ok(wide.bodyBytes <= 120);
	assert.ok(!wide.body.includes(String.fromCharCode(0xfffd)), "truncation split a multi-byte character");
});

await test("D5 parseArgs enforces the --body-file and marker opt-in rules", () => {
	const parsed = postScript.parseArgs(["ENG-1", "--body-file", "/tmp/x.md", "--dry-run"]);
	assert.equal(parsed.identifier, "ENG-1");
	assert.equal(parsed.bodyFile, "/tmp/x.md");
	assert.equal(parsed.dryRun, true);
	assert.equal(parsed.maxBytes, postScript.DEFAULT_MAX_BYTES);
	assert.equal(parsed.markerScanPages, postScript.DEFAULT_MARKER_SCAN_PAGES);

	throwsWithCode("USAGE", () => postScript.parseArgs(["ENG-1"]));
	throwsWithCode("USAGE", () => postScript.parseArgs(["--body-file", "/tmp/x.md"]));
	throwsWithCode("USAGE", () => postScript.parseArgs(["ENG-1", "ENG-2", "--body-file", "/tmp/x.md"]));
	throwsWithCode("USAGE", () => postScript.parseArgs(["ENG-1", "--body-file"]));
	throwsWithCode("USAGE", () => postScript.parseArgs(["ENG-1", "--body-file", "/tmp/x.md", "--bogus"]));
	throwsWithCode("USAGE", () => postScript.parseArgs(["ENG-1", "--body-file", "/tmp/x.md", "--max-bytes", "0"]));

	// The `--` sentinel lets a leading-dash identifier through as a positional.
	const sentinel = postScript.parseArgs(["--body-file", "/tmp/x.md", "--", "-ENG-1"]);
	assert.equal(sentinel.identifier, "-ENG-1");
	assert.equal(postScript.parseArgs(["--help"]).wantHelp, true);
});

await test("D5 the create mutation id is deterministic per (issue, marker, body)", () => {
	const id = deterministicUuid("issue-1", "pi-kit:a", "body");
	assert.equal(id, deterministicUuid("issue-1", "pi-kit:a", "body"), "same inputs must give the same id");
	assert.notEqual(id, deterministicUuid("issue-1", "pi-kit:a", "body2"));
	assert.notEqual(id, deterministicUuid("issue-2", "pi-kit:a", "body"));
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, "id must be UUIDv4-shaped");
	// NUL joining prevents field-boundary collisions.
	assert.notEqual(deterministicUuid("a", "bc", ""), deterministicUuid("ab", "c", ""));
});

await test("D5 every declared envelope action is reachable in the source", () => {
	const source = readFileSync(resolve(root, "skills/linear-pr-audit/scripts/post-linear-comment.mjs"), "utf8");
	for (const action of ["created", "updated", "unchanged", "would-create", "would-update", "would-skip", "skipped"]) {
		assert.ok(
			new RegExp(`action:\\s*(?:options\\.dryRun\\s*\\?\\s*)?"${action}"|"${action}"\\s*:`).test(source) ||
				source.includes(`"${action}"`),
			`envelope action "${action}" is documented but never emitted`,
		);
	}
});

/* --------------------------------------------- D6: stubbed transport */

await test("D6 fetchAllConnection stops on a stalled cursor and declares itself incomplete", async () => {
	const stub = stubFetch([
		{ body: connectionBody([{ id: "c1" }], { hasNextPage: true, endCursor: "cursor-A" }) },
		{ body: connectionBody([{ id: "c2" }], { hasNextPage: true, endCursor: "cursor-A" }) },
	]);
	try {
		const result = await fetchAllConnection(KEY, {
			query: "query {}",
			field: "comments",
			pick: (data) => data?.comments,
		});
		assert.equal(result.complete, false, "a stalled cursor must not report complete");
		assert.equal(result.truncated, true);
		assert.equal(result.pages, 2);
		assert.deepEqual(result.nodes.map((node) => node.id), ["c1", "c2"], "data already read must be kept");
		assert.equal(stub.calls.length, 2, "the stalled cursor must not be requested a third time");
	} finally {
		stub.restore();
	}
});

await test("D6 fetchAllConnection dedupes an edit-induced duplicate id across pages", async () => {
	const stub = stubFetch([
		{ body: connectionBody([{ id: "a" }, { id: "b" }], { hasNextPage: true, endCursor: "p2" }) },
		{ body: connectionBody([{ id: "b" }, { id: "c" }], { hasNextPage: true, endCursor: "p3" }) },
		{ body: connectionBody([{ id: "c" }, { id: "d" }], { hasNextPage: false, endCursor: null }) },
	]);
	try {
		const result = await fetchAllConnection(KEY, { query: "query {}", pick: (data) => data?.comments });
		assert.deepEqual(result.nodes.map((node) => node.id), ["a", "b", "c", "d"]);
		assert.equal(result.complete, true);
		assert.equal(result.truncated, false);
		assert.equal(result.pages, 3);
	} finally {
		stub.restore();
	}
});

await test("D6 fetchAllConnection honours maxPages as a declared truncation", async () => {
	const stub = stubFetch([
		{ body: connectionBody([{ id: "a" }], { hasNextPage: true, endCursor: "p2" }) },
		{ body: connectionBody([{ id: "b" }], { hasNextPage: true, endCursor: "p3" }) },
	]);
	try {
		const result = await fetchAllConnection(KEY, { query: "query {}", pick: (data) => data?.comments, maxPages: 2 });
		assert.equal(result.pages, 2);
		assert.equal(result.complete, false);
		assert.equal(result.truncated, true);
	} finally {
		stub.restore();
	}
});

await test("D6 graphql retries a 429 and honours Retry-After", async () => {
	const stub = stubFetch([
		{ status: 429, headers: { "retry-after": "0" }, body: { errors: [{ message: "slow down" }] } },
		{ status: 200, body: { data: { ok: true } } },
	]);
	try {
		const result = await graphql(KEY, "query {}", {});
		assert.deepEqual(result.data, { ok: true });
		assert.equal(stub.calls.length, 2, "the 429 must be retried exactly once here");
	} finally {
		stub.restore();
	}
});

await test("D6 graphql surfaces a terminal 429 as RATE_LIMIT", async () => {
	process.env.LINEAR_MAX_ATTEMPTS = "1";
	const stub = stubFetch([{ status: 429, body: { errors: [{ message: "rate limited" }] } }]);
	try {
		await rejectsWithCode("RATE_LIMIT", () => graphql(KEY, "query {}", {}));
	} finally {
		stub.restore();
		delete process.env.LINEAR_MAX_ATTEMPTS;
	}
});

await test("D6 graphql accepts partial errors alongside usable data, but mutations fail closed", async () => {
	const partial = {
		status: 200,
		body: { data: { issue: { id: "i1" } }, errors: [{ message: "field x unavailable", path: ["issue", "x"] }] },
	};
	let stub = stubFetch([partial]);
	try {
		const result = await graphql(KEY, "query {}", {});
		assert.deepEqual(result.data, { issue: { id: "i1" } }, "usable data must survive a partial error");
		assert.equal(result.errors.length, 1);
	} finally {
		stub.restore();
	}

	// Same payload through a mutation must throw: a half-applied write is never acceptable.
	stub = stubFetch([partial]);
	try {
		await rejectsWithCode("GRAPHQL", () => graphql(KEY, "mutation {}", {}, { mutation: true }));
	} finally {
		stub.restore();
	}

	// data:null is not a usable partial response.
	stub = stubFetch([{ status: 200, body: { data: null, errors: [{ message: "boom" }] } }]);
	try {
		await rejectsWithCode("GRAPHQL", () => graphql(KEY, "query {}", {}));
	} finally {
		stub.restore();
	}

	// A fatal code overrides the presence of data.
	stub = stubFetch([
		{ status: 200, body: { data: { issue: null }, errors: [{ message: "nope", extensions: { code: "AUTHENTICATION_ERROR" } }] } },
	]);
	try {
		await rejectsWithCode("AUTH", () => graphql(KEY, "query {}", {}));
	} finally {
		stub.restore();
	}
});

await test("D6 graphql retries a timeout and then succeeds", async () => {
	const stub = stubFetch([
		transientError("AbortError"),
		transientError("Error", "ECONNRESET"),
		{ status: 200, body: { data: { ok: 1 } } },
	]);
	try {
		const result = await graphql(KEY, "query {}", {});
		assert.deepEqual(result.data, { ok: 1 });
		assert.equal(stub.calls.length, 3);
	} finally {
		stub.restore();
	}
});

await test("D6 graphql gives up on a transient error once attempts are exhausted", async () => {
	process.env.LINEAR_MAX_ATTEMPTS = "2";
	const stub = stubFetch([transientError("AbortError"), transientError("AbortError")]);
	try {
		await rejectsWithCode("NETWORK", () => graphql(KEY, "query {}", {}));
		assert.equal(stub.calls.length, 2);
	} finally {
		stub.restore();
		delete process.env.LINEAR_MAX_ATTEMPTS;
	}
});

await test("D6 graphql does not retry a non-transient transport error", async () => {
	const stub = stubFetch([transientError("TypeError", "ERR_INVALID_URL")]);
	try {
		await rejectsWithCode("NETWORK", () => graphql(KEY, "query {}", {}));
		assert.equal(stub.calls.length, 1, "a permanent transport error must not be retried");
	} finally {
		stub.restore();
	}
});

await test("D6 graphql retries once at half page size on a complexity error", async () => {
	const stub = stubFetch([
		{ status: 200, body: { data: null, errors: [{ message: "Query is too complex", extensions: { code: "GRAPHQL_COMPLEXITY" } }] } },
		{ status: 200, body: { data: { ok: true } } },
	]);
	try {
		const result = await graphql(KEY, "query {}", { first: 50 });
		assert.deepEqual(result.data, { ok: true });
		assert.equal(stub.calls[0].variables.first, 50);
		assert.equal(stub.calls[1].variables.first, 25, "the retry must halve the page size");
		assert.equal(result.pageSize, 25);
	} finally {
		stub.restore();
	}
});

await test("D6 graphql sends the pi-kit User-Agent and never a Bearer prefix", async () => {
	const stub = stubFetch([{ status: 200, body: { data: {} } }]);
	try {
		await graphql(`Bearer ${KEY}`, "query {}", {});
		const headers = stub.calls[0].headers;
		assert.equal(headers.Authorization, KEY, "Linear keys are sent raw");
		assert.match(headers["User-Agent"], /^pi-kit\/\S+ \(\+linear-skill\)$/);
	} finally {
		stub.restore();
	}
});

await test("D6 graphql maps 401/403/404 onto the exit contract", async () => {
	for (const [status, code] of [
		[401, "AUTH"],
		[403, "AUTH"],
		[404, "NOT_FOUND"],
		[400, "GRAPHQL"],
	]) {
		const stub = stubFetch([{ status, body: { errors: [{ message: "nope" }] } }]);
		try {
			await rejectsWithCode(code, () => graphql(KEY, "query {}", {}));
		} finally {
			stub.restore();
		}
	}
});

await test("D6 graphql rejects a non-JSON 200", async () => {
	const stub = stubFetch([{ status: 200, body: "<html>gateway</html>" }]);
	try {
		await rejectsWithCode("GRAPHQL", () => graphql(KEY, "query {}", {}));
	} finally {
		stub.restore();
	}
});

await test("D6 findMarkedComment scans newest-first and reports scan completeness", async () => {
	const marker = "pi-kit:linear-pr-audit:5";
	// Backward pagination: the newest page arrives first.
	const stub = stubFetch([
		{
			body: {
				data: {
					comments: {
						nodes: [{ id: "old", body: "chatter" }, { id: "new", body: `<!-- ${marker} -->\n\nreport` }],
						pageInfo: { hasPreviousPage: true, startCursor: "c1" },
					},
				},
			},
		},
	]);
	try {
		const found = await postScript.findMarkedComment(KEY, "issue-1", marker, 20);
		assert.equal(found.comment?.id, "new");
		assert.equal(found.complete, true, "a hit makes the scan conclusive");
		assert.equal(stub.calls.length, 1, "the scan must stop at the first hit");
		assert.equal(stub.calls[0].variables.last, 50, "backward pagination must use last/before");
	} finally {
		stub.restore();
	}

	// Cap reached without a hit => markerScanComplete must be false, not a silent "no duplicate".
	const capped = stubFetch([
		{ body: { data: { comments: { nodes: [{ id: "a", body: "x" }], pageInfo: { hasPreviousPage: true, startCursor: "p2" } } } } },
		{ body: { data: { comments: { nodes: [{ id: "b", body: "y" }], pageInfo: { hasPreviousPage: true, startCursor: "p3" } } } } },
	]);
	try {
		const found = await postScript.findMarkedComment(KEY, "issue-1", marker, 2);
		assert.equal(found.comment, null);
		assert.equal(found.complete, false);
	} finally {
		capped.restore();
	}

	// A quoted marker in someone's comment must not be mistaken for a prior post.
	const quoted = stubFetch([
		{
			body: {
				data: {
					comments: {
						nodes: [{ id: "q", body: "see \\`<!-- " + marker + " -->\\` for the format" }],
						pageInfo: { hasPreviousPage: false, startCursor: null },
					},
				},
			},
		},
	]);
	try {
		const found = await postScript.findMarkedComment(KEY, "issue-1", marker, 20);
		assert.equal(found.comment, null, "a quoted marker is not a prior post");
		assert.equal(found.complete, true);
	} finally {
		quoted.restore();
	}
});

await test("D6 the comments filter declares $issueId as ID!, not String!", () => {
	// Regression guard: Linear's IDComparator rejects String!, so a String! declaration makes
	// every marker scan fail with HTTP 400 and the duplicate guard silently stops working.
	const source = readFileSync(resolve(root, "skills/linear-pr-audit/scripts/post-linear-comment.mjs"), "utf8");
	const declaration = source.match(/query IssueCommentsForPiComment\(([^)]*)\)/)?.[1] ?? "";
	assert.match(declaration, /\$issueId:\s*ID!/, `comments filter must use ID!, got: ${declaration}`);
	assert.match(source, /\$last:\s*Int!/, "the marker scan must paginate backwards with last/before");
});

/* ------------------------------------------------- D7: assertTlsSane */

await test("D7 assertTlsSane throws when NODE_TLS_REJECT_UNAUTHORIZED=0", () => {
	const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	try {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		const error = throwsWithCode("AUTH", () => assertTlsSane());
		assert.match(error.message, /NODE_TLS_REJECT_UNAUTHORIZED/);
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
		assertTlsSane();
		delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		assertTlsSane();
	} finally {
		if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
	}
});

await test("D7 graphql refuses to send a key with TLS verification disabled", async () => {
	const original = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
	const stub = stubFetch([{ status: 200, body: { data: {} } }]);
	try {
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
		await rejectsWithCode("AUTH", () => graphql(KEY, "query {}", {}));
		assert.equal(stub.calls.length, 0, "no request may leave the process");
	} finally {
		stub.restore();
		if (original === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		else process.env.NODE_TLS_REJECT_UNAUTHORIZED = original;
	}
});

/* --------------------------------------------- D8: exit-code mapping */

await test("D8 the exit-code table matches the declared contract", () => {
	assert.deepEqual(EXIT, {
		OK: 0,
		UNKNOWN: 1,
		USAGE: 2,
		NOT_FOUND: 3,
		AUTH: 4,
		RATE_LIMIT: 5,
		NETWORK: 6,
		GRAPHQL: 7,
		CONFLICT: 8,
		TOO_LARGE: 9,
	});
	// Each script re-exports its own copy's table; the values must agree exactly.
	assert.deepEqual(fetchScript.EXIT, EXIT, "fetch-linear-issue.mjs must export the same table");
	assert.deepEqual(postScript.EXIT, EXIT, "post-linear-comment.mjs must export the same table");

	for (const [name, value] of Object.entries(EXIT)) {
		assert.equal(new LinearError(name, "x").exitCode, value, `LinearError(${name}).exitCode`);
	}
	const unknown = new LinearError("NOT_A_CODE", "x");
	assert.equal(unknown.code, "UNKNOWN");
	assert.equal(unknown.exitCode, 1);
});

await test("D8 fail writes the JSON envelope to stderr and sets the exit code", () => {
	const chunks = [];
	const originalWrite = process.stderr.write;
	const originalExitCode = process.exitCode;
	try {
		process.stderr.write = (chunk) => {
			chunks.push(String(chunk));
			return true;
		};
		fail("AUTH", "no key configured");
	} finally {
		process.stderr.write = originalWrite;
	}
	assert.equal(process.exitCode, EXIT.AUTH);
	process.exitCode = originalExitCode;

	const parsed = JSON.parse(chunks.join(""));
	assert.deepEqual(parsed, { ok: false, code: "AUTH", message: "no key configured" });
});

/* --------------------------------- extra: determinism and derivations */

await test("byCreatedAt sorts numerically with an id tiebreak", () => {
	const rows = [
		{ id: "b", createdAt: "2024-01-02T00:00:00.000Z" },
		{ id: "a", createdAt: "2024-01-02T00:00:00.000Z" },
		{ id: "c", createdAt: "2024-01-01T23:59:59.999Z" },
		{ id: "d", createdAt: null },
	];
	assert.deepEqual([...rows].sort(byCreatedAt).map((row) => row.id), ["c", "a", "b", "d"]);
	// Offset forms compare by instant, not by string: 02:00-06:00 is 08:00Z, before 10:00Z.
	const offset = [
		{ id: "later", createdAt: "2024-01-01T10:00:00.000Z" },
		{ id: "earlier", createdAt: "2024-01-01T02:00:00.000-06:00" },
	];
	assert.deepEqual([...offset].sort(byCreatedAt).map((row) => row.id), ["earlier", "later"]);
});

await test("nowIso honours SOURCE_DATE_EPOCH", () => {
	const original = process.env.SOURCE_DATE_EPOCH;
	try {
		process.env.SOURCE_DATE_EPOCH = "1700000000";
		assert.equal(nowIso(), "2023-11-14T22:13:20.000Z");
		process.env.SOURCE_DATE_EPOCH = "not-a-number";
		assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T/);
	} finally {
		if (original === undefined) delete process.env.SOURCE_DATE_EPOCH;
		else process.env.SOURCE_DATE_EPOCH = original;
	}
});

await test("threadComments nests replies under their parent and assigns depth/threadId", () => {
	const raw = [
		{ id: "r2", createdAt: "2024-01-03T00:00:00Z", parent: null },
		{ id: "r1", createdAt: "2024-01-01T00:00:00Z", parent: null },
		{ id: "r1b", createdAt: "2024-01-05T00:00:00Z", parent: { id: "r1" } },
		{ id: "r1a", createdAt: "2024-01-02T00:00:00Z", parent: { id: "r1" } },
		{ id: "orphan", createdAt: "2024-01-04T00:00:00Z", parent: { id: "gone" } },
	];
	const ordered = fetchScript.threadComments(raw);
	assert.deepEqual(ordered.map((entry) => entry.comment.id), ["r1", "r1a", "r1b", "r2", "orphan"]);
	assert.deepEqual(ordered.map((entry) => entry.depth), [0, 1, 1, 0, 0]);
	assert.deepEqual(ordered.map((entry) => entry.threadId), ["r1", "r1", "r1", "r2", "orphan"]);
	assert.deepEqual(ordered.map((entry) => entry.sequence), [1, 2, 3, 4, 5]);
	assert.equal(ordered.length, raw.length, "no comment may be dropped");
});

await test("threadComments survives a parent cycle without hanging or dropping nodes", () => {
	const raw = [
		{ id: "x", createdAt: "2024-01-01T00:00:00Z", parent: { id: "y" } },
		{ id: "y", createdAt: "2024-01-02T00:00:00Z", parent: { id: "x" } },
	];
	const ordered = fetchScript.threadComments(raw);
	assert.equal(ordered.length, 2);
	assert.deepEqual([...new Set(ordered.map((entry) => entry.comment.id))].sort(), ["x", "y"]);
});

await test("normalizeComments emits requirementSignals, thread fields and resolution state", () => {
	const comments = fetchScript.normalizeComments(
		[
			{
				id: "c1",
				createdAt: "2024-01-01T00:00:00Z",
				body: "验收标准：改为按 PRD 最终方案执行",
				user: { id: "u1", name: "Ann", email: "ann@example.com" },
				resolvedAt: "2024-01-09T00:00:00Z",
				resolvingUser: { id: "u2", name: "Bob" },
			},
			{
				id: "c2",
				createdAt: "2024-01-02T00:00:00Z",
				body: "ci passed",
				parent: { id: "c1" },
				botActor: { id: "bot", name: "GitHub", type: "app" },
			},
		],
		{ includeEmails: false },
	);

	assert.deepEqual(comments[0].requirementSignals.sort(), ["acceptance", "prd", "revision"]);
	assert.equal(comments[0].isRequirementRelevant, true);
	assert.equal(comments[0].threadRootId, "c1");
	assert.equal(comments[0].isReply, false);
	assert.equal(comments[0].resolvedAt, "2024-01-09T00:00:00Z");
	assert.equal(comments[0].isResolved, true);
	assert.equal(comments[0].resolvingUser.name, "Bob");
	assert.equal(comments[0].user.email, null, "emails must be withheld by default");

	assert.equal(comments[1].isReply, true);
	assert.equal(comments[1].threadRootId, "c1");
	assert.equal(comments[1].depth, 1);
	assert.equal(comments[1].isBot, true);
	assert.equal(comments[1].isRequirementRelevant, false);

	const withEmails = fetchScript.normalizeComments(
		[{ id: "c1", createdAt: "2024-01-01T00:00:00Z", body: "x", user: { id: "u1", name: "Ann", email: "ann@example.com" } }],
		{ includeEmails: true },
	);
	assert.equal(withEmails[0].user.email, "ann@example.com");
});

await test("normalizeComments truncates long bodies with a visible marker", () => {
	const long = "a".repeat(9000);
	const [comment] = fetchScript.normalizeComments([{ id: "c", createdAt: "2024-01-01T00:00:00Z", body: long }], {
		maxCommentChars: 100,
	});
	assert.equal(comment.bodyTruncated, true);
	assert.equal(comment.bodyChars, 9000);
	assert.match(comment.body, /truncated: showing 100 of 9000 characters/);

	const [untouched] = fetchScript.normalizeComments([{ id: "c", createdAt: "2024-01-01T00:00:00Z", body: long }], {
		maxCommentChars: 0,
	});
	assert.equal(untouched.bodyTruncated, false);
	assert.equal(untouched.body.length, 9000);
});

await test("limitComments keeps the newest N plus every requirement-relevant comment", () => {
	const comments = Array.from({ length: 10 }, (_, index) => ({
		sequence: index + 1,
		isRequirementRelevant: index === 0,
	}));
	const limited = fetchScript.limitComments(comments, 3);
	assert.deepEqual(limited.comments.map((comment) => comment.sequence), [1, 8, 9, 10]);
	assert.equal(limited.commentsOmitted, 6);
	assert.equal(fetchScript.limitComments(comments, 0).commentsOmitted, 0);
	assert.equal(fetchScript.limitComments(comments, 50).comments.length, 10);
});

await test("isPotentialPrd scores a bounded window, not the whole description", () => {
	// A deliberately neutral URL, so only the surrounding prose can score.
	const url = "https://example.com/p/a1";
	assert.deepEqual(fetchScript.documentSignals(url), [], "the bare URL must score nothing on its own");
	const near = `需求文档 见 ${url}`;
	const far = `需求文档 ${"填充".repeat(400)} ${url}`;

	const nearLinks = fetchScript.buildDocumentLinks({ description: near }, [], []);
	assert.equal(nearLinks[0].isPotentialPrd, true, "a keyword next to the URL should score");

	const farLinks = fetchScript.buildDocumentLinks({ description: far }, [], []);
	assert.equal(farLinks[0].isPotentialPrd, false, "a keyword 800 characters away must not score");
	assert.equal(farLinks[0].prdScore, 0);
});

await test("documentLinks dedupes repeated sources", () => {
	const url = "https://example.com/spec";
	const comment = {
		sequence: 1,
		id: "c1",
		body: `${url} and again ${url}`,
		links: [url, url],
		createdAt: "2024-01-01T00:00:00Z",
		user: { name: "Ann" },
	};
	const [link] = fetchScript.buildDocumentLinks({ description: `${url} ${url}` }, [comment], []);
	assert.equal(link.sources.length, 2, `expected one description + one comment source, got ${JSON.stringify(link.sources)}`);
	assert.deepEqual(link.sources.map((source) => source.type), ["description", "comment"]);
});

await test("linkedPullRequests are derived from GitHub/GitLab attachments", () => {
	const attachments = fetchScript.normalizeAttachments([
		{
			id: "a1",
			title: "Fix the thing",
			url: "https://github.com/acme/widgets/pull/42",
			sourceType: "github",
			createdAt: "2024-01-01T00:00:00Z",
			metadata: { status: "merged", branch: "feature/x", draft: false, title: "Fix the thing" },
		},
		{
			id: "a2",
			title: "MR",
			url: "https://gitlab.com/group/sub/proj/-/merge_requests/7",
			sourceType: "gitlab",
			createdAt: "2024-01-02T00:00:00Z",
			metadata: { status: "opened" },
		},
		{ id: "a3", title: "Figma", url: "https://figma.com/file/abc", sourceType: "figma", createdAt: "2024-01-03T00:00:00Z" },
		{
			id: "a4",
			title: "dupe",
			url: "https://github.com/acme/widgets/pull/42",
			sourceType: "github",
			createdAt: "2024-01-04T00:00:00Z",
		},
	]);

	const prs = fetchScript.deriveLinkedPullRequests(attachments);
	assert.equal(prs.length, 2, `expected 2 PRs, got ${JSON.stringify(prs.map((pr) => pr.key))}`);
	assert.deepEqual(
		{ provider: prs[0].provider, owner: prs[0].owner, repo: prs[0].repo, number: prs[0].number, merged: prs[0].merged },
		{ provider: "github", owner: "acme", repo: "widgets", number: 42, merged: true },
	);
	assert.equal(prs[0].branch, "feature/x");
	assert.equal(prs[1].provider, "gitlab");
	assert.equal(prs[1].number, 7);
	assert.equal(prs[1].merged, false);
});

await test("attachment metadata over 4 KB is dropped rather than inlined", () => {
	const [small] = fetchScript.normalizeAttachments([
		{ id: "a", createdAt: "2024-01-01T00:00:00Z", metadata: { note: "short" } },
	]);
	assert.deepEqual(small.metadata, { note: "short" });
	assert.equal(small.metadataTruncated, false);

	const [big] = fetchScript.normalizeAttachments([
		{ id: "b", createdAt: "2024-01-01T00:00:00Z", metadata: { blob: "x".repeat(5000) } },
	]);
	assert.equal(big.metadata, null);
	assert.equal(big.metadataTruncated, true);
	assert.ok(big.metadataBytes > fetchScript.METADATA_BYTE_CAP);
});

await test("embeddedImages flag Linear uploads as requiring auth", () => {
	const images = fetchScript.extractEmbeddedImages([
		"![shot](https://uploads.linear.app/abc/def/image.png)",
		'<img src="https://cdn.example.com/pic.jpg">',
		"plain link https://example.com/diagram.svg",
		"not an image https://example.com/page",
		"![dupe](https://uploads.linear.app/abc/def/image.png)",
	]);
	const byUrl = new Map(images.map((image) => [image.url, image.requiresAuth]));
	assert.equal(byUrl.get("https://uploads.linear.app/abc/def/image.png"), true);
	assert.equal(byUrl.get("https://cdn.example.com/pic.jpg"), false);
	assert.equal(byUrl.get("https://example.com/diagram.svg"), false);
	assert.equal(byUrl.has("https://example.com/page"), false, "non-image links must not be listed");
	assert.equal(images.length, 3, "duplicates must be collapsed");
});

await test("blockedBy lists only open inbound blockers", () => {
	const blocked = fetchScript.deriveBlockedBy([
		{ id: "r1", type: "blocks", issue: { id: "i1", identifier: "ENG-1", state: { type: "started" } } },
		{ id: "r2", type: "blocks", issue: { id: "i2", identifier: "ENG-2", state: { type: "completed" } } },
		{ id: "r3", type: "blocks", issue: { id: "i3", identifier: "ENG-3", state: { type: "canceled" } } },
		{ id: "r4", type: "related", issue: { id: "i4", identifier: "ENG-4", state: { type: "started" } } },
	]);
	assert.deepEqual(blocked.map((entry) => entry.issue.identifier), ["ENG-1"]);
});

await test("normalizeIssue keeps the documented top-level keys and splits human/bot counts", () => {
	const issue = {
		id: "i1",
		identifier: "ENG-9",
		number: 9,
		title: "Ship it",
		description: "See https://example.com/prd 需求文档",
		archivedAt: "2024-02-01T00:00:00Z",
		state: { id: "s1", name: "Done", type: "completed", position: 3 },
		team: { id: "t1", key: "ENG", name: "Engineering" },
		labels: { nodes: [{ id: "l1", name: "bug", color: "#f00" }] },
		inverseRelations: { nodes: [{ id: "r1", type: "blocks", issue: { id: "i2", identifier: "ENG-2", state: { type: "started" } } }] },
		relations: { nodes: [] },
		children: { nodes: [] },
	};
	const commentResult = {
		nodes: [
			{ id: "c1", createdAt: "2024-01-01T00:00:00Z", body: "验收标准 ok", user: { id: "u", name: "Ann" } },
			{ id: "c2", createdAt: "2024-01-02T00:00:00Z", body: "build green", botActor: { id: "b", name: "CI", type: "app" } },
			{ id: "c3", createdAt: "2024-01-03T00:00:00Z", body: "lgtm", user: { id: "u2", name: "Bob" } },
		],
		complete: true,
		pages: 1,
		truncated: false,
		errors: [],
	};
	const attachmentResult = { nodes: [], complete: true, pages: 1, truncated: false, errors: [] };

	const document = fetchScript.normalizeIssue(issue, commentResult, attachmentResult, {});
	for (const key of [
		"description",
		"comments",
		"commentCount",
		"requirementRelevantComments",
		"documentLinks",
		"attachments",
		"fetchMetadata",
	]) {
		assert.ok(Object.prototype.hasOwnProperty.call(document, key), `missing documented top-level key ${key}`);
	}
	assert.equal(document.archived, true, "an archived issue is reported, not treated as missing");
	assert.equal(document.commentCount, 3);
	assert.equal(document.fetchMetadata.humanCommentCount, 2);
	assert.equal(document.fetchMetadata.botCommentCount, 1);
	assert.equal(document.fetchMetadata.totalCommentCount, 3);
	assert.equal(document.fetchMetadata.complete, true);
	assert.equal(document.fetchMetadata.commentsOmitted, 0);
	assert.deepEqual(document.fetchMetadata.partialErrors, []);
	assert.deepEqual(document.blockedBy.map((entry) => entry.issue.identifier), ["ENG-2"]);
	assert.equal(document.requirementRelevantComments.length, 1);
	assert.equal(document.requirementRelevantComments[0].id, "c1");
	assert.ok(Array.isArray(document.requirementRelevantComments[0].requirementSignals));
});

await test("a truncated comment page produces an actionable warning naming --max-comments", () => {
	const document = fetchScript.normalizeIssue(
		{ id: "i", identifier: "ENG-1" },
		{ nodes: [], complete: false, pages: fetchScript.MAX_PAGES, truncated: true, errors: [] },
		{ nodes: [], complete: true, pages: 1, truncated: false, errors: [] },
		{},
	);
	assert.equal(document.fetchMetadata.complete, false);
	assert.equal(document.fetchMetadata.truncated, true);
	assert.equal(document.fetchMetadata.warnings.length, 1);
	assert.match(document.fetchMetadata.warnings[0], /--max-comments/);
	assert.equal(fetchScript.MAX_PAGES, 40, "the page cap must stay readable (40 pages = 2000 comments)");
});

await test("selectFields honours presets and a csv list while keeping core identity keys", () => {
	const document = fetchScript.normalizeIssue(
		{ id: "i", identifier: "ENG-1", state: { id: "s", name: "Todo", type: "unstarted" } },
		{ nodes: [], complete: true, pages: 1, truncated: false, errors: [] },
		{ nodes: [], complete: true, pages: 1, truncated: false, errors: [] },
		{},
	);

	assert.equal(fetchScript.selectFields(document, "full"), document);

	const meta = fetchScript.selectFields(document, "meta");
	assert.ok("state" in meta);
	assert.equal("comments" in meta, false);
	assert.equal("documentLinks" in meta, false);
	for (const key of ["fetchMetadata", "id", "identifier", "url"]) assert.ok(key in meta, `core key ${key} was dropped`);
	assert.equal(meta.fetchMetadata.fields, "meta");

	const links = fetchScript.selectFields(document, "links");
	assert.ok("documentLinks" in links && "linkedPullRequests" in links);
	assert.equal("comments" in links, false);

	const reqs = fetchScript.selectFields(document, "reqs");
	assert.ok("comments" in reqs && "description" in reqs);
	assert.equal("attachments" in reqs, false);

	const csv = fetchScript.selectFields(document, "description,comments");
	assert.ok("description" in csv && "comments" in csv);
	assert.equal("attachments" in csv, false);
	assert.ok("identifier" in csv);

	throwsWithCode("USAGE", () => fetchScript.selectFields(document, "nope,alsonope"));
});

await test("fetch parseArgs validates presets, counts and the -- sentinel", () => {
	const parsed = fetchScript.parseArgs(["ENG-1", "--fields", "meta", "--compact", "--max-comments", "5", "--include-emails"]);
	assert.deepEqual(
		{
			identifier: parsed.identifier,
			fields: parsed.fields,
			compact: parsed.compact,
			maxComments: parsed.maxComments,
			includeEmails: parsed.includeEmails,
		},
		{ identifier: "ENG-1", fields: "meta", compact: true, maxComments: 5, includeEmails: true },
	);
	assert.equal(fetchScript.parseArgs(["ENG-1"]).maxCommentChars, fetchScript.DEFAULT_MAX_COMMENT_CHARS);
	assert.equal(fetchScript.parseArgs(["-h"]).wantHelp, true);
	assert.equal(fetchScript.parseArgs(["--help"]).wantHelp, true);
	assert.equal(fetchScript.parseArgs(["--", "-ENG-1"]).identifier, "-ENG-1");

	throwsWithCode("USAGE", () => fetchScript.parseArgs([]));
	throwsWithCode("USAGE", () => fetchScript.parseArgs(["ENG-1", "ENG-2"]));
	throwsWithCode("USAGE", () => fetchScript.parseArgs(["ENG-1", "--bogus"]));
	throwsWithCode("USAGE", () => fetchScript.parseArgs(["ENG-1", "--max-comments", "-3"]));
	throwsWithCode("USAGE", () => fetchScript.parseArgs(["ENG-1", "--fields"]));
});

await test("both CLIs print help to stdout and select exit 0", () => {
	for (const script of [fetchScript, postScript]) {
		const chunks = [];
		const originalWrite = process.stdout.write;
		const originalExitCode = process.exitCode;
		try {
			process.stdout.write = (chunk) => {
				chunks.push(String(chunk));
				return true;
			};
			lib.help(script.HELP_TEXT);
		} finally {
			process.stdout.write = originalWrite;
		}
		assert.equal(process.exitCode, EXIT.OK);
		process.exitCode = originalExitCode;
		const text = chunks.join("");
		assert.match(text, /^Usage: /);
		assert.match(text, /Exit codes/);
		assert.ok(text.endsWith("\n"));
	}
});

/* ------------------------------------------------------------- report */

if (failures.length) {
	for (const { name, error } of failures) {
		process.stderr.write(`FAIL ${name}\n  ${error?.message ?? error}\n`);
	}
	process.stderr.write(`\n${failures.length} of ${passed + failures.length} linear-script tests failed\n`);
	process.exit(1);
}

console.log(`Linear scripts OK (${passed} tests: drift guard, identifier parsing, redaction, auth header, markers, stubbed transport, TLS guard, exit codes)`);

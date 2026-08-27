// Shared Linear transport + safety helpers for the pi-kit Linear skills.
//
// IMPORTANT — DRIFT GUARD
// This file must stay BYTE-IDENTICAL in both locations:
//   skills/linear-to-pr/scripts/lib-linear.mjs
//   skills/linear-pr-audit/scripts/lib-linear.mjs
// Each skill directory is exported standalone (scripts/build-claude-plugin.sh does `cp -R skills`),
// so a shared skills/_lib/ would break the export. Edit ONE copy, then:
//   cp skills/linear-to-pr/scripts/lib-linear.mjs skills/linear-pr-audit/scripts/lib-linear.mjs
// tests/linear-scripts.mjs fails the build if the two copies differ.
//
// Zero external dependencies: node: builtins only. Never log, print or interpolate the API key.

import { readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const API_URL = "https://api.linear.app/graphql";
export const REDACTED = "[REDACTED_LINEAR_KEY]";
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_PAGES = 40;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_MS = 500;
export const DEFAULT_THROTTLE_MS = 250;
export const RETRY_CAP_MS = 30_000;
export const RATE_LIMIT_FLOOR = 50;
export const SAFE_ARG_MAX = 120;
export const KEY_FILE_FIX = 'printf %s "$KEY" > ~/.config/pi/linear-api-key';

/** Process exit contract. Shared by both CLIs so agents can branch on the code. */
export const EXIT = {
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
};

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const RETRYABLE_SOCKET_CODES = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ENOTFOUND",
	"EAI_AGAIN",
	"UND_ERR_SOCKET",
	"UND_ERR_CONNECT_TIMEOUT",
]);
const FATAL_GRAPHQL_CODES = new Set(["AUTHENTICATION_ERROR", "FORBIDDEN", "RATELIMITED", "INTERNAL_SERVER_ERROR"]);
const GRAPHQL_CODE_TO_EXIT = new Map([
	["AUTHENTICATION_ERROR", "AUTH"],
	["FORBIDDEN", "AUTH"],
	["RATELIMITED", "RATE_LIMIT"],
	["INTERNAL_SERVER_ERROR", "NETWORK"],
]);
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const ANY_CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
const LINEAR_KEY_PATTERN = /lin_(api|oauth)_[A-Za-z0-9]+/g;

/** Typed failure whose `code` maps 1:1 onto EXIT. */
export class LinearError extends Error {
	constructor(code, message, details = undefined) {
		super(typeof message === "string" ? message : String(message ?? ""));
		this.name = "LinearError";
		this.code = Object.prototype.hasOwnProperty.call(EXIT, code) ? code : "UNKNOWN";
		this.exitCode = EXIT[this.code];
		if (details !== undefined) this.details = details;
	}
}

/**
 * Package version, used only for the User-Agent. Reading ../../../package.json is best-effort:
 * an exported standalone skill directory has no package.json above it and must not crash.
 */
export const PKG_VERSION = (() => {
	try {
		const here = dirname(fileURLToPath(import.meta.url));
		const parsed = JSON.parse(readFileSync(resolve(here, "../../../package.json"), "utf8"));
		const version = parsed?.version;
		return typeof version === "string" && version.trim() ? version.trim() : "0.0.0-portable";
	} catch {
		return "0.0.0-portable";
	}
})();

export const USER_AGENT = `pi-kit/${PKG_VERSION} (+linear-skill)`;

export function sleep(ms) {
	const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
	if (delay === 0) return Promise.resolve();
	return new Promise((done) => {
		setTimeout(done, delay);
	});
}

function envInt(name, fallback, min = 0) {
	const raw = process.env[name];
	if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
	const value = Number(String(raw).trim());
	if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < min) return fallback;
	return value;
}

/** Reproducible-build friendly timestamp. */
export function nowIso() {
	const raw = process.env.SOURCE_DATE_EPOCH?.trim();
	if (raw && /^\d+$/.test(raw)) {
		const epoch = Number(raw);
		if (Number.isSafeInteger(epoch)) return new Date(epoch * 1000).toISOString();
	}
	return new Date().toISOString();
}

/** Strip any occurrence of the live key plus anything shaped like a Linear key. */
export function redact(message, apiKey = "") {
	let text = typeof message === "string" ? message : String(message ?? "");
	const candidates = new Set();
	if (typeof apiKey === "string" && apiKey.trim()) {
		candidates.add(apiKey.trim());
		candidates.add(apiKey.replace(/^Bearer\s+/i, "").trim());
	}
	for (const candidate of candidates) {
		if (candidate.length >= 4) text = text.split(candidate).join(REDACTED);
	}
	return text.replace(LINEAR_KEY_PATTERN, REDACTED);
}

/** Render untrusted argv safely for error messages: JSON-quoted, de-controlled, length-capped. */
export function safeArg(value) {
	const raw = typeof value === "string" ? value : String(value ?? "");
	const json = JSON.stringify(raw.replace(ANY_CONTROL_CHARS, "\uFFFD"));
	if (json.length <= SAFE_ARG_MAX) return json;
	return `${json.slice(0, SAFE_ARG_MAX - 1)}…`;
}

/** Refuse to send credentials over a connection whose TLS verification was disabled. */
export function assertTlsSane() {
	if (String(process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "").trim() === "0") {
		throw new LinearError(
			"AUTH",
			"NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification; refusing to send a Linear API key over an unverified connection. Unset it and retry.",
		);
	}
}

/**
 * Normalise a Linear personal API key into an Authorization header value.
 * Linear keys are sent raw (no Bearer prefix). The key itself is never echoed.
 */
export function authHeader(apiKey) {
	const raw = typeof apiKey === "string" ? apiKey : "";
	const key = raw.replace(/^Bearer\s+/i, "").trim();
	if (!key) {
		throw new LinearError("AUTH", `Linear API key is empty. Re-save it without a trailing newline: ${KEY_FILE_FIX}`);
	}
	if (!/^[\x21-\x7E]+$/.test(key)) {
		throw new LinearError(
			"AUTH",
			`Linear API key contains whitespace, a newline or a non-ASCII character, which would corrupt the HTTP header. Re-save it with: ${KEY_FILE_FIX}`,
		);
	}
	return key;
}

/** Read a key file, refusing group/world-accessible modes on POSIX. Missing file => "". */
export async function readKeyFile(path) {
	let info;
	try {
		info = await stat(path);
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw new LinearError("AUTH", `cannot read Linear API key file ${path}: ${error?.message ?? String(error)}`);
	}
	if (!info.isFile()) {
		throw new LinearError("AUTH", `Linear API key path is not a regular file: ${path}`);
	}
	if (platform() !== "win32" && (info.mode & 0o077) !== 0) {
		const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
		throw new LinearError(
			"AUTH",
			`Linear API key file ${path} is group/world accessible (mode ${mode}); refusing to use it. Fix it with: chmod 600 ${path}`,
		);
	}
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if (error?.code === "ENOENT") return "";
		throw new LinearError("AUTH", `cannot read Linear API key file ${path}: ${error?.message ?? String(error)}`);
	}
}

function expandHome(path) {
	return resolve(path.replace(/^~(?=\/|$)/, homedir()));
}

/**
 * LINEAR_API_KEY > LINEAR_API_KEY_FILE > ~/.config/pi/linear-api-key.
 * Throws LinearError("AUTH") when nothing is configured (unless required:false).
 */
export async function resolveApiKey(options = {}) {
	const required = options.required !== false;
	const inline = process.env.LINEAR_API_KEY?.trim();
	if (inline) return inline;

	const configuredPath = process.env.LINEAR_API_KEY_FILE?.trim();
	if (configuredPath) {
		const key = await readKeyFile(expandHome(configuredPath));
		if (key) return key;
	}

	const key = await readKeyFile(resolve(homedir(), ".config/pi/linear-api-key"));
	if (key) return key;
	if (!required) return "";
	throw new LinearError(
		"AUTH",
		"Linear API key is not configured. Set LINEAR_API_KEY, or LINEAR_API_KEY_FILE, or create ~/.config/pi/linear-api-key with mode 600.",
	);
}

function issueNumber(text) {
	if (!/^\d{1,15}$/.test(text)) {
		throw new LinearError("USAGE", `Linear issue number is out of range: ${safeArg(text)}`);
	}
	const value = Number(text);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new LinearError("USAGE", `Linear issue number must be a positive integer: ${safeArg(text)}`);
	}
	return value;
}

/** Parse TEAM-123 / 123 / #123 into { team, number, identifier }. Throws LinearError("USAGE"). */
export function parseIdentifier(input, options = {}) {
	const rawDefault = options.teamKey ?? process.env.LINEAR_TEAM_KEY ?? "";
	const defaultTeam = String(rawDefault).trim().toUpperCase();
	const raw = typeof input === "string" ? input : String(input ?? "");
	if (ANY_CONTROL_CHARS.test(raw)) {
		ANY_CONTROL_CHARS.lastIndex = 0;
		throw new LinearError("USAGE", `invalid Linear identifier (control characters): ${safeArg(raw)}`);
	}
	ANY_CONTROL_CHARS.lastIndex = 0;
	const value = raw.trim();
	if (!value) throw new LinearError("USAGE", "missing Linear issue identifier");

	const full = value.match(/^([A-Za-z][A-Za-z0-9_-]*)-(\d+)$/);
	if (full) {
		const team = full[1].toUpperCase();
		const number = issueNumber(full[2]);
		return { team, number, identifier: `${team}-${number}` };
	}

	const bare = value.match(/^#?(\d+)$/);
	if (bare) {
		if (!defaultTeam) {
			throw new LinearError(
				"USAGE",
				"a bare Linear issue number requires LINEAR_TEAM_KEY; otherwise pass a full identifier such as ENG-123",
			);
		}
		if (!/^[A-Z][A-Z0-9_-]*$/.test(defaultTeam)) {
			throw new LinearError("USAGE", `LINEAR_TEAM_KEY is not a valid Linear team key: ${safeArg(rawDefault)}`);
		}
		const number = issueNumber(bare[1]);
		return { team: defaultTeam, number, identifier: `${defaultTeam}-${number}` };
	}

	throw new LinearError("USAGE", `invalid Linear identifier: ${safeArg(raw)}`);
}

function safeJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isTransientTransportError(error) {
	if (!error) return false;
	if (error.name === "AbortError" || error.name === "TimeoutError") return true;
	const codes = [error.code, error.cause?.code, error.cause?.cause?.code];
	return codes.some((code) => typeof code === "string" && RETRYABLE_SOCKET_CODES.has(code));
}

function fullJitterMs(attempt, baseMs) {
	if (baseMs <= 0) return 0;
	const ceiling = Math.min(RETRY_CAP_MS, baseMs * 2 ** attempt);
	return Math.floor(Math.random() * ceiling);
}

function headerValue(headers, name) {
	const raw = headers?.get?.(name);
	return typeof raw === "string" ? raw.trim() : "";
}

/** Retry-After (seconds or HTTP-date) wins; then x-ratelimit-requests-reset; else null. */
function serverHintedWaitMs(headers) {
	const retryAfter = headerValue(headers, "retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_CAP_MS, seconds * 1000);
		const when = Date.parse(retryAfter);
		if (!Number.isNaN(when)) return Math.min(RETRY_CAP_MS, Math.max(0, when - Date.now()));
	}
	const reset = headerValue(headers, "x-ratelimit-requests-reset");
	if (reset) {
		const value = Number(reset);
		if (Number.isFinite(value) && value >= 0) {
			// Linear sends an epoch (ms, sometimes seconds); tolerate a plain delta too.
			let deltaMs;
			if (value >= 1e11) deltaMs = value - Date.now();
			else if (value >= 1e9) deltaMs = value * 1000 - Date.now();
			else deltaMs = value * 1000;
			return Math.min(RETRY_CAP_MS, Math.max(0, deltaMs));
		}
	}
	return null;
}

function isComplexityError(errors) {
	return errors.some((error) => {
		const code = error?.extensions?.code ?? error?.extensions?.type;
		if (code === "GRAPHQL_COMPLEXITY") return true;
		return /complexity|too complex/i.test(String(error?.message ?? ""));
	});
}

/** Flatten a GraphQL error into a JSON-safe, key-free descriptor. */
export function describeGraphqlError(error) {
	return {
		message: String(error?.message ?? "").replace(CONTROL_CHARS, " ").slice(0, 500),
		code: error?.extensions?.code ?? error?.extensions?.type ?? null,
		path: Array.isArray(error?.path) ? error.path.map((part) => String(part)).join(".") : null,
	};
}

function graphqlFailure(errors, mutation) {
	const message = errors.map((error) => error?.message).filter(Boolean).join("; ") || "unknown GraphQL error";
	const fatal = errors.find((error) => {
		const code = error?.extensions?.code ?? error?.extensions?.type;
		return typeof code === "string" && FATAL_GRAPHQL_CODES.has(code);
	});
	const fatalCode = fatal?.extensions?.code ?? fatal?.extensions?.type;
	const exitCode = GRAPHQL_CODE_TO_EXIT.get(fatalCode) ?? "GRAPHQL";
	const prefix = mutation ? "Linear mutation failed" : "Linear GraphQL error";
	return new LinearError(exitCode, `${prefix}: ${message}`, { errors: errors.map(describeGraphqlError) });
}

/**
 * POST a GraphQL document with timeout, retry/backoff, rate-limit self-throttle and
 * complexity de-escalation. Returns { data, errors, pageSize, status }.
 *
 * `errors` is only ever non-empty for a *usable* partial response (data present, no fatal code).
 * Mutations (`options.mutation: true`) always fail closed on any error.
 */
export async function graphql(apiKey, query, variables = {}, options = {}) {
	assertTlsSane();
	const authorization = authHeader(apiKey);
	const mutation = options.mutation === true;
	const url = options.url ?? API_URL;
	const timeoutMs = envInt("LINEAR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS, 1);
	const maxAttempts = Math.max(1, envInt("LINEAR_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1));
	const baseMs = envInt("LINEAR_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 0);
	const throttleMs = envInt("LINEAR_THROTTLE_MS", DEFAULT_THROTTLE_MS, 0);

	let vars = { ...variables };
	let complexityRetried = false;
	let lastTransportError = null;

	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const isLast = attempt === maxAttempts - 1;
		let response;
		try {
			response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: authorization,
					"Content-Type": "application/json",
					Accept: "application/json",
					"User-Agent": USER_AGENT,
				},
				body: JSON.stringify({ query, variables: vars }),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			lastTransportError = error;
			if (isTransientTransportError(error) && !isLast) {
				await sleep(fullJitterMs(attempt, baseMs));
				continue;
			}
			throw new LinearError("NETWORK", `Linear request failed: ${error?.message ?? String(error)}`);
		}

		const status = Number(response?.status ?? 0);
		const remaining = Number(headerValue(response?.headers, "x-ratelimit-requests-remaining"));
		const nearRateLimit = Number.isFinite(remaining) && remaining < RATE_LIMIT_FLOOR;

		let text;
		try {
			text = await response.text();
		} catch (error) {
			lastTransportError = error;
			if (!isLast) {
				await sleep(fullJitterMs(attempt, baseMs));
				continue;
			}
			throw new LinearError("NETWORK", `Linear response body could not be read: ${error?.message ?? String(error)}`);
		}

		if (response.ok === false || (status !== 0 && (status < 200 || status >= 300))) {
			if (RETRYABLE_STATUS.has(status) && !isLast) {
				const hinted = serverHintedWaitMs(response.headers);
				await sleep(hinted === null ? fullJitterMs(attempt, baseMs) : hinted);
				continue;
			}
			const payload = safeJson(text);
			const details =
				payload?.errors?.map((error) => error?.message).filter(Boolean).join("; ") ||
				(typeof response.statusText === "string" && response.statusText) ||
				`HTTP ${status}`;
			if (status === 401 || status === 403) {
				throw new LinearError("AUTH", `Linear rejected the API key (HTTP ${status}): ${details}`);
			}
			if (status === 429) throw new LinearError("RATE_LIMIT", `Linear rate limit exceeded (HTTP ${status}): ${details}`);
			if (status === 404) throw new LinearError("NOT_FOUND", `Linear HTTP ${status}: ${details}`);
			throw new LinearError(status >= 500 || status === 408 ? "NETWORK" : "GRAPHQL", `Linear HTTP ${status}: ${details}`);
		}

		const payload = safeJson(text);
		if (payload === undefined || payload === null || typeof payload !== "object") {
			throw new LinearError("GRAPHQL", `Linear returned a non-JSON response (HTTP ${status})`);
		}

		const errors = Array.isArray(payload.errors) ? payload.errors : [];
		if (errors.length) {
			const canHalve = typeof vars.first === "number" && vars.first > 1;
			const canHalveLast = typeof vars.last === "number" && vars.last > 1;
			if (!complexityRetried && isComplexityError(errors) && (canHalve || canHalveLast) && !isLast) {
				complexityRetried = true;
				vars = { ...vars };
				if (canHalve) vars.first = Math.max(1, Math.floor(vars.first / 2));
				if (canHalveLast) vars.last = Math.max(1, Math.floor(vars.last / 2));
				continue;
			}
			const fatal = errors.some((error) => {
				const code = error?.extensions?.code ?? error?.extensions?.type;
				return typeof code === "string" && FATAL_GRAPHQL_CODES.has(code);
			});
			if (mutation || !payload.data || fatal) throw graphqlFailure(errors, mutation);
		}

		if (nearRateLimit) await sleep(throttleMs);

		return {
			data: payload.data ?? null,
			errors,
			pageSize: typeof vars.first === "number" ? vars.first : typeof vars.last === "number" ? vars.last : null,
			status,
		};
	}

	throw new LinearError(
		"NETWORK",
		`Linear request failed after ${maxAttempts} attempts: ${lastTransportError?.message ?? "no response"}`,
	);
}

/**
 * Walk a Relay connection to exhaustion.
 *
 * Returns { nodes, complete, pages, truncated, errors, stopped, cursor }. `complete: false` is a
 * declared outcome (page cap, stalled cursor, early stop) — never a throw — so callers can report
 * partial data honestly instead of losing everything.
 */
export async function fetchAllConnection(apiKey, options = {}) {
	const {
		query,
		variables = {},
		field,
		pick,
		pageSize = DEFAULT_PAGE_SIZE,
		maxPages = DEFAULT_MAX_PAGES,
		backward = false,
		onPage,
	} = options;

	const nodes = [];
	const seen = new Set();
	const errors = [];
	let cursor = null;
	let pages = 0;
	let complete = false;
	let truncated = false;
	let stopped = false;
	let size = pageSize;

	while (true) {
		if (pages >= maxPages) {
			truncated = true;
			break;
		}

		const vars = backward ? { ...variables, last: size, before: cursor } : { ...variables, first: size, after: cursor };
		const result = await graphql(apiKey, query, vars);
		for (const error of result.errors ?? []) errors.push(describeGraphqlError(error));
		if (typeof result.pageSize === "number" && result.pageSize > 0) size = result.pageSize;

		const connection = typeof pick === "function" ? pick(result.data) : result.data?.[field];
		if (!connection || !Array.isArray(connection.nodes) || !connection.pageInfo) {
			throw new LinearError("GRAPHQL", `Linear returned an invalid ${field ?? "connection"} response`);
		}
		pages += 1;

		const page = [];
		for (const node of connection.nodes) {
			// Concurrent edits can re-window a cursor and repeat a node across pages; dedupe by id.
			const id = node?.id;
			const key = typeof id === "string" && id ? id : `\u0000anon:${pages}:${page.length}`;
			if (seen.has(key)) continue;
			seen.add(key);
			nodes.push(node);
			page.push(node);
		}

		if (typeof onPage === "function" && onPage(page, { pages, nodes }) === true) {
			stopped = true;
			break;
		}

		const info = connection.pageInfo;
		const hasMore = backward ? info.hasPreviousPage === true : info.hasNextPage === true;
		if (!hasMore) {
			complete = true;
			break;
		}

		const next = backward ? info.startCursor : info.endCursor;
		if (!next || next === cursor) {
			// A stalled cursor would loop forever; stop and declare the result incomplete.
			truncated = true;
			break;
		}
		cursor = next;
	}

	return { nodes, complete, pages, truncated, errors, stopped, cursor };
}

/** Deterministic chronological sort: numeric time, id tiebreak, no locale involvement. */
export function byCreatedAt(a, b) {
	const left = Date.parse(String(a?.createdAt ?? ""));
	const right = Date.parse(String(b?.createdAt ?? ""));
	const leftValue = Number.isNaN(left) ? Number.POSITIVE_INFINITY : left;
	const rightValue = Number.isNaN(right) ? Number.POSITIVE_INFINITY : right;
	if (leftValue !== rightValue) return leftValue < rightValue ? -1 : 1;
	const leftId = String(a?.id ?? "");
	const rightId = String(b?.id ?? "");
	if (leftId === rightId) return 0;
	return leftId < rightId ? -1 : 1;
}

/** UUIDv4-shaped, deterministic id derived from the given parts (NUL-joined). */
export function deterministicUuid(...parts) {
	const digest = createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u0000"), "utf8").digest();
	const bytes = Buffer.from(digest.subarray(0, 16));
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function sha256Hex(value) {
	return createHash("sha256").update(typeof value === "string" ? value : String(value ?? ""), "utf8").digest("hex");
}

/** Write a JSON document to stdout. */
export function emit(value, options = {}) {
	const text = JSON.stringify(value, null, options.compact === true ? 0 : 2);
	process.stdout.write(`${text}\n`);
	return text;
}

/** Write the machine-readable failure envelope to stderr and set the exit code. */
export function fail(code, message, extra = {}) {
	const key = Object.prototype.hasOwnProperty.call(EXIT, code) ? code : "UNKNOWN";
	const envelope = { ok: false, code: key, message: String(message ?? ""), ...extra };
	process.stderr.write(`${JSON.stringify(envelope)}\n`);
	process.exitCode = EXIT[key];
	return EXIT[key];
}

/**
 * Write usage text to STDOUT and select exit 0.
 * Callers must `return` immediately afterwards; process.exit() is avoided so a piped
 * stdout is flushed rather than truncated.
 */
export function help(text) {
	const body = typeof text === "string" ? text : String(text ?? "");
	process.stdout.write(body.endsWith("\n") ? body : `${body}\n`);
	process.exitCode = EXIT.OK;
	return EXIT.OK;
}

/** `node script.mjs | head` must not explode with an unhandled EPIPE. */
export function installStdoutGuard() {
	const swallow = (error) => {
		if (error?.code === "EPIPE") process.exit(0);
	};
	process.stdout.on("error", swallow);
	process.stderr.on("error", swallow);
}

/**
 * Top-level driver: installs the EPIPE guard, runs `main(secret)` and turns any throw into a
 * redacted JSON envelope on stderr. `main` should assign the resolved key to `secret.key`
 * so it can be scrubbed from downstream error text.
 */
export async function runCli(main) {
	installStdoutGuard();
	const secret = { key: "" };
	try {
		await main(secret);
	} catch (error) {
		const code = error instanceof LinearError ? error.code : "UNKNOWN";
		const raw = error instanceof Error ? error.message : String(error ?? "");
		fail(code, redact(raw, secret.key));
	}
}

/** True when this module's importer is the process entrypoint. */
export function isEntrypoint(moduleUrl) {
	const entry = process.argv[1];
	if (!entry) return false;
	try {
		return fileURLToPath(moduleUrl) === resolve(entry);
	} catch {
		return false;
	}
}

// randomUUID is re-exported so callers can generate non-deterministic ids without a second import.
export { randomUUID };

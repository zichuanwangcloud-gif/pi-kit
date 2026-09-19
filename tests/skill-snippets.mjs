#!/usr/bin/env node
// Validates the bash snippets embedded in SKILL.md and references/*.md.
//
// Why this exists: three separate review rounds found defects that reading could not catch and
// running would have — a snippet that aborted before reaching `EXIT=$?`, an env file that was
// sourced before it was created, a variable used in the push command that was assigned nowhere.
// Prose review kept scoring these as correct because they *look* correct. This check runs them.
//
// Two passes:
//   1. syntax  — `bash -n` on every fence, with <placeholder> tokens neutralised.
//   2. binding — every $VAR a fence reads must be assigned in that fence, declared in the skill's
//                parameter-freezing template, or be a shell special. Unbound reads are how
//                `git push -u origin "$BR"` silently becomes a refspec-less push.

import { readdir, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Shell specials and loop/read bindings that are never "unbound" in the sense we care about.
const SHELL_BUILTINS = new Set([
	"?", "$", "!", "#", "@", "*", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
	"HOME", "PATH", "PWD", "USER", "SHELL", "TMPDIR", "IFS", "LINENO", "RANDOM", "SECONDS",
	"GIT_PAGER", "GH_PROMPT_DISABLED", "GH_NO_UPDATE_NOTIFIER", "GIT_DIR", "GIT_COMMON_DIR",
	"LINEAR_API_KEY", "LINEAR_API_KEY_FILE", "LINEAR_TEAM_KEY", "NODE_TLS_REJECT_UNAUTHORIZED",
	"SOURCE_DATE_EPOCH", "BASH_SOURCE", "FUNCNAME", "OLDPWD", "REPLY",
]);

// A fence may legitimately read a variable the *reader* is told to substitute by hand.
const PLACEHOLDER = /<[^<>\n]{1,60}>/g;

function fences(markdown) {
	const out = [];
	const re = /^```bash\n([\s\S]*?)^```/gm;
	let m;
	while ((m = re.exec(markdown))) {
		out.push({ body: m[1], line: markdown.slice(0, m.index).split("\n").length });
	}
	return out;
}

function assignedIn(body) {
	const names = new Set();
	// Assignment may follow start-of-line, `;`, `&&`, `||`, `(`, or `export`/`local`/`declare`.
	// `; EXIT=$?` after a subshell is the idiom these skills depend on, so it must be recognised.
	for (const m of body.matchAll(/(?:^|[;&|(]\s*|\bexport\s+|\blocal\s+|\bdeclare\s+-\w+\s+)\s*([A-Za-z_][A-Za-z0-9_]*)=/gm)) names.add(m[1]);
	// `export A='x' B='y'` puts several names on one line.
	for (const line of body.split("\n")) {
		if (!/^\s*export\s/.test(line)) continue;
		for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) names.add(m[1]);
	}
	for (const m of body.matchAll(/\bfor\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\b/g)) names.add(m[1]);
	for (const m of body.matchAll(/\bread\s+(?:-\w+\s+)*(?:-d\s+\S+\s+)?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
	return names;
}

function readIn(body) {
	const names = new Set();
	for (const m of body.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
	return names;
}

// The parameter-freezing template is the skill's declared contract. Harvest every `export NAME=`
// across the whole skill: SKILL.md holds the template, but a reference may legitimately persist an
// additional variable into the env file via a heredoc, and that is still a real declaration.
function templateVars(bodies) {
	const names = new Set();
	for (const body of bodies) {
		for (const line of body.split("\n")) {
			if (!/^\s*export\s/.test(line) && !/printf\s+"export\s/.test(line)) continue;
			for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) names.add(m[1]);
			for (const m of line.matchAll(/printf\s+"export\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
		}
	}
	return names;
}

let syntaxErrors = 0;
let unboundReports = 0;
let fenceCount = 0;

const skills = (await readdir(resolve(root, "skills"), { withFileTypes: true }))
	.filter((e) => e.isDirectory())
	.map((e) => e.name)
	.sort();

for (const skill of skills) {
	const skillPath = `skills/${skill}/SKILL.md`;
	const skillBody = await readFile(resolve(root, skillPath), "utf8");

	let refs = [];
	try {
		refs = (await readdir(resolve(root, `skills/${skill}/references`)))
			.filter((f) => f.endsWith(".md"))
			.map((f) => `skills/${skill}/references/${f}`)
			.sort();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}

	const bodies = new Map([[skillPath, skillBody]]);
	for (const path of refs) bodies.set(path, await readFile(resolve(root, path), "utf8"));
	const declared = templateVars(bodies.values());

	for (const [path, body] of bodies) {
		for (const fence of fences(body)) {
			fenceCount += 1;
			const neutral = fence.body.replace(PLACEHOLDER, "PLACEHOLDER");

			// Pass 1 — syntax.
			try {
				await run("bash", ["-n", "-c", neutral]);
			} catch (error) {
				syntaxErrors += 1;
				const detail = String(error.stderr ?? error.message).trim().split("\n")[0];
				console.error(`SYNTAX  ${path}:${fence.line}  ${detail}`);
			}

			// Pass 2 — binding.
			const assigned = assignedIn(fence.body);
			const unbound = [...readIn(fence.body)].filter(
				(n) =>
					/^[A-Z][A-Z0-9_]*$/.test(n) && // shell convention; lowercase = jq/awk internals
					!assigned.has(n) &&
					!declared.has(n) &&
					!SHELL_BUILTINS.has(n),
			);
			if (unbound.length) {
				unboundReports += 1;
				console.error(`UNBOUND ${path}:${fence.line}  ${unbound.join(" ")}`);
			}
		}
	}
}

if (syntaxErrors || unboundReports) {
	console.error(
		`\nSkill snippets FAILED: ${syntaxErrors} syntax, ${unboundReports} unbound-variable fences (of ${fenceCount}).`,
	);
	process.exitCode = 1;
} else {
	console.log(`Skill snippets OK (${fenceCount} bash fences: syntax + variable binding)`);
}

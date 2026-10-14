#!/usr/bin/env node
// Pins the linter's verdicts on a known-good and a deliberately broken spec.
// The broken fixture is the point: a checker that only ever says "clean" proves nothing.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { lintSpec } from "../lib/spec-lint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => lintSpec(readFileSync(resolve(here, name), "utf8"));
const codes = (result) => new Set(result.findings.map((f) => f.code));
let failures = 0;
const expect = (condition, message) => {
	if (!condition) {
		failures += 1;
		console.error(`FAIL ${message}`);
	}
};

const good = read("good.md");
expect(good.summary.errors === 0, `good.md should have no errors, got ${good.summary.errors}`);
expect(good.summary.gaps === 0, "good.md should report zero gaps");

const bad = read("bad-vague.md");
const badCodes = codes(bad);
for (const code of [
	"AC-VAGUE",
	"AC-NO-EXAMPLE",
	"AC-NO-PROVENANCE",
	"AC-NO-NEGATIVE",
	"REVERSE-UNBACKED",
	"SELFCHECK-GAPS-MISMATCH",
	"STATUS-OVERSTATED",
	"STATUS-OVERSTATED-OPEN",
]) {
	expect(badCodes.has(code), `bad-vague.md should trigger ${code}`);
}
expect(bad.summary.errors >= 8, `bad-vague.md should be caught hard, got ${bad.summary.errors} errors`);
expect(bad.summary.score < good.summary.score, "broken spec must score below the good one");

if (failures) {
	console.error(`spec-lint self-check FAILED (${failures})`);
	process.exit(1);
}
console.log(`spec-lint self-check OK (good score=${good.summary.score}, broken score=${bad.summary.score})`);

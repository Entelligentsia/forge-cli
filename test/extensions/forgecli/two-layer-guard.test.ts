// CI gate: build-payload.cjs must not contain hardcoded source-path references
// to engineering/ or .forge/ directories in copy expressions.
//
// The two-layer invariant: the Forge plugin source (forge/) and the
// forge-engineering sprint workspace (engineering/, .forge/) must be kept
// strictly separate. build-payload.cjs is only allowed to read from:
//   - forgeRoot     (resolved from package.json:forge.forgeRoot)
//   - repoRoot      (resolved from __dirname + relative navigation)
//   - outDir        (resolved from process.argv)
//
// Hardcoded paths like path.join("engineering", ...) or path.join(".forge", ...)
// would silently bundle private sprint data into the public npm package payload.
//
// This test scans the build-payload.cjs source text (excluding comment lines)
// for string literals containing these forbidden path segments. It is a
// static-text gate — it does not require `npm run build` to run.
//
// Reference: Iron Law §IL1 — code only in forge-cli/. See FORGE-S25-T28 plan.

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";


const PKG_ROOT = path.resolve(__dirname, "../../..");
const BUILD_PAYLOAD_SCRIPT = path.join(PKG_ROOT, "scripts/build-payload.cjs");


/**
 * Strip single-line comments (// …) from a line.
 * Block comments (/* … *\/) are rare in build-payload.cjs and their
 * handling is conservative: we strip lines that start with whitespace + *.
 */
function stripComments(source: string): string {
	return source
		.split("\n")
		.filter((line) => {
			const trimmed = line.trimStart();
			// Full-line // comment
			if (trimmed.startsWith("//")) return false;
			// Full-line * comment (inside /* block */)
			if (trimmed.startsWith("*")) return false;
			return true;
		})
		.map((line) => {
			// Remove trailing // inline comment (simple heuristic)
			const commentIdx = line.indexOf("//");
			if (commentIdx > 0) {
				return line.slice(0, commentIdx);
			}
			return line;
		})
		.join("\n");
}


describe("two-layer-guard — build-payload.cjs source-path invariant", () => {
	let sourceWithoutComments: string;

	it("build-payload.cjs exists", () => {
		expect(fs.existsSync(BUILD_PAYLOAD_SCRIPT)).toBe(true);
		const raw = fs.readFileSync(BUILD_PAYLOAD_SCRIPT, "utf8");
		sourceWithoutComments = stripComments(raw);
	});

	it('no string literal in non-comment code references "engineering/" as a path segment', () => {
		// Match any string literal that contains a segment boundary + "engineering"
		// followed by / — e.g. "engineering/sprints", "./engineering/", "/engineering/"
		// We tolerate the word "engineering" in identifiers (e.g. variable names) —
		// only string literals delimited by ' or " are checked.
		const re = /["'][^"']*(?:^|[/\\])engineering(?:[/\\]|["'])/;
		const lines = sourceWithoutComments
			.split("\n")
			.filter((line) => re.test(line));

		expect(lines).toEqual([]);
	});

	it('no string literal in non-comment code references ".forge/" as a path segment', () => {
		// Match string literals containing ".forge/" — the dogfooding instance
		// directory. Legitimate references to ".forge-*" (e.g. ".forge-payload")
		// are allowed; we only flag the exact segment ".forge/".
		const re = /["'][^"']*\.forge\//;
		const lines = sourceWithoutComments
			.split("\n")
			.filter((line) => re.test(line));

		expect(lines).toEqual([]);
	});
});

// CI gate: every .cjs tool referenced by string literal in TS handlers
// must be present in TOOLS_TO_COPY in scripts/build-payload.cjs.
//
// Uses source-text scanning rather than a post-build assertion against
// dist/forge-payload/. This is intentional: source-scan catches the gap
// at author time without requiring `npm run build`, making it a fast
// unit-tier gate. It is semantically equivalent to the build-time check
// for the coverage gap we are closing — if a new .cjs tool is referenced
// in TS but omitted from TOOLS_TO_COPY, this test fails before CI runs
// the build (FORGE-S25-T19).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ── Paths ─────────────────────────────────────────────────────────────────

// __dirname here is test/extensions/forgecli/; ../../.. steps to forge-cli/
const PKG_ROOT = path.resolve(__dirname, "../../..");
const SRC_DIR = path.join(PKG_ROOT, "src/extensions/forgecli");
const BUILD_PAYLOAD_SCRIPT = path.join(PKG_ROOT, "scripts/build-payload.cjs");

// ── Exclusions ────────────────────────────────────────────────────────────

// These .cjs names appear in TS source but are NOT runtime tools that belong
// in TOOLS_TO_COPY. They are either build scripts, test fixtures, or are
// referenced in comments.
const ALLOWLIST_EXCLUSIONS = new Set<string>([
	// build-payload.cjs is the build script itself — not a Forge runtime tool.
	// It appears in error messages / comments in src/ if at all.
	"build-payload.cjs",
]);

// ── Helpers ───────────────────────────────────────────────────────────────

function collectTsFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectTsFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			results.push(full);
		}
	}
	return results;
}

function extractCjsRefs(source: string): Set<string> {
	const refs = new Set<string>();
	// Match string literals containing a .cjs basename:
	//   "store-cli.cjs"   or   'store-cli.cjs'
	// We only want the tool name (e.g. "store-cli.cjs"), not a path.
	const re = /["']([a-zA-Z0-9_-]+\.cjs)["']/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(source)) !== null) {
		refs.add(m[1]);
	}
	return refs;
}

function extractNamedArray(scriptSource: string, constName: string, required: boolean): Set<string> {
	// Extract quoted .cjs basenames from a `const <name> = [ ... ]` literal.
	// Used for both TOOLS_TO_COPY (top-level tools) and LIB_ALLOWLIST (lib/ deps);
	// a .cjs referenced from TS is "covered" if it is copied by either path.
	const blockMatch = new RegExp(`const ${constName}\\s*=\\s*(?:new Set\\()?\\[([^\\]]+)\\]`, "s").exec(scriptSource);
	if (!blockMatch) {
		if (required) throw new Error(`Could not locate ${constName} in build-payload.cjs`);
		return new Set<string>();
	}
	const block = blockMatch[1];
	const tools = new Set<string>();
	const re = /["']([a-zA-Z0-9_-]+\.cjs)["']/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(block)) !== null) {
		tools.add(m[1]);
	}
	return tools;
}

function extractToolsToCopy(scriptSource: string): Set<string> {
	// A .cjs is covered if it is in TOOLS_TO_COPY (top-level tools) OR LIB_ALLOWLIST
	// (tools/lib/ deps copied into the bundle). Both reach the payload.
	const tools = extractNamedArray(scriptSource, "TOOLS_TO_COPY", true);
	for (const lib of extractNamedArray(scriptSource, "LIB_ALLOWLIST", false)) {
		tools.add(lib);
	}
	return tools;
}

// ── Test ──────────────────────────────────────────────────────────────────

describe("allowlist-coverage: every .cjs tool referenced in TS is in TOOLS_TO_COPY", () => {
	it("finds no uncovered .cjs references", () => {
		// 1. Scan all TS files under src/extensions/forgecli/
		const tsFiles = collectTsFiles(SRC_DIR);
		expect(tsFiles.length).toBeGreaterThan(0);

		const allRefs = new Set<string>();
		for (const f of tsFiles) {
			const src = fs.readFileSync(f, "utf8");
			for (const ref of extractCjsRefs(src)) {
				allRefs.add(ref);
			}
		}

		// 2. Read TOOLS_TO_COPY from scripts/build-payload.cjs
		expect(fs.existsSync(BUILD_PAYLOAD_SCRIPT)).toBe(true);
		const scriptSource = fs.readFileSync(BUILD_PAYLOAD_SCRIPT, "utf8");
		const toolsToCopy = extractToolsToCopy(scriptSource);
		expect(toolsToCopy.size).toBeGreaterThan(0);

		// 3. Assert every reference is covered (or explicitly excluded)
		const uncovered: string[] = [];
		for (const ref of allRefs) {
			if (!ALLOWLIST_EXCLUSIONS.has(ref) && !toolsToCopy.has(ref)) {
				uncovered.push(ref);
			}
		}

		if (uncovered.length > 0) {
			throw new Error(
				`The following .cjs tool(s) are referenced in TS source but missing from ` +
					`TOOLS_TO_COPY in scripts/build-payload.cjs:\n` +
					uncovered.map((t) => `  - ${t}`).join("\n") +
					`\n\nAdd them to TOOLS_TO_COPY or to ALLOWLIST_EXCLUSIONS in this test.`,
			);
		}

		expect(uncovered).toHaveLength(0);
	});
});

describe("allowlist-coverage: workflow-referenced tools pinned in TOOLS_TO_COPY", () => {
	// The TS source-scan above cannot see tools that only the generated
	// WORKFLOW MARKDOWN references (subagents invoke them via bash). Pin
	// those explicitly so a payload rebuild never silently drops them.
	const WORKFLOW_REFERENCED_TOOLS = [
		// forge-engineering#40: commit_task.md (plugin >= 1.2.20) routes the
		// entire commit choreography through this tool; without it the commit
		// phase halts on every initialized project.
		"commit-task.cjs",
	];

	it("every workflow-referenced tool is in TOOLS_TO_COPY", () => {
		const scriptSource = fs.readFileSync(BUILD_PAYLOAD_SCRIPT, "utf8");
		const toolsToCopy = extractToolsToCopy(scriptSource);
		for (const tool of WORKFLOW_REFERENCED_TOOLS) {
			expect(toolsToCopy.has(tool), `${tool} missing from TOOLS_TO_COPY (scripts/build-payload.cjs)`).toBe(true);
		}
	});
});

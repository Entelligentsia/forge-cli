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

function extractToolsToCopy(scriptSource: string): Set<string> {
	// Extract the array literal assigned to TOOLS_TO_COPY.
	// Strategy: find the const declaration, then extract all quoted .cjs names.
	const blockMatch = /const TOOLS_TO_COPY\s*=\s*\[([^\]]+)\]/s.exec(scriptSource);
	if (!blockMatch) {
		throw new Error("Could not locate TOOLS_TO_COPY array in build-payload.cjs");
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

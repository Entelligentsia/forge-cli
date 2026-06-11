// CI gate: every .cjs tool referenced by string literal in TS handlers
// must be vendored by the Forge payload. The source of truth is
// forge/forge/payload-manifest.json (FORGE-S32-T03) — the `tools` and
// `tools/lib` entries' curated `select.include` lists. (Previously this scanned
// the TOOLS_TO_COPY / LIB_ALLOWLIST literal arrays in build-payload.cjs; those
// were deleted when the consumers were wired to the manifest.)
//
// Uses source-text scanning of TS + a manifest read rather than a post-build
// assertion against dist/forge-payload/. This is intentional: it catches the
// gap at author time without requiring `npm run build`, making it a fast
// unit-tier gate — if a new .cjs tool is referenced in TS but omitted from the
// manifest, this test fails before CI runs the build (FORGE-S25-T19).

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

// ── Paths ─────────────────────────────────────────────────────────────────

// __dirname here is test/extensions/forgecli/; ../../.. steps to forge-cli/
const PKG_ROOT = path.resolve(__dirname, "../../..");
const SRC_DIR = path.join(PKG_ROOT, "src/extensions/forgecli");
const FORGE_ROOT = path.resolve(
	PKG_ROOT,
	JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).forge.forgeRoot,
);
const MANIFEST_PATH = path.join(FORGE_ROOT, "payload-manifest.json");

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
	for (const m of source.matchAll(re)) {
		refs.add(m[1]);
	}
	return refs;
}

function manifestCoveredTools(): Set<string> {
	// A .cjs is covered if the manifest vendors it via the `tools` entry
	// (top-level tools) or the `tools/lib` entry (tools/lib/ deps). Both reach the
	// payload. Curated entries declare their members in `select.include`.
	const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as {
		entries: Array<{ source: string; select?: { include?: string[] } }>;
	};
	const tools = new Set<string>();
	for (const source of ["tools", "tools/lib"]) {
		const entry = manifest.entries.find((e) => e.source === source);
		for (const name of entry?.select?.include ?? []) {
			if (name.endsWith(".cjs")) tools.add(name);
		}
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

		// 2. Read the covered tool set from the payload manifest
		expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
		const toolsToCopy = manifestCoveredTools();
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
					`the payload manifest (forge/forge/payload-manifest.json, tools / tools/lib entries):\n` +
					uncovered.map((t) => `  - ${t}`).join("\n") +
					`\n\nAdd them to the manifest's tools select.include or to ALLOWLIST_EXCLUSIONS in this test.`,
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

	it("every workflow-referenced tool is in the payload manifest", () => {
		const toolsToCopy = manifestCoveredTools();
		for (const tool of WORKFLOW_REFERENCED_TOOLS) {
			expect(toolsToCopy.has(tool), `${tool} missing from payload-manifest.json tools select.include`).toBe(true);
		}
	});
});

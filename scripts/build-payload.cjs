#!/usr/bin/env node
// build-payload.cjs — builds dist/forge-payload/ from forge/forge/ source.
//
// Two-pass operation:
//   Pass 1: invoke substitute-placeholders --target pi to produce:
//     dist/forge-payload/{personas,skills,templates,workflows}/
//   Pass 2: selective recursive copy to produce expanded bundle layout:
//     dist/forge-payload/tools/         ← selected .cjs tools + lib/
//     dist/forge-payload/.init/          ← discovery/*.md + generation/generate-*.md
//     dist/forge-payload/.base-pack/     ← forge/forge/init/base-pack/** (recursive)
//     dist/forge-payload/.schemas/       ← forge/forge/schemas/*.schema.json
//     dist/forge-payload/.claude-plugin/ ← plugin.json
//
// Iron Law 6: spawnSync with argv array — NO shell-string interpolation.
// Iron Law 1: reads from forge/forge/ (vendored reference) — never writes there.

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// ── Argv ──────────────────────────────────────────────────────────────────
// `--include-full` restores the historical superset bundle (Pass 1 top-level
// dirs, every `tools/lib/*`, every `.init/generation/*.md`, generic
// `.schemas/*.json`). Default build emits the minimal payload — only files
// a live forge-cli runtime path actually reads (per
// engineering/sprints/FORGE-S17/PAYLOAD_AUDIT.md).
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
	console.log(
		[
			"build-payload.cjs — build dist/forge-payload/ from forge/forge/ source.",
			"",
			"Usage:",
			"  node scripts/build-payload.cjs [--include-full]",
			"",
			"Flags:",
			"  --include-full  Emit historical superset payload (pre-T04). Adds Pass 1",
			"                  pre-substituted personas/skills/workflows/templates/ at",
			"                  the bundle root, the full tools/lib/ tree (including",
			"                  *.test.cjs and store-{nlp,query-exec,facade}.cjs),",
			"                  every .init/generation/*.md, and generic .schemas/*.json.",
			"                  Use only for /forge:enhance precursor work (S18+).",
			"  --help, -h      Show this message and exit.",
			"",
			"Default mode is the minimal payload consumed by /forge:init and other",
			"forge-cli runtime paths. See PAYLOAD_AUDIT.md for the classification.",
		].join("\n"),
	);
	process.exit(0);
}
const includeFull = argv.includes("--include-full");

// ── Resolve paths ──────────────────────────────────────────────────────────

// scripts/ is one level under the repo root (forge-cli/)
const repoRoot = path.resolve(__dirname, "..");
const pkgPath = path.join(repoRoot, "package.json");

let pkg;
try {
	pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
} catch (err) {
	console.error("build-payload: failed to read package.json:", err.message);
	process.exit(1);
}

const forgeRootRel = pkg?.forge?.forgeRoot;
if (!forgeRootRel || typeof forgeRootRel !== "string") {
	console.error(
		"build-payload: package.json is missing forge.forgeRoot field. " +
			"Set it to the path of the Forge plugin source relative to the repo root.",
	);
	process.exit(1);
}

const forgeRoot = path.resolve(repoRoot, forgeRootRel);
const toolPath = path.join(forgeRoot, "tools", "substitute-placeholders.cjs");
const outDir = path.resolve(repoRoot, "dist", "forge-payload");

// ── Guard: tool must exist ─────────────────────────────────────────────────
if (!fs.existsSync(toolPath)) {
	console.error(
		`build-payload: substitute-placeholders.cjs not found at:\n  ${toolPath}\n` +
			"Run 'npm run sync-forge' or set forge.forgeRoot correctly in package.json.",
	);
	process.exit(1);
}

// ── Ensure output dir exists ───────────────────────────────────────────────
fs.mkdirSync(outDir, { recursive: true });

// ── Pass 1: invoke substitute-placeholders --target pi ────────────────────
// Pass 1 emits pre-substituted personas/skills/workflows/templates at the
// bundle root. forge-init.ts re-runs substitute-placeholders against the
// user's actual config at runtime (Phase 3b, reading .base-pack/), so Pass 1
// output is dead in the default flow. Skipped unless --include-full.
if (includeFull) {
	console.log("build-payload: pass 1 — substitute-placeholders --target pi");
	console.log(`  forgeRoot: ${forgeRoot}`);
	console.log(`  outDir:    ${outDir}`);

	const pass1Result = spawnSync(
		"node",
		[toolPath, "--target", "pi", "--forge-root", forgeRoot, "--out", outDir],
		{
			stdio: "inherit",
			encoding: "utf8",
		},
	);

	if (pass1Result.error) {
		console.error("build-payload: failed to spawn substitute-placeholders:", pass1Result.error.message);
		process.exit(1);
	}

	if (pass1Result.status !== 0) {
		console.error("build-payload: substitute-placeholders exited with status", pass1Result.status);
		process.exit(pass1Result.status ?? 1);
	}

	console.log("build-payload: pass 1 complete");
} else {
	console.log("build-payload: pass 1 — skipped (default minimal payload; pass --include-full to restore)");
}

// ── Helper functions ───────────────────────────────────────────────────────

/**
 * Copy a file, creating parent dirs as needed.
 * @param {string} src
 * @param {string} dest
 */
function copyFile(src, dest) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
}

/**
 * Recursively copy a directory.
 * @param {string} srcDir
 * @param {string} destDir
 * @param {(name: string) => boolean} [filter] — optional predicate on entry name
 */
function copyDir(srcDir, destDir, filter) {
	if (!fs.existsSync(srcDir)) return;
	fs.mkdirSync(destDir, { recursive: true });
	const entries = fs.readdirSync(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		if (filter && !filter(entry.name)) continue;
		const src = path.join(srcDir, entry.name);
		const dest = path.join(destDir, entry.name);
		if (entry.isDirectory()) {
			copyDir(src, dest);
		} else if (entry.isFile()) {
			copyFile(src, dest);
		}
	}
}

// ── Pass 2: selective copy for expanded bundle layout ─────────────────────
console.log("build-payload: pass 2 — expanded bundle layout");

// 2a: tools/ — selective list of .cjs tools + full lib/ directory
const TOOLS_TO_COPY = [
	"substitute-placeholders.cjs",
	"build-init-context.cjs",
	"build-overlay.cjs",
	"manage-versions.cjs",
	"generation-manifest.cjs",
	"build-persona-pack.cjs",
	"build-context-pack.cjs",
	"seed-store.cjs",
	"manage-config.cjs",
	"banners.cjs",
	"validate-store.cjs",
	"collate.cjs",
	"store-cli.cjs",
	"store.cjs",
	"store-query.cjs",
	// Orchestrator-pipeline tools: invoked by every materialized workflow
	// via "$FORGE_ROOT/tools/<tool>.cjs" and by run-task.ts. Missing any of
	// these breaks the plan/review/validate phases at the bash boundary.
	"preflight-gate.cjs",
	"read-verdict.cjs",
	"parse-gates.cjs",
	// Plan-11 / Slice 2: friction recorder (subagent) and provider backfill helper.
	"friction-emit.cjs",
	"backfill-provider.cjs",
];

const toolsSrcDir = path.join(forgeRoot, "tools");
const toolsDestDir = path.join(outDir, "tools");
fs.mkdirSync(toolsDestDir, { recursive: true });

// FORGE-BUG-030: forge-cli package.json sets "type":"module", which makes
// every bundled .js file (lib/validate.js, lib/result.js) resolve as ESM.
// Those files use CommonJS module.exports. Drop a package.json scope-marker
// here so .js files in this subtree resolve as CommonJS regardless of the
// outer forge-cli package type. .cjs files are unaffected.
fs.writeFileSync(
	path.join(toolsDestDir, "package.json"),
	`${JSON.stringify({ type: "commonjs" }, null, 2)}\n`,
);
console.log("build-payload: tools/package.json written (type=commonjs scope marker)");

for (const toolName of TOOLS_TO_COPY) {
	const src = path.join(toolsSrcDir, toolName);
	if (!fs.existsSync(src)) {
		console.warn(`build-payload: tool not found (skipping): ${toolName}`);
		continue;
	}
	copyFile(src, path.join(toolsDestDir, toolName));
}

// Copy lib/ subdirectory.
// Default: allowlist mirrors what bundled tools require. Source citations:
//   forge-root.cjs, paths.cjs, pricing.cjs, project-root.cjs — required by
//     bundled store-cli.cjs / manage-config.cjs / manage-versions.cjs /
//     collate.cjs / store.cjs / substitute-placeholders.cjs.
//   result.js, validate.js — required by store-cli.cjs.
// Excluded by default: *.test.cjs (node:test units, never run from bundle),
//   store-{nlp,query-exec,facade}.cjs (only consumed by store-query.cjs,
//   which is not in TOOLS_TO_COPY).
const LIB_ALLOWLIST = new Set([
	"forge-root.cjs",
	"paths.cjs",
	"pricing.cjs",
	"project-root.cjs",
	"result.js",
	"validate.js",
	"store-facade.cjs",
	"store-nlp.cjs",
	"store-query-exec.cjs",
]);
const libSrc = path.join(toolsSrcDir, "lib");
const libDest = path.join(toolsDestDir, "lib");
if (fs.existsSync(libSrc)) {
	copyDir(libSrc, libDest, (name) => includeFull || LIB_ALLOWLIST.has(name));
	console.log(`build-payload: tools/lib/ copied (${includeFull ? "full" : "allowlist"})`);
} else {
	console.warn("build-payload: forge/forge/tools/lib/ not found — skipping");
}

console.log(`build-payload: tools/ — ${TOOLS_TO_COPY.length} tools copied`);

// 2b: .init/discovery/ — discover-*.md (5 files)
const discoveryDestDir = path.join(outDir, ".init", "discovery");
const discoverySrcDir = path.join(forgeRoot, "init", "discovery");
fs.mkdirSync(discoveryDestDir, { recursive: true });

if (fs.existsSync(discoverySrcDir)) {
	const discoveryFiles = fs.readdirSync(discoverySrcDir).filter((f) => f.startsWith("discover-") && f.endsWith(".md"));
	for (const file of discoveryFiles) {
		copyFile(path.join(discoverySrcDir, file), path.join(discoveryDestDir, file));
	}
	console.log(`build-payload: .init/discovery/ — ${discoveryFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/init/discovery/ not found — skipping");
}

// 2c: .init/generation/ — generate-*.md files
const generationDestDir = path.join(outDir, ".init", "generation");
const generationSrcDir = path.join(forgeRoot, "init", "generation");
fs.mkdirSync(generationDestDir, { recursive: true });

// Default: only generate-kb-doc.md is read at runtime (cited by Phase 2
// prompt in forge-cli/src/extensions/forgecli/forge-init.ts:230). The other
// generate-*.md and lazy-materialize.md are placeholders for /forge:enhance,
// /forge:regenerate, /forge:materialize — all deferred to S18+. Restore them
// (and add to TOOLS_TO_COPY) when those commands ship.
if (fs.existsSync(generationSrcDir)) {
	const generationFiles = fs
		.readdirSync(generationSrcDir)
		.filter((f) => f.endsWith(".md") && (includeFull || f === "generate-kb-doc.md"));
	for (const file of generationFiles) {
		copyFile(path.join(generationSrcDir, file), path.join(generationDestDir, file));
	}
	console.log(`build-payload: .init/generation/ — ${generationFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/init/generation/ not found — skipping");
}

// 2d: .base-pack/ — forge/forge/init/base-pack/** (recursive)
const basePackSrc = path.join(forgeRoot, "init", "base-pack");
const basePackDest = path.join(outDir, ".base-pack");

if (fs.existsSync(basePackSrc)) {
	copyDir(basePackSrc, basePackDest);
	// Count total files for report
	let bpFileCount = 0;
	function countFiles(dir) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			if (e.isDirectory()) countFiles(path.join(dir, e.name));
			else bpFileCount++;
		}
	}
	countFiles(basePackDest);
	console.log(`build-payload: .base-pack/ — ${bpFileCount} files copied`);
} else {
	console.warn("build-payload: forge/forge/init/base-pack/ not found — skipping");
}

// 2e: .schemas/ — forge/forge/schemas/*.schema.json
const schemasSrc = path.join(forgeRoot, "schemas");
const schemasDest = path.join(outDir, ".schemas");
fs.mkdirSync(schemasDest, { recursive: true });

// Default: only `*.schema.json` (real JSON-Schemas, copied verbatim into
// the user's `.forge/schemas/` by forge-init.ts:799-808 and consumed by
// validate-store.cjs / store-cli PreToolUse hook). `structure-manifest.json`
// is not a schema and no bundled tool reads it — restored only with
// --include-full.
if (fs.existsSync(schemasSrc)) {
	const schemaFiles = fs
		.readdirSync(schemasSrc)
		.filter((f) => f.endsWith(".schema.json") || (includeFull && f.endsWith(".json")));
	for (const file of schemaFiles) {
		copyFile(path.join(schemasSrc, file), path.join(schemasDest, file));
	}
	console.log(`build-payload: .schemas/ — ${schemaFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/schemas/ not found — skipping");
}

// 2f: .claude-plugin/ — plugin.json
const claudePluginSrc = path.join(forgeRoot, ".claude-plugin");
const claudePluginDest = path.join(outDir, ".claude-plugin");
fs.mkdirSync(claudePluginDest, { recursive: true });

if (fs.existsSync(claudePluginSrc)) {
	const pluginFiles = fs.readdirSync(claudePluginSrc).filter((f) => f.endsWith(".json"));
	for (const file of pluginFiles) {
		copyFile(path.join(claudePluginSrc, file), path.join(claudePluginDest, file));
	}
	console.log(`build-payload: .claude-plugin/ — ${pluginFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/.claude-plugin/ not found — skipping");
}

// 2g: tools/prompts/ and tools/schemas/ — forge-cli/src/extensions/forgecli/{prompts,schemas}/
// These are co-located with the sprint-plan.ts handler (FORGE-S19-T02).
// Always included (not gated by --include-full) — required for runtime, not historical superset.
const extensionPromptsSrc = path.join(repoRoot, "src", "extensions", "forgecli", "prompts");
const extensionPromptsDest = path.join(outDir, "tools", "prompts");
if (fs.existsSync(extensionPromptsSrc)) {
	copyDir(extensionPromptsSrc, extensionPromptsDest);
	console.log("build-payload: tools/prompts/ — extension prompts copied");
} else {
	console.warn("build-payload: src/extensions/forgecli/prompts/ not found — skipping");
}

const extensionSchemasSrc = path.join(repoRoot, "src", "extensions", "forgecli", "schemas");
const extensionSchemasDest = path.join(outDir, "tools", "schemas");
if (fs.existsSync(extensionSchemasSrc)) {
	copyDir(extensionSchemasSrc, extensionSchemasDest);
	console.log("build-payload: tools/schemas/ — extension schemas copied");
} else {
	console.warn("build-payload: src/extensions/forgecli/schemas/ not found — skipping");
}

console.log("build-payload: forge-payload written to", outDir);
console.log("build-payload: expanded bundle layout complete");

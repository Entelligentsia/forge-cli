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
	// forge-cli#25 defect B: health-check tools omitted from previous build.
	// /forge:health invokes all three; missing tools produce "(skipped — <tool>
	// not available in this Forge version)" for 3 of 14 checks on every install.
	"check-structure.cjs",
	"list-skills.js",
	"verify-integrity.cjs",
	// FORGE-S24 SKILL-CURATION Phase 2 pipeline tools — required by the new
	// meta-enhance workflow shipped in forge-plugin 0.45.1–0.46.x. Missing any
	// of these breaks /forge:enhance with `Cannot find module './forge/tools/<X>.cjs'`
	// because the workflow `require()`s them from $FORGE_ROOT/tools/.
	"queue-drain.cjs",
	"compression-gate.cjs",
	"judge-proposal.cjs",
	"delete-candidate-detector.cjs",
	"replay-scoring.cjs",
	// FORGE-S26-T16: backported plugin tools — artifact.cjs and verify-apply.cjs
	// are canonical plugin-side implementations; forge-cli shims delegate to them.
	"artifact.cjs",
	"verify-apply.cjs",
	// FORGE-S26-T17: init phase verification tool — called by verifiers.ts wrappers
	// and by the phase prompt files themselves to validate phase deliverables.
	"verify-phase.cjs",
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
	"frontmatter.cjs",
	"fsutil.cjs",
	"json-io.cjs",
	"paths.cjs",
	"pricing.cjs",
	"project-root.cjs",
	"result.js",
	"schema-loader.cjs",
	"slug.cjs",
	"suggest.cjs",
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

// 2a2: meta/ — forge/forge/meta/ (personas + skills source-of-truth)
// forge-cli#25 defect A: meta/ was not bundled. build-persona-pack.cjs hashes
// meta/personas/ and meta/skills/ to produce the persona-pack cache key; without
// these directories the hash is always the empty-input SHA (e3b0c4...) and
// /forge:health flags "persona pack stale — meta/ has changed since last build"
// on every fresh install.
const metaSrcDir = path.join(forgeRoot, "meta");
const metaDestDir = path.join(outDir, "meta");
if (fs.existsSync(metaSrcDir)) {
	copyDir(metaSrcDir, metaDestDir);
	// Count total files for report
	let metaFileCount = 0;
	function countMetaFiles(dir) {
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			if (e.isDirectory()) countMetaFiles(path.join(dir, e.name));
			else metaFileCount++;
		}
	}
	countMetaFiles(metaDestDir);
	console.log(`build-payload: meta/ — ${metaFileCount} files copied`);
} else {
	console.warn("build-payload: forge/forge/meta/ not found — skipping");
}

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

// 2e-pre: init/phases/ — per-phase prompt files (FORGE-S26-T17)
// Phase prompt files are read by verifiers.ts / run-phases.ts at runtime to
// build the prompt sent to the agent for each init phase.
const phasesSrc = path.join(forgeRoot, "init", "phases");
const phasesDestDir = path.join(outDir, "init", "phases");

if (fs.existsSync(phasesSrc)) {
	fs.mkdirSync(phasesDestDir, { recursive: true });
	const phaseFiles = fs.readdirSync(phasesSrc).filter(f => f.endsWith(".md"));
	for (const file of phaseFiles) {
		copyFile(path.join(phasesSrc, file), path.join(phasesDestDir, file));
	}
	console.log(`build-payload: init/phases/ — ${phaseFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/init/phases/ not found — skipping");
}

// 2e: .schemas/ — forge/forge/schemas/*.schema.json
const schemasSrc = path.join(forgeRoot, "schemas");
const schemasDest = path.join(outDir, ".schemas");
fs.mkdirSync(schemasDest, { recursive: true });

// Default: only `*.schema.json` (real JSON-Schemas, copied verbatim into
// the user's `.forge/schemas/` by forge-init.ts:799-808 and consumed by
// validate-store.cjs / store-cli PreToolUse hook).
//
// Recursive walk (FORGE-S25-T12) so subdirectory shared definitions
// (e.g. _defs/phaseSummary.schema.json, $ref'd from task + bug schemas)
// ship in the bundle preserving their relative path.
if (fs.existsSync(schemasSrc)) {
	let schemaFileCount = 0;
	const walkSchemas = (dir, relDir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullSrc = path.join(dir, entry.name);
			const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				walkSchemas(fullSrc, relPath);
			} else if (
				entry.isFile() &&
				(entry.name.endsWith(".schema.json") || (includeFull && entry.name.endsWith(".json")))
			) {
				const destPath = path.join(schemasDest, relPath);
				fs.mkdirSync(path.dirname(destPath), { recursive: true });
				copyFile(fullSrc, destPath);
				schemaFileCount++;
			}
		}
	};
	walkSchemas(schemasSrc, "");
	console.log(`build-payload: .schemas/ — ${schemaFileCount} files copied`);
} else {
	console.warn("build-payload: forge/forge/schemas/ not found — skipping");
}

// 2e0: schemas/ (non-dot path) — full recursive copy of forge/forge/schemas/
// into <bundleRoot>/schemas/. Plugin command files (health.md, etc.) resolve
// $FORGE_ROOT/schemas/*.json at runtime; the agent reads these paths literally.
// The dotted .schemas/ holds the same files for tool resolution (check-structure.cjs
// uses __dirname/../schemas/ for structure-manifest.json), but commands that
// reference $FORGE_ROOT/schemas/ in prose need the non-dot path to work.
// The recursive walk copies all .json files (schema + non-schema like
// enum-catalog.json, transitions/*.json) and subdirectories, mirroring the
// original forge/forge/schemas/ layout exactly.
const nonDotSchemasDest = path.join(outDir, "schemas");
if (fs.existsSync(schemasSrc)) {
	fs.mkdirSync(nonDotSchemasDest, { recursive: true });
	let nonDotCount = 0;
	const walkNonDotSchemas = (dir, relDir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const fullSrc = path.join(dir, entry.name);
			const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				walkNonDotSchemas(fullSrc, relPath);
			} else if (entry.isFile() && entry.name.endsWith(".json")) {
				const destPath = path.join(nonDotSchemasDest, relPath);
				fs.mkdirSync(path.dirname(destPath), { recursive: true });
				copyFile(fullSrc, destPath);
				nonDotCount++;
			}
		}
	};
	// Skip __tests__ (test files not needed at runtime)
	for (const entry of fs.readdirSync(schemasSrc, { withFileTypes: true })) {
		if (entry.name === "__tests__") continue;
		if (entry.isDirectory()) {
			walkNonDotSchemas(path.join(schemasSrc, entry.name), entry.name);
		} else if (entry.isFile() && entry.name.endsWith(".json")) {
			copyFile(path.join(schemasSrc, entry.name), path.join(nonDotSchemasDest, entry.name));
			nonDotCount++;
		}
	}
	console.log(`build-payload: schemas/ — ${nonDotCount} files copied (mirrors .schemas/)`);
} else {
	console.warn("build-payload: forge/forge/schemas/ not found — skipping schemas/ (non-dot)");
}

// 2e0b: integrity.json — bundled at <forgeRoot>/integrity.json, the exact
// path verify-integrity.cjs resolves. Without it, /forge:health's
// checkVerifyIntegrity() silently passes with "integrity.json not found"
// and plugin-tampering detection is dead.
const integritySrc = path.join(forgeRoot, "integrity.json");
const integrityDest = path.join(outDir, "integrity.json");
if (fs.existsSync(integritySrc)) {
	copyFile(integritySrc, integrityDest);
	console.log("build-payload: integrity.json copied");
} else {
	console.warn("build-payload: forge/forge/integrity.json not found — skipping");
}

// 2e1: migrations.json — forge/forge/migrations.json
// Required by migration-engine.ts at runtime (FORGE-S23-T01).
// Placed in .schemas/ alongside schema files; read via bundleRoot/.schemas/migrations.json.
// Source: lowercase 'm' (confirmed on disk: forge/forge/migrations.json).
const migrationsSrc = path.join(forgeRoot, "migrations.json");
const migrationsDest = path.join(schemasDest, "migrations.json");
if (fs.existsSync(migrationsSrc)) {
	copyFile(migrationsSrc, migrationsDest);
	console.log("build-payload: migrations.json copied to .schemas/");
} else {
	console.warn("build-payload: migrations.json not found — skipping");
}

// 2e1b: enum-catalog.json + transitions/*.json — FORGE-S25-T26/T27.
// These non-schema JSON files are not captured by the *.schema.json walk above.
// Copied to .schemas/ so catalog-loader.ts can find them alongside the schema files.
// Required by transition-guard.ts (runtime FSM lookup) and catalog-loader.ts.
const enumCatalogSrc = path.join(forgeRoot, "schemas", "enum-catalog.json");
const enumCatalogDest = path.join(schemasDest, "enum-catalog.json");
if (fs.existsSync(enumCatalogSrc)) {
	copyFile(enumCatalogSrc, enumCatalogDest);
	console.log("build-payload: .schemas/enum-catalog.json copied");
} else {
	console.warn("build-payload: forge/forge/schemas/enum-catalog.json not found — skipping");
}

const transitionsSrc = path.join(forgeRoot, "schemas", "transitions");
const transitionsDest = path.join(schemasDest, "transitions");
if (fs.existsSync(transitionsSrc)) {
	fs.mkdirSync(transitionsDest, { recursive: true });
	const transitionFiles = fs.readdirSync(transitionsSrc).filter((f) => f.endsWith(".json"));
	for (const file of transitionFiles) {
		copyFile(path.join(transitionsSrc, file), path.join(transitionsDest, file));
	}
	console.log(`build-payload: .schemas/transitions/ — ${transitionFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/schemas/transitions/ not found — skipping");
}

// 2e2: commands/ — forge/forge/commands/*.md (plugin slash-command markdowns
// like health.md, config.md, status.md). delegateMarkdownCommand reads them
// from <forgeRoot>/commands/<name>.md at runtime. Distinct from
// .base-pack/commands/ which holds per-project sprint workflow commands.
const pluginCommandsSrc = path.join(forgeRoot, "commands");
const pluginCommandsDest = path.join(outDir, "commands");
fs.mkdirSync(pluginCommandsDest, { recursive: true });

if (fs.existsSync(pluginCommandsSrc)) {
	const cmdFiles = fs.readdirSync(pluginCommandsSrc).filter((f) => f.endsWith(".md"));
	for (const file of cmdFiles) {
		copyFile(path.join(pluginCommandsSrc, file), path.join(pluginCommandsDest, file));
	}
	console.log(`build-payload: commands/ — ${cmdFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/commands/ not found — skipping");
}

// 2e3: agents/ — forge/forge/agents/*.md (plugin Claude Code subagents:
// tomoshibi, store-query-validator). Tracked by integrity.json — without
// these files in the bundle, /forge:health's checkVerifyIntegrity() reports
// them as missing on every install. Copied verbatim (no `.md` filter on
// extension beyond markdown; bundle source has only .md today).
const pluginAgentsSrc = path.join(forgeRoot, "agents");
const pluginAgentsDest = path.join(outDir, "agents");
if (fs.existsSync(pluginAgentsSrc)) {
	fs.mkdirSync(pluginAgentsDest, { recursive: true });
	const agentFiles = fs.readdirSync(pluginAgentsSrc).filter((f) => f.endsWith(".md"));
	for (const file of agentFiles) {
		copyFile(path.join(pluginAgentsSrc, file), path.join(pluginAgentsDest, file));
	}
	console.log(`build-payload: agents/ — ${agentFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/agents/ not found — skipping");
}

// 2e4: hooks/ — forge/forge/hooks/*.cjs (Claude Code plugin hooks tracked
// by integrity.json: check-update.cjs, forge-permissions.cjs, triage-error.cjs,
// validate-write.cjs). Not executed by forge-cli runtime (pi-coding-agent
// doesn't run Claude Code hooks) but bundled to satisfy integrity tracking.
// Per integrity.json scope: only top-level *.cjs are tracked — hooks/lib/,
// hooks/__tests__/, and hooks.json are intentionally excluded.
// Updated .js → .cjs by FORGE-S25-T14 (hooks rename).
const pluginHooksSrc = path.join(forgeRoot, "hooks");
const pluginHooksDest = path.join(outDir, "hooks");
if (fs.existsSync(pluginHooksSrc)) {
	fs.mkdirSync(pluginHooksDest, { recursive: true });
	const hookFiles = fs
		.readdirSync(pluginHooksSrc, { withFileTypes: true })
		.filter((e) => e.isFile() && e.name.endsWith(".cjs"))
		.map((e) => e.name);
	for (const file of hookFiles) {
		copyFile(path.join(pluginHooksSrc, file), path.join(pluginHooksDest, file));
	}
	console.log(`build-payload: hooks/ — ${hookFiles.length} files copied`);
} else {
	console.warn("build-payload: forge/forge/hooks/ not found — skipping");
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

// 2h: CHANGELOG sources for /whats-new — pin to bundled versions at build
// time so the runtime doesn't have to chase node_modules layout. Fail-soft:
// missing sources just disable that component in the /whats-new panel.
const distDir = path.resolve(repoRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });

const forgePluginChangelogSrc = path.join(forgeRoot, "..", "CHANGELOG.md");
const forgePluginChangelogDest = path.join(distDir, "CHANGELOG-forge-plugin.md");
if (fs.existsSync(forgePluginChangelogSrc)) {
	copyFile(forgePluginChangelogSrc, forgePluginChangelogDest);
	console.log("build-payload: CHANGELOG-forge-plugin.md bundled");
} else {
	console.warn("build-payload: forge plugin CHANGELOG.md not found — /whats-new will skip forge-plugin");
}

const piChangelogSrc = path.join(
	repoRoot,
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"CHANGELOG.md",
);
const piChangelogDest = path.join(distDir, "CHANGELOG-pi.md");
if (fs.existsSync(piChangelogSrc)) {
	copyFile(piChangelogSrc, piChangelogDest);
	console.log("build-payload: CHANGELOG-pi.md bundled");
} else {
	console.warn("build-payload: pi-coding-agent CHANGELOG.md not found in node_modules — /whats-new will skip pi");
}

// 2i: skills/ — forge/forge/skills/{store-custodian,store-query-grammar,store-query-nlp,refresh-kb-links}/
// Bundle 4 plugin SKILL.md skill directories into the payload so forge-cli agents
// auto-load store-custodian and related skills at runtime. Each directory contains
// only SKILL.md (no subdirectories). Source of truth remains in forge/forge/skills/.
//
// Single destination: dist/forge-payload/skills/<name>/. package.json
// `pi.skills` points here for auto-discovery; index.ts also reads the same dir
// via loadSkillsFromDir(). No pkg-root copy — that path caused untracked dirs
// after every build and dual-loaded skills under two source labels.
const SKILLS_TO_COPY = [
	"store-custodian",
	"store-query-grammar",
	"store-query-nlp",
	"refresh-kb-links",
];

const skillsSrcDir = path.join(forgeRoot, "skills");
const skillsPayloadDestDir = path.join(outDir, "skills");

let skillsCopiedCount = 0;
for (const skillName of SKILLS_TO_COPY) {
	const srcDir = path.join(skillsSrcDir, skillName);
	if (!fs.existsSync(srcDir)) {
		console.warn(`build-payload: skill directory not found (skipping): ${skillName}`);
		continue;
	}
	copyDir(srcDir, path.join(skillsPayloadDestDir, skillName));
	skillsCopiedCount++;
}
console.log(`build-payload: skills/ — ${skillsCopiedCount}/${SKILLS_TO_COPY.length} skill directories copied to payload`);

console.log("build-payload: forge-payload written to", outDir);
console.log("build-payload: expanded bundle layout complete");

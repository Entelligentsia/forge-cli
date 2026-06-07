#!/usr/bin/env node
"use strict";

// check-vendored-refs.cjs — no dead vendored references gate (forge#112 class).
//
// Scans every vendored text file in a bootstrapped project for path
// references into the vendored Forge surface and asserts each target exists.
// Catches the bug class behind four 2026-06-07 field failures: a runtime
// reference (hook script, tool, rulebook) whose target wasn't carried through
// the payload→vendor pipeline (build-payload bundling AND bootstrap copy must
// BOTH include it).
//
// Usage: node tools/check-vendored-refs.cjs <projectDir>
//   exit 0 — all references resolve
//   exit 1 — dead references found (listed on stderr)
//   exit 2 — bad invocation / projectDir not bootstrapped
//
// Scope: only references into the subtrees the BOOTSTRAP is responsible for
// (.forge/{tools,schemas,init,meta,.base-pack,.claude-plugin}). References to
// init-MATERIALIZED content (.forge/workflows/, personas/, config.json,
// store/, …) are out of scope — those don't exist until /forge:init runs.

const fs = require("node:fs");
const path = require("node:path");

// Vendored text files to scan (relative to project root).
const SCAN_GLOBS = [
	[".claude", "commands", "forge"],
	[".claude", "workflows"],
	[".claude", "agents"],
	[".claude", "skills"],
	[".forge", "init"],
	[".forge", "meta"],
	[".forge", ".base-pack"],
];
const SCAN_FILES = [[".claude", "settings.json"]];
const TEXT_EXT = new Set([".md", ".js", ".cjs", ".json"]);

// Reference patterns into bootstrap-owned subtrees. $FORGE_ROOT and
// $CLAUDE_PROJECT_DIR/.forge both normalize to .forge.
const REF_RE =
	/(?:\$FORGE_ROOT|\$CLAUDE_PROJECT_DIR\/\.forge|\.forge)\/(?:tools|schemas|init|meta|\.base-pack|\.claude-plugin)\/[A-Za-z0-9_/.-]*\.(?:json|cjs|js|md)\b/g;

function walkFiles(dir, out) {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walkFiles(full, out);
		else if (entry.isFile() && TEXT_EXT.has(path.extname(entry.name))) out.push(full);
	}
}

function normalizeRef(ref) {
	return ref.replace(/^\$FORGE_ROOT/, ".forge").replace(/^\$CLAUDE_PROJECT_DIR\/\.forge/, ".forge");
}

function checkVendoredRefs(projectDir) {
	const files = [];
	for (const parts of SCAN_GLOBS) walkFiles(path.join(projectDir, ...parts), files);
	for (const parts of SCAN_FILES) {
		const f = path.join(projectDir, ...parts);
		if (fs.existsSync(f)) files.push(f);
	}

	// missing ref -> Set of referencing files
	const missing = new Map();
	let refCount = 0;

	for (const file of files) {
		const content = fs.readFileSync(file, "utf8");
		for (const raw of content.match(REF_RE) || []) {
			// Skip template/placeholder forms: ${kbFolder}, {filename}, <name>
			if (raw.includes("{") || raw.includes("<")) continue;
			const ref = normalizeRef(raw);
			refCount++;
			if (!fs.existsSync(path.join(projectDir, ref))) {
				if (!missing.has(ref)) missing.set(ref, new Set());
				missing.get(ref).add(path.relative(projectDir, file));
			}
		}
	}

	return { scannedFiles: files.length, refCount, missing };
}

if (require.main === module) {
	const projectDir = process.argv[2];
	if (!projectDir) {
		process.stderr.write("usage: check-vendored-refs.cjs <projectDir>\n");
		process.exit(2);
	}
	if (!fs.existsSync(path.join(projectDir, ".forge", "tools"))) {
		process.stderr.write(`× ${projectDir} does not look bootstrapped (.forge/tools/ missing)\n`);
		process.exit(2);
	}

	const { scannedFiles, refCount, missing } = checkVendoredRefs(projectDir);

	if (missing.size > 0) {
		process.stderr.write(`× dead vendored references — ${missing.size} target(s) missing:\n`);
		for (const [ref, sources] of [...missing.entries()].sort()) {
			process.stderr.write(`  · ${ref}\n`);
			for (const s of [...sources].sort()) process.stderr.write(`      referenced by ${s}\n`);
		}
		process.stderr.write(
			"\nFix BOTH layers: scripts/build-payload.cjs (bundle the target) and\n" +
				"src/extensions/forgecli/claude-bootstrap/bootstrap.ts (vendor it).\n",
		);
		process.exit(1);
	}

	process.stdout.write(`〇 vendored refs OK — ${refCount} reference(s) across ${scannedFiles} file(s), 0 dead\n`);
}

module.exports = { checkVendoredRefs };

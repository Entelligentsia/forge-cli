#!/usr/bin/env node
// build-payload.cjs — invokes substitute-placeholders.cjs --target pi
// to produce dist/forge-payload/ before tsc runs.
//
// Reads forge.forgeRoot from package.json (relative to the repo root, not
// this script's location).
//
// Iron Law 6: spawnSync with argv array — NO shell-string interpolation.

"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// ── Resolve paths ──────────────────────────────────────────────────────────

// scripts/ is one level under the repo root
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

// ── Invoke substitute-placeholders --target pi ────────────────────────────
console.log(`build-payload: running substitute-placeholders --target pi`);
console.log(`  forgeRoot: ${forgeRoot}`);
console.log(`  outDir:    ${outDir}`);

const result = spawnSync(
	"node",
	[toolPath, "--target", "pi", "--forge-root", forgeRoot, "--out", outDir],
	{
		stdio: "inherit",
		encoding: "utf8",
	},
);

if (result.error) {
	console.error("build-payload: failed to spawn substitute-placeholders:", result.error.message);
	process.exit(1);
}

if (result.status !== 0) {
	console.error("build-payload: substitute-placeholders exited with status", result.status);
	process.exit(result.status ?? 1);
}

console.log("build-payload: forge-payload written to", outDir);

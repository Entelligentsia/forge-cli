#!/usr/bin/env node
/*
 * forge-cli no-skipped-tests gate (FORGE-S25-T02).
 *
 * Scans test/**.{test,spec}.ts and src/**.{test,spec}.ts for `it.skip`,
 * `it.only`, `describe.skip`, `describe.only`, `test.skip`, `test.only`,
 * `xit(`, `xdescribe(`. Exits 1 with file:line list on any primary hit.
 *
 * Secondary check (warn-only on stderr; never affects exit code):
 *   FIXME-with-skip and TODO-with-re-enable comment markers.
 *
 * Excludes: fixtures/**, .archive/**, node_modules/**, dist/**.
 *
 * Usage:
 *   node tools/check-no-skipped-tests.cjs                 # scan repo root
 *   node tools/check-no-skipped-tests.cjs --root <dir>    # scan given dir
 *
 * Iron Law #6 alignment: no shell-string interpolation; pure node fs walk.
 *
 * Sibling of forge/forge/tools/check-no-skipped-tests.cjs (T01); behaviour
 * is intentionally mirrored.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PRIMARY_REGEX = /\b(it|test|describe)\.(skip|only)\b|\b(xit|xdescribe)\s*\(/;
const SECONDARY_REGEX = /\/\/\s*FIXME\b.*\bskip\b|\/\/\s*TODO\b.*\bre-?enable\b/i;

const INCLUDE_DIRS = ["test", "src"];
const FILE_EXTS = new Set([".test.ts", ".spec.ts"]);
const EXCLUDE_SEGMENTS = new Set([
	"node_modules",
	"dist",
	"fixtures",
	".archive",
]);

// Meta-test files whose source intentionally embeds the forbidden patterns as
// fixture-string literals. These are the script's own paired tests; allowlisted
// by exact relative path from the scan root.
const EXCLUDE_FILES = new Set([
	path.join("test", "check-no-skipped-tests.test.ts"),
]);

function parseArgs(argv) {
	let root = process.cwd();
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--root" && argv[i + 1]) {
			root = path.resolve(argv[i + 1]);
			i++;
		}
	}
	return { root };
}

function isExcluded(relPath) {
	const segs = relPath.split(path.sep);
	for (const s of segs) {
		if (EXCLUDE_SEGMENTS.has(s)) return true;
	}
	return false;
}

function matchesExt(filename) {
	for (const ext of FILE_EXTS) {
		if (filename.endsWith(ext)) return true;
	}
	return false;
}

function walk(dir, root, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return;
		throw e;
	}
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		const rel = path.relative(root, full);
		if (isExcluded(rel)) continue;
		if (ent.isDirectory()) {
			walk(full, root, out);
		} else if (ent.isFile() && matchesExt(ent.name)) {
			if (EXCLUDE_FILES.has(rel)) continue;
			out.push(full);
		}
	}
}

function scanFile(file) {
	const primary = [];
	const secondary = [];
	const text = fs.readFileSync(file, "utf8");
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (PRIMARY_REGEX.test(line)) primary.push(i + 1);
		if (SECONDARY_REGEX.test(line)) secondary.push(i + 1);
	}
	return { primary, secondary };
}

function main() {
	const { root } = parseArgs(process.argv.slice(2));
	const files = [];
	for (const sub of INCLUDE_DIRS) {
		walk(path.join(root, sub), root, files);
	}

	const primaryHits = [];
	const secondaryHits = [];
	for (const f of files) {
		const { primary, secondary } = scanFile(f);
		const rel = path.relative(root, f);
		for (const ln of primary) primaryHits.push(`${rel}:${ln}`);
		for (const ln of secondary) secondaryHits.push(`${rel}:${ln}`);
	}

	if (secondaryHits.length > 0) {
		process.stderr.write(
			`warn: re-enable / FIXME-skip TODO markers (warn-only):\n`,
		);
		for (const h of secondaryHits) {
			process.stderr.write(`  ${h}\n`);
		}
	}

	if (primaryHits.length > 0) {
		process.stdout.write(
			`forge-cli: skipped/focused tests are not permitted (FORGE-S25-T02):\n`,
		);
		for (const h of primaryHits) {
			process.stdout.write(`  ${h}\n`);
		}
		process.exit(1);
	}

	process.exit(0);
}

main();

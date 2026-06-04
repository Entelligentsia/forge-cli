#!/usr/bin/env node
/*
 * forge-cli import-layering gate.
 *
 * Enforces the dependency direction inside src/extensions/forgecli/ that the
 * code-organization refactor established (lib/ depends only downward):
 *
 *   1. lib/     may relative-import only within lib/
 *   2. paths/   may relative-import only within paths/
 *   3. parsers/ may relative-import only within parsers/ or into lib/
 *
 * Package and node: imports are always allowed — only relative specifiers
 * (./ or ../) are checked. Both static `from "..."` and dynamic
 * `import("...")` specifiers are scanned.
 *
 * Exits 1 with a file:line list on any violation; silent exit 0 otherwise.
 * To legitimately relax a rule, change LAYER_RULES here with a justification
 * comment — do not work around the gate with a path trick.
 *
 * Usage:
 *   node tools/check-import-layering.cjs                 # scan repo root
 *   node tools/check-import-layering.cjs --root <dir>    # scan given dir
 *
 * Iron Law #6 alignment: no shell-string interpolation; pure node fs walk.
 * Sibling of tools/check-no-skipped-tests.cjs (FORGE-S25-T02); behaviour
 * (argv parsing, walk, file:line reporting) is intentionally mirrored.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXT_DIR = path.join("src", "extensions", "forgecli");

// layer (directory under EXT_DIR) → directories under EXT_DIR its files may
// reach via relative imports, besides their own. Resolution is per-file: the
// import specifier is resolved against the file's directory, then classified
// by its top-level directory under EXT_DIR ("" = forgecli top level).
const LAYER_RULES = {
	lib: new Set(["lib"]),
	paths: new Set(["paths"]),
	parsers: new Set(["parsers", "lib"]),
};

// Matches the specifier of static imports/re-exports (`from "x"`) and dynamic
// imports (`import("x")`). Line-based, like the no-skip gate: forgecli source
// keeps one specifier per line.
const SPECIFIER_REGEX = /(?:from\s+|import\s*\(\s*)["']((?:\.\.?\/)[^"']+)["']/g;

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

function walk(dir, out) {
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {
		if (e.code === "ENOENT") return;
		throw e;
	}
	for (const ent of entries) {
		const full = path.join(dir, ent.name);
		if (ent.isDirectory()) {
			walk(full, out);
		} else if (ent.isFile() && ent.name.endsWith(".ts")) {
			out.push(full);
		}
	}
}

/**
 * Classify an absolute path by its top-level directory under extRoot.
 * Returns "" for forgecli top-level files, the directory name for files in a
 * subdirectory, and null for paths escaping extRoot entirely.
 */
function classify(absPath, extRoot) {
	const rel = path.relative(extRoot, absPath);
	if (rel.startsWith("..")) return null;
	const segs = rel.split(path.sep);
	return segs.length > 1 ? segs[0] : "";
}

function main() {
	const { root } = parseArgs(process.argv.slice(2));
	const extRoot = path.join(root, EXT_DIR);

	const violations = [];
	for (const [layer, allowed] of Object.entries(LAYER_RULES)) {
		const layerDir = path.join(extRoot, layer);
		const files = [];
		walk(layerDir, files);
		for (const file of files) {
			const text = fs.readFileSync(file, "utf8");
			const lines = text.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				for (const m of lines[i].matchAll(SPECIFIER_REGEX)) {
					const target = path.resolve(path.dirname(file), m[1]);
					const targetLayer = classify(target, extRoot);
					if (targetLayer === null || !allowed.has(targetLayer)) {
						const rel = path.relative(root, file);
						violations.push(
							`${rel}:${i + 1}  ${layer}/ may not import "${m[1]}" ` +
								`(allowed: ${[...allowed].map((a) => `${a}/`).join(", ")})`,
						);
					}
				}
			}
		}
	}

	if (violations.length > 0) {
		process.stdout.write("forge-cli: import-layering violations (lib/ depends only downward):\n");
		for (const v of violations) {
			process.stdout.write(`  ${v}\n`);
		}
		process.exit(1);
	}

	process.exit(0);
}

main();

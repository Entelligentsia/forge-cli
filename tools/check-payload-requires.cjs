#!/usr/bin/env node
"use strict";

// check-payload-requires.cjs — payload-completeness require-walker (FORGE-S32-T04).
//
// Statically proves that every require() target and referenced runtime path in
// the bundled payload's .cjs/.js tools and hooks resolves INSIDE the bundle.
// Makes the MODULE_NOT_FOUND drift class (FORGE-BUG-030 / FORGE-BUG-036)
// structurally impossible to ship: a bundled file that requires a sibling the
// build did not carry through is caught red, build-side, in BOTH forge-cli CI
// and forge plugin CI.
//
// Generalizes the two narrow regression guards
// (bug-025-payload-completeness, bug-036-payload-lib-completeness — the latter
// walks only tools/lib/ for ./-relative requires) into ONE walker over ALL
// .cjs/.js files under <payloadRoot>/tools and <payloadRoot>/hooks.
//
// Usage: node tools/check-payload-requires.cjs <payloadRoot>
//   exit 0 — every static require + enumerated dynamic target resolves
//   exit 1 — unresolvable target(s) OR an un-enumerated dynamic require site
//   exit 2 — bad invocation / payloadRoot not found
//
// THREE reference classes, no silent skips (Iron Law 5):
//   1. Static string requires   — require('./x'), require('../tools/lib/y.cjs').
//      Relative specifiers resolve against the file's dir with the standard
//      candidate extensions. Bare specifiers (node core + node_modules) are
//      classified external and not walked.
//   2. Referenced runtime paths — the path literals behind the dynamic require
//      sites (e.g. tools/lib/validate.js, tools/generation-manifest.cjs). These
//      are declared as `targets` on each DYNAMIC_SITES entry and asserted to
//      exist in the bundle.
//   3. Dynamic require(<non-literal>) — enumerated against the DYNAMIC_SITES
//      allowlist, keyed STRUCTURALLY by file + normalized expression (NOT by
//      line number, which drifts). Any dynamic require site with no matching
//      allowlist entry is ITSELF a hard failure — a new un-enumerated dynamic
//      require cannot pass silently; the engineer must add it (with its target
//      set) or the gate stays red.

const fs = require("node:fs");
const path = require("node:path");

// ---------------------------------------------------------------------------
// DYNAMIC_SITES allowlist — the ONLY sanctioned dynamic require(<variable>)
// sites in the bundled payload. Keyed structurally (file + normalized expr) so
// it survives line drift. `targets` are bundle-relative paths (POSIX) that the
// dynamic require can resolve to; the walker asserts each exists.
//
// To add a new dynamic site: append an entry here with its candidate targets.
// Leaving it out makes the gate red — that is the Iron Law 5 guard.
// ---------------------------------------------------------------------------
const DYNAMIC_SITES = [
	{
		file: "tools/forge-preflight.cjs",
		expr: "require(path.join(forgeRoot, 'tools', 'generation-manifest.cjs'))",
		targets: ["tools/generation-manifest.cjs"],
	},
	{
		file: "tools/forge-preflight.cjs",
		expr: "require(path.join(forgeRoot, 'tools', 'check-structure.cjs'))",
		targets: ["tools/check-structure.cjs"],
	},
	{
		// hooks/validate-write.cjs has two `require(c)` sites (resolveValidator
		// and resolveSchemaLoader); both iterate a `candidates` array of bundle
		// path literals. One structural key covers both occurrences.
		file: "hooks/validate-write.cjs",
		expr: "require(c)",
		targets: ["tools/lib/validate.js", "tools/lib/schema-loader.cjs"],
	},
];

const SCAN_SUBTREES = ["tools", "hooks"];
const CODE_EXT = new Set([".cjs", ".js"]);
const RESOLVE_EXTS = ["", ".cjs", ".js", ".mjs", ".json"];

// ---------------------------------------------------------------------------
// Comment masking. Replaces // and /* */ comment characters with spaces while
// preserving offsets and newlines, and WITHOUT masking comment-like sequences
// that appear inside string literals. String CONTENTS are preserved (we need
// the require('literal') and path-literal text). This keeps a `require(` token
// that appears only in a comment (e.g. prose "files cannot require() this")
// from being mistaken for a real dynamic site.
// ---------------------------------------------------------------------------
function maskComments(src) {
	const out = src.split("");
	let i = 0;
	const n = src.length;
	let state = "code"; // code | line | block | sq | dq | tpl
	while (i < n) {
		const c = src[i];
		const c2 = i + 1 < n ? src[i + 1] : "";
		switch (state) {
			case "code":
				if (c === "/" && c2 === "/") {
					out[i] = " ";
					out[i + 1] = " ";
					i += 2;
					state = "line";
				} else if (c === "/" && c2 === "*") {
					out[i] = " ";
					out[i + 1] = " ";
					i += 2;
					state = "block";
				} else if (c === "'") {
					state = "sq";
					i++;
				} else if (c === '"') {
					state = "dq";
					i++;
				} else if (c === "`") {
					state = "tpl";
					i++;
				} else {
					i++;
				}
				break;
			case "line":
				if (c === "\n") {
					state = "code";
					i++;
				} else {
					out[i] = " ";
					i++;
				}
				break;
			case "block":
				if (c === "*" && c2 === "/") {
					out[i] = " ";
					out[i + 1] = " ";
					i += 2;
					state = "code";
				} else {
					if (c !== "\n") out[i] = " ";
					i++;
				}
				break;
			case "sq":
			case "dq":
			case "tpl": {
				const quote = state === "sq" ? "'" : state === "dq" ? '"' : "`";
				if (c === "\\") {
					i += 2; // skip escaped char
				} else if (c === quote) {
					state = "code";
					i++;
				} else {
					i++;
				}
				break;
			}
		}
	}
	return out.join("");
}

// Walk balanced parens starting at the index of the '(' after `require`.
// Returns { inner, end } where inner is the argument expression text and end is
// the index just past the matching ')'. Honors nested parens; ignores parens
// inside string literals.
function readBalanced(src, openIdx) {
	let depth = 0;
	let i = openIdx;
	let str = null;
	const n = src.length;
	for (; i < n; i++) {
		const c = src[i];
		if (str) {
			if (c === "\\") {
				i++;
				continue;
			}
			if (c === str) str = null;
			continue;
		}
		if (c === "'" || c === '"' || c === "`") {
			str = c;
			continue;
		}
		if (c === "(") depth++;
		else if (c === ")") {
			depth--;
			if (depth === 0) {
				return { inner: src.slice(openIdx + 1, i), end: i + 1 };
			}
		}
	}
	return { inner: src.slice(openIdx + 1), end: n };
}

function lineAt(src, idx) {
	let line = 1;
	for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") line++;
	return line;
}

// Collapse a full `require(...)` expression to a whitespace-normalized form so
// the structural key is stable across formatting/line drift.
function normalizeExpr(fullRequireExpr) {
	return fullRequireExpr.trim().replace(/\s+/g, " ");
}

// Extract every require(...) call site from comment-masked source.
// Returns [{ raw, arg, literal|null, isDynamic, line }].
function extractRequireSites(masked) {
	const sites = [];
	const re = /\brequire\s*\(/g;
	let m;
	while ((m = re.exec(masked)) !== null) {
		// Reject member access like `foo.require(` and `require.resolve(`.
		const before = m.index > 0 ? masked[m.index - 1] : "";
		if (before === ".") continue;
		const openIdx = m.index + m[0].length - 1; // index of '('
		const { inner, end } = readBalanced(masked, openIdx);
		re.lastIndex = end;
		const arg = inner.trim();
		if (arg === "") continue; // require() with no arg (e.g. masked comment residue)
		const litMatch = /^(['"])((?:\\.|[^\\])*?)\1$/.exec(arg);
		sites.push({
			arg,
			literal: litMatch ? litMatch[2] : null,
			isDynamic: !litMatch,
			line: lineAt(masked, m.index),
		});
	}
	return sites;
}

function resolveRelative(spec, fromDir) {
	const base = path.resolve(fromDir, spec);
	const hasExt = /\.(cjs|js|mjs|json)$/.test(spec);
	const candidates = hasExt
		? [base]
		: RESOLVE_EXTS.map((e) => base + e).concat([path.join(base, "index.cjs"), path.join(base, "index.js")]);
	return candidates.some((c) => fs.existsSync(c));
}

function walkCodeFiles(payloadRoot) {
	const out = [];
	for (const sub of SCAN_SUBTREES) {
		const root = path.join(payloadRoot, sub);
		if (!fs.existsSync(root)) continue;
		const stack = [root];
		while (stack.length) {
			const dir = stack.pop();
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) stack.push(full);
				else if (entry.isFile() && CODE_EXT.has(path.extname(entry.name))) out.push(full);
			}
		}
	}
	return out.sort();
}

function toPosixRel(payloadRoot, file) {
	return path.relative(payloadRoot, file).split(path.sep).join("/");
}

/**
 * Statically check that every require/runtime-path reference in the bundled
 * payload resolves inside the bundle.
 *
 * @param {string} payloadRoot  Directory containing tools/ and hooks/.
 * @param {object} [opts]
 * @param {Array}  [opts.dynamicSites]  Override the DYNAMIC_SITES allowlist
 *                                       (used by fixtures/tests).
 * @returns {{ok:boolean, scannedFiles:string[], unresolved:Array, unenumeratedDynamic:Array}}
 */
function checkPayloadRequires(payloadRoot, opts = {}) {
	const dynamicSites = opts.dynamicSites || DYNAMIC_SITES;
	const files = walkCodeFiles(payloadRoot);
	const scannedFiles = files.map((f) => toPosixRel(payloadRoot, f));

	const unresolved = []; // { file, line, target }
	const unenumeratedDynamic = []; // { file, line, expr }

	// Index allowlist by file -> [{ expr(normalized), targets }].
	const allowByFile = new Map();
	for (const entry of dynamicSites) {
		const list = allowByFile.get(entry.file) || [];
		list.push({ expr: normalizeExpr(entry.expr), targets: entry.targets || [] });
		// entry.expr is the full `require(...)` form; site keys are built the same way below.
		allowByFile.set(entry.file, list);
	}

	for (const file of files) {
		const rel = toPosixRel(payloadRoot, file);
		const fromDir = path.dirname(file);
		const masked = maskComments(fs.readFileSync(file, "utf8"));
		for (const site of extractRequireSites(masked)) {
			if (!site.isDynamic) {
				const spec = site.literal;
				// Class 1: static relative require must resolve in-bundle.
				if (spec.startsWith("./") || spec.startsWith("../")) {
					if (!resolveRelative(spec, fromDir)) {
						unresolved.push({ file: rel, line: site.line, target: spec });
					}
				}
				// Bare specifier (node core / node_modules) — external, skip.
				continue;
			}
			// Class 3: dynamic require(<non-literal>). Must be enumerated.
			const norm = normalizeExpr(`require(${site.arg})`);
			const entries = allowByFile.get(rel) || [];
			const match = entries.find((e) => e.expr === norm);
			if (!match) {
				unenumeratedDynamic.push({ file: rel, line: site.line, expr: norm });
				continue;
			}
			// Class 2: each declared runtime-path target must exist in-bundle.
			for (const t of match.targets) {
				const abs = path.join(payloadRoot, t);
				if (!fs.existsSync(abs)) {
					unresolved.push({ file: rel, line: site.line, target: t });
				}
			}
		}
	}

	return {
		ok: unresolved.length === 0 && unenumeratedDynamic.length === 0,
		scannedFiles,
		unresolved,
		unenumeratedDynamic,
	};
}

if (require.main === module) {
	const payloadRoot = process.argv[2];
	if (!payloadRoot) {
		process.stderr.write("usage: check-payload-requires.cjs <payloadRoot>\n");
		process.exit(2);
	}
	const toolsDir = path.join(payloadRoot, "tools");
	if (!fs.existsSync(payloadRoot) || !fs.existsSync(toolsDir)) {
		process.stderr.write(`× ${payloadRoot} is not a payload root (tools/ missing)\n`);
		process.exit(2);
	}

	const { scannedFiles, unresolved, unenumeratedDynamic } = checkPayloadRequires(payloadRoot);

	if (unresolved.length === 0 && unenumeratedDynamic.length === 0) {
		process.stdout.write(
			`〇 payload requires OK — ${scannedFiles.length} file(s) walked, every target resolves in-bundle\n`,
		);
		process.exit(0);
	}

	if (unresolved.length > 0) {
		process.stderr.write(`× unresolvable payload references — ${unresolved.length} target(s):\n`);
		for (const u of unresolved) process.stderr.write(`  · ${u.file}:${u.line} → ${u.target}\n`);
	}
	if (unenumeratedDynamic.length > 0) {
		process.stderr.write(
			`× un-enumerated dynamic require site(s) — ${unenumeratedDynamic.length} (Iron Law 5):\n`,
		);
		for (const d of unenumeratedDynamic) {
			process.stderr.write(`  · ${d.file}:${d.line} → ${d.expr}\n`);
		}
		process.stderr.write(
			"\nAdd each sanctioned dynamic site to DYNAMIC_SITES in tools/check-payload-requires.cjs\n" +
				"(structural key: file + normalized expr) with its candidate targets, or remove the\n" +
				"dynamic require. Un-enumerated dynamic requires are a hard failure by design.\n",
		);
	}
	if (unresolved.length > 0) {
		process.stderr.write(
			"\nFix the build: ensure forge/forge/payload-manifest.json (and scripts/build-payload.cjs)\n" +
				"carry every required sibling into dist/forge-payload/.\n",
		);
	}
	process.exit(1);
}

module.exports = { checkPayloadRequires, DYNAMIC_SITES };

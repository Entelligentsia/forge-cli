#!/usr/bin/env node
'use strict';

// scripts/lib/payload-manifest.cjs — CommonJS loader + select filter for the
// Forge payload manifest (FORGE-S32-T03). Consumed by scripts/build-payload.cjs
// to drive the Pass-2 bundle copies from forge/forge/payload-manifest.json
// instead of the hand-maintained TOOLS_TO_COPY / LIB_ALLOWLIST / SKILLS_TO_COPY
// arrays (the FORGE-BUG-030 / FORGE-BUG-036 MODULE_NOT_FOUND lockstep class).
//
// The select semantics (matchesFilter / isExcluded / curated include) are a
// faithful re-implementation of forge/forge/tools/check-payload-manifest.cjs so
// the three payload consumers cannot drift from the T02 validator's reading of
// ext / prefix / include / exclude / recursive. A shared-fixture parity test
// pins the two implementations together (advisory 2).
//
// Built-ins only (fs, path). Reads the source tree, writes nothing.

const fs = require('node:fs');
const path = require('node:path');

// ── Pure select helpers (mirror check-payload-manifest.cjs) ──────────────────

// Does `name` satisfy an entry's ext/prefix filter? Curated `include` is handled
// by the caller (applySelect); `exclude` is matched separately on path segments.
function matchesFilter(name, select) {
	if (!select) return true;
	if (Array.isArray(select.ext) && select.ext.length > 0) {
		if (!select.ext.some((e) => name.endsWith(e))) return false;
	}
	if (Array.isArray(select.prefix) && select.prefix.length > 0) {
		if (!select.prefix.some((p) => name.startsWith(p))) return false;
	}
	return true;
}

// Is any path segment of `rel` (or the basename) in the exclude list?
function isExcluded(rel, name, select) {
	if (!select || !Array.isArray(select.exclude)) return false;
	const segs = rel.split(path.sep);
	return select.exclude.some((x) => x === name || segs.includes(x));
}

/**
 * Resolve a dir entry's `select` against a concrete directory, returning the
 * sorted list of entry-relative POSIX-ish paths the select claims. Mirrors the
 * walk + claim logic of check-payload-manifest.cjs (recursive / ext / prefix /
 * exclude / curated include) so build, bundle and install agree on the set.
 *
 * @param {string} absDir  Absolute directory to walk (a source or bundle root).
 * @param {object} [select]
 * @returns {string[]} entry-relative file paths (sorted, deterministic).
 */
function applySelect(absDir, select) {
	const out = [];
	if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return out;
	const sel = select || {};
	const curated = Array.isArray(sel.include) && sel.include.length > 0;

	const walk = (dir, relBase) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = relBase ? path.join(relBase, entry.name) : entry.name;
			if (isExcluded(rel, entry.name, sel)) continue;
			if (entry.isDirectory()) {
				// Non-recursive entries do not descend — unless the directory name
				// is itself a curated include target (e.g. skills/<skill-dir>/).
				if (sel.recursive === false && !(curated && sel.include.includes(entry.name))) continue;
				walk(abs, rel);
			} else if (entry.isFile()) {
				if (curated) {
					const top = rel.split(path.sep)[0];
					if (!(sel.include.includes(top) || sel.include.includes(entry.name))) continue;
				} else if (!matchesFilter(entry.name, sel)) {
					continue;
				}
				out.push(rel);
			}
		}
	};
	walk(absDir, '');
	out.sort();
	return out;
}

/**
 * Load and shape-validate the payload manifest from a forge root.
 * @param {string} forgeRoot  Directory containing payload-manifest.json.
 * @returns {{entries: object[], [k: string]: unknown}}
 */
function loadManifest(forgeRoot) {
	const manifestPath = path.join(forgeRoot, 'payload-manifest.json');
	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		throw new Error(`payload-manifest: cannot read ${manifestPath}: ${err.message}`);
	}
	if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.entries)) {
		throw new Error(`payload-manifest: ${manifestPath} is malformed (missing entries[] array).`);
	}
	return manifest;
}

module.exports = { loadManifest, applySelect, matchesFilter, isExcluded };

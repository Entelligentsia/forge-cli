// lib/payload-manifest.ts — typed reader for the Forge payload manifest (FORGE-S32-T03).
//
// The single source of truth for "what the Forge payload ships" is
// forge/forge/payload-manifest.json, bundled into dist/forge-payload/ by
// scripts/build-payload.cjs. This module loads + shape-validates that manifest
// and exposes the select/grouping helpers the two TypeScript consumers need:
//   - bootstrap.ts  → groupByInstall() to vendor bundle → install destinations
//   - uninstall.ts  → groupByOwner()   to remove install destinations by owner
//
// The select semantics (matchesFilter / isExcluded / curated include) are a
// faithful re-implementation of forge/forge/tools/check-payload-manifest.cjs
// and scripts/lib/payload-manifest.cjs, pinned together by a shared-fixture
// parity test (advisory 2) so the three consumers never drift from the T02
// validator's reading of ext / prefix / include / exclude / recursive.
//
// Pure fs; no network, no LLM, no store writes.

import * as fs from "node:fs";
import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Selection filter for dir entries (mirrors build-payload Pass-2 logic). */
export interface PayloadSelect {
	recursive?: boolean;
	ext?: string[];
	include?: string[];
	exclude?: string[];
	prefix?: string[];
}

/** A single payload manifest entry. */
export interface PayloadEntry {
	/** Repo-relative path under forge/forge/ (file or directory root). */
	source: string;
	/** Destination path inside dist/forge-payload/ that build-payload emits. */
	bundle: string;
	/** Destination inside a bootstrapped project (absent for bundleOnly entries). */
	install?: string;
	/** True when shipped to the bundle but NOT vendored into a project (FORGE-BUG-044/045). */
	bundleOnly?: boolean;
	/** Removal owner consumed by uninstall.ts. */
	owner: string;
	kind: "file" | "dir";
	/** True when build-payload synthesizes the artifact rather than copying it. */
	synthesized?: boolean;
	select?: PayloadSelect;
	note?: string;
}

export interface PayloadManifest {
	entries: PayloadEntry[];
	[key: string]: unknown;
}

// ── Select helpers (mirror check-payload-manifest.cjs) ───────────────────────

/**
 * Does `name` satisfy an entry's ext/prefix filter? Curated `include` is handled
 * by the caller (applySelect); `exclude` is matched separately on path segments.
 */
export function matchesFilter(name: string, select?: PayloadSelect): boolean {
	if (!select) return true;
	if (Array.isArray(select.ext) && select.ext.length > 0) {
		if (!select.ext.some((e) => name.endsWith(e))) return false;
	}
	if (Array.isArray(select.prefix) && select.prefix.length > 0) {
		if (!select.prefix.some((p) => name.startsWith(p))) return false;
	}
	return true;
}

/** Is any path segment of `rel` (or the basename) in the exclude list? */
export function isExcluded(rel: string, name: string, select?: PayloadSelect): boolean {
	if (!select || !Array.isArray(select.exclude)) return false;
	const segs = rel.split(path.sep);
	return select.exclude.some((x) => x === name || segs.includes(x));
}

/**
 * Resolve a dir entry's `select` against a concrete directory, returning the
 * sorted list of entry-relative paths the select claims. Mirrors the walk +
 * claim logic of check-payload-manifest.cjs (recursive / ext / prefix / exclude
 * / curated include) so build, bundle and install agree on the set.
 */
export function applySelect(absDir: string, select?: PayloadSelect): string[] {
	const out: string[] = [];
	if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) return out;
	const sel = select ?? {};
	const curated = Array.isArray(sel.include) && sel.include.length > 0;

	const walk = (dir: string, relBase: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const abs = path.join(dir, entry.name);
			const rel = relBase ? path.join(relBase, entry.name) : entry.name;
			if (isExcluded(rel, entry.name, sel)) continue;
			if (entry.isDirectory()) {
				// Non-recursive entries do not descend — unless the directory name
				// is itself a curated include target (e.g. skills/<skill-dir>/).
				if (sel.recursive === false && !(curated && sel.include?.includes(entry.name))) continue;
				walk(abs, rel);
			} else if (entry.isFile()) {
				if (curated) {
					const top = rel.split(path.sep)[0];
					if (!(sel.include?.includes(top) || sel.include?.includes(entry.name))) continue;
				} else if (!matchesFilter(entry.name, sel)) {
					continue;
				}
				out.push(rel);
			}
		}
	};
	walk(absDir, "");
	out.sort();
	return out;
}

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Load + shape-validate the payload manifest from a root directory (the forge
 * root at build time, or the payload root at runtime — both carry the file).
 * Throws on a missing file or a malformed (no entries[]) manifest.
 */
export function loadManifest(root: string): PayloadManifest {
	const manifestPath = path.join(root, "payload-manifest.json");
	let raw: string;
	try {
		raw = fs.readFileSync(manifestPath, "utf8");
	} catch (err) {
		const e = err as { message?: string };
		throw new Error(`payload-manifest: cannot read ${manifestPath}: ${e.message ?? String(err)}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		const e = err as { message?: string };
		throw new Error(`payload-manifest: ${manifestPath} is not valid JSON: ${e.message ?? String(err)}`);
	}
	if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as PayloadManifest).entries)) {
		throw new Error(`payload-manifest: ${manifestPath} is malformed (missing entries[] array).`);
	}
	return parsed as PayloadManifest;
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

/**
 * Entries that are vendored into a bootstrapped project (bundleOnly entries are
 * excluded — they ship to the bundle for tool resolution only). Order is
 * preserved from the manifest. FORGE-S32-T06 collapsed the former two command
 * trees into a single unified `commands/` entry, so there is no longer a
 * commands-union precedence or name-collision ordering to honour.
 */
export function installEntries(manifest: PayloadManifest): PayloadEntry[] {
	return manifest.entries.filter(
		(e) => e.bundleOnly !== true && typeof e.install === "string" && e.install.length > 0,
	);
}

/** Group install-bearing entries by their install destination (manifest order). */
export function groupByInstall(manifest: PayloadManifest): Map<string, PayloadEntry[]> {
	const groups = new Map<string, PayloadEntry[]>();
	for (const entry of installEntries(manifest)) {
		const key = entry.install as string;
		const list = groups.get(key);
		if (list) list.push(entry);
		else groups.set(key, [entry]);
	}
	return groups;
}

/** Group install-bearing entries by removal owner (uninstall grouping). */
export function groupByOwner(manifest: PayloadManifest): Map<string, PayloadEntry[]> {
	const groups = new Map<string, PayloadEntry[]>();
	for (const entry of installEntries(manifest)) {
		const list = groups.get(entry.owner);
		if (list) list.push(entry);
		else groups.set(entry.owner, [entry]);
	}
	return groups;
}

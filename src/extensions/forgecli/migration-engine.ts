// migration-engine.ts — Deterministic migration apply engine (FORGE-S23-T01)
//
// Reads migrations.json from the bundled payload, walks version entries between
// the given bounds using semver comparison [from, to) semantics, applies
// regeneration actions against the project's .forge/ directory, and maintains
// an idempotency ledger at .forge/applied-migrations.json.
//
// Design: pure engine — no pi runtime context, no UI calls, no event emission.
// The calling command handler (forge-update-command.ts) is responsible for
// event emission after this engine returns a MigrationResult.
//
// Layer: Layer 1 of the two-layer split (pure engine / command handler).

import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { isFile } from "./lib/shared-fs-utils.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MigrationEntry {
	version: string;
	date: string;
	notes: string;
	regenerate?: string[];
	fileOps?: FileOp[];
	breaking?: boolean;
	manual?: string[];
}

export interface FileOp {
	op: "mkdir" | "copy" | "delete" | "substitute-placeholder";
	path: string;
	src?: string;
}

export interface MigrationsJson {
	[key: string]: MigrationEntry;
}

// C-19: FailedCategory records a migration operation that could not be applied.
// Accumulated in MigrationResult.failedCategories and surfaced to the caller
// (forge-update-command.ts) which emits a "warning" notification.
export interface FailedCategory {
	version: string;
	category: string;
	reason: string;
}

export interface MigrationResult {
	applied: Array<{ fromVersion: string; toVersion: string; categories: string[] }>;
	skippedBreaking: Array<{ fromVersion: string; toVersion: string; reason: string }>;
	manualSteps: Array<{ fromVersion: string; toVersion: string; steps: string[] }>;
	dryRun: boolean;
	schemasRefreshed: string[];
	forgeRootUpdated: boolean;
	// C-19: categories that failed to apply due to ENOENT or other non-fatal errors.
	// Empty array means all operations succeeded (or dryRun — no writes attempted).
	failedCategories: FailedCategory[];
}

export interface RunMigrationsOptions {
	/** Absolute path to the dist/forge-payload/ bundle root */
	bundleRoot: string;
	/** Absolute path to the project root (contains .forge/) */
	projectRoot: string;
	/** Version the user was running before the upgrade */
	fromVersion: string;
	/** Version the user just upgraded to */
	toVersion: string;
	/** When true, log actions without writing any files */
	dryRun?: boolean;
}

interface AppliedMigrationsLedger {
	schemaVersion: 1;
	appliedVersions: string[];
}

interface EntryWithKey {
	key: string;
	entry: MigrationEntry;
}

/** Write-descriptor: source path + destination path for a file copy/write operation */
interface WriteDescriptor {
	src: string;
	dest: string;
	content?: string; // pre-loaded content (for substitute-file path)
}

// ── semverCompare ─────────────────────────────────────────────────────────────

/**
 * Compare two version strings using semver integer-component comparison.
 * Returns: negative if a < b, 0 if a === b, positive if a > b.
 *
 * Unlike string comparison, this correctly handles 0.9.x vs 0.10.x boundaries.
 * Strips leading "v" prefix (matches parseTriple() behavior in forge-update-command.ts:118).
 * Falls back to localeCompare for invalid/non-semver inputs.
 */
export function semverCompare(a: string, b: string): number {
	const parse = (v: string): [number, number, number] | null => {
		const cleaned = v.startsWith("v") ? v.slice(1) : v; // Strip "v" prefix (parity with parseTriple())
		const parts = cleaned.split(".");
		if (parts.length !== 3) return null;
		const [major, minor, patch] = parts.map(Number);
		if ([major, minor, patch].some((n) => Number.isNaN(n))) return null;
		return [major!, minor!, patch!];
	};
	const pa = parse(a);
	const pb = parse(b);
	if (!pa || !pb) return a.localeCompare(b); // Fallback for invalid format
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
	}
	return 0;
}

// ── filterMigrationEntries ────────────────────────────────────────────────────

/**
 * Filter migrations.json entries using [fromVersion, toVersion) semantics on keys.
 *
 * - fromVersion entry IS included: it represents the transition AWAY from that version.
 * - toVersion entry is EXCLUDED: it would be a further transition past the target.
 * - Results are sorted ascending by semver (oldest first).
 *
 * No first-run special case — this same filter applies for both first-run
 * (empty ledger) and subsequent runs. The idempotency ledger handles re-run protection.
 */
export function filterMigrationEntries(
	migrations: MigrationsJson,
	fromVersion: string,
	toVersion: string,
): EntryWithKey[] {
	return Object.entries(migrations)
		.filter(([key]) => {
			return (
				semverCompare(key, fromVersion) >= 0 &&
				semverCompare(key, toVersion) < 0
			);
		})
		.map(([key, entry]) => ({ key, entry }))
		.sort((a, b) => semverCompare(a.key, b.key));
}

// ── resolveCategory ────────────────────────────────────────────────────────────

/**
 * Resolve a migration category string to one or more WriteDescriptors.
 * Pure function — does not write files; appends to the provided writes array.
 *
 * ENOENT trap rule: if source doesn't exist, skip silently (never throw on ENOENT).
 * Non-ENOENT IO errors propagate.
 *
 * Path-traversal defense: all output paths are validated against
 * path.join(projectRoot, '.forge') before being added to writes.
 */
export function resolveCategory(
	category: string,
	bundleRoot: string,
	projectRoot: string,
	writes: WriteDescriptor[],
): void {
	const forgeDir = path.join(projectRoot, ".forge");
	const basePack = path.join(bundleRoot, ".base-pack");
	const schemas = path.join(bundleRoot, ".schemas");

	function safeDest(rel: string): string {
		const resolved = path.join(forgeDir, rel);
		const safePrefix = forgeDir + path.sep;
		if (!resolved.startsWith(safePrefix)) {
			throw new Error(`Path traversal attempt: resolved output path '${resolved}' is outside .forge/`);
		}
		return resolved;
	}

	function tryAdd(src: string, dest: string): void {
		// isFile() returns false on ENOENT and any other stat error — intentional,
		// since the migration engine must not crash on missing optional sources.
		if (isFile(src)) {
			writes.push({ src, dest });
		}
	}

	// ── Schema categories ───────────────────────────────────────────────────

	if (category === "schemas") {
		// Bare schemas — copy all *.schema.json from bundle/.schemas/ recursively,
		// preserving subdirectory structure under the destination .forge/schemas/.
		// (FORGE-S25-T12: enables _defs/ subtree shipping for $ref'd shared schemas.)
		function walk(dir: string): void {
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
				throw err;
			}
			for (const entry of entries) {
				const fullSrc = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(fullSrc);
				} else if (entry.isFile() && entry.name.endsWith(".schema.json")) {
					const rel = path.relative(schemas, fullSrc);
					writes.push({
						src: fullSrc,
						dest: safeDest(path.join("schemas", rel)),
					});
				}
			}
		}
		walk(schemas);
		return;
	}

	if (category.startsWith("schemas:")) {
		const name = category.slice("schemas:".length);

		// Path-traversal defense on the name itself
		if (name.includes("..") || name.includes("/") || name.includes("\\")) {
			// Validate safe destination will catch it — but throw explicitly for clarity
			const dest = path.join(forgeDir, "schemas", `${name}.schema.json`);
			const safePrefix = forgeDir + path.sep;
			if (!dest.startsWith(safePrefix)) {
				throw new Error(`Path traversal attempt: schemas category '${category}'`);
			}
		}

		// Special case: structure-manifest (non-.schema.json file)
		if (name === "structure-manifest") {
			// Probe .schema.json first, fall back to .json
			const srcSchema = path.join(schemas, `${name}.schema.json`);
			const srcJson = path.join(schemas, `${name}.json`);
			const dest = safeDest(path.join("schemas", `${name}.json`));
			if (fs.existsSync(srcSchema)) {
				writes.push({ src: srcSchema, dest });
			} else {
				tryAdd(srcJson, dest);
			}
			return;
		}

		// Standard schema: <name>.schema.json
		tryAdd(
			path.join(schemas, `${name}.schema.json`),
			safeDest(path.join("schemas", `${name}.schema.json`)),
		);
		return;
	}

	// ── hooks:* short-circuit ───────────────────────────────────────────────

	if (category === "hooks" || category.startsWith("hooks:")) {
		// No source directory in bundle; short-circuit before any fs call
		return;
	}

	// ── tools:* short-circuit (excluding tools:lib:*) ──────────────────────

	if (category === "tools" || (category.startsWith("tools:") && !category.startsWith("tools:lib"))) {
		// paths.forgeRoot is updated by substitute-placeholders, not by this engine directly.
		// No file operations for tools:* categories.
		return;
	}

	// ── tools:lib/<name> and tools:lib:<name> ──────────────────────────────

	if (category.startsWith("tools:lib")) {
		const rest = category.slice("tools:lib".length);
		// Normalize separator: tools:lib/forge-root or tools:lib:validate → name
		const name = rest.startsWith("/") ? rest.slice(1) : rest.startsWith(":") ? rest.slice(1) : rest;

		const libSrc = path.join(bundleRoot, "tools", "lib");

		// tools:lib files are forge-cli internal tools (bundled in dist/forge-payload/tools/lib/).
		// They serve the forge-cli extension itself, not the user's .forge/ project tree.
		// This engine can only write to projectRoot/.forge/ — it cannot update the installed
		// forge-cli tools. The migration engine records which source files exist (for tracking),
		// but cannot write them to a meaningful location within .forge/.
		//
		// Probe .cjs first, then .js (matching LIB_ALLOWLIST entry patterns).
		// For default-payload installs: forge-root.cjs, paths.cjs, validate.js ARE present.
		// ENOENT on both: graceful skip (no throw).
		const srcCjs = path.join(libSrc, `${name}.cjs`);
		const srcJs = path.join(libSrc, `${name}.js`);
		const resolvedSrc = fs.existsSync(srcCjs) ? srcCjs : fs.existsSync(srcJs) ? srcJs : null;

		if (resolvedSrc) {
			// Record as informational write to a .forge/schemas/ tracking file.
			// This is a best-effort record — the actual lib file update requires npm reinstall.
			writes.push({
				src: resolvedSrc,
				dest: safeDest(path.join("schemas", `.tools-lib-${name}.marker`)),
			});
		}
		// ENOENT on both: graceful skip
		return;
	}

	// ── fragments:* and events:* (convention aliases) ──────────────────────

	if (category.startsWith("fragments:") || category.startsWith("events:")) {
		const prefix = category.startsWith("fragments:") ? "fragments:" : "events:";
		const name = category.slice(prefix.length);
		tryAdd(
			path.join(basePack, "workflows", "_fragments", `${name}.md`),
			safeDest(path.join("workflows", "_fragments", `${name}.md`)),
		);
		return;
	}

	// ── workflows:_fragments (bare-directory token) ─────────────────────────

	if (category === "workflows:_fragments") {
		const fragDir = path.join(basePack, "workflows", "_fragments");
		try {
			const entries = fs.readdirSync(fragDir);
			for (const entry of entries) {
				// Nesting guard: do NOT recurse into a subdirectory named _fragments/
				if (entry === "_fragments") continue;
				const fullSrc = path.join(fragDir, entry);
				// isFile() returns false for dirs and any stat error — skip silently.
				if (isFile(fullSrc)) {
					writes.push({
						src: fullSrc,
						dest: safeDest(path.join("workflows", "_fragments", entry)),
					});
				}
			}
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		return;
	}

	// ── workflows:_fragments_<name> (underscore compound) ──────────────────

	if (category.startsWith("workflows:_fragments_")) {
		const name = category.slice("workflows:_fragments_".length);
		tryAdd(
			path.join(basePack, "workflows", "_fragments", `${name}.md`),
			safeDest(path.join("workflows", "_fragments", `${name}.md`)),
		);
		return;
	}

	// ── Base-pack categories ────────────────────────────────────────────────

	const VALID_BASE_PACK_TYPES = ["personas", "workflows", "skills", "templates", "commands"] as const;
	type BasePackType = (typeof VALID_BASE_PACK_TYPES)[number];

	const colonIdx = category.indexOf(":");
	const typeStr = colonIdx >= 0 ? category.slice(0, colonIdx) : category;
	const subTarget = colonIdx >= 0 ? category.slice(colonIdx + 1) : null;

	if (!VALID_BASE_PACK_TYPES.includes(typeStr as BasePackType)) {
		// Unknown category — log at debug level and skip
		return;
	}

	const type = typeStr as BasePackType;

	if (subTarget === null) {
		// Bare category — walk the entire subdirectory
		const srcDir = path.join(basePack, type);
		try {
			const files = fs.readdirSync(srcDir).filter((f) => f.endsWith(".md"));
			for (const f of files) {
				const dest = type === "skills"
					? safeDest(path.join(type, f)) // skills files already have -skills.md suffix
					: type === "commands"
					? safeDest(path.join("commands", "forge", f))
					: safeDest(path.join(type, f));
				tryAdd(path.join(srcDir, f), dest);
			}
		} catch (err: unknown) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
		return;
	}

	// Special case: workflows:base-pack-store-cli-form — explicit no-op
	if (type === "workflows" && subTarget === "base-pack-store-cli-form") {
		// Sub-target doesn't exist in base-pack; debug-logged no-op
		return;
	}

	// Sub-target category: <type>:<name>
	const filename = type === "skills"
		? `${subTarget}-skills.md` // skills:<name> → <name>-skills.md
		: `${subTarget}.md`;

	const dest =
		type === "commands"
			? safeDest(path.join("commands", "forge", filename))
			: safeDest(path.join(type, filename));

	tryAdd(path.join(basePack, type, filename), dest);
}

// ── executeFileOps ─────────────────────────────────────────────────────────────

// C-19: Return type for executeFileOps — tracks both applied and failed operations.
interface FileOpsResult {
	categories: string[];
	failed: Array<{ category: string; reason: string }>;
}

function executeFileOps(
	fileOps: FileOp[],
	projectRoot: string,
	dryRun: boolean,
): FileOpsResult {
	const forgeDir = path.join(projectRoot, ".forge");
	const safePrefix = forgeDir + path.sep;
	const categories: string[] = [];
	// C-19: accumulate ENOENT failures for copy/substitute-placeholder ops
	const failed: Array<{ category: string; reason: string }> = [];

	for (const op of fileOps) {
		const dest = path.resolve(projectRoot, op.path);
		if (!dest.startsWith(safePrefix) && !dest.startsWith(forgeDir)) {
			throw new Error(`Path traversal attempt in fileOps: '${op.path}'`);
		}

		const categoryLabel = `fileOps:${op.op}`;
		categories.push(categoryLabel);

		if (dryRun) continue;

		switch (op.op) {
			case "mkdir":
				fs.mkdirSync(dest, { recursive: true });
				break;
			case "copy":
				if (op.src) {
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					try {
						fs.copyFileSync(op.src, dest);
					} catch (err: unknown) {
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
						// C-19: src absent — record failure so caller can surface it
						failed.push({ category: categoryLabel, reason: `ENOENT: ${op.src}` });
					}
				}
				break;
			case "delete":
				try {
					fs.rmSync(dest, { force: true });
				} catch (err: unknown) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
				break;
			case "substitute-placeholder":
				// Forward-compat: just copy for now (no ctx available in engine)
				if (op.src) {
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					try {
						fs.copyFileSync(op.src, dest);
					} catch (err: unknown) {
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
						// C-19: src absent — record failure so caller can surface it
						failed.push({ category: categoryLabel, reason: `ENOENT: ${op.src}` });
					}
				}
				break;
		}
	}

	return { categories, failed };
}

// ── Ledger helpers ────────────────────────────────────────────────────────────

function readLedger(projectRoot: string): AppliedMigrationsLedger {
	const ledgerPath = path.join(projectRoot, ".forge", "applied-migrations.json");
	try {
		const raw = fs.readFileSync(ledgerPath, "utf8");
		return JSON.parse(raw) as AppliedMigrationsLedger;
	} catch {
		return { schemaVersion: 1, appliedVersions: [] };
	}
}

function writeLedger(projectRoot: string, ledger: AppliedMigrationsLedger): void {
	const ledgerPath = path.join(projectRoot, ".forge", "applied-migrations.json");
	fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf8");
}

// ── runMigrations ─────────────────────────────────────────────────────────────

/**
 * Execute all migration entries between [fromVersion, toVersion) from the
 * bundled migrations.json against the project's .forge/ directory.
 *
 * Design constraints:
 * - No UI context (no ctx.ui calls).
 * - No event emission (caller is responsible).
 * - Pure deterministic engine: reads from bundleRoot, writes to projectRoot/.forge/.
 * - Idempotent: already-applied versions (from .forge/applied-migrations.json) are skipped.
 *
 * Forward-compat: entries with non-empty fileOps[] use fileOps; otherwise regenerate.
 * NOTE: 0 of 158 current entries use fileOps — the executor is dead code on day 1.
 * Once a real fileOps entry lands, an integration test against that entry MUST be added.
 */
export async function runMigrations(opts: RunMigrationsOptions): Promise<MigrationResult> {
	const { bundleRoot, projectRoot, fromVersion, toVersion, dryRun = false } = opts;

	const result: MigrationResult = {
		applied: [],
		skippedBreaking: [],
		manualSteps: [],
		dryRun,
		schemasRefreshed: [],
		forgeRootUpdated: false,
		failedCategories: [], // C-19: populated when ops fail with ENOENT
	};

	// Read migrations.json from bundle
	const migrationsPath = path.join(bundleRoot, ".schemas", "migrations.json");
	let migrations: MigrationsJson;
	try {
		const raw = fs.readFileSync(migrationsPath, "utf8");
		migrations = JSON.parse(raw) as MigrationsJson;
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			// migrations.json not in bundle — no migrations to apply
			return result;
		}
		throw err;
	}

	// Filter entries using [from, to) semantics
	const entries = filterMigrationEntries(migrations, fromVersion, toVersion);

	if (entries.length === 0) {
		// No-op: empty range (from == to) or no entries in range
		return result;
	}

	// Read idempotency ledger
	const ledger = readLedger(projectRoot);

	// Build substitution map ONCE using config from .forge/config.json
	let buildSubstitutionMap: ((config: unknown) => Map<string, string>) | null = null;
	let substituteFile: ((content: string, map: Map<string, string>) => string) | null = null;
	try {
		const substPath = path.join(bundleRoot, "tools", "substitute-placeholders.cjs");
		const _require = createRequire(import.meta.url);
		const substModule = _require(substPath) as {
			buildSubstitutionMap: (config: unknown) => Map<string, string>;
			substituteFile: (content: string, map: Map<string, string>) => string;
		};
		buildSubstitutionMap = substModule.buildSubstitutionMap;
		substituteFile = substModule.substituteFile;
	} catch {
		// substitute-placeholders not available (testing or minimal bundle)
		// Fall back to identity substitution
	}

	let substitutionMap: Map<string, string> | null = null;
	if (buildSubstitutionMap) {
		try {
			const configPath = path.join(projectRoot, ".forge", "config.json");
			const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
			substitutionMap = buildSubstitutionMap(config);
		} catch {
			// Config unreadable — proceed without substitution
		}
	}

	// Process each entry in ascending semver order
	for (const { key, entry } of entries) {
		// Skip if already applied (idempotency)
		if (ledger.appliedVersions.includes(key)) {
			continue;
		}

		// Skip breaking entries
		if (entry.breaking) {
			result.skippedBreaking.push({
				fromVersion: key,
				toVersion: entry.version,
				reason: `breaking: true — manual intervention required. Notes: ${entry.notes}`,
			});
			continue;
		}

		// Collect manual steps
		if (entry.manual && entry.manual.length > 0) {
			result.manualSteps.push({
				fromVersion: key,
				toVersion: entry.version,
				steps: entry.manual,
			});
		}

		let appliedCategories: string[] = [];

		// fileOps takes priority over regenerate when non-empty
		// NOTE: 0 of 158 current entries use fileOps (dead code on day 1).
		// When a real fileOps entry lands, add an integration test against it.
		if (entry.fileOps && entry.fileOps.length > 0) {
			// C-19: consume FileOpsResult to capture ENOENT failures
			const fileOpsResult = executeFileOps(entry.fileOps, projectRoot, dryRun);
			appliedCategories = fileOpsResult.categories;
			for (const f of fileOpsResult.failed) {
				result.failedCategories.push({ version: key, category: f.category, reason: f.reason });
			}
		} else if (entry.regenerate && entry.regenerate.length > 0) {
			// Resolve categories to write descriptors
			const writes: WriteDescriptor[] = [];
			for (const category of entry.regenerate) {
				resolveCategory(category, bundleRoot, projectRoot, writes);
			}

			// Execute writes (unless dry-run)
			if (!dryRun) {
				for (const { src, dest } of writes) {
					try {
						fs.mkdirSync(path.dirname(dest), { recursive: true });
						// Apply placeholder substitution for base-pack files
						if (
							substituteFile &&
							substitutionMap &&
							src.includes(path.join(".base-pack")) &&
							dest.endsWith(".md")
						) {
							const content = fs.readFileSync(src, "utf8");
							const substituted = substituteFile(content, substitutionMap);
							fs.writeFileSync(dest, substituted, "utf8");
						} else {
							fs.copyFileSync(src, dest);
						}
					} catch (err: unknown) {
						if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
						// C-19: ENOENT on src — skip silently but record the failure so
						// the caller (forge-update-command.ts) can surface a warning.
						result.failedCategories.push({
							version: key,
							category: src,
							reason: `ENOENT: ${src}`,
						});
					}
				}
			}

			appliedCategories = entry.regenerate;
		}

		result.applied.push({
			fromVersion: key,
			toVersion: entry.version,
			categories: appliedCategories,
		});

		// Update ledger after successful application
		if (!dryRun) {
			ledger.appliedVersions.push(key);
		}
	}

	// Write updated ledger
	if (!dryRun && result.applied.length > 0) {
		writeLedger(projectRoot, ledger);
	}

	// Always-on schema refresh post-pass: copy all *.schema.json to .forge/schemas/
	// Runs regardless of whether any entry had a schemas category.
	// This is an always-overwrite safety net (schemas are not user-edited).
	const schemasDir = path.join(bundleRoot, ".schemas");
	const forgeSchemasDir = path.join(projectRoot, ".forge", "schemas");
	try {
		const schemaFiles = fs.readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
		if (!dryRun) {
			fs.mkdirSync(forgeSchemasDir, { recursive: true });
			for (const f of schemaFiles) {
				try {
					fs.copyFileSync(path.join(schemasDir, f), path.join(forgeSchemasDir, f));
					result.schemasRefreshed.push(f);
				} catch (err: unknown) {
					if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
				}
			}
		} else {
			result.schemasRefreshed = schemaFiles;
		}
	} catch (err: unknown) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	return result;
}

// ── Test helpers (exported for test access) ───────────────────────────────────

export const __test__ = {
	semverCompare,
	filterMigrationEntries,
	resolveCategory,
};

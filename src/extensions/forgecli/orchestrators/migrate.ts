// migrate.ts — native handler for /forge:migrate (FORGE-S23-T09)
//
// Two-branch handler:
//   Structural branch: --structural flag OR .forge/structure-versions.json absent
//     → runForgeSubagent(architect persona + migrate_structural.md workflow)
//   Schema branch: deterministic store migration
//     → runMigrations() from migration-engine.ts (T01)
//
// Post-migration health check runs in both branches via runHealthCheck().
//
// Iron Laws:
//   IL6 — no shell-string interpolation (argv-array throughout)
//   IL10 — structural branch uses runForgeSubagent (in-process pi SDK), not sendKickoff
//   FORGE-BUG-001 — ctx.modelRegistry passed to runForgeSubagent

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getBundledPayloadRoot } from "../forge-init/forge-init.js";
import { loadForgePersona, runForgeSubagent } from "../forge-subagent.js";
import { type ForgeToolDefs, getSubagentTools } from "../forge-tools.js";
import { runHealthCheck } from "../health-check.js";
import { runMigrations } from "../update/migration-engine.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ParsedMigrateArgs {
	/** True when --structural flag present OR .forge/structure-versions.json absent. */
	structural: boolean;
	/** True when --dry-run flag present (schema branch only). */
	dryRun: boolean;
}

/** Minimal shape of .forge/applied-migrations.json */
interface AppliedMigrationsLedger {
	schemaVersion?: number;
	appliedVersions?: string[];
}

// ── Argument parser ─────────────────────────────────────────────────────────

/**
 * Parse /forge:migrate arguments.
 *
 * Also checks filesystem for .forge/structure-versions.json to determine
 * structural vs schema branch (absence → structural).
 */
export function parseMigrateArgs(args: string, cwd: string): ParsedMigrateArgs {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const hasStructuralFlag = parts.includes("--structural");
	const hasDryRun = parts.includes("--dry-run");

	// Structural if --structural flag OR structure-versions.json absent
	const structureVersionsPath = path.join(cwd, ".forge", "structure-versions.json");
	const structural = hasStructuralFlag || !fs.existsSync(structureVersionsPath);

	return { structural, dryRun: hasDryRun };
}

// ── Ledger reader ───────────────────────────────────────────────────────────

function readAppliedMigrationsFromVersion(cwd: string): string {
	const ledgerPath = path.join(cwd, ".forge", "applied-migrations.json");
	try {
		const raw = fs.readFileSync(ledgerPath, "utf8");
		const ledger = JSON.parse(raw) as AppliedMigrationsLedger;
		const versions = ledger.appliedVersions ?? [];
		return versions.at(-1) ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

// ── Bundle version reader ───────────────────────────────────────────────────

function readBundledForgeVersion(bundleRoot: string): string {
	try {
		const pluginJson = path.join(bundleRoot, ".claude-plugin", "plugin.json");
		const raw = fs.readFileSync(pluginJson, "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.version === "string" && parsed.version) return parsed.version;
	} catch {
		// fall through
	}
	return "0.0.0";
}

// ── Register ────────────────────────────────────────────────────────────────

export interface RegisterMigrateOptions {
	/** Override bundleRoot — for testing only. Production: always undefined (resolved via getBundledPayloadRoot). */
	_testBundleRoot?: string;
	/** Forge tool definitions for subagent injection. */
	forgeToolDefs?: ForgeToolDefs;
}

export function registerMigrate(pi: ExtensionAPI, opts: RegisterMigrateOptions = {}): void {
	pi.registerCommand("forge:migrate", {
		description:
			"Migrate an existing project store to Forge format. " +
			"Structural branch (--structural or pre-T05 install): delegates to architect persona. " +
			"Schema branch: applies deterministic store migrations from bundled migrations.json.",
		async handler(args: string, ctx: ExtensionCommandContext) {
			const cwd = process.cwd();
			const parsed = parseMigrateArgs(args, cwd);

			// Config guard (Step 1 from plugin source)
			const configPath = path.join(cwd, ".forge", "config.json");
			if (!fs.existsSync(configPath)) {
				ctx.ui.notify(
					"× forge:migrate — no .forge/config.json found. " +
						"Run /forge:init first, then come back to /forge:migrate.",
					"error",
				);
				return;
			}

			// Resolve forge root (for subagent and health check)
			let forgeRoot: string | undefined;
			let bundleRoot: string;
			if (opts._testBundleRoot) {
				bundleRoot = opts._testBundleRoot;
			} else {
				try {
					bundleRoot = getBundledPayloadRoot();
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					ctx.ui.notify(`× forge:migrate — could not resolve bundle root: ${msg}`, "error");
					return;
				}
			}

			try {
				const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
				const paths = cfg.paths as Record<string, unknown> | undefined;
				if (paths && typeof paths.forgeRoot === "string") forgeRoot = paths.forgeRoot;
			} catch {
				// non-fatal — forgeRoot remains undefined; health check degrades gracefully
			}

			if (parsed.structural) {
				// ── Structural branch ────────────────────────────────────────────────
				await runStructuralMigration(cwd, forgeRoot, bundleRoot, ctx, opts.forgeToolDefs);
			} else {
				// ── Schema branch ────────────────────────────────────────────────────
				await runSchemaMigration(cwd, forgeRoot, bundleRoot, parsed.dryRun, ctx);
			}
		},
	});
}

// ── Structural branch ────────────────────────────────────────────────────────

/**
 * Structural migration: load migrate_structural.md (materialized workflow),
 * run marker check, spawn architect subagent, then health check.
 *
 * Marker check rationale: migrate_structural.md does NOT contain
 * Store-Write Verification or forge_store markers (it is a prose-heavy
 * migration guide, not a store-writing kickoff). The handler checks only
 * for `Iron Laws` as the minimum safeguard. This is a documented deviation
 * from the full pack-06 marker set (pack-06 markers are designed for
 * store-writing kickoff shims; structural migration is a different workflow
 * class). Filed for follow-up: add Store-Write Verification to meta-migrate.md.
 */
async function runStructuralMigration(
	cwd: string,
	forgeRoot: string | undefined,
	bundleRoot: string,
	ctx: ExtensionCommandContext,
	forgeToolDefs?: ForgeToolDefs,
): Promise<void> {
	ctx.ui.setStatus?.("forge:migrate", "Structural migration — loading workflow…");

	// Read the materialized structural migration workflow
	const workflowPath = path.join(cwd, ".forge", "workflows", "migrate_structural.md");
	let workflowContent: string;
	try {
		workflowContent = fs.readFileSync(workflowPath, "utf8");
	} catch {
		ctx.ui.notify(
			`× forge:migrate — migrate_structural.md not found at ${workflowPath}. ` +
				"Run /forge:materialize first to fill missing workflows.",
			"error",
		);
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	// Materialization marker check (partial — Iron Laws only for structural workflow class)
	if (!workflowContent.includes("Iron Laws")) {
		ctx.ui.notify(
			`× forge:migrate — workflow regression: 'Iron Laws' not found in ${workflowPath}. ` +
				"Run /forge:materialize to refresh.",
			"error",
		);
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	// Load architect persona
	let persona: ReturnType<typeof loadForgePersona>;
	try {
		persona = loadForgePersona("architect", cwd);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`× forge:migrate — could not load architect persona: ${msg}`, "error");
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	ctx.ui.setStatus?.("forge:migrate", "Structural migration — architect running…");

	// Spawn isolated subagent (IL10)
	const result = await runForgeSubagent({
		persona,
		task: workflowContent,
		cwd,
		signal: ctx.signal,
		forgeRoot,
		modelRegistry: ctx.modelRegistry, // FORGE-BUG-001 followup
		customTools: forgeToolDefs ? getSubagentTools(forgeToolDefs) : undefined,
	});

	if (result.exitCode !== 0) {
		ctx.ui.notify(`× forge:migrate — structural migration subagent failed (exit ${result.exitCode})`, "error");
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	ctx.ui.notify("〇 forge:migrate — structural migration complete", "info");
	await runPostMigrationHealthCheck(cwd, bundleRoot, forgeRoot, ctx);
	ctx.ui.setStatus?.("forge:migrate", undefined);
}

// ── Schema branch ─────────────────────────────────────────────────────────────

async function runSchemaMigration(
	cwd: string,
	forgeRoot: string | undefined,
	bundleRoot: string,
	dryRun: boolean,
	ctx: ExtensionCommandContext,
): Promise<void> {
	ctx.ui.setStatus?.("forge:migrate", "Schema migration — detecting versions…");

	const fromVersion = readAppliedMigrationsFromVersion(cwd);
	const toVersion = readBundledForgeVersion(bundleRoot);

	if (!toVersion || toVersion === "0.0.0") {
		ctx.ui.notify(
			"× forge:migrate — could not determine bundled forge version. " +
				"The bundle may be incomplete. Try reinstalling forge-cli.",
			"error",
		);
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	if (fromVersion === toVersion) {
		ctx.ui.notify(
			`〇 forge:migrate — store is already at v${toVersion}; no schema migration needed. ` +
				'Run `node "$FORGE_ROOT/tools/validate-store.cjs"` to confirm.',
			"info",
		);
		await runPostMigrationHealthCheck(cwd, bundleRoot, forgeRoot, ctx);
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	ctx.ui.notify(
		`forge:migrate — applying migrations from v${fromVersion} → v${toVersion}${dryRun ? " (dry-run)" : ""}`,
		"info",
	);
	ctx.ui.setStatus?.("forge:migrate", `Applying migrations v${fromVersion} → v${toVersion}…`);

	let migResult: Awaited<ReturnType<typeof runMigrations>>;
	try {
		migResult = await runMigrations({
			bundleRoot,
			projectRoot: cwd,
			fromVersion,
			toVersion,
			dryRun,
		});
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`× forge:migrate — migration engine error: ${msg}`, "error");
		ctx.ui.setStatus?.("forge:migrate", undefined);
		return;
	}

	// Surface results
	if (migResult.applied.length > 0) {
		const versions = migResult.applied.map((a) => `v${a.toVersion}`).join(", ");
		ctx.ui.notify(`〇 forge:migrate — applied ${migResult.applied.length} migration(s): ${versions}`, "info");
	} else {
		ctx.ui.notify(`〇 forge:migrate — no new migrations to apply from v${fromVersion} to v${toVersion}`, "info");
	}

	if (migResult.skippedBreaking.length > 0) {
		for (const skipped of migResult.skippedBreaking) {
			ctx.ui.notify(
				`△ forge:migrate — skipped breaking migration to v${skipped.toVersion}: ${skipped.reason}`,
				"warning",
			);
		}
	}

	if (migResult.manualSteps.length > 0) {
		ctx.ui.notify("△ forge:migrate — manual steps required after migration:", "warning");
		for (const ms of migResult.manualSteps) {
			for (const step of ms.steps) {
				ctx.ui.notify(`  · v${ms.toVersion}: ${step}`, "info");
			}
		}
	}

	await runPostMigrationHealthCheck(cwd, bundleRoot, forgeRoot, ctx);
	ctx.ui.setStatus?.("forge:migrate", undefined);
}

// ── Shared post-migration health check ─────────────────────────────────────────

async function runPostMigrationHealthCheck(
	cwd: string,
	bundleRoot: string,
	forgeRoot: string | undefined,
	ctx: ExtensionCommandContext,
): Promise<void> {
	try {
		const healthResult = await runHealthCheck(cwd, bundleRoot, forgeRoot);
		if (healthResult.clean) {
			ctx.ui.notify("〇 /forge:health: clean.", "info");
		} else {
			ctx.ui.notify(`△ /forge:health: ${healthResult.gaps.length} gap(s) detected after migration`, "warning");
			for (const gap of healthResult.gaps) {
				ctx.ui.notify(`  · ${gap.check}: ${gap.message}`, "info");
			}
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(`△ forge:migrate — health check failed (non-fatal): ${msg}`, "warning");
	}
}

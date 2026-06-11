// parity-gate.test.ts — Plugin ↔ CLI command surface parity gate (FORGE-S26-T12)
//
// Ensures the plugin slash-command set (forge/forge/commands/*.md) and the CLI
// command set (EXPLICITLY_REGISTERED_NAMES in forge-commands.ts) stay in sync.
//
// Two invariants enforced:
//   1. Plugin → CLI: every plugin command file has a corresponding CLI entry.
//   2. CLI → Plugin: every CLI entry that is not in a documented exception set
//      has a corresponding plugin command file.
//
// Documented exception sets:
//   CLI_ONLY_COMMANDS — commands intentionally in CLI but absent from the plugin
//                        command file surface (pipeline orchestrators, new v1.0
//                        names whose plugin files still use old names, etc.)
//   INTERNAL_COMMANDS — commands excluded from parity entirely (not user-facing)
//
// If either invariant fails, update the appropriate exception set below and
// add a comment explaining why the new entry is intentionally divergent.
//
// Plugin command source resolution (in priority order):
//   1. FORGE_TMP_SMOKE_PLUGIN_SRC env var + /commands/ — CI with cloned plugin
//   2. dist/forge-payload/commands/                    — local after `npm run build`
//   3. Test is skipped if neither path is available (no-build fast-test run)

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { __test__ } from "../../../src/extensions/forgecli/forge-commands.js";

// ── Constants ─────────────────────────────────────────────────────────────

// Commands that exist in CLI (EXPLICITLY_REGISTERED_NAMES) but intentionally
// have no corresponding plugin command file. Each entry must have a comment.
const CLI_ONLY_COMMANDS = new Set<string>([
	// ── Pipeline phase handlers — NOW IN PARITY (FORGE-S32-T06) ──────────
	// The former two-tree split is gone: the sprint-workflow command files
	// (plan, implement, run-task, run-sprint, fix-bug, review-plan, review-code,
	// approve, commit, validate, collate, new-sprint, plan-sprint, retro) were
	// materialized into the unified forge/forge/commands/ tree, so they now have
	// plugin command files and are covered by invariant 1. They were REMOVED
	// from this exception set (keeping them would trip the stale-exception gate).

	// ── CLI-only overlays / widgets ───────────────────────────────────────
	// forge:dashboard is a pi-tui overlay that visualizes the orchestrator
	// tree (sprint > tasks > phases). It has no plugin analogue — the plugin
	// meta lives entirely in the CLI extension. Adding a plugin command file
	// would be misleading, since the overlay is purely a CLI concern.
	"forge:dashboard",

	// ── v1.0 renamed commands — NOW IN PARITY (FORGE-S32-T06) ────────────
	// new-sprint / plan-sprint / retro now exist as files in the unified
	// forge/forge/commands/ tree (materialized from base-pack), so they are
	// covered by invariant 1 and were removed from this exception set.

	// ── Deprecated CLI redirect stubs for removed plugin commands ─────────
	// These old command names have no corresponding plugin command file (the
	// files were removed during T02/T03 renames) but the CLI registers
	// deprecated redirect stubs so old users get a helpful error message.
	"forge:sprint-intake", // removed from plugin commands; CLI stub redirects to forge:new-sprint
	"forge:sprint-plan", // removed from plugin commands; CLI stub redirects to forge:plan-sprint
	"forge:retrospective", // removed from plugin commands; CLI stub redirects to forge:retro

	// ── CLI-native features ───────────────────────────────────────────────
	// forge:threads is a CLI-native UX feature (thread-switcher chip strip).
	// No workflow needed; intentionally CLI-only.
	"forge:threads", // CLI-native thread-switcher (FORGE-S25)

	// forge:run-workflow is registered dynamically by registerRunWorkflow but
	// is not in EXPLICITLY_REGISTERED_NAMES; listed here for documentation.
	// If it is ever added to EXPLICITLY_REGISTERED_NAMES, this entry activates.
	"forge:run-workflow", // generic workflow engine (CLI-native, no plugin file)
]);

// Commands excluded from parity entirely — not user-facing, no plugin file
// should exist for them.
const INTERNAL_COMMANDS = new Set<string>([
	"forge:read", // CLI-internal file reader, not a user-facing command
	"forge:refresh-kb-links", // admin utility — registered by registerAllForgeCommands
	// forge:enhance: the unified forge/forge/commands/ tree carries the
	// materialized base-pack enhance.md (live bytes, not a tombstone) since
	// FORGE-S32-T06. It remains intentionally absent from the CLI
	// EXPLICITLY_REGISTERED_NAMES — never re-add it as a primary handler.
	// registerAllForgeCommands emits an advisory stub for the bundled file; that
	// is not a primary command surface and is excluded from parity here.
	"forge:enhance",
]);

// ── Helpers ───────────────────────────────────────────────────────────────

/** Resolve the plugin commands directory. Returns null if not available. */
function resolvePluginCommandsDir(pkgRoot: string): string | null {
	// 1. FORGE_TMP_SMOKE_PLUGIN_SRC env var (CI)
	const pluginSrc = process.env.FORGE_TMP_SMOKE_PLUGIN_SRC;
	if (pluginSrc) {
		const candidate = path.join(pluginSrc, "commands");
		if (fs.existsSync(candidate)) return candidate;
	}

	// 2. dist/forge-payload/commands/ (local after npm run build)
	const distCandidate = path.join(pkgRoot, "dist", "forge-payload", "commands");
	if (fs.existsSync(distCandidate)) return distCandidate;

	return null;
}

/** Extract command names (forge:<name>) from a plugin commands directory. */
function readPluginCommandNames(commandsDir: string): Set<string> {
	const names = new Set<string>();
	const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
	for (const file of files) {
		const name = file.replace(/\.md$/, "");
		names.add(`forge:${name}`);
	}
	return names;
}

// ── Test suite ────────────────────────────────────────────────────────────

describe("FORGE-S26-T12: Plugin ↔ CLI Parity Gate", () => {
	// Resolve package root from the test file's location.
	// test/extensions/forgecli/ → ../../../ = forge-cli/
	const testDir = path.dirname(fileURLToPath(import.meta.url));
	const pkgRoot = path.resolve(testDir, "../../..");

	const commandsDir = resolvePluginCommandsDir(pkgRoot);

	it("plugin commands directory is available (else build first or set FORGE_TMP_SMOKE_PLUGIN_SRC)", () => {
		if (!commandsDir) {
			// Graceful skip: dist not built and no FORGE_TMP_SMOKE_PLUGIN_SRC.
			// This is expected in a fast `npm test` without a prior `npm run build`.
			// CI always has the payload available (smoke.yml runs build first).
			console.warn(
				"[parity-gate] plugin commands directory not found — skipping parity checks.\n" +
					"  Run `npm run build` locally, or set FORGE_TMP_SMOKE_PLUGIN_SRC in CI.",
			);
			return;
		}
		expect(commandsDir).toBeTruthy();
		const files = fs.readdirSync(commandsDir).filter((f) => f.endsWith(".md"));
		expect(files.length, "plugin commands dir is empty — build may be incomplete").toBeGreaterThan(0);
	});

	it("invariant 1: every plugin command has a corresponding CLI entry in EXPLICITLY_REGISTERED_NAMES", () => {
		if (!commandsDir) return; // no payload — skip

		const pluginCommands = readPluginCommandNames(commandsDir);
		const cliCommands = __test__.EXPLICITLY_REGISTERED_NAMES;

		const pluginOnlyCmds = [...pluginCommands].filter(
			(cmd) => !cliCommands.has(cmd) && !INTERNAL_COMMANDS.has(cmd),
		);

		expect(
			pluginOnlyCmds,
			`Plugin commands missing from CLI EXPLICITLY_REGISTERED_NAMES:\n` +
				pluginOnlyCmds.map((c) => `  ${c}`).join("\n") +
				"\n\nFix: add each missing command to EXPLICITLY_REGISTERED_NAMES in forge-commands.ts " +
				"(or to CLI_ONLY_COMMANDS / INTERNAL_COMMANDS in this test if intentionally absent).",
		).toHaveLength(0);
	});

	it("invariant 2: every CLI command has a corresponding plugin entry or is in a documented exception set", () => {
		if (!commandsDir) return; // no payload — skip

		const pluginCommands = readPluginCommandNames(commandsDir);
		const cliCommands = __test__.EXPLICITLY_REGISTERED_NAMES;

		const unexpectedCliOnly = [...cliCommands].filter(
			(cmd) => !pluginCommands.has(cmd) && !CLI_ONLY_COMMANDS.has(cmd) && !INTERNAL_COMMANDS.has(cmd),
		);

		expect(
			unexpectedCliOnly,
			`CLI commands not in plugin command files and not in the documented exception sets:\n` +
				unexpectedCliOnly.map((c) => `  ${c}`).join("\n") +
				"\n\nFix: either add the command file to forge/forge/commands/ in the plugin repo, " +
				"or add the command name to CLI_ONLY_COMMANDS in this test with an explanatory comment.",
		).toHaveLength(0);
	});

	it("documented CLI-only exceptions are not accidentally added to the plugin command set", () => {
		if (!commandsDir) return; // no payload — skip

		const pluginCommands = readPluginCommandNames(commandsDir);

		// If a CLI-only command acquires a plugin command file, it should be
		// graduated out of CLI_ONLY_COMMANDS and into parity. This test catches
		// the case where a command was added to the plugin but the exception
		// entry was not cleaned up.
		const staleExceptions = [...CLI_ONLY_COMMANDS].filter((cmd) => pluginCommands.has(cmd));

		expect(
			staleExceptions,
			`These commands are in CLI_ONLY_COMMANDS but now also have plugin command files:\n` +
				staleExceptions.map((c) => `  ${c}`).join("\n") +
				"\n\nFix: remove from CLI_ONLY_COMMANDS in this test (they are now in parity).",
		).toHaveLength(0);
	});
});

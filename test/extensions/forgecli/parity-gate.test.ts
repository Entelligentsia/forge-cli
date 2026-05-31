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
	// ── Pipeline phase handlers ──────────────────────────────────────────
	// These are project-level workflow phases invoked by the orchestrator.
	// They live in forge/forge/init/base-pack/commands/ (project-installed),
	// NOT in forge/forge/commands/ (plugin slash commands).
	"forge:plan", // pipeline plan phase (FORGE-S20-T05)
	"forge:implement", // pipeline implement phase (FORGE-S20-T06)
	"forge:run-task", // pipeline orchestrator (FORGE-S21-T02)
	"forge:run-sprint", // sprint orchestrator (FORGE-S21-T03)
	"forge:fix-bug", // bug-fix pipeline (FORGE-S21-T07)
	"forge:review-plan", // pipeline review phase (FORGE-S21-T10)
	"forge:review-code", // pipeline review phase (FORGE-S21-T10)
	"forge:approve", // pipeline approve phase (FORGE-S21-T10)
	"forge:commit", // pipeline commit phase (FORGE-S21-T10)
	"forge:validate", // pipeline validate phase (FORGE-S21-T10)
	"forge:collate", // internal orchestrator collation — not user-facing in v1.0

	// ── v1.0 renamed commands ────────────────────────────────────────────
	// New names registered in CLI; plugin still uses old names (quiz-agent.md,
	// retrospective.md, regenerate.md, store-query.md, store-repair.md,
	// sprint-intake.md, sprint-plan.md do not exist in forge/forge/commands/ but
	// the new names are registered as primary CLI handlers). The old-name command
	// files in the plugin (e.g. regenerate.md) map to deprecated redirect stubs
	// in CLI — those old names ARE in the plugin command set and will be covered
	// by invariant 1. The new names below have NO corresponding plugin file yet.
	"forge:new-sprint", // renamed from forge:sprint-intake (FORGE-S26-T10)
	"forge:plan-sprint", // renamed from forge:sprint-plan (FORGE-S26-T10)
	"forge:retro", // renamed from forge:retrospective (FORGE-S26-T10)

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
	// forge:enhance was REMOVED as a command in v1.0 (FORGE-S26-T10); the plugin
	// ships commands/enhance.md only as a deprecation tombstone pointing users at
	// /forge:rebuild --enrich (FORGE-S26-T03). It is intentionally absent from the
	// CLI EXPLICITLY_REGISTERED_NAMES — never re-add it. registerAllForgeCommands
	// emits an advisory stub for the bundled file; that is not a primary command
	// surface and is excluded from parity here.
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

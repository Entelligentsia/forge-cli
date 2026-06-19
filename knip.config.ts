// knip.config.ts — dead-code gate for forge-cli (FORGE-S25-T28)
//
// Identifies unused exports and dead files in src/.
// Entry points mirror the TypeScript compilation roots: bin entrypoints + the
// extension registration surface exposed to consumers of @entelligentsia/forgecli.
//
// Test files are included so knip can follow imports between src and test,
// preventing false-positive "unused export" reports for items consumed only
// in tests.
//
// Ignored patterns:
//   scripts/           build scripts (CJS, not part of the TS compilation unit)
//   vendor-pi/         vendored tarballs (binaries)
//   dist/              build output (generated, not a dead-code source)
//
// Developer action on gate failure:
//   npm run dead-code          — show findings
//   npm run dead-code -- --fix — auto-remove unused exports where safe
//
// See forge-cli/CLAUDE.md § CI Gates.

import type { KnipConfig } from "knip";

const config: KnipConfig = {
	entry: [
		// CLI bin entry points
		"src/bin/*.ts",
		// Extension registration surface — consumed by pi framework at runtime
		"src/extensions/forgecli/index.ts",
		// Subagent module — discovered and invoked dynamically by pi framework;
		// not imported via static TypeScript imports. Vendored from pi-mono.
		"src/extensions/forgecli/subagent/index.ts",
		"src/extensions/forgecli/subagent/agents.ts",
		// config-tui barrel modules — consumed via dynamic dispatch (pi TUI
		// lifecycle calls keys.ts and state/index.ts without static imports).
		"src/extensions/forgecli/config-tui/keys.ts",
		"src/extensions/forgecli/config-tui/state/index.ts",
		// MCP server bundle entry point — consumed by esbuild (build-mcp-server.cjs),
		// not via static TypeScript imports. index.ts is the bundle entrypoint;
		// server.ts exports `main` which is the process entry, called only from index.ts.
		"src/extensions/forgecli/mcp/index.ts",
	],
	project: [
		"src/**/*.ts",
	],
	// Include test files so exports consumed only by tests are not flagged as dead.
	// Knip treats test files as leaf consumers (they import but don't export to src).
	ignore: [
		"scripts/**",
		"vendor-pi/**",
		"dist/**",
		"test/poc/**",
		"test/.archive/**",
		"test/e2e/**",
		"test/fixtures/**",
	],
	// Handler-module exports: functions like parseXxxArgs/composeKickoff are exported
	// so the pi framework can discover them via the handler-module convention. They are
	// not imported via static TypeScript imports within this package. Suppress these
	// false-positive "unused export" findings by pattern.
	//
	// Iron Law reference: forge-cli-engineer Iron Laws §IL1 (code only in forge-cli/),
	// §IL2 (TypeScript). The handler-module convention (export parse/compose) is
	// documented in .claude/skills/forge-cli-engineer/skill-pack/04-handler-patterns.md.
	ignoreExportsUsedInFile: true,
	ignoreDependencies: [],
	// Suppress known external-API or test-utility exports that knip cannot trace via
	// static imports. Each exclusion is justified below.
	//
	// ignoreIssues format: { "glob": ["issueType", ...] }
	// Issue types relevant here: "exports" (unused exports), "types" (unused types)
	ignoreIssues: {
		// config-tui screen/theme helpers — consumed by the pi TUI runtime via dynamic
		// dispatch; not imported from src/ via static imports.
		"src/extensions/forgecli/config-tui/screens.ts": ["exports", "types"],
		"src/extensions/forgecli/config-tui/screens/shared.ts": ["exports", "types"],
		"src/extensions/forgecli/config-tui/theme.ts": ["exports", "types"],
		// catalog-types.ts — public API types for downstream @entelligentsia/forgecli consumers.
		"src/extensions/forgecli/lib/catalog-types.ts": ["exports", "types"],
		// Test-reset helpers (_reset*, __reset*) — exported for integration test access;
		// not called by current vitest suite.
		"src/extensions/forgecli/hook-dispatcher.ts": ["exports"],
		"src/extensions/forgecli/tui/input-router.ts": ["exports"],
		// friction-emit.ts types exported for downstream skill-curation consumers.
		"src/extensions/forgecli/skill-curation/friction-emit.ts": ["types"],
		// lib/state-helpers.ts base interfaces consumed by extending classes.
		"src/extensions/forgecli/lib/state-helpers.ts": ["types"],
		// Public API types in model-registry.ts and skill-curator-subagent.ts.
		"src/extensions/forgecli/config/model-registry.ts": ["types"],
		"src/extensions/forgecli/skill-curation/skill-curator-subagent.ts": ["types"],
		// status-command.ts helper exported for potential external CLI integrations.
		"src/extensions/forgecli/commands/status-command.ts": ["exports"],
	},
};

export default config;

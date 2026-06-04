// Unit + integration tests for /forge:migrate handler (FORGE-S23-T09)
//
// Tests:
//   - parseMigrateArgs: branch dispatch conditions
//   - Schema branch: runMigrations called with correct fromVersion/toVersion
//   - Schema branch: fromVersion defaults to "0.0.0" when ledger absent
//   - Schema branch: runHealthCheck called after runMigrations
//   - Schema branch: integration — mocked runMigrations returning applied entries
//   - Structural branch: runForgeSubagent called with architect persona
//   - Structural branch: marker check fires before subagent spawn
//   - EXPLICITLY_REGISTERED_NAMES: "forge:migrate" present

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock forge-init.js (hoisted)
vi.mock("../../../src/extensions/forgecli/forge-init/forge-init.js", () => ({
	getBundledPayloadRoot: vi.fn(() => "/mock-bundle-root"),
	getBundledToolsRoot: vi.fn(() => "/mock-tools-root"),
	isPiRuntime: vi.fn(() => true),
}));

// Mock forge-subagent.js (hoisted)
vi.mock("../../../src/extensions/forgecli/forge-subagent.js", () => ({
	loadForgePersona: vi.fn((name: string, cwd: string) => ({
		name,
		description: `Mock ${name}`,
		systemPrompt: "You are mock.",
		filePath: `${cwd}/.forge/personas/${name}.md`,
	})),
	runForgeSubagent: vi.fn().mockResolvedValue({
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		stopReason: "end_turn",
		model: "mock-model",
		provider: "mock-provider",
	}),
	getFinalOutput: vi.fn(() => ""),
}));

// Mock migration-engine.js (hoisted)
vi.mock("../../../src/extensions/forgecli/update/migration-engine.js", () => ({
	runMigrations: vi.fn().mockResolvedValue({
		applied: [],
		skippedBreaking: [],
		manualSteps: [],
		dryRun: false,
		schemasRefreshed: [],
		forgeRootUpdated: false,
	}),
}));

// Mock health-check.js (hoisted)
vi.mock("../../../src/extensions/forgecli/health-check.js", () => ({
	runHealthCheck: vi.fn().mockResolvedValue({
		clean: true,
		gaps: [],
		configPresent: true,
		summary: "clean",
	}),
}));

import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";
import { loadForgePersona, runForgeSubagent } from "../../../src/extensions/forgecli/forge-subagent.js";
import { runHealthCheck } from "../../../src/extensions/forgecli/health-check.js";
import { parseMigrateArgs, registerMigrate } from "../../../src/extensions/forgecli/orchestrators/migrate.js";
import { runMigrations } from "../../../src/extensions/forgecli/update/migration-engine.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-migrate-"));
	// Reset mocks
	vi.clearAllMocks();
	(runMigrations as ReturnType<typeof vi.fn>).mockResolvedValue({
		applied: [],
		skippedBreaking: [],
		manualSteps: [],
		dryRun: false,
		schemasRefreshed: [],
		forgeRootUpdated: false,
	});
	(runHealthCheck as ReturnType<typeof vi.fn>).mockResolvedValue({
		clean: true,
		gaps: [],
		configPresent: true,
		summary: "clean",
	});
	(runForgeSubagent as ReturnType<typeof vi.fn>).mockResolvedValue({
		exitCode: 0,
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		stopReason: "end_turn",
		model: "mock-model",
		provider: "mock-provider",
	});
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ── Helpers ──────────────────────────────────────────────────────────────────

interface ScaffoldOpts {
	withStructureVersions?: boolean;
	appliedVersions?: string[];
	withConfig?: boolean;
	configMode?: string;
	withWorkflow?: boolean;
	/** If true, create a fake bundle directory under tmpRoot/bundle/ with a plugin.json */
	withBundleVersion?: string;
}

/** Returns the bundle root path (tmpRoot/bundle) */
function scaffoldProject(opts: ScaffoldOpts): string {
	const forgeDir = path.join(tmpRoot, ".forge");
	const bundleDir = path.join(tmpRoot, "bundle");
	fs.mkdirSync(forgeDir, { recursive: true });
	fs.mkdirSync(bundleDir, { recursive: true });

	// Always create a bundle plugin.json so toVersion resolves
	const bundledVersion = opts.withBundleVersion ?? "0.44.0";
	const pluginDir = path.join(bundleDir, ".claude-plugin");
	fs.mkdirSync(pluginDir, { recursive: true });
	fs.writeFileSync(path.join(pluginDir, "plugin.json"), JSON.stringify({ version: bundledVersion }, null, 2), "utf8");

	if (opts.withConfig !== false) {
		const config = {
			version: "1.0",
			mode: opts.configMode ?? "full",
			paths: { engineering: "engineering", forgeRoot: "/mock-forge-root" },
		};
		fs.writeFileSync(path.join(forgeDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
	}

	if (opts.withStructureVersions) {
		fs.writeFileSync(
			path.join(forgeDir, "structure-versions.json"),
			JSON.stringify({ version: "0.40" }, null, 2),
			"utf8",
		);
	}

	if (opts.appliedVersions !== undefined) {
		const ledger = { schemaVersion: 1, appliedVersions: opts.appliedVersions };
		fs.writeFileSync(path.join(forgeDir, "applied-migrations.json"), JSON.stringify(ledger, null, 2), "utf8");
	}

	if (opts.withWorkflow) {
		const wfDir = path.join(forgeDir, "workflows");
		fs.mkdirSync(wfDir, { recursive: true });
		const workflowContent = `---
audience: orchestrator-only
deps:
  personas: [architect]
---
# Structural Migration

Iron Laws apply here.

Store-Write Verification: use forge_store.
forge_store is available.
`;
		fs.writeFileSync(path.join(wfDir, "migrate_structural.md"), workflowContent, "utf8");
	}

	return bundleDir;
}

function buildPi() {
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	return {
		registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, def.handler);
		}),
		getHandler: (name: string) => commands.get(name),
	};
}

function buildCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
		},
		signal: new AbortController().signal,
		modelRegistry: undefined,
		hasUI: true,
		...overrides,
	};
}

// ── parseMigrateArgs ─────────────────────────────────────────────────────────

describe("parseMigrateArgs", () => {
	it("no structure-versions.json → structural:true", () => {
		// tmpRoot has no .forge/structure-versions.json
		const result = parseMigrateArgs("", tmpRoot);
		expect(result.structural).toBe(true);
		expect(result.dryRun).toBe(false);
	});

	it("--structural flag with structure-versions.json present → structural:true", () => {
		scaffoldProject({ withStructureVersions: true });
		const result = parseMigrateArgs("--structural", tmpRoot);
		expect(result.structural).toBe(true);
	});

	it("structure-versions.json present, no flag → structural:false (schema branch)", () => {
		scaffoldProject({ withStructureVersions: true });
		const result = parseMigrateArgs("", tmpRoot);
		expect(result.structural).toBe(false);
	});

	it("--dry-run flag → dryRun:true", () => {
		scaffoldProject({ withStructureVersions: true });
		const result = parseMigrateArgs("--dry-run", tmpRoot);
		expect(result.dryRun).toBe(true);
		expect(result.structural).toBe(false);
	});
});

// ── Schema branch ─────────────────────────────────────────────────────────────

describe("schema branch", () => {
	it("calls runMigrations with fromVersion from ledger when present", async () => {
		const bundleDir = scaffoldProject({
			withStructureVersions: true,
			appliedVersions: ["0.43.1", "0.43.5"],
		});

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			// fromVersion should be "0.43.5" (last in appliedVersions)
			expect(runMigrations).toHaveBeenCalledWith(
				expect.objectContaining({ fromVersion: "0.43.5", toVersion: "0.44.0" }),
			);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("fromVersion defaults to 0.0.0 when applied-migrations.json absent", async () => {
		const bundleDir = scaffoldProject({ withStructureVersions: true });
		// No applied-migrations.json created

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			// runMigrations called with fromVersion: "0.0.0"
			expect(runMigrations).toHaveBeenCalledWith(expect.objectContaining({ fromVersion: "0.0.0" }));
		} finally {
			process.chdir(origCwd);
		}
	});

	it("runHealthCheck called after runMigrations completes", async () => {
		const bundleDir = scaffoldProject({ withStructureVersions: true });

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			expect(runHealthCheck).toHaveBeenCalled();
		} finally {
			process.chdir(origCwd);
		}
	});

	it("mocked runMigrations returning 2 applied → handler notifies applied count", async () => {
		const bundleDir = scaffoldProject({ withStructureVersions: true });

		(runMigrations as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			applied: [
				{ fromVersion: "0.0.0", toVersion: "0.43.1", categories: ["workflows"] },
				{ fromVersion: "0.43.1", toVersion: "0.44.0", categories: ["schemas"] },
			],
			skippedBreaking: [],
			manualSteps: [],
			dryRun: false,
			schemasRefreshed: [],
			forgeRootUpdated: false,
		});

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
			const appliedMsg = notifyCalls.find(([msg]) => msg.includes("applied 2 migration"));
			expect(appliedMsg).toBeDefined();
		} finally {
			process.chdir(origCwd);
		}
	});
});

// ── Structural branch ─────────────────────────────────────────────────────────

describe("structural branch", () => {
	it("runForgeSubagent called with persona.name === 'architect'", async () => {
		const bundleDir = scaffoldProject({ withWorkflow: true });
		// No structure-versions.json → structural branch

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			expect(loadForgePersona).toHaveBeenCalledWith("architect", tmpRoot);
			expect(runForgeSubagent).toHaveBeenCalledWith(
				expect.objectContaining({
					persona: expect.objectContaining({ name: "architect" }),
				}),
			);
		} finally {
			process.chdir(origCwd);
		}
	});

	it("missing Iron Laws marker → returns without calling runForgeSubagent", async () => {
		// Scaffold workflow WITHOUT Iron Laws
		const bundleDir = scaffoldProject({});
		const forgeDir = path.join(tmpRoot, ".forge");
		const wfDir = path.join(forgeDir, "workflows");
		fs.mkdirSync(wfDir, { recursive: true });
		fs.writeFileSync(path.join(wfDir, "migrate_structural.md"), "# Structural Migration\n\nNo laws here.\n", "utf8");

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMigrate(pi as never, { _testBundleRoot: bundleDir });
			const handler = pi.getHandler("forge:migrate");

			const ctx = buildCtx();
			await handler!("", ctx);

			// runForgeSubagent must NOT have been called
			expect(runForgeSubagent).not.toHaveBeenCalled();
			// Should have notified about marker failure
			const notifyCalls = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls as Array<[string, string]>;
			const markerMsg = notifyCalls.find(
				([msg]) => msg.includes("Iron Laws") || msg.includes("workflow regression"),
			);
			expect(markerMsg).toBeDefined();
		} finally {
			process.chdir(origCwd);
		}
	});
});

// ── EXPLICITLY_REGISTERED_NAMES ─────────────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("does NOT register forge:migrate as a command in v1.0 (removed FORGE-S26-T10; handler reused by /forge:init --migrate)", () => {
		const names = forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES;
		expect(names.has("forge:migrate")).toBe(false);
	});
});

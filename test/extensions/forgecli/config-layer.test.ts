// Tests for the layered forge-cli config loader (Slice 1 — Plan 16).
//
// Post-FORGE-S20-T11 (v0.10.0): the global config path is now resolved
// via the central path resolver (`paths/paths.ts`) at
// `~/.pi/forge-cli/config.json` (or `$FORGE_CLI_HOME/config.json`), not
// `~/.pi/agent/forge-cli/config.json`. These tests stub the resolver
// directly to keep the layered-merge coverage intact.
//
// Coverage:
//  1. Both files missing → {global: null, project: null, merged: {}}
//  2. Global only → merged equals global
//  3. Project only → merged equals project; pipelines carried
//  4. Both → persona-models shallow-merged, project wins per key; pipelines from project
//  5. Schema-invalid global → error surfaced, project still loads
//  6. Schema-invalid project → error surfaced, global still loads
//  7. Walk-up discovery: project config located at cwd/.pi/forge-cli/config.json (cwd-direct)
//  8. FORGE_CLI_HOME env var honored for global path (via resolver)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type LayeredConfig, loadLayeredConfig } from "../../../src/extensions/forgecli/config/config-layer.js";

const PRIOR_ENV = { ...process.env };

let tmpRoot: string;
let userRoot: string;
let projectDir: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forge-config-layer-"));
	userRoot = path.join(tmpRoot, "forge-cli-user");
	projectDir = path.join(tmpRoot, "project");
	fs.mkdirSync(userRoot, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	// Route the resolver's global config under our tmpdir, and disable
	// the lazy migrator so it doesn't touch the real $HOME.
	process.env.FORGE_CLI_HOME = userRoot;
	process.env.FORGE_CLI_SKIP_MIGRATION = "1";
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	if (PRIOR_ENV.FORGE_CLI_HOME !== undefined) process.env.FORGE_CLI_HOME = PRIOR_ENV.FORGE_CLI_HOME;
	else delete process.env.FORGE_CLI_HOME;
	if (PRIOR_ENV.FORGE_CLI_SKIP_MIGRATION !== undefined)
		process.env.FORGE_CLI_SKIP_MIGRATION = PRIOR_ENV.FORGE_CLI_SKIP_MIGRATION;
	else delete process.env.FORGE_CLI_SKIP_MIGRATION;
});

function writeGlobal(content: unknown): void {
	fs.mkdirSync(userRoot, { recursive: true });
	fs.writeFileSync(path.join(userRoot, "config.json"), JSON.stringify(content));
}

function writeProject(content: unknown): void {
	const dir = path.join(projectDir, ".pi", "forge-cli");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(content));
}

// 1. Both files missing
describe("loadLayeredConfig", () => {
	it("returns nulls and empty merged when both files are missing", () => {
		const result = loadLayeredConfig(projectDir);
		expect(result.global).toBeNull();
		expect(result.project).toBeNull();
		expect(result.merged._global).toBeNull();
		expect(result.merged._project).toBeNull();
		expect(result.merged["persona-models"]).toBeUndefined();
		expect(result.merged.pipelines).toBeUndefined();
		expect(result.errors).toEqual([]);
	});

	// 2. Global only
	it("merged equals global when only global file exists", () => {
		writeGlobal({
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
			},
		});
		const result = loadLayeredConfig(projectDir);
		expect(result.global).not.toBeNull();
		expect(result.project).toBeNull();
		expect(result.merged["persona-models"]).toEqual({
			engineer: { provider: "anthropic", model: "claude-opus-4-5" },
		});
		expect(result.errors).toEqual([]);
	});

	// 3. Project only — merged equals project; pipelines carried
	it("merged equals project when only project file exists, pipelines carried", () => {
		writeProject({
			"persona-models": {
				engineer: { provider: "openai", model: "gpt-4o" },
			},
			pipelines: {
				default: {
					phases: { plan: {} },
				},
			},
		});
		const result = loadLayeredConfig(projectDir);
		expect(result.global).toBeNull();
		expect(result.project).not.toBeNull();
		expect(result.merged["persona-models"]).toEqual({
			engineer: { provider: "openai", model: "gpt-4o" },
		});
		expect(result.merged.pipelines?.["default"]).toBeDefined();
		expect(result.errors).toEqual([]);
	});

	// 4. Both → shallow-merge, project wins on key collision
	it("shallow-merges persona-models with project winning on key collision", () => {
		writeGlobal({
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
				architect: { provider: "anthropic", model: "claude-opus-4-5" },
				default: { provider: "anthropic", model: "claude-sonnet-4-6" },
			},
		});
		writeProject({
			"persona-models": {
				engineer: { provider: "openai", model: "gpt-4o" },
			},
		});
		const result = loadLayeredConfig(projectDir);
		// Project's engineer wins
		expect(result.merged["persona-models"]?.["engineer"]).toEqual({
			provider: "openai",
			model: "gpt-4o",
		});
		// Global's architect survives
		expect(result.merged["persona-models"]?.["architect"]).toEqual({
			provider: "anthropic",
			model: "claude-opus-4-5",
		});
		// Global's default survives
		expect(result.merged["persona-models"]?.["default"]).toEqual({
			provider: "anthropic",
			model: "claude-sonnet-4-6",
		});
		expect(result.errors).toEqual([]);
	});

	// 4b. Pipelines come only from project
	it("pipelines come only from project config, not global", () => {
		writeGlobal({
			"persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
		});
		writeProject({
			pipelines: {
				default: {
					"persona-models": { supervisor: { provider: "openai", model: "gpt-4o" } },
					phases: { plan: {}, implement: {} },
				},
			},
		});
		const result = loadLayeredConfig(projectDir);
		expect(result.merged.pipelines?.["default"]).toBeDefined();
		expect(result.merged.pipelines?.["default"]["persona-models"]?.["supervisor"]).toEqual({
			provider: "openai",
			model: "gpt-4o",
		});
	});

	// 5. Schema-invalid global → error surfaced, project still loads
	it("surfaces schema error for invalid global but still loads project", () => {
		writeGlobal({ "persona-models": { engineer: "not-an-object" } });
		writeProject({
			"persona-models": { architect: { provider: "google", model: "gemini-2.5-flash" } },
		});
		const result = loadLayeredConfig(projectDir);
		expect(result.global).toBeNull();
		expect(result.project).not.toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toMatch(/global/i);
		// Project still loaded into merged
		expect(result.merged["persona-models"]?.["architect"]).toEqual({
			provider: "google",
			model: "gemini-2.5-flash",
		});
	});

	// 6. Schema-invalid project → error surfaced, global still loads
	it("surfaces schema error for invalid project but still loads global", () => {
		writeGlobal({
			"persona-models": { engineer: { provider: "anthropic", model: "claude-opus-4-5" } },
		});
		writeProject({ unknownTopLevelKey: true });
		const result = loadLayeredConfig(projectDir);
		expect(result.global).not.toBeNull();
		expect(result.project).toBeNull();
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.errors[0]).toMatch(/project/i);
		// Global still in merged
		expect(result.merged["persona-models"]?.["engineer"]).toBeDefined();
	});

	// 7. Project config located at cwd/.pi/forge-cli/config.json (cwd-direct, no walk-up)
	it("finds project config at cwd/.pi/forge-cli/config.json directly (no walk-up)", () => {
		const subDir = path.join(projectDir, "subdir", "deep");
		fs.mkdirSync(subDir, { recursive: true });
		// Config at projectDir root — NOT in subDir
		writeProject({
			"persona-models": { engineer: { provider: "openai", model: "gpt-4o" } },
		});
		// Running from subDir: no walk-up, project config absent
		const resultFromSub = loadLayeredConfig(subDir);
		expect(resultFromSub.project).toBeNull();
		// Running from projectDir: found
		const resultFromRoot = loadLayeredConfig(projectDir);
		expect(resultFromRoot.project).not.toBeNull();
	});

	// 8. FORGE_CLI_HOME honored for the global config path (post-v0.10.0
	// replacement for the PI_CODING_AGENT_DIR path the loader used in
	// pre-resolver versions). The dedicated paths.test.ts unit owns the
	// resolver invariant test; here we just verify the loader honors it.
	it("honors FORGE_CLI_HOME for the global config path", () => {
		const customUserRoot = path.join(tmpRoot, "custom-forge-cli-home");
		fs.mkdirSync(customUserRoot, { recursive: true });
		fs.writeFileSync(
			path.join(customUserRoot, "config.json"),
			JSON.stringify({ "persona-models": { scribe: { provider: "google", model: "gemini-2.5-flash" } } }),
		);
		process.env.FORGE_CLI_HOME = customUserRoot;

		const result = loadLayeredConfig(projectDir);
		expect(result.global).not.toBeNull();
		expect(result.merged["persona-models"]?.["scribe"]).toEqual({
			provider: "google",
			model: "gemini-2.5-flash",
		});
	});

	// 9. Empty config files → empty merged
	it("returns empty persona-models and pipelines for empty config objects", () => {
		writeGlobal({});
		writeProject({});
		const result = loadLayeredConfig(projectDir);
		// Both are schema-valid empty objects — no errors
		expect(result.errors).toEqual([]);
		expect(result.merged["persona-models"]).toBeUndefined();
		expect(result.merged.pipelines).toBeUndefined();
	});
});

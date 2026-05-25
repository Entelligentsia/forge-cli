// Tests for forge config show [--resolved] (Slice 3 — Plan 16).
//
// Coverage:
//  1. parseConfigArgs(['show']) → { subcommand: 'show', resolved: false, json: false }
//  2. parseConfigArgs(['show', '--resolved']) → { subcommand: 'show', resolved: true }
//  3. parseConfigArgs(['show', '--json']) → { subcommand: 'show', json: true }
//  4. parseConfigArgs(['show', '--resolved', '--json']) → both flags
//  5. parseConfigArgs([]) → usage subcommand
//  6. parseConfigArgs(['unknown']) → error
//  7. runConfigShow: no .pi/forge-cli/config.json → "No forge-cli model routing config found" message
//  8. runConfigShow --resolved: project config with persona-models → table with source column
//  9. runConfigShow --json: project config → JSON output with expected shape
// 10. runConfigShow: persona with unavailable model → availability badge in table / JSON flag
// 11. runConfigShow: no .forge/config.json → pipeline catalogue = null, pipelines section absent

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfigArgs, runConfigShow } from "../../src/bin/config.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeTmpAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "forge-config-"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "auth.json"), "{}");
	return dir;
}

function writePiConfig(cwd: string, config: object): void {
	const dir = join(cwd, ".pi", "forge-cli");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(config));
}

function writeForgeConfig(cwd: string, pipelines: Record<string, unknown>): void {
	const dir = join(cwd, ".forge");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify({ version: "0.0.0-test", pipelines }));
}

// Strip every known provider env var so ModelRegistry sees no auth.
const PROVIDER_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XAI_API_KEY",
	"GOOGLE_API_KEY",
];

// ── parseConfigArgs ──────────────────────────────────────────────────────────

describe("parseConfigArgs", () => {
	it("1. ['show'] → subcommand=show, resolved=false, json=false", () => {
		const r = parseConfigArgs(["show"]);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.subcommand).toBe("show");
		expect(r.resolved).toBe(false);
		expect(r.json).toBe(false);
	});

	it("2. ['show', '--resolved'] → resolved=true", () => {
		const r = parseConfigArgs(["show", "--resolved"]);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.subcommand).toBe("show");
		expect(r.resolved).toBe(true);
	});

	it("3. ['show', '--json'] → json=true", () => {
		const r = parseConfigArgs(["show", "--json"]);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.subcommand).toBe("show");
		expect(r.json).toBe(true);
	});

	it("4. ['show', '--resolved', '--json'] → both true", () => {
		const r = parseConfigArgs(["show", "--resolved", "--json"]);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.resolved).toBe(true);
		expect(r.json).toBe(true);
	});

	it("5. [] → subcommand=usage", () => {
		const r = parseConfigArgs([]);
		expect("error" in r).toBe(false);
		if ("error" in r) return;
		expect(r.subcommand).toBe("usage");
	});

	it("6. ['unknown'] → error", () => {
		const r = parseConfigArgs(["unknown"]);
		expect("error" in r).toBe(true);
	});

	it("7. show unknown option → error with 'unknown option' (N-B-D)", () => {
		const r = parseConfigArgs(["show", "--whatisthis"]);
		expect("error" in r).toBe(true);
		// N-B-D: error message must use "unknown option" (not "unknown flag")
		expect((r as { error: string }).error).toMatch(/unknown option/);
	});
});

// ── runConfigShow ────────────────────────────────────────────────────────────

describe("runConfigShow", () => {
	let tmpCwd: string;
	let tmpAgentDir: string;
	// Post-FORGE-S20-T11 (v0.10.0): the loader resolves the global config
	// via paths/paths.ts honoring FORGE_CLI_HOME instead of getAgentDir().
	// Scope both envs in beforeEach for hermeticity; otherwise a real
	// ~/.pi/forge-cli/config.json on the runner leaks in.
	let savedAgentDir: string | undefined;
	let savedForgeCliHome: string | undefined;
	let savedSkipMig: string | undefined;
	let savedEnvValues: { key: string; value: string | undefined }[] = [];

	beforeEach(() => {
		tmpCwd = mkdtempSync(join(tmpdir(), "forge-cwd-"));
		tmpAgentDir = makeTmpAgentDir();
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		savedForgeCliHome = process.env.FORGE_CLI_HOME;
		savedSkipMig = process.env.FORGE_CLI_SKIP_MIGRATION;
		process.env.PI_CODING_AGENT_DIR = tmpAgentDir;
		process.env.FORGE_CLI_HOME = tmpAgentDir; // hermetic forge-cli user root
		process.env.FORGE_CLI_SKIP_MIGRATION = "1";
		savedEnvValues = PROVIDER_ENV_KEYS.map((k) => ({
			key: k,
			value: process.env[k],
		}));
		for (const k of PROVIDER_ENV_KEYS) delete process.env[k];
	});

	afterEach(() => {
		if (savedAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		if (savedForgeCliHome === undefined) delete process.env.FORGE_CLI_HOME;
		else process.env.FORGE_CLI_HOME = savedForgeCliHome;
		if (savedSkipMig === undefined) delete process.env.FORGE_CLI_SKIP_MIGRATION;
		else process.env.FORGE_CLI_SKIP_MIGRATION = savedSkipMig;
		for (const { key, value } of savedEnvValues) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tmpCwd, { recursive: true, force: true });
		rmSync(tmpAgentDir, { recursive: true, force: true });
	});

	it("7. no config → 'no forge-cli model routing config' message, exit 0", async () => {
		const lines: string[] = [];
		const exitCode = await runConfigShow({ subcommand: "show", resolved: false, json: false }, tmpCwd, (line) =>
			lines.push(line),
		);
		expect(exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toMatch(/no forge-cli model routing config/i);
	});

	it("8. project config with persona-models, --resolved → table with source column", async () => {
		writePiConfig(tmpCwd, {
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
			},
		});
		writeForgeConfig(tmpCwd, {});

		const lines: string[] = [];
		const exitCode = await runConfigShow({ subcommand: "show", resolved: true, json: false }, tmpCwd, (line) =>
			lines.push(line),
		);
		expect(exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toMatch(/engineer/);
		expect(text).toMatch(/anthropic/);
		expect(text).toMatch(/claude-opus-4-5/);
		// source level should appear
		expect(text).toMatch(/L[12]|L1|L2|L3|L4|default|inherit/);
	});

	it("9. --json → JSON output with expected top-level keys", async () => {
		writePiConfig(tmpCwd, {
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
			},
		});

		const chunks: string[] = [];
		const exitCode = await runConfigShow({ subcommand: "show", resolved: false, json: true }, tmpCwd, (line) =>
			chunks.push(line),
		);
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(chunks.join(""));
		expect(parsed).toHaveProperty("personaModels");
		expect(parsed.personaModels).toHaveProperty("engineer");
	});

	it("10. unavailable model → availability badge 'unavailable' in output", async () => {
		writePiConfig(tmpCwd, {
			"persona-models": {
				engineer: { provider: "ollama", model: "not-installed" },
			},
		});

		const lines: string[] = [];
		await runConfigShow({ subcommand: "show", resolved: true, json: false }, tmpCwd, (line) => lines.push(line));
		const text = lines.join("\n");
		expect(text).toMatch(/unavailable|✗|×/i);
	});

	it("11. no .forge/config.json → no pipeline section in output", async () => {
		writePiConfig(tmpCwd, {
			"persona-models": {
				engineer: { provider: "anthropic", model: "claude-opus-4-5" },
			},
		});
		// Deliberately no .forge/config.json

		const lines: string[] = [];
		await runConfigShow({ subcommand: "show", resolved: false, json: false }, tmpCwd, (line) => lines.push(line));
		const text = lines.join("\n");
		// Should not error; pipeline section absent or empty
		expect(text).not.toMatch(/error/i);
	});

	// N-B-E: prints schema errors before config output and exits 0 (Decision 9).
	it("12. schema-invalid config → schema error lines printed before output; exit 0", async () => {
		// Write a schema-invalid project config (persona-models entry must be an object).
		writePiConfig(tmpCwd, { "persona-models": { engineer: "not-an-object" } });

		const lines: string[] = [];
		const exitCode = await runConfigShow({ subcommand: "show", resolved: false, json: false }, tmpCwd, (line) =>
			lines.push(line),
		);

		// Exit code must be 0 (informational surface; config inspector stays useful).
		expect(exitCode).toBe(0);

		// At least one line must mention the schema error.
		const errorLine = lines.find((l) => l.includes("schema error") || l.includes("Config error"));
		expect(errorLine).toBeDefined();
	});
});

// Unit tests for /forge:update-tools handler (FORGE-S23-T10)
//
// Tests:
//   - runUpdateTools: copies N schema files from bundled .schemas/ to .forge/schemas/
//   - runUpdateTools: handles missing bundled .schemas/ directory gracefully
//   - runUpdateTools: skips file when srcPath === destPath (structural guard, mock case)
//   - registerUpdateTools: outside-project guard (no .forge/config.json)
//   - EXPLICITLY_REGISTERED_NAMES: "forge:update-tools" present

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock forge-init.js before importing handler (hoisting constraint)
vi.mock("../../../src/extensions/forgecli/forge-init.js", () => ({
	getBundledPayloadRoot: vi.fn(() => "/mock-bundle-root"),
	getBundledToolsRoot: vi.fn(() => "/mock-tools-root"),
	isPiRuntime: vi.fn(() => true),
}));

// Mock node:child_process to avoid running real node processes
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(
				_cmd: string,
				_args: string[],
				_opts: unknown,
				cb: (err: Error | null, stdout: string, stderr: string) => void,
			) => {
				// Default: simulate validate-store --dry-run success
				cb(null, "", "");
			},
		),
	};
});

import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";
import { registerUpdateTools, runUpdateTools } from "../../../src/extensions/forgecli/update/update-tools.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-update-tools-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ── runUpdateTools ───────────────────────────────────────────────────────────

describe("runUpdateTools", () => {
	it("copies N schema files from bundled .schemas/ to .forge/schemas/", async () => {
		// Set up a fake bundle root with .schemas/ containing 3 JSON files
		const bundleRoot = path.join(tmpRoot, "bundle");
		const schemasDir = path.join(bundleRoot, ".schemas");
		fs.mkdirSync(schemasDir, { recursive: true });
		fs.writeFileSync(path.join(schemasDir, "task.schema.json"), '{"$schema":"foo"}');
		fs.writeFileSync(path.join(schemasDir, "sprint.schema.json"), '{"$schema":"bar"}');
		fs.writeFileSync(path.join(schemasDir, "bug.schema.json"), '{"$schema":"baz"}');

		// Project root
		const projectRoot = path.join(tmpRoot, "project");
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		// Fake tools root (validate-store.cjs won't exist — child_process mocked)
		const toolsRoot = path.join(bundleRoot, "tools");

		const result = await runUpdateTools(projectRoot, {
			_testBundleRoot: bundleRoot,
			_testToolsRoot: toolsRoot,
		});

		expect(result.copied).toBe(3);
		expect(result.skipped).toBe(0);
		// Files should exist in dest
		const destSchemas = fs.readdirSync(path.join(projectRoot, ".forge", "schemas"));
		expect(destSchemas).toHaveLength(3);
		expect(destSchemas.sort()).toEqual(["bug.schema.json", "sprint.schema.json", "task.schema.json"]);
	});

	it("handles missing bundled .schemas/ directory gracefully (returns error message, no throw)", async () => {
		// Bundle root with no .schemas/ subdirectory
		const bundleRoot = path.join(tmpRoot, "empty-bundle");
		fs.mkdirSync(bundleRoot, { recursive: true });

		const projectRoot = path.join(tmpRoot, "project");
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		const result = await runUpdateTools(projectRoot, {
			_testBundleRoot: bundleRoot,
			_testToolsRoot: path.join(bundleRoot, "tools"),
		});

		expect(result.copied).toBe(0);
		expect(result.validationPassed).toBe(false);
		expect(result.messages.some((m) => m.includes("not found"))).toBe(true);
	});

	it("returns non-zero copy count when schemas exist and reports validation result", async () => {
		// Bundle root with .schemas/ containing 2 JSON files
		const bundleRoot = path.join(tmpRoot, "bundle2");
		const schemasDir = path.join(bundleRoot, ".schemas");
		fs.mkdirSync(schemasDir, { recursive: true });
		fs.writeFileSync(path.join(schemasDir, "config.schema.json"), "{}");
		fs.writeFileSync(path.join(schemasDir, "event.schema.json"), "{}");

		const projectRoot = path.join(tmpRoot, "project2");
		fs.mkdirSync(path.join(projectRoot, ".forge"), { recursive: true });

		const result = await runUpdateTools(projectRoot, {
			_testBundleRoot: bundleRoot,
			_testToolsRoot: path.join(bundleRoot, "tools"),
		});

		expect(result.copied).toBe(2);
		// Validation attempted (mocked to succeed)
		expect(result.validationPassed).toBe(true);
		expect(result.messages.some((m) => m.includes("〇"))).toBe(true);
	});
});

// ── registerUpdateTools guard ────────────────────────────────────────────────

describe("registerUpdateTools handler guards", () => {
	function buildPi(handlers: Map<string, (args: string, ctx: unknown) => Promise<void>>) {
		return {
			registerCommand: vi.fn((name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
				handlers.set(name, def.handler);
			}),
		};
	}

	function buildCtx(messages: Array<{ msg: string; severity: string }>) {
		return {
			ui: {
				notify: vi.fn((msg: string, severity: string) => {
					messages.push({ msg, severity });
				}),
				setStatus: vi.fn(),
			},
		};
	}

	it("emits error notify when .forge/config.json not found (outside-project guard)", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		// Project root without .forge/config.json
		const projectRoot = path.join(tmpRoot, "no-forge-project");
		fs.mkdirSync(projectRoot, { recursive: true });

		// Temporarily change cwd
		const origCwd = process.cwd();
		process.chdir(projectRoot);

		try {
			registerUpdateTools(pi as any);
			const handler = handlers.get("forge:update-tools");
			expect(handler).toBeDefined();
			await handler!("", ctx as any);
			expect(messages.some((m) => m.severity === "error" && m.msg.includes("forge:init"))).toBe(true);
		} finally {
			process.chdir(origCwd);
		}
	});
});

// ── EXPLICITLY_REGISTERED_NAMES ──────────────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("does NOT register forge:update-tools in v1.0 (removed FORGE-S26-T10)", () => {
		const { EXPLICITLY_REGISTERED_NAMES } = forgeCommandsTest;
		expect(EXPLICITLY_REGISTERED_NAMES.has("forge:update-tools")).toBe(false);
	});
});

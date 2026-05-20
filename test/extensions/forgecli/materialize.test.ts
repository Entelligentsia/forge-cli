// Unit tests for /forge:materialize handler (FORGE-S23-T09)
//
// Tests:
//   - parseMaterializeArgs: all recognised arg forms
//   - registerMaterialize: guard paths (missing config, single-workflow mode)
//   - Mode-neutral invariant: handler never writes config.mode
//   - EXPLICITLY_REGISTERED_NAMES: "forge:materialize" present

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

// Mock child_process.spawn so tests don't actually run node processes
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: vi.fn(() => {
			const emitter = {
				stdout: {
					on: vi.fn(),
					pipe: vi.fn(),
				},
				stderr: {
					on: (_: string, cb: (d: Buffer) => void) => {
						// emit nothing
						void cb;
					},
				},
				on: vi.fn((event: string, cb: (code: number) => void) => {
					if (event === "close") setTimeout(() => cb(0), 0);
				}),
				kill: vi.fn(),
			};
			return emitter;
		}),
	};
});

import { parseMaterializeArgs, registerMaterialize } from "../../../src/extensions/forgecli/materialize.js";
import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";

// ── Tmp scaffolding ──────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "forgecli-materialize-"));
});

afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
	vi.clearAllMocks();
});

// ── parseMaterializeArgs ─────────────────────────────────────────────────────

describe("parseMaterializeArgs", () => {
	it("empty string → mode:all", () => {
		expect(parseMaterializeArgs("")).toEqual({ mode: "all" });
	});

	it("--all → mode:all", () => {
		expect(parseMaterializeArgs("--all")).toEqual({ mode: "all" });
	});

	it("workflows plan_task (space form) → mode:single-workflow", () => {
		expect(parseMaterializeArgs("workflows plan_task")).toEqual({
			mode: "single-workflow",
			workflowId: "plan_task",
		});
	});

	it("workflows:plan_task (colon form) → mode:single-workflow", () => {
		expect(parseMaterializeArgs("workflows:plan_task")).toEqual({
			mode: "single-workflow",
			workflowId: "plan_task",
		});
	});

	it("unrecognised args → mode:all (fail-open)", () => {
		expect(parseMaterializeArgs("--unknown-flag")).toEqual({ mode: "all" });
	});
});

// ── registerMaterialize guard paths ─────────────────────────────────────────

describe("registerMaterialize handler guards", () => {
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
			...overrides,
		};
	}

	it("single-workflow mode → notifies unsupported and returns without spawning", async () => {
		// Change cwd to tmpRoot (no config.json there)
		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMaterialize(pi as never);
			const handler = pi.getHandler("forge:materialize");
			expect(handler).toBeDefined();

			const ctx = buildCtx();
			await handler!("workflows plan_task", ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("single-workflow mode"),
				"info",
			);
			// spawn should NOT have been called
			const { spawn } = await import("node:child_process");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			process.chdir(origCwd);
		}
	});

	it("missing .forge/config.json → notifies error and returns without spawning", async () => {
		const origCwd = process.cwd();
		process.chdir(tmpRoot); // no config.json in tmpRoot
		try {
			const pi = buildPi();
			registerMaterialize(pi as never);
			const handler = pi.getHandler("forge:materialize");

			const ctx = buildCtx();
			await handler!("", ctx);

			expect(ctx.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("no .forge/config.json"),
				"error",
			);
			const { spawn } = await import("node:child_process");
			expect(spawn).not.toHaveBeenCalled();
		} finally {
			process.chdir(origCwd);
		}
	});

	it("mode-neutral: config.mode unchanged after successful run", async () => {
		// Scaffold a minimal .forge/config.json with mode:fast
		const forgeDir = path.join(tmpRoot, ".forge");
		const cacheDir = path.join(forgeDir, "cache");
		fs.mkdirSync(forgeDir, { recursive: true });
		fs.mkdirSync(cacheDir, { recursive: true });
		const config = { version: "1.0", mode: "fast", paths: { engineering: "engineering" } };
		fs.writeFileSync(path.join(forgeDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

		// Scaffold mock bundle tools directory structure
		// getBundledToolsRoot returns /mock-tools-root (mocked above)
		// getBundledPayloadRoot returns /mock-bundle-root (mocked above)
		// The handler checks fs.existsSync for the tools — we mock those to return false
		// so it skips tool execution gracefully (tools not found = short-circuit)

		const origCwd = process.cwd();
		process.chdir(tmpRoot);
		try {
			const pi = buildPi();
			registerMaterialize(pi as never);
			const handler = pi.getHandler("forge:materialize");

			const ctx = buildCtx();
			await handler!("--all", ctx);

			// Read config back — mode must still be "fast"
			const readBack = JSON.parse(fs.readFileSync(path.join(forgeDir, "config.json"), "utf8")) as {
				mode: string;
			};
			expect(readBack.mode).toBe("fast");
		} finally {
			process.chdir(origCwd);
		}
	});
});

// ── EXPLICITLY_REGISTERED_NAMES ─────────────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("includes forge:materialize", () => {
		const names = forgeCommandsTest.EXPLICITLY_REGISTERED_NAMES;
		expect(names.has("forge:materialize")).toBe(true);
	});
});

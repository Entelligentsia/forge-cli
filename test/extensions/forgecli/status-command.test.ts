// Unit tests for /forge:status v0 handler (FORGE-S23-T10)
//
// Tests:
//   - runStatus: active sprint present → formats task list and emits summary
//   - runStatus: no active sprint → emits "No active sprint found" message
//   - runStatus: store-cli error → emits error message gracefully
//   - registerStatusCommand: outside-project guard (null forgeRoot)
//   - EXPLICITLY_REGISTERED_NAMES: "forge:status" present

import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mock state (ESM-compatible, runs before imports) ─────────────────

const execFileMock = vi.hoisted(() => ({
	callCount: 0,
	responses: [] as Array<{ stdout: string; err?: Error }>,
}));

// Mock store-resolver to control resolveToolDir
vi.mock("../../../src/extensions/forgecli/store/store-resolver.js", () => ({
	resolveToolDir: vi.fn((forgeRoot: string) => path.join(forgeRoot, "tools")),
	ENTITY_TYPES: new Set(["task", "sprint", "bug", "feature"]),
	ID_PATTERNS: {},
	isDebug: vi.fn(() => false),
	runStoreCli: vi.fn(),
}));

// Mock node:child_process — callback form compatible with promisify
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFile: vi.fn(
			(
				_cmd: string,
				_args: string[],
				_opts: unknown,
				cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
			) => {
				const response = execFileMock.responses[execFileMock.callCount] ?? { stdout: '{"results":[]}' };
				execFileMock.callCount++;
				if (response.err) {
					cb(response.err, { stdout: "", stderr: response.err.message });
				} else {
					cb(null, { stdout: response.stdout, stderr: "" });
				}
			},
		),
	};
});

import { __test__ as forgeCommandsTest } from "../../../src/extensions/forgecli/forge-commands.js";
import { registerStatusCommand, runStatus } from "../../../src/extensions/forgecli/commands/status-command.js";

const FAKE_FORGE_ROOT = "/fake/forge";

beforeEach(() => {
	execFileMock.callCount = 0;
	execFileMock.responses = [];
	vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sprintListResponse(sprints: Array<{ id: string; status: string; title?: string }>): string {
	return JSON.stringify({ results: sprints });
}

function sprintTasksResponse(tasks: Array<{ id: string; status: string; title: string }>): string {
	return JSON.stringify({ results: tasks });
}

// ── runStatus ─────────────────────────────────────────────────────────────────

describe("runStatus", () => {
	it("active sprint present → output lines include sprint ID and task statuses", async () => {
		execFileMock.responses = [
			{
				stdout: sprintListResponse([
					{ id: "FORGE-S23", status: "active" },
					{ id: "FORGE-S22", status: "retrospective-done" },
				]),
			},
			{
				stdout: sprintTasksResponse([
					{ id: "FORGE-S23-T01", status: "committed", title: "Task one" },
					{ id: "FORGE-S23-T02", status: "in-progress", title: "Task two" },
				]),
			},
		];

		const result = await runStatus(FAKE_FORGE_ROOT, "/cwd");

		expect(result.hasActiveSprint).toBe(true);
		expect(result.lines.some((l) => l.includes("FORGE-S23"))).toBe(true);
		expect(result.lines.some((l) => l.includes("FORGE-S23-T01"))).toBe(true);
		expect(result.lines.some((l) => l.includes("committed"))).toBe(true);
		expect(result.lines.some((l) => l.includes("in-progress"))).toBe(true);
	});

	it("no active sprint → emits 'No active sprint found' message", async () => {
		execFileMock.responses = [
			{
				stdout: sprintListResponse([
					{ id: "FORGE-S20", status: "completed" },
					{ id: "FORGE-S21", status: "completed" },
				]),
			},
		];

		const result = await runStatus(FAKE_FORGE_ROOT, "/cwd");

		expect(result.hasActiveSprint).toBe(false);
		expect(result.lines.some((l) => l.includes("No active sprint"))).toBe(true);
	});

	it("store-cli error on list-sprints → returns error message, no throw", async () => {
		execFileMock.responses = [
			{ err: Object.assign(new Error("ENOENT"), { stderr: "store-cli not found" }), stdout: "" },
		];

		const result = await runStatus(FAKE_FORGE_ROOT, "/cwd");

		expect(result.hasActiveSprint).toBe(false);
		expect(result.lines.some((l) => l.startsWith("×"))).toBe(true);
	});
});

// ── registerStatusCommand guard ──────────────────────────────────────────────

describe("registerStatusCommand handler guards", () => {
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

	it("emits error notify when forgeRoot is null (outside-project guard)", async () => {
		const handlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
		const pi = buildPi(handlers);
		const messages: Array<{ msg: string; severity: string }> = [];
		const ctx = buildCtx(messages);

		registerStatusCommand(pi as any, { forgeRoot: null });
		const handler = handlers.get("forge:status");
		expect(handler).toBeDefined();
		await handler!("", ctx as any);
		expect(messages.some((m) => m.severity === "error" && m.msg.includes("forge:init"))).toBe(true);
	});
});

// ── EXPLICITLY_REGISTERED_NAMES ──────────────────────────────────────────────

describe("EXPLICITLY_REGISTERED_NAMES", () => {
	it("contains forge:status", () => {
		const { EXPLICITLY_REGISTERED_NAMES } = forgeCommandsTest;
		expect(EXPLICITLY_REGISTERED_NAMES.has("forge:status")).toBe(true);
	});
});

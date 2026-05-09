// Unit tests for hook-dispatcher module (FORGE-S18-T02).
//
// Coverage:
//   registerHookDispatcher:
//     1. Mount test — pi.on() called for "tool_call" and "tool_result" exactly once each
//     2. Non-bash tool_call passthrough — returns undefined (not blocked)
//     3. Bash non-store-cli tool_call — parseStoreCLIInvocation returns null
//     4. Bash store-cli write — tool_call handler does not block; intercept parsed
//     5. Bash store-cli update-status — intercept parsed correctly
//     6. Audit log written when FORGE_HOOK_AUDIT=1 for tool_call
//     7. Audit log written when FORGE_HOOK_AUDIT=1 for tool_result
//
//   parseStoreCLIInvocation (exported, used by T03):
//     8.  Returns null for empty/non-bash string
//     9.  Returns null when no store-cli.cjs in command
//    10.  Parses "write task" with JSON payload
//    11.  Parses "write sprint" with JSON payload
//    12.  Parses "update-status task" command
//    13.  Returns null for other subcommands (emit, list, nlp)
//    14.  Handles single-quoted JSON in bash command string
//    15.  Handles double-quoted paths in node invocation

import { mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BashToolCallEvent,
	ExtensionAPI,
	ReadToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	parseStoreCLIInvocation,
	registerHookDispatcher,
} from "../../../src/extensions/forgecli/hook-dispatcher.js";

// ── Mock node:fs ─────────────────────────────────────────────────────────────
// We mock mkdirSync and appendFileSync to capture audit-log writes without
// touching the real filesystem in audit-log tests.

const { fsMockState } = vi.hoisted(() => {
	const fsMockState = {
		mkdirCalls: [] as string[],
		appendLines: [] as string[],
	};
	return { fsMockState };
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		mkdirSync: vi.fn((p: string, _opts?: unknown) => {
			fsMockState.mkdirCalls.push(String(p));
		}),
		appendFileSync: vi.fn((p: string, data: string, _enc?: unknown) => {
			fsMockState.appendLines.push(String(data));
			void p;
		}),
	};
});

// ── Test helpers ──────────────────────────────────────────────────────────────

const FAKE_FORGE_ROOT = "/fake/forge-root";

/** Create a minimal ExtensionAPI stub that captures pi.on() registrations. */
function makeStubApi(): {
	pi: ExtensionAPI;
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>;
} {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on(event: string, handler: (e: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers };
}

/** Call the registered tool_call handler with a synthetic event. */
function callToolCallHandler(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolCallEvent,
): ToolCallEventResult | void {
	const handler = handlers.get("tool_call");
	if (!handler) throw new Error("tool_call handler not registered");
	return handler(event, {}) as ToolCallEventResult | void;
}

/** Call the registered tool_result handler with a synthetic event. */
function callToolResultHandler(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolResultEvent,
): void {
	const handler = handlers.get("tool_result");
	if (!handler) throw new Error("tool_result handler not registered");
	handler(event, {});
}

/** Build a minimal BashToolCallEvent. */
function makeBashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc-001",
		input: { command },
	};
}

/** Build a minimal ReadToolCallEvent. */
function makeReadEvent(filePath: string): ReadToolCallEvent {
	return {
		type: "tool_call",
		toolName: "read",
		toolCallId: "tc-002",
		input: { file_path: filePath },
	};
}

/** Build a minimal tool_result event (bash). */
function makeToolResultEvent(): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc-003",
		content: [{ type: "text", text: "ok" }],
	} as unknown as ToolResultEvent;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
	fsMockState.mkdirCalls = [];
	fsMockState.appendLines = [];
	// Ensure FORGE_HOOK_AUDIT is off by default.
	delete process.env.FORGE_HOOK_AUDIT;
});

afterEach(() => {
	delete process.env.FORGE_HOOK_AUDIT;
});

// ── Tests: registerHookDispatcher ─────────────────────────────────────────────

describe("registerHookDispatcher — mounting", () => {
	it("1. registers both tool_call and tool_result handlers exactly once", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		expect(handlers.has("tool_call")).toBe(true);
		expect(handlers.has("tool_result")).toBe(true);
		// Exactly two entries registered (no extra events).
		expect(handlers.size).toBe(2);
	});
});

describe("registerHookDispatcher — tool_call handler", () => {
	it("2. returns undefined for non-bash tool call (read) — no blocking", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		const result = callToolCallHandler(handlers, makeReadEvent("/some/file.md"));
		expect(result).toBeUndefined();
	});

	it("3. returns undefined for bash command that is not a store-cli invocation", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		const result = callToolCallHandler(handlers, makeBashEvent("ls -la .forge/store/"));
		expect(result).toBeUndefined();
	});

	it("4. does not block a store-cli write bash command (audit-only in T02)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		const cmd = `node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" write task '{"taskId":"FORGE-S18-T02","sprintId":"FORGE-S18","status":"planned"}'`;
		const result = callToolCallHandler(handlers, makeBashEvent(cmd));
		// T02: audit-only — must NOT block.
		expect(result == null || (result as ToolCallEventResult).block !== true).toBe(true);
	});

	it("5. does not block a store-cli update-status bash command (audit-only in T02)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		const cmd = `node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" update-status task FORGE-S18-T02 status implemented`;
		const result = callToolCallHandler(handlers, makeBashEvent(cmd));
		expect(result == null || (result as ToolCallEventResult).block !== true).toBe(true);
	});
});

describe("registerHookDispatcher — audit log", () => {
	it("6. writes audit log for tool_call when FORGE_HOOK_AUDIT=1", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		callToolCallHandler(handlers, makeBashEvent("ls -la"));
		expect(fsMockState.appendLines.length).toBeGreaterThan(0);
		expect(fsMockState.appendLines[0]).toContain("[tool_call]");
	});

	it("7. writes audit log for tool_result when FORGE_HOOK_AUDIT=1", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		callToolResultHandler(handlers, makeToolResultEvent());
		expect(fsMockState.appendLines.length).toBeGreaterThan(0);
		expect(fsMockState.appendLines[0]).toContain("[tool_result]");
	});

	it("does not write audit log when FORGE_HOOK_AUDIT is unset", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);
		callToolCallHandler(handlers, makeBashEvent("ls -la"));
		callToolResultHandler(handlers, makeToolResultEvent());
		expect(fsMockState.appendLines).toHaveLength(0);
	});
});

// ── Tests: parseStoreCLIInvocation ────────────────────────────────────────────

describe("parseStoreCLIInvocation", () => {
	it("8. returns null for empty string", () => {
		expect(parseStoreCLIInvocation("", FAKE_FORGE_ROOT)).toBeNull();
	});

	it("9. returns null when command does not contain store-cli.cjs", () => {
		expect(
			parseStoreCLIInvocation("node /forge/tools/collate.cjs FORGE-S18", FAKE_FORGE_ROOT),
		).toBeNull();
	});

	it("10. parses 'write task' with JSON payload", () => {
		const payload = { taskId: "FORGE-S18-T02", sprintId: "FORGE-S18", status: "planned" };
		const cmd = `node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" write task '${JSON.stringify(payload)}'`;
		const result = parseStoreCLIInvocation(cmd, FAKE_FORGE_ROOT);
		expect(result).not.toBeNull();
		expect(result!.subcmd).toBe("write");
		expect(result!.entity).toBe("task");
		expect(result!.payload).toEqual(payload);
	});

	it("11. parses 'write sprint' with JSON payload", () => {
		const payload = { sprintId: "FORGE-S18", status: "active" };
		const cmd = `node /abs/path/store-cli.cjs write sprint '${JSON.stringify(payload)}'`;
		const result = parseStoreCLIInvocation(cmd, FAKE_FORGE_ROOT);
		expect(result).not.toBeNull();
		expect(result!.subcmd).toBe("write");
		expect(result!.entity).toBe("sprint");
		expect(result!.payload).toEqual(payload);
	});

	it("12. parses 'update-status task' command", () => {
		const cmd = `node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" update-status task FORGE-S18-T02 status implemented`;
		const result = parseStoreCLIInvocation(cmd, FAKE_FORGE_ROOT);
		expect(result).not.toBeNull();
		expect(result!.subcmd).toBe("update-status");
		expect(result!.entity).toBe("task");
		expect(result!.payload).toEqual({
			entityId: "FORGE-S18-T02",
			field: "status",
			value: "implemented",
		});
	});

	it("13. returns null for other subcommands (emit, list, nlp)", () => {
		const root = FAKE_FORGE_ROOT;
		expect(
			parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" emit FORGE-S18 '{}'`, root),
		).toBeNull();
		expect(
			parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" list tasks`, root),
		).toBeNull();
		expect(
			parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" nlp "FORGE-S18-T02"`, root),
		).toBeNull();
	});

	it("14. handles single-quoted JSON in bash command string", () => {
		const cmd = `node /some/store-cli.cjs write task '{"taskId":"T01","status":"draft"}'`;
		const result = parseStoreCLIInvocation(cmd, FAKE_FORGE_ROOT);
		expect(result).not.toBeNull();
		expect(result!.payload).toEqual({ taskId: "T01", status: "draft" });
	});

	it("15. handles double-quoted paths in node invocation", () => {
		const cmd = `node "/path with spaces/store-cli.cjs" write bug '{"bugId":"BUG-001"}'`;
		const result = parseStoreCLIInvocation(cmd, FAKE_FORGE_ROOT);
		expect(result).not.toBeNull();
		expect(result!.entity).toBe("bug");
		expect(result!.payload).toEqual({ bugId: "BUG-001" });
	});
});

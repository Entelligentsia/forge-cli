// Unit tests for hook-dispatcher module (FORGE-S18-T02 + FORGE-S18-T03 + FORGE-S23-T02 + FORGE-S23-T03).
//
// Coverage:
//   registerHookDispatcher (T02):
//     1. Mount test — pi.on() called for "tool_call" and "tool_result" exactly once each
//     2. Non-bash tool_call passthrough — returns undefined (not blocked)
//     3. Bash non-store-cli tool_call — parseStoreCLIInvocation returns null
//     4. Bash store-cli write — tool_call handler does not block; intercept parsed
//     5. Bash store-cli update-status — intercept parsed correctly
//     6. Audit log written when FORGE_HOOK_AUDIT=1 for tool_call
//     7. Audit log written when FORGE_HOOK_AUDIT=1 for tool_result
//
//   parseStoreCLIInvocation (T02, exported, used by T03):
//     8.  Returns null for empty/non-bash string
//     9.  Returns null when no store-cli.cjs in command
//    10.  Parses "write task" with JSON payload
//    11.  Parses "write sprint" with JSON payload
//    12.  Parses "update-status task" command
//    13.  Returns null for other subcommands (emit, list, nlp)
//    14.  Handles single-quoted JSON in bash command string
//    15.  Handles double-quoted paths in node invocation
//
//   registerHookDispatcher — T03: enforcement (write validation)
//    16.  Bad write payload → { block: true, reason } (enforcement mode)
//    17.  Good write payload → undefined (allowed through)
//    18.  Bad write payload + FORGE_HOOK_AUDIT=1 → undefined (audit mode, not blocked)
//    19.  Audit mode logs decision=would-block with reason
//
//   registerHookDispatcher — T03: enforcement (transition guard)
//    20.  Illegal transition → { block: true, reason } with from/to named
//    21.  Legal transition → undefined (allowed)
//    22.  Illegal transition + --force → undefined (bypasses transition-guard)
//    23.  --force + bad payload → still blocked by store-validator
//    24.  Lookup failure → fail-open (allowed, decision=lookup-failed logged)
//
//   registerHookDispatcher — S23-T02: write-guard (FS-level schema guard)
//    25.  Write event targeting store path with bad payload → block: true
//    26.  Edit event targeting store path with bad payload → block: true
//    27.  Write event targeting store path with valid payload → undefined (allowed)
//    28.  Non-Forge-path Write → undefined (allowed)
//    29.  FORGE_SKIP_WRITE_VALIDATION=1 + bad payload → undefined (bypassed)
//
//   registerHookDispatcher — S23-T03: triage-error (Bash failure context injection)
//    30.  Bash tool_result isError=true + Forge-related command → ctx.ui.notify with "warning"
//    31.  Bash tool_result isError=true + non-Forge command → no notify
//    32.  Bash tool_result isError=false + Forge-related command → no notify

import { mkdirSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	BashToolCallEvent,
	EditToolCallEvent,
	ExtensionAPI,
	ReadToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseStoreCLIInvocation, registerHookDispatcher } from "../../../src/extensions/forgecli/hook-dispatcher.js";

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

// ── Mock store-validator and transition-guard (T03) ───────────────────────────

const { validatorMockState, guardMockState } = vi.hoisted(() => {
	return {
		validatorMockState: {
			ok: true as boolean,
			reason: "" as string,
		},
		guardMockState: {
			allowed: true as boolean,
			reason: "" as string,
		},
	};
});

vi.mock("../../../src/extensions/forgecli/store/store-validator.js", async () => {
	return {
		validateStoreCLIPayload: vi.fn((_entity: string, _payload: unknown, _forgeRoot: string) => ({
			ok: validatorMockState.ok,
			reason: validatorMockState.reason,
		})),
	};
});

vi.mock("../../../src/extensions/forgecli/store/transition-guard.js", async () => {
	return {
		checkTransition: vi.fn((_input: { entity: string; entityId: string; toStatus: string }, _forgeRoot: string) => ({
			allowed: guardMockState.allowed,
			reason: guardMockState.reason,
		})),
	};
});

// ── Mock write-guard (S23-T02) ────────────────────────────────────────────────
// The write-guard is a pure function — mock it at the module boundary so
// hook-dispatcher integration tests remain wiring tests, not schema tests.

const { writeGuardMockState } = vi.hoisted(() => {
	return {
		writeGuardMockState: {
			block: false as boolean,
			reason: "" as string,
		},
	};
});

vi.mock("../../../src/extensions/forgecli/hooks/write-guard.js", async () => {
	return {
		checkWriteGuard: vi.fn((_filePath: string, _contents: string, _forgeRoot: string) => ({
			block: writeGuardMockState.block,
			reason: writeGuardMockState.reason,
		})),
		applyPiEdits: vi.fn((_filePath: string, _edits: unknown[]) => ""),
		matchWriteRegistry: vi.fn(() => null),
		WRITE_REGISTRY: [],
	};
});

// ── Mock triage-error (S23-T03) ───────────────────────────────────────────────
// The triage-error helper is a pure module. We mock it at the boundary so
// hook-dispatcher integration tests stay focused on wiring, not pattern logic.

const { triageMockState } = vi.hoisted(() => {
	return {
		triageMockState: {
			isForgeRelated: true as boolean,
		},
	};
});

vi.mock("../../../src/extensions/forgecli/hooks/triage-error.js", async () => {
	return {
		isForgeRelated: vi.fn((_command: string) => triageMockState.isForgeRelated),
		buildTriageMessage: vi.fn(
			(_command: string, _snippet: string) =>
				"FORGE_ERROR_TRIAGE: A Forge command just failed. Would you like to file a bug? Run /forge:report-bug",
		),
		FORGE_PATTERNS: [],
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

/** Build a minimal WriteToolCallEvent (pi Write tool: path + content). */
function makeWriteEvent(filePath: string, content: string): WriteToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		toolCallId: "tc-write-001",
		input: { path: filePath, content },
	} as unknown as WriteToolCallEvent;
}

/** Build a minimal EditToolCallEvent (pi Edit tool: path + edits array). */
function makeEditEvent(filePath: string, edits: Array<{ oldText: string; newText: string }>): EditToolCallEvent {
	return {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "tc-edit-001",
		input: { path: filePath, edits },
	} as unknown as EditToolCallEvent;
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

/**
 * Build a minimal BashToolResultEvent with configurable isError and command.
 * Used for S23-T03 triage-error tests.
 */
function makeBashToolResultEvent(command: string, isError: boolean, output = ""): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "tc-triage-001",
		input: { command },
		isError,
		content: output ? [{ type: "text", text: output }] : [],
		details: undefined,
	} as unknown as ToolResultEvent;
}

/**
 * Call the registered tool_result handler with a spy ctx.
 * Returns the spy's notify calls.
 */
function callToolResultHandlerWithCtx(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolResultEvent,
): Array<{ message: string; type: string }> {
	const notifyCalls: Array<{ message: string; type: string }> = [];
	const ctx = {
		ui: {
			notify: (message: string, type?: string) => {
				notifyCalls.push({ message, type: type ?? "info" });
			},
		},
	};
	const handler = handlers.get("tool_result");
	if (!handler) throw new Error("tool_result handler not registered");
	handler(event, ctx);
	return notifyCalls;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
	fsMockState.mkdirCalls = [];
	fsMockState.appendLines = [];
	// Ensure FORGE_HOOK_AUDIT is off by default.
	delete process.env.FORGE_HOOK_AUDIT;
	// Ensure bypass is off by default.
	delete process.env.FORGE_SKIP_WRITE_VALIDATION;
	// Reset store-validator mock to "ok" by default.
	validatorMockState.ok = true;
	validatorMockState.reason = "";
	// Reset transition-guard mock to "allowed" by default.
	guardMockState.allowed = true;
	guardMockState.reason = "";
	// Reset write-guard mock to "allow" by default.
	writeGuardMockState.block = false;
	writeGuardMockState.reason = "";
	// Reset triage-error mock to "forge-related" by default.
	triageMockState.isForgeRelated = true;
});

afterEach(() => {
	delete process.env.FORGE_HOOK_AUDIT;
	delete process.env.FORGE_SKIP_WRITE_VALIDATION;
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
		expect(parseStoreCLIInvocation("node /forge/tools/collate.cjs FORGE-S18", FAKE_FORGE_ROOT)).toBeNull();
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
		expect(parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" emit FORGE-S18 '{}'`, root)).toBeNull();
		expect(parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" list tasks`, root)).toBeNull();
		expect(parseStoreCLIInvocation(`node "${root}/tools/store-cli.cjs" nlp "FORGE-S18-T02"`, root)).toBeNull();
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

// ── T03: Enforcement — write validation ───────────────────────────────────────

describe("registerHookDispatcher — T03 enforcement: write validation", () => {
	const writeCmd = (entity: string, payload: object) =>
		`node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" write ${entity} '${JSON.stringify(payload)}'`;

	it("16. bad write payload → { block: true, reason } in enforcement mode", () => {
		validatorMockState.ok = false;
		validatorMockState.reason = "missing required field: taskId";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeBashEvent(writeCmd("task", { sprintId: "FORGE-S18" })));

		expect(result).toBeDefined();
		expect((result as ToolCallEventResult).block).toBe(true);
		expect((result as ToolCallEventResult).reason).toBe("missing required field: taskId");
	});

	it("17. good write payload → undefined (allowed through)", () => {
		validatorMockState.ok = true;
		validatorMockState.reason = "";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(
			handlers,
			makeBashEvent(
				writeCmd("task", {
					taskId: "FORGE-S18-T03",
					sprintId: "FORGE-S18",
					status: "planned",
				}),
			),
		);

		expect(result).toBeUndefined();
	});

	it("18. bad write payload + FORGE_HOOK_AUDIT=1 → undefined (not blocked in audit mode)", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		validatorMockState.ok = false;
		validatorMockState.reason = "bad payload";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeBashEvent(writeCmd("task", { bad: "data" })));

		expect(result).toBeUndefined();
	});

	it("19. audit mode logs decision=would-block with reason", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		validatorMockState.ok = false;
		validatorMockState.reason = "missing taskId";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		callToolCallHandler(handlers, makeBashEvent(writeCmd("task", {})));

		const auditLine = fsMockState.appendLines.find((l) => l.includes("decision=would-block"));
		expect(auditLine).toBeDefined();
		expect(auditLine).toContain("reason=missing taskId");
	});
});

// ── T03: Enforcement — transition guard ───────────────────────────────────────

describe("registerHookDispatcher — T03 enforcement: transition guard", () => {
	const updateCmd = (entity: string, entityId: string, value: string, force = false) =>
		`node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" update-status ${entity} ${entityId} status ${value}${force ? " --force" : ""}`;

	it("20. illegal transition → { block: true, reason } with from/to named", () => {
		guardMockState.allowed = false;
		guardMockState.reason =
			"draft → committed is not a legal transition for task. Legal next states from draft: planned.";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeBashEvent(updateCmd("task", "FORGE-S18-T03", "committed")));

		expect(result).toBeDefined();
		expect((result as ToolCallEventResult).block).toBe(true);
		expect((result as ToolCallEventResult).reason).toContain("draft → committed");
		expect((result as ToolCallEventResult).reason).toContain("planned");
	});

	it("21. legal transition → undefined (allowed through)", () => {
		guardMockState.allowed = true;
		guardMockState.reason = "";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeBashEvent(updateCmd("task", "FORGE-S18-T03", "planned")));

		expect(result).toBeUndefined();
	});

	it("22. illegal transition + --force → undefined (transition-guard bypassed)", () => {
		// Guard would block, but --force should bypass it.
		guardMockState.allowed = false;
		guardMockState.reason = "draft → committed not allowed";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		// --force in the command.
		const result = callToolCallHandler(
			handlers,
			makeBashEvent(updateCmd("task", "FORGE-S18-T03", "committed", true)),
		);

		// --force bypasses transition-guard, so no block.
		expect(result).toBeUndefined();
	});

	it("23. --force + bad write payload → still blocked by store-validator", () => {
		// For a WRITE command (not update-status), --force must not bypass store-validator.
		validatorMockState.ok = false;
		validatorMockState.reason = "malformed payload";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		// Write command with --force appended.
		const cmd = `node "${FAKE_FORGE_ROOT}/tools/store-cli.cjs" write task '{}' --force`;
		const result = callToolCallHandler(handlers, makeBashEvent(cmd));

		// store-validator still runs even with --force.
		expect(result).toBeDefined();
		expect((result as ToolCallEventResult).block).toBe(true);
		expect((result as ToolCallEventResult).reason).toBe("malformed payload");
	});

	it("24. lookup failure → fail-open (allowed), decision=lookup-failed audit-logged", () => {
		// Guard returns lookup-failed — must never block.
		guardMockState.allowed = true;
		guardMockState.reason = "lookup-failed";

		process.env.FORGE_HOOK_AUDIT = "1";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeBashEvent(updateCmd("task", "FORGE-S18-T03", "planned")));

		// Fail-open: must not block.
		expect(result).toBeUndefined();

		// Audit line must contain decision=lookup-failed.
		const auditLine = fsMockState.appendLines.find((l) => l.includes("decision=lookup-failed"));
		expect(auditLine).toBeDefined();
	});
});

// ── Tests: write-guard integration (S23-T02) ──────────────────────────────────

describe("registerHookDispatcher — write-guard FS-level schema guard (S23-T02)", () => {
	it("25. Write event targeting store path with bad payload → block: true", () => {
		writeGuardMockState.block = true;
		writeGuardMockState.reason = "❌ Forge schema violation — taskId: missing required field";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(
			handlers,
			makeWriteEvent("/project/.forge/store/tasks/T01.json", '{"bad":"payload"}'),
		);

		expect(result).toBeDefined();
		expect((result as ToolCallEventResult).block).toBe(true);
		expect((result as ToolCallEventResult).reason).toContain("schema violation");
	});

	it("26. Edit event targeting store path with bad payload → block: true", () => {
		writeGuardMockState.block = true;
		writeGuardMockState.reason = "❌ Forge schema violation — taskId: missing required field";

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(
			handlers,
			makeEditEvent("/project/.forge/store/tasks/T01.json", [{ oldText: "foo", newText: "bar" }]),
		);

		expect(result).toBeDefined();
		expect((result as ToolCallEventResult).block).toBe(true);
	});

	it("27. Write event targeting store path with valid payload → undefined (allowed)", () => {
		// write-guard default: block=false
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const validTask = JSON.stringify({
			taskId: "FORGE-S23-T02",
			sprintId: "FORGE-S23",
			title: "Test",
			status: "draft",
			path: "foo",
		});
		const result = callToolCallHandler(handlers, makeWriteEvent("/project/.forge/store/tasks/T02.json", validTask));

		expect(result).toBeUndefined();
	});

	it("28. Non-Forge-path Write → undefined (allowed, write-guard returns block:false)", () => {
		// write-guard default: block=false (non-Forge path returns immediately)
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(handlers, makeWriteEvent("/tmp/unrelated.json", '{"anything":true}'));

		expect(result).toBeUndefined();
	});

	it("29. FORGE_SKIP_WRITE_VALIDATION=1 + bad payload → undefined (write-guard bypassed)", () => {
		process.env.FORGE_SKIP_WRITE_VALIDATION = "1";
		// The write-guard mock still returns block:false when the env var is set
		// (the real write-guard handles the bypass internally; mock does too via default)
		writeGuardMockState.block = false; // mock simulates bypass behavior

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const result = callToolCallHandler(
			handlers,
			makeWriteEvent("/project/.forge/store/tasks/T03.json", '{"bad":"payload"}'),
		);

		expect(result).toBeUndefined();
	});
});

// ── S23-T03: triage-error Bash failure context injection ──────────────────────

describe("registerHookDispatcher — S23-T03 triage-error: Bash failure context injection", () => {
	it("30. Bash tool_result isError=true + Forge-related command → ctx.ui.notify with 'warning'", () => {
		triageMockState.isForgeRelated = true;

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const notifyCalls = callToolResultHandlerWithCtx(
			handlers,
			makeBashToolResultEvent("node .forge/tools/store-cli.cjs list tasks", true, "Error: ENOENT"),
		);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].type).toBe("warning");
		expect(notifyCalls[0].message).toContain("FORGE_ERROR_TRIAGE");
	});

	it("31. Bash tool_result isError=true + non-Forge command → no notify", () => {
		triageMockState.isForgeRelated = false;

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const notifyCalls = callToolResultHandlerWithCtx(
			handlers,
			makeBashToolResultEvent("npm install", true, "error: ENOENT"),
		);

		expect(notifyCalls).toHaveLength(0);
	});

	it("32. Bash tool_result isError=false + Forge-related command → no notify", () => {
		triageMockState.isForgeRelated = true;

		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, FAKE_FORGE_ROOT);

		const notifyCalls = callToolResultHandlerWithCtx(
			handlers,
			makeBashToolResultEvent("node .forge/tools/store-cli.cjs list tasks", false, "task1\ntask2"),
		);

		expect(notifyCalls).toHaveLength(0);
	});
});

// FORGE-S25-T27: regression — SYNTHETIC_EVENT_TYPES re-export from hook-dispatcher
describe("hook-dispatcher / SYNTHETIC_EVENT_TYPES catalog re-export (T27 regression)", () => {
	it("SYNTHETIC_EVENT_TYPES re-export is non-empty and contains init-complete", async () => {
		const { SYNTHETIC_EVENT_TYPES } = await import("../../../src/extensions/forgecli/hook-dispatcher.js");
		expect(Array.isArray(SYNTHETIC_EVENT_TYPES)).toBe(true);
		expect(SYNTHETIC_EVENT_TYPES.length).toBeGreaterThan(0);
		expect(SYNTHETIC_EVENT_TYPES).toContain("init-complete");
		expect(SYNTHETIC_EVENT_TYPES).toContain("sprint-collate-complete");
		expect(SYNTHETIC_EVENT_TYPES).toContain("migration-applied");
	});
});

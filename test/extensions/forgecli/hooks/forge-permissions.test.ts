// Tests for the forge-permissions pattern registry — FORGE-S23-T04.
//
// Coverage:
//   matchForgePermission (pure function):
//     1. bash: node tool invocation → allowed
//     2. bash: mkdir -p → allowed
//     3. bash: git commit → allowed
//     4. write: .forge/ path → allowed
//     5. write: engineering/ path → allowed
//     6. bash: unrecognised command → null (falls through)
//     7. bash: node -e exclusion → null (security: arbitrary code not auto-approved)
//
//   hook-dispatcher integration (AC#4 + AC#5 wiring):
//     A. Bash with node-tool pattern → return undefined (not blocked)
//     B. Bash with mkdir pattern → return undefined (not blocked)
//     C. Bash with git-commit pattern → return undefined (not blocked)
//     D. Write to non-Forge path (src/index.ts) → falls through (not matched)
//     E. Write to .forge/store/ (matched) with invalid schema → still blocked (AC#4)
//     F. Write to forge/forge/meta/ (NOT matched by WRITE_PATTERNS) → blocked by two-layer-guard

import * as path from "node:path";
import type {
	BashToolCallEvent,
	EditToolCallEvent,
	ExtensionAPI,
	ToolCallEvent,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHookDispatcher } from "../../../../src/extensions/forgecli/hook-dispatcher.js";
import { matchForgePermission } from "../../../../src/extensions/forgecli/hooks/forge-permissions.js";

// ── Mock node:fs ──────────────────────────────────────────────────────────────

const { fsMockState, writeGuardMock } = vi.hoisted(() => {
	const fsMockState = {
		appendLines: [] as string[],
	};
	const writeGuardMock = {
		checkWriteGuard: vi.fn(() => ({ block: false as boolean, reason: undefined as string | undefined })),
		applyPiEdits: vi.fn(() => ""),
	};
	return { fsMockState, writeGuardMock };
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn((_p: string, data: string) => {
			fsMockState.appendLines.push(String(data));
		}),
		readFileSync: vi.fn(() => "not valid json"),
		existsSync: vi.fn(() => false),
	};
});

// store-validator: returns ok=true by default
vi.mock("../../../../src/extensions/forgecli/store-validator.js", () => ({
	validateStoreCLIPayload: vi.fn(() => ({ ok: true, reason: "" })),
}));

vi.mock("../../../../src/extensions/forgecli/transition-guard.js", () => ({
	checkTransition: vi.fn(() => ({ allowed: true, reason: "" })),
}));

// write-guard: hoisted mock; test E will override checkWriteGuard return value
vi.mock("../../../../src/extensions/forgecli/hooks/write-guard.js", () => writeGuardMock);

// ── Helpers ────────────────────────────────────────────────────────────────────

const CWD = "/repo";

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

function callToolCall(
	handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
	event: ToolCallEvent,
): ToolCallEventResult | void {
	const handler = handlers.get("tool_call");
	if (!handler) throw new Error("tool_call handler not registered");
	return handler(event, {}) as ToolCallEventResult | void;
}

function makeBashEvent(command: string): BashToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "tc-b-001",
		input: { command },
	} as BashToolCallEvent;
}

function makeWriteEvent(filePath: string, content = ""): WriteToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		toolCallId: "tc-w-001",
		input: { path: filePath, content },
	} as WriteToolCallEvent;
}

function makeEditEvent(filePath: string): EditToolCallEvent {
	return {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "tc-e-001",
		input: { path: filePath, edits: [] },
	} as EditToolCallEvent;
}

// ── Pure-function tests: matchForgePermission ──────────────────────────────────

describe("matchForgePermission — pure function", () => {
	it("1. bash: node tool invocation → matched", () => {
		const rule = matchForgePermission("bash", {
			command: "node /home/user/.forge/tools/store-cli.cjs write task '{}'",
		});
		expect(rule).not.toBeNull();
		expect(rule).toContain("tools");
	});

	it("2. bash: mkdir -p → matched", () => {
		const rule = matchForgePermission("bash", { command: "mkdir -p .forge/store/tasks" });
		expect(rule).not.toBeNull();
	});

	it("3. bash: git commit → matched", () => {
		const rule = matchForgePermission("bash", { command: 'git commit -m "fix: foo"' });
		expect(rule).not.toBeNull();
	});

	it("4. write: .forge/ path → matched", () => {
		const rule = matchForgePermission("write", { path: ".forge/store/tasks/T01.json" });
		expect(rule).not.toBeNull();
	});

	it("5. write: engineering/ path → matched", () => {
		const rule = matchForgePermission("write", { path: "engineering/sprints/S01/PLAN.md" });
		expect(rule).not.toBeNull();
	});

	it("6. bash: unrecognised command → null", () => {
		const rule = matchForgePermission("bash", { command: "rm -rf /" });
		expect(rule).toBeNull();
	});

	it("7. bash: node -e exclusion → null (security: arbitrary code not auto-approved)", () => {
		// node -e is deliberately excluded from BASH_PATTERNS in the plugin and this port.
		const rule = matchForgePermission("bash", { command: 'node -e "require(\'os\').platform()"' });
		expect(rule).toBeNull();
	});

	it("returns null for unknown tool name", () => {
		const rule = matchForgePermission("webfetch", { url: "https://example.com" });
		expect(rule).toBeNull();
	});

	it("returns null when toolInput has no command field (bash)", () => {
		const rule = matchForgePermission("bash", {});
		expect(rule).toBeNull();
	});
});

// ── Integration tests: hook-dispatcher wiring ──────────────────────────────────

describe("registerHookDispatcher — forge-permissions wiring (AC#4 + AC#5)", () => {
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

	beforeEach(() => {
		fsMockState.appendLines = [];
		delete process.env.FORGE_HOOK_AUDIT;
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(CWD);
		// Reset write-guard to allow by default
		writeGuardMock.checkWriteGuard.mockReturnValue({ block: false });
		writeGuardMock.applyPiEdits.mockReturnValue("");
	});

	afterEach(() => {
		cwdSpy?.mockRestore();
		delete process.env.FORGE_HOOK_AUDIT;
		vi.clearAllMocks();
	});

	it("A. Bash with node-tool pattern (non-store-cli) → return undefined (not blocked)", () => {
		// store-cli.cjs commands are excluded from forge-permissions matching so that
		// store-validator schema validation still runs on them. This test uses a different
		// node tool invocation to exercise the BASH_PATTERNS match.
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(
			handlers,
			makeBashEvent("node /home/x/.forge/tools/build-manifest.cjs"),
		);
		expect(result).toBeUndefined();
	});

	it("B. Bash with mkdir pattern → return undefined (not blocked)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeBashEvent("mkdir -p .forge/store/tasks"));
		expect(result).toBeUndefined();
	});

	it("C. Bash with git-commit pattern → return undefined (not blocked)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeBashEvent('git commit -m "sprint: done"'));
		expect(result).toBeUndefined();
	});

	it("D. Write to non-Forge path falls through (not matched, two-layer and write-guard both allow)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		// src/index.ts is not in WRITE_PATTERNS and not under forge/forge/meta/
		const result = callToolCall(handlers, makeWriteEvent("src/index.ts", "export {};\n"));
		expect(result).toBeUndefined();
		// No forge-permissions log
		const audit = fsMockState.appendLines.join("\n");
		expect(audit).not.toContain("[forge-permissions]");
	});

	it("E. Write to .forge/store/ (forge-permissions matched) with invalid schema → still blocked (AC#4)", () => {
		// Configure write-guard to simulate schema violation for this test
		writeGuardMock.checkWriteGuard.mockReturnValue({
			block: true,
			reason: "schema violation: missing required field taskId",
		});
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		// .forge/store/tasks/ is matched by WRITE_PATTERNS (/^\.forge\//)
		const result = callToolCall(
			handlers,
			makeWriteEvent(".forge/store/tasks/FORGE-S23-T04.json", '{"bad":"data"}'),
		);
		// Must be blocked by write-guard despite permission match (AC#4)
		expect(result).toBeDefined();
		const blocked = result as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("schema violation");
		// Also verify: write-guard WAS called (forge-permissions skip only skips two-layer-guard)
		expect(writeGuardMock.checkWriteGuard).toHaveBeenCalled();
	});

	it("F. Write to forge/forge/meta/ (NOT matched by WRITE_PATTERNS) → blocked by two-layer-guard", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeWriteEvent("forge/forge/meta/personas/meta-engineer.md"));
		expect(result).toBeDefined();
		const blocked = result as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("forge-cli runtime cannot write to forge/forge/meta/");
	});

	it("audit mode (FORGE_HOOK_AUDIT=1): forge-permissions allows bash even if auditing", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeBashEvent("mkdir -p .forge/store"));
		// Forge-permissions allow is not conditional on audit mode — it always returns undefined for matched bash
		expect(result).toBeUndefined();
		const audit = fsMockState.appendLines.join("\n");
		expect(audit).toContain("[forge-permissions]");
	});
});

// Tests for the two-layer boundary guard — FORGE-S20-T07.
//
// Coverage:
//   checkTwoLayerBoundary (pure function):
//     1. Direct path under forge/forge/meta/ → rejected
//     2. Absolute path under forge/forge/meta/ → rejected
//     3. `..` traversal landing inside meta → rejected
//     4. Sibling path (forge/forge/tools/) → allowed
//     5. Substring-but-not-prefix sibling (forge/forge/meta-archive/) → allowed
//     6. Error message format includes resolved path + canonical reason
//
//   registerHookDispatcher integration:
//     7. write tool call to meta path → blocked
//     8. edit tool call to meta path → blocked
//     9. read tool call to meta path → not intercepted (passes through)
//    10. FORGE_HOOK_AUDIT=1: write to meta logs but does not block

import * as path from "node:path";
import type {
	EditToolCallEvent,
	ExtensionAPI,
	ReadToolCallEvent,
	ToolCallEvent,
	ToolCallEventResult,
	WriteToolCallEvent,
} from "@entelligentsia/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerHookDispatcher } from "../../../../src/extensions/forgecli/hook-dispatcher.js";
import { checkTwoLayerBoundary } from "../../../../src/extensions/forgecli/hooks/two-layer-guard.js";

// ── Mock node:fs (capture audit-log writes) ──────────────────────────────────

const { fsMockState } = vi.hoisted(() => {
	const fsMockState = {
		appendLines: [] as string[],
	};
	return { fsMockState };
});

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:fs")>();
	return {
		...original,
		mkdirSync: vi.fn(),
		appendFileSync: vi.fn((_p: string, data: string) => {
			fsMockState.appendLines.push(String(data));
		}),
	};
});

// store-validator and transition-guard are not exercised by these tests, but
// hook-dispatcher imports them — stub to no-op so the module loads cleanly.
vi.mock("../../../../src/extensions/forgecli/store-validator.js", () => ({
	validateStoreCLIPayload: vi.fn(() => ({ ok: true, reason: "" })),
}));
vi.mock("../../../../src/extensions/forgecli/transition-guard.js", () => ({
	checkTransition: vi.fn(() => ({ allowed: true, reason: "" })),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

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

function makeWriteEvent(filePath: string): WriteToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		toolCallId: "tc-w-001",
		input: { path: filePath, content: "x" },
	} as WriteToolCallEvent;
}

function makeEditEvent(filePath: string): EditToolCallEvent {
	return {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "tc-e-001",
		input: { path: filePath, edits: [{ oldText: "a", newText: "b" }] },
	} as EditToolCallEvent;
}

function makeReadEvent(filePath: string): ReadToolCallEvent {
	return {
		type: "tool_call",
		toolName: "read",
		toolCallId: "tc-r-001",
		input: { file_path: filePath },
	} as ReadToolCallEvent;
}

// ── Pure-function tests: checkTwoLayerBoundary ──────────────────────────────

describe("checkTwoLayerBoundary", () => {
	it("1. rejects a direct relative path under forge/forge/meta/", () => {
		const v = checkTwoLayerBoundary("forge/forge/meta/personas/meta-engineer.md", CWD);
		expect(v.allowed).toBe(false);
		expect(v.reason).toBeDefined();
		expect(v.resolvedPath).toBe(path.resolve(CWD, "forge/forge/meta/personas/meta-engineer.md"));
	});

	it("2. rejects an absolute path under forge/forge/meta/", () => {
		const abs = path.resolve(CWD, "forge", "forge", "meta", "skills", "meta-x.md");
		const v = checkTwoLayerBoundary(abs, CWD);
		expect(v.allowed).toBe(false);
		expect(v.resolvedPath).toBe(abs);
	});

	it("3. rejects a `..` traversal that lands inside meta", () => {
		// Resolve from forge/forge/tools/ back into forge/forge/meta/y.md.
		const v = checkTwoLayerBoundary("forge/forge/tools/../meta/y.md", CWD);
		expect(v.allowed).toBe(false);
		expect(v.resolvedPath).toBe(path.resolve(CWD, "forge/forge/meta/y.md"));
		expect(v.resolvedPath).not.toContain("..");
	});

	it("4. allows a sibling path (forge/forge/tools/...)", () => {
		const v = checkTwoLayerBoundary("forge/forge/tools/build-manifest.cjs", CWD);
		expect(v.allowed).toBe(true);
		expect(v.reason).toBeUndefined();
	});

	it("5. allows substring-but-not-prefix sibling (forge/forge/meta-archive/)", () => {
		// Without the trailing-sep guard, this would be a false positive.
		const v = checkTwoLayerBoundary("forge/forge/meta-archive/x.md", CWD);
		expect(v.allowed).toBe(true);
	});

	it("6. error message contains canonical reason and the resolved path", () => {
		const v = checkTwoLayerBoundary("forge/forge/meta/x.md", CWD);
		expect(v.allowed).toBe(false);
		expect(v.reason).toContain("forge-cli runtime cannot write to forge/forge/meta/");
		expect(v.reason).toContain("forge-engineer/forge-bugfixer");
		expect(v.reason).toContain(`(resolved: ${v.resolvedPath})`);
	});
});

// ── Integration tests: registerHookDispatcher wiring ────────────────────────

describe("registerHookDispatcher — two-layer guard wiring", () => {
	let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

	beforeEach(() => {
		fsMockState.appendLines = [];
		delete process.env.FORGE_HOOK_AUDIT;
		// Pin process.cwd() to CWD so the guard's prefix matches our test paths.
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(CWD);
	});

	afterEach(() => {
		cwdSpy?.mockRestore();
		delete process.env.FORGE_HOOK_AUDIT;
	});

	it("7. blocks a write tool call whose path resolves under forge/forge/meta/", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeWriteEvent("forge/forge/meta/personas/meta-engineer.md"));
		expect(result).toBeDefined();
		const blocked = result as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("forge-cli runtime cannot write to forge/forge/meta/");
	});

	it("8. blocks an edit tool call whose path resolves under forge/forge/meta/", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeEditEvent("forge/forge/meta/skills/meta-x.md"));
		expect(result).toBeDefined();
		const blocked = result as { block: boolean; reason: string };
		expect(blocked.block).toBe(true);
		expect(blocked.reason).toContain("forge-engineer/forge-bugfixer");
	});

	it("9. does NOT intercept a read tool call (read is allowed)", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		// Even though the path is under meta, reads are not subject to the guard.
		const result = callToolCall(handlers, makeReadEvent("forge/forge/meta/personas/meta-engineer.md"));
		expect(result).toBeUndefined();
	});

	it("10. audit mode (FORGE_HOOK_AUDIT=1) logs would-block but does not block", () => {
		process.env.FORGE_HOOK_AUDIT = "1";
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeWriteEvent("forge/forge/meta/x.md"));
		// In audit mode, the handler returns undefined (does not block).
		expect(result).toBeUndefined();
		// And the would-block decision was logged.
		const audit = fsMockState.appendLines.join("\n");
		expect(audit).toContain("[two-layer-guard] decision=would-block");
		expect(audit).toContain(path.resolve(CWD, "forge/forge/meta/x.md"));
	});

	it("allows a write to a sibling (forge/forge/tools/) — no block, no audit line", () => {
		const { pi, handlers } = makeStubApi();
		registerHookDispatcher(pi, "/fake/forge-root");
		const result = callToolCall(handlers, makeWriteEvent("forge/forge/tools/new.cjs"));
		expect(result).toBeUndefined();
		const audit = fsMockState.appendLines.join("\n");
		// No two-layer-guard log line should fire on the allow path.
		expect(audit).not.toContain("[two-layer-guard]");
	});
});

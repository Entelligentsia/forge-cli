/**
 * Spike R4 — vitest spec.
 *
 * FORGE-S15-T07 — Discharges architectural-review.md §R4 (permission
 * semantics). Two surfaces, four specs:
 *
 *   AC1 shape (auth-free, MUST PASS) — direct invocation of the captured
 *   `tool_call` handler against synthetic Write/Edit events plus negative
 *   cases (bash and write-to-non-store-path).
 *
 *   AC1 live (auth-gated, `describe.skipIf(SKIP)`) — drives a real
 *   AgentSession, prompts the model to write under .forge/store/, asserts the
 *   tool result reflects the block reason.
 *
 *   AC2 true / AC2 false (auth-free, MUST PASS) — direct invocation of the
 *   captured command handler with a stub `ExtensionCommandContext` whose
 *   `ui.confirm` returns true / false, asserts both branches.
 */

import path from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type EditToolCallEvent,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionFactory,
	type ExtensionUIContext,
	getAgentDir,
	type RegisteredCommand,
	SessionManager,
	type ToolCallEvent,
	type WriteToolCallEvent,
} from "@mariozechner/pi-coding-agent";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getCaptured, getEvidence, registerSpikeR4, resetEvidence } from "./spike.js";

const SKIP = !process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Stub ExtensionAPI — captures (event, handler) and (name, def) registrations.
// Only fields actually consumed by registerSpikeR4 are implemented.
// ---------------------------------------------------------------------------

interface StubAPIRecord {
	on: Array<{ event: string; handler: unknown }>;
	commands: Array<{ name: string; def: Omit<RegisteredCommand, "name" | "sourceInfo"> }>;
}

function makeStubPi(record: StubAPIRecord): ExtensionAPI {
	const api = {
		on(event: string, handler: unknown) {
			record.on.push({ event, handler });
		},
		registerCommand(name: string, def: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			record.commands.push({ name, def });
		},
		// Other ExtensionAPI surface unused by this spike. Cast-through is
		// scoped to this stub — production code uses the real pi runtime.
	} as unknown as ExtensionAPI;
	return api;
}

// ---------------------------------------------------------------------------
// Synthetic event builders. Field names match types.d.ts:598-604.
// ---------------------------------------------------------------------------

function makeWriteEvent(filePath: string, content = "x"): WriteToolCallEvent {
	return {
		type: "tool_call",
		toolName: "write",
		toolCallId: "test-write-1",
		// Field name is `path` (see core/tools/write.d.ts).
		input: { path: filePath, content },
	} as unknown as WriteToolCallEvent;
}

function makeEditEvent(filePath: string): EditToolCallEvent {
	return {
		type: "tool_call",
		toolName: "edit",
		toolCallId: "test-edit-1",
		// Field name is `path` (see core/tools/edit.d.ts).
		input: { path: filePath, edits: [{ oldText: "a", newText: "b" }] },
	} as unknown as EditToolCallEvent;
}

function makeBashEvent(cmd: string): ToolCallEvent {
	return {
		type: "tool_call",
		toolName: "bash",
		toolCallId: "test-bash-1",
		input: { command: cmd },
	} as unknown as ToolCallEvent;
}

// ---------------------------------------------------------------------------
// AC1 shape — auth-free, MUST PASS.
// ---------------------------------------------------------------------------

describe("spike-r4 AC1 shape — tool_call hard block", () => {
	const cwd = process.cwd();
	let stubRecord: StubAPIRecord;

	beforeEach(() => {
		resetEvidence();
		stubRecord = { on: [], commands: [] };
		const pi = makeStubPi(stubRecord);
		registerSpikeR4(pi, { cwd });
	});

	it("registers exactly one tool_call handler and one command", () => {
		const toolCallHandlers = stubRecord.on.filter((r) => r.event === "tool_call");
		expect(toolCallHandlers).toHaveLength(1);
		expect(stubRecord.commands).toHaveLength(1);
		expect(stubRecord.commands[0].name).toBe("forge:poc-confirm-destructive");
		expect(getCaptured().toolCallHandler).toBeTypeOf("function");
		expect(getCaptured().command?.name).toBe("forge:poc-confirm-destructive");
	});

	it("blocks `write` to a path under .forge/store/ with the canonical reason", async () => {
		const handler = getCaptured().toolCallHandler!;
		const target = path.join(cwd, ".forge", "store", "_spike_r4.json");
		const result = await handler(makeWriteEvent(target));
		expect(result).toEqual({
			block: true,
			reason: "Use forge_store for store mutations.",
		});
		const obs = getEvidence().blockObservations.at(-1);
		expect(obs?.decision).toBe("block");
		expect(obs?.toolName).toBe("write");
	});

	it("blocks `edit` to a path under .forge/store/ with the canonical reason", async () => {
		const handler = getCaptured().toolCallHandler!;
		const target = path.join(cwd, ".forge", "store", "tasks", "FORGE-S15-T07.json");
		const result = await handler(makeEditEvent(target));
		expect(result).toEqual({
			block: true,
			reason: "Use forge_store for store mutations.",
		});
	});

	it("passes through `bash` (toolName not write/edit)", async () => {
		const handler = getCaptured().toolCallHandler!;
		const result = await handler(makeBashEvent("echo hi"));
		expect(result).toBeUndefined();
	});

	it("passes through `write` to a path outside .forge/store/", async () => {
		const handler = getCaptured().toolCallHandler!;
		const result = await handler(makeWriteEvent(path.join(cwd, "tmp", "scratch.txt")));
		expect(result).toBeUndefined();
		const obs = getEvidence().blockObservations.at(-1);
		expect(obs?.decision).toBe("passthrough");
	});

	it("rejects substring near-miss `/.forge/storefoo/x.json` (path membership, not prefix)", async () => {
		const handler = getCaptured().toolCallHandler!;
		const target = path.join(cwd, ".forge", "storefoo", "x.json");
		const result = await handler(makeWriteEvent(target));
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// AC2 — soft confirm via ctx.ui.confirm. Both branches.
// ---------------------------------------------------------------------------

interface UICalls {
	confirmCalls: Array<{ title: string; message: string }>;
	notifyCalls: Array<{ message: string; type: "info" | "warning" | "error" }>;
}

function makeStubCtx(opts: { confirmReturns: boolean; calls: UICalls }): ExtensionCommandContext {
	const ui = {
		async confirm(title: string, message: string) {
			opts.calls.confirmCalls.push({ title, message });
			return opts.confirmReturns;
		},
		notify(message: string, type?: "info" | "warning" | "error") {
			opts.calls.notifyCalls.push({ message, type: type ?? "info" });
		},
	} as unknown as ExtensionUIContext;
	return { ui, hasUI: true } as unknown as ExtensionCommandContext;
}

describe("spike-r4 AC2 — ctx.ui.confirm soft confirm", () => {
	const cwd = process.cwd();

	beforeEach(() => {
		resetEvidence();
		const pi = makeStubPi({ on: [], commands: [] });
		registerSpikeR4(pi, { cwd });
	});

	it("AC2 true branch — confirm() returns true → notify(info) and `approved`", async () => {
		const cmd = getCaptured().command;
		expect(cmd).toBeDefined();
		const calls: UICalls = { confirmCalls: [], notifyCalls: [] };
		const ctx = makeStubCtx({ confirmReturns: true, calls });
		await cmd!.def.handler("", ctx);

		expect(getEvidence().confirmDecisions).toEqual(["approved"]);
		expect(calls.confirmCalls).toEqual([{ title: "Confirm destructive op", message: "Proceed?" }]);
		expect(calls.notifyCalls).toEqual([{ message: "destructive op approved", type: "info" }]);
	});

	it("AC2 false branch — confirm() returns false → notify(warning) and `aborted`", async () => {
		const cmd = getCaptured().command;
		expect(cmd).toBeDefined();
		const calls: UICalls = { confirmCalls: [], notifyCalls: [] };
		const ctx = makeStubCtx({ confirmReturns: false, calls });
		await cmd!.def.handler("", ctx);

		expect(getEvidence().confirmDecisions).toEqual(["aborted"]);
		expect(calls.confirmCalls).toEqual([{ title: "Confirm destructive op", message: "Proceed?" }]);
		expect(calls.notifyCalls).toEqual([{ message: "aborted", type: "warning" }]);
	});
});

// ---------------------------------------------------------------------------
// AC1 live — auth-gated. Exercises real AgentSession + tool_call dispatch.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("spike-r4 AC1 live — real AgentSession blocks .forge/store write", () => {
	let session: AgentSession;
	const cwd = process.cwd();

	beforeAll(async () => {
		const factories: ExtensionFactory[] = [(pi) => registerSpikeR4(pi, { cwd })];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir: getAgentDir(),
			extensionFactories: factories,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		// Mandatory per SPIKE-LESSONS §2 — caller must reload custom loaders.
		await resourceLoader.reload();
		const created = await createAgentSession({
			model: getModel("anthropic", "claude-haiku-4-5"),
			thinkingLevel: "min",
			// Explicit allowlist (SPIKE-LESSONS §3); never noTools.
			tools: ["write", "bash"],
			sessionManager: SessionManager.inMemory(),
			cwd,
			resourceLoader,
		});
		session = created.session;
	}, 60_000);

	afterAll(async () => {
		if (session) await session.dispose();
	});

	it("model attempt to write .forge/store/_spike_r4.json sees the block reason in tool result", async () => {
		resetEvidence();
		const target = path.join(cwd, ".forge", "store", "_spike_r4_live.json");
		await session.sendUserMessage(
			`Use the write tool exactly once to create the file at the absolute path ${target} with content {"hello":"r4"}. Do not call any other tools and do not retry on failure.`,
		);

		const obs = getEvidence().blockObservations.find((o) => o.decision === "block");
		expect(
			obs,
			`expected at least one block observation; got ${JSON.stringify(getEvidence().blockObservations)}`,
		).toBeDefined();
		expect(obs?.reason).toBe("Use forge_store for store mutations.");
	}, 120_000);
});

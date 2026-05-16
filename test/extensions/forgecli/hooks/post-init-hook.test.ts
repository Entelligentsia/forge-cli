// Unit tests for post-init-hook.ts (FORGE-S21-T04).
//
// Coverage (≥5 as required by AC#9):
//
// 1. fires once on init-complete: emit → handler invoked → sendKickoff called
// 2. sentinel prevents re-fire: emit twice → handler called once, second emit
//    hits sentinel, notifies "already fired"
// 3. missing meta-enhance materialization marker aborts hook (no enhance
//    dispatch, init still successful — no error thrown)
// 4. audience check passes in orchestrator context (CallerContextStore reports
//    "orchestrator" → assertAudience passes for orchestrator-only workflow)
// 5. error in phase-1 enhance surfaces via notify but /forge:init exits success
//    (sendKickoff throws → ctx.ui.notify error, handler does not re-throw)

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CallerContextStore } from "../../../../src/extensions/forgecli/subagent/caller-context.js";
import {
	createPostInitHookHandler,
	type InitCompleteEventPayload,
} from "../../../../src/extensions/forgecli/hooks/post-init-hook.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let notifyCalls: Array<{ msg: string; level: string }>;
let kickoffMessages: string[];

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "forge-post-init-hook-test-"));
}

function makeForgeDir(dir: string): void {
	fs.mkdirSync(path.join(dir, ".forge", "cache"), { recursive: true });
	fs.mkdirSync(path.join(dir, ".forge", "workflows"), { recursive: true });
}

function writeFakeEnhanceWorkflow(dir: string, withMarkers = true): void {
	const content = withMarkers
		? [
				"---",
				"audience: orchestrator-only",
				"deps:",
				"  personas: [engineer]",
				"---",
				"",
				"# Enhance Workflow",
				"",
				"Store-Write Verification",
				"Iron Laws",
				"forge_store",
				"engineer.md",
			].join("\n")
		: "# Enhance Workflow (no markers)";
	fs.writeFileSync(path.join(dir, ".forge", "workflows", "enhance.md"), content, "utf8");
}

function makeFakePi(kickoffRef: string[]): ExtensionAPI {
	return {
		sendUserMessage(text: string, _opts?: unknown) {
			kickoffRef.push(text);
		},
	} as unknown as ExtensionAPI;
}

function makeFakeCtx(notifyRef: Array<{ msg: string; level: string }>): ExtensionCommandContext {
	return {
		ui: {
			notify(msg: string, level: string) {
				notifyRef.push({ msg, level });
			},
		},
	} as unknown as ExtensionCommandContext;
}

function makeEvent(dir: string, projectPrefix = "TEST"): InitCompleteEventPayload {
	return { projectPrefix, cwd: dir };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
	tmpDir = makeTmpDir();
	notifyCalls = [];
	kickoffMessages = [];
	makeForgeDir(tmpDir);
	writeFakeEnhanceWorkflow(tmpDir, true);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("post-init-hook handler", () => {
	it("1. fires once on init-complete: handler invoked → sendKickoff called", async () => {
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostInitHookHandler(pi);
		const event = makeEvent(tmpDir);

		await handler(event, ctx);

		// sendKickoff must have been called with enhance phase 1 --auto
		expect(kickoffMessages.length).toBe(1);
		expect(kickoffMessages[0]).toMatch(/forge:enhance\s+--phase\s+1\s+--auto/);
	});

	it("2. sentinel prevents re-fire: second emit notifies 'already fired'", async () => {
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostInitHookHandler(pi);
		const event = makeEvent(tmpDir);

		// First fire — should call sendKickoff
		await handler(event, ctx);
		expect(kickoffMessages.length).toBe(1);

		// Second fire — sentinel is present; should not call sendKickoff again
		await handler(event, ctx);
		expect(kickoffMessages.length).toBe(1); // still 1

		// A notification about "already fired" should have been emitted
		const skipNotify = notifyCalls.find((n) => n.msg.includes("already fired"));
		expect(skipNotify).toBeDefined();
		expect(skipNotify?.level).toBe("info");
	});

	it("3. missing meta-enhance markers aborts hook; no sendKickoff, no error thrown", async () => {
		// Write workflow without materialization markers
		writeFakeEnhanceWorkflow(tmpDir, false);

		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostInitHookHandler(pi);
		const event = makeEvent(tmpDir);

		// Must not throw
		await expect(handler(event, ctx)).resolves.toBeUndefined();

		// sendKickoff must NOT be called
		expect(kickoffMessages.length).toBe(0);

		// A notification about the marker regression must have been emitted
		const markerNotify = notifyCalls.find(
			(n) => n.msg.includes("workflow regression") || n.msg.includes("marker"),
		);
		expect(markerNotify).toBeDefined();
	});

	it("4. audience check passes in orchestrator context (CallerContextStore default)", async () => {
		// CallerContextStore defaults to "orchestrator" — meta-enhance is
		// orchestrator-only → assertAudience must pass → sendKickoff invoked.
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostInitHookHandler(pi);
		const event = makeEvent(tmpDir);

		await handler(event, ctx);

		// Audience check passed — sendKickoff was called.
		expect(kickoffMessages.length).toBe(1);
		// No "orchestrator-only" error notification
		const audienceError = notifyCalls.find(
			(n) => n.level === "error" && n.msg.includes("orchestrator-only"),
		);
		expect(audienceError).toBeUndefined();
	});

	it("5. error in phase-1 enhance surfaces via notify but handler does not re-throw", async () => {
		const pi: ExtensionAPI = {
			sendUserMessage(_text: string, _opts?: unknown): void {
				throw new Error("simulate sendKickoff failure");
			},
		} as unknown as ExtensionAPI;

		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostInitHookHandler(pi);
		const event = makeEvent(tmpDir);

		// Must not throw — error is contained inside the handler
		await expect(handler(event, ctx)).resolves.toBeUndefined();

		// Error must have been surfaced via ctx.ui.notify
		const errorNotify = notifyCalls.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.msg).toMatch(/enhance|phase|post-init/i);
	});
});

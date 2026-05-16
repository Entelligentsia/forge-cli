// Unit tests for post-sprint-hook.ts (FORGE-S21-T05).
//
// Coverage (≥5 as required by AC#9):
//
// 1. fires on sprint completion (sprintId matches regex) → sendKickoff called
// 2. bug-ID filtered (FORGE-BUG-015, BUG-031) → no dispatch, notifies "does not match"
// 3. missing meta-enhance materialization marker aborts hook (no enhance dispatch)
// 4. audience passes in orchestrator context (CallerContextStore default)
// 5. error in phase-2 enhance surfaces via notify but does not block sprint close
//    (sendKickoff throws → ctx.ui.notify error, handler does not re-throw)
// 6. sprint-ID regex parity: additional patterns verified against ^[A-Z]+-S\d+$
// 7. sentinel prevents re-fire: second emit → notifies "already fired", no extra dispatch

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@entelligentsia/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createPostSprintHookHandler,
	isSprintId,
	SPRINT_ID_REGEX,
	type SprintCollateCompleteEventPayload,
} from "../../../../src/extensions/forgecli/hooks/post-sprint-hook.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;
let notifyCalls: Array<{ msg: string; level: string }>;
let kickoffMessages: string[];

function makeTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "forge-post-sprint-hook-test-"));
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

function makeEvent(dir: string, sprintId = "FORGE-S21"): SprintCollateCompleteEventPayload {
	return { type: "sprint-collate-complete", sprintId, cwd: dir };
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

describe("post-sprint-hook handler", () => {
	it("1. fires on sprint completion (sprintId matches regex) → sendKickoff called", async () => {
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostSprintHookHandler(pi);
		const event = makeEvent(tmpDir, "FORGE-S21");

		await handler(event, ctx);

		// sendKickoff must have been called with enhance phase 2
		expect(kickoffMessages.length).toBe(1);
		expect(kickoffMessages[0]).toMatch(/forge:enhance\s+--phase\s+2/);
	});

	it("2. bug-IDs filtered: no dispatch, notify emitted", async () => {
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostSprintHookHandler(pi);

		// Test multiple bug-ID patterns
		const bugIds = ["FORGE-BUG-015", "BUG-031", "FORGE-B07", "enhancement"];

		for (const bugId of bugIds) {
			notifyCalls.length = 0;
			kickoffMessages.length = 0;
			const event = makeEvent(tmpDir, bugId);
			await handler(event, ctx);

			// sendKickoff must NOT be called
			expect(kickoffMessages.length).toBe(0);
			// A notification about the filter must have been emitted
			const filterNotify = notifyCalls.find(
				(n) => n.msg.includes("does not match sprint-ID shape") || n.msg.includes("already fired"),
			);
			expect(filterNotify).toBeDefined();
		}
	});

	it("3. missing meta-enhance markers aborts hook; no sendKickoff, no error thrown", async () => {
		// Write workflow without materialization markers
		writeFakeEnhanceWorkflow(tmpDir, false);

		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostSprintHookHandler(pi);
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
		const handler = createPostSprintHookHandler(pi);
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

	it("5. error in phase-2 enhance surfaces via notify but handler does not re-throw", async () => {
		const pi: ExtensionAPI = {
			sendUserMessage(_text: string, _opts?: unknown): void {
				throw new Error("simulate sendKickoff failure");
			},
		} as unknown as ExtensionAPI;

		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostSprintHookHandler(pi);
		const event = makeEvent(tmpDir);

		// Must not throw — error is contained inside the handler
		await expect(handler(event, ctx)).resolves.toBeUndefined();

		// Error must have been surfaced via ctx.ui.notify
		const errorNotify = notifyCalls.find((n) => n.level === "error");
		expect(errorNotify).toBeDefined();
		expect(errorNotify?.msg).toMatch(/enhance|phase|post-sprint/i);
	});

	it("7. sentinel prevents re-fire: second emit notifies 'already fired'", async () => {
		const pi = makeFakePi(kickoffMessages);
		const ctx = makeFakeCtx(notifyCalls);
		const handler = createPostSprintHookHandler(pi);
		const event = makeEvent(tmpDir, "FORGE-S21");

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
});

// ── Sprint-ID regex parity tests ──────────────────────────────────────────────
// AC#4 + AC#6: Parity with forge/forge/hooks/post-sprint.cjs trigger regex.
// Plugin uses `\S*-S\d+` against the collate.cjs command. We apply
// `^[A-Z]+-S\d+$` as a full-string gate on the sprintId field directly.

describe("isSprintId / SPRINT_ID_REGEX", () => {
	it("6. sprint-ID regex: valid sprint IDs match", () => {
		const validIds = ["FORGE-S21", "FORGE-S1", "PROJECT-S3", "ABC-S100"];
		for (const id of validIds) {
			expect(isSprintId(id)).toBe(true);
			expect(SPRINT_ID_REGEX.test(id)).toBe(true);
		}
	});

	it("6. sprint-ID regex: bug IDs do NOT match", () => {
		const bugIds = [
			"FORGE-BUG-015",  // canonical FORGE-BUG pattern
			"BUG-031",        // standalone BUG pattern (no uppercase prefix before -S)
			"FORGE-B07",      // short bug pattern from plugin docs
			"enhancement",    // internal enhancement sprint ID in plugin
			"FORGE-BUG-S21",  // would match if not careful — but BUG in the middle breaks ^[A-Z]+-S\d+$
			"forge-s21",      // lowercase — not uppercase required
			"FORGE-",         // incomplete
			"",               // empty
			"FORGE-S",        // no digits after S
		];
		for (const id of bugIds) {
			expect(isSprintId(id)).toBe(false);
		}
	});
});

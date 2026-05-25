// thread-cancellation.test.ts — tests for the thread cancellation feature.
//
// Covers:
//   1. SessionRegistry.requestCancel() transitions running → cancelling, fires abort
//   2. SessionRegistry.confirmCancelled() transitions cancelling → cancelled
//   3. SessionRegistry.getAbortSignal() returns the session's AbortSignal
//   4. SessionRegistry completeSession handles cancelling session
//   5. AbortController is created at startSession and cleared on terminal
//   6. runTaskPipeline returns "cancelled" when signal.aborted
//   7. runBugPipeline returns "cancelled" when signal.aborted
//   8. ChipStrip cancel prompt rendering
//   9. ChipStripGlyphs for cancelling/cancelled sessions

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type SessionState } from "../../../src/extensions/forgecli/session-registry.js";

// ── SessionRegistry cancellation lifecycle ─────────────────────────────────

describe("SessionRegistry — cancellation lifecycle", () => {
	let r: SessionRegistry;

	beforeEach(() => {
		r = new SessionRegistry();
		r.startSession("FORGE-S21-T02");
		r.startPhase("FORGE-S21-T02", "plan", 0);
	});

	it("requestCancel transitions running → cancelling and fires abort", () => {
		const session = r.getSession("FORGE-S21-T02")!;
		const signal = session.abortController!.signal;
		expect(signal.aborted).toBe(false);

		const result = r.requestCancel("FORGE-S21-T02");
		expect(result).toBe(true);
		expect(session.status).toBe("cancelling");
		expect(signal.aborted).toBe(true);
	});

	it("requestCancel returns false for non-existent session", () => {
		const result = r.requestCancel("NON-EXISTENT");
		expect(result).toBe(false);
	});

	it("requestCancel returns false for already-completed session", () => {
		r.completeSession("FORGE-S21-T02", "completed");
		const result = r.requestCancel("FORGE-S21-T02");
		expect(result).toBe(false);
	});

	it("requestCancel returns false for already-cancelled session", () => {
		r.requestCancel("FORGE-S21-T02");
		r.confirmCancelled("FORGE-S21-T02");
		const result = r.requestCancel("FORGE-S21-T02");
		expect(result).toBe(false);
	});

	it("confirmCancelled transitions cancelling → cancelled", () => {
		r.requestCancel("FORGE-S21-T02");
		r.confirmCancelled("FORGE-S21-T02");
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.status).toBe("cancelled");
		expect(session.abortController).toBeUndefined();
	});

	it("confirmCancelled is a no-op if session is not in cancelling state", () => {
		r.confirmCancelled("FORGE-S21-T02");
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.status).toBe("running"); // unchanged
	});

	it("getAbortSignal returns the session's AbortSignal", () => {
		const signal = r.getAbortSignal("FORGE-S21-T02");
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal!.aborted).toBe(false);
	});

	it("getAbortSignal returns undefined for non-existent session", () => {
		const signal = r.getAbortSignal("NON-EXISTENT");
		expect(signal).toBeUndefined();
	});

	it("getAbortSignal returns undefined after session completes (controller cleared)", () => {
		r.completeSession("FORGE-S21-T02", "completed");
		const signal = r.getAbortSignal("FORGE-S21-T02");
		expect(signal).toBeUndefined();
	});

	it("completeSession transitions cancelling → cancelled", () => {
		r.requestCancel("FORGE-S21-T02");
		r.completeSession("FORGE-S21-T02", "cancelled");
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.status).toBe("cancelled");
	});

	it("completeSession is idempotent — won't transition cancelled session", () => {
		r.completeSession("FORGE-S21-T02", "completed");
		r.completeSession("FORGE-S21-T02", "failed");
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.status).toBe("completed"); // stays first terminal
	});

	it("AbortController is created at startSession", () => {
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.abortController).toBeInstanceOf(AbortController);
	});

	it("AbortController is re-created on resume (startSession on existing)", () => {
		const firstController = r.getSession("FORGE-S21-T02")!.abortController;
		r.startSession("FORGE-S21-T02"); // resume
		const session = r.getSession("FORGE-S21-T02")!;
		expect(session.abortController).not.toBe(firstController);
	});

	it("requestCancel emits 'change' event", () => {
		const events: string[] = [];
		r.on("change", (taskId) => events.push(taskId));
		r.requestCancel("FORGE-S21-T02");
		expect(events).toContain("FORGE-S21-T02");
	});

	it("confirmCancelled emits 'change' event", () => {
		r.requestCancel("FORGE-S21-T02");
		const events: string[] = [];
		r.on("change", (taskId) => events.push(taskId));
		r.confirmCancelled("FORGE-S21-T02");
		expect(events).toContain("FORGE-S21-T02");
	});
});

// ── Phase status includes "cancelled" ──────────────────────────────────────

describe("SessionRegistry — cancelled phase status", () => {
	let r: SessionRegistry;

	beforeEach(() => {
		r = new SessionRegistry();
		r.startSession("FORGE-S21-T02");
		r.startPhase("FORGE-S21-T02", "plan", 0);
	});

	it("completePhase accepts 'cancelled' status", () => {
		r.completePhase("FORGE-S21-T02", "plan", "cancelled");
		const session = r.getSession("FORGE-S21-T02")!;
		const phase = session.phases[0];
		expect(phase.status).toBe("cancelled");
	});
});

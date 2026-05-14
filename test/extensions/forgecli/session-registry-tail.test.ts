// session-registry-tail.test.ts — tests for per-phase tailBuffer + unreadWarnings
// added in Step 2 of the thread-switcher UX rebuild.

import { describe, it, expect, beforeEach } from "vitest";
import { SessionRegistry } from "../../../src/extensions/forgecli/session-registry.js";

describe("SessionRegistry — tailBuffer + unreadWarnings", () => {
	let r: SessionRegistry;

	beforeEach(() => {
		r = new SessionRegistry();
		r.startSession("HLO-S01-T03");
		r.startPhase("HLO-S01-T03", "plan", 0);
	});

	it("appendTail pushes lines into the active phase's buffer", () => {
		r.appendTail("HLO-S01-T03", "plan", "[plan] reading architect.md");
		r.appendTail("HLO-S01-T03", "plan", "[plan] resolved FORGE_ROOT");
		const lines = r.getTailLines("HLO-S01-T03", "plan");
		expect(lines).toEqual([
			"[plan] reading architect.md",
			"[plan] resolved FORGE_ROOT",
		]);
	});

	it("appendTail with warning:true increments unreadWarnings", () => {
		r.appendTail("HLO-S01-T03", "plan", "[plan] bash error: exit 1", { warning: true });
		r.appendTail("HLO-S01-T03", "plan", "[plan] read failed: ENOENT", { warning: true });
		r.appendTail("HLO-S01-T03", "plan", "[plan] retrying", { warning: false });
		const session = r.getSession("HLO-S01-T03");
		const phase = session?.phases.find((p) => p.role === "plan");
		expect(phase?.unreadWarnings).toBe(2);
	});

	it("markRead zeroes unreadWarnings", () => {
		r.appendTail("HLO-S01-T03", "plan", "warn 1", { warning: true });
		r.appendTail("HLO-S01-T03", "plan", "warn 2", { warning: true });
		r.markRead("HLO-S01-T03", "plan");
		const phase = r.getSession("HLO-S01-T03")?.phases.find((p) => p.role === "plan");
		expect(phase?.unreadWarnings).toBe(0);
	});

	it("getTailLines respects limit (returns last N)", () => {
		for (let i = 0; i < 10; i++) r.appendTail("HLO-S01-T03", "plan", `line ${i}`);
		const last3 = r.getTailLines("HLO-S01-T03", "plan", 3);
		expect(last3).toEqual(["line 7", "line 8", "line 9"]);
	});

	it("tailBuffer is bounded — old lines drop when capacity exceeded", () => {
		// MAX_TAIL_LINES_PER_PHASE = 2048
		for (let i = 0; i < 2100; i++) r.appendTail("HLO-S01-T03", "plan", `line ${i}`);
		const all = r.getTailLines("HLO-S01-T03", "plan");
		expect(all.length).toBe(2048);
		expect(all[0]).toBe("line 52"); // first 52 were dropped
		expect(all[all.length - 1]).toBe("line 2099");
	});

	it("emits 'tail' event on appendTail", () => {
		const events: Array<{ taskId: string; phaseRole: string }> = [];
		r.on("tail", (e) => events.push(e));
		r.appendTail("HLO-S01-T03", "plan", "x");
		expect(events).toEqual([{ taskId: "HLO-S01-T03", phaseRole: "plan" }]);
	});

	it("emits 'tail' event on markRead only when unread > 0", () => {
		const events: Array<{ taskId: string; phaseRole: string }> = [];
		r.appendTail("HLO-S01-T03", "plan", "w", { warning: true });
		r.on("tail", (e) => events.push(e));
		r.markRead("HLO-S01-T03", "plan");
		r.markRead("HLO-S01-T03", "plan"); // second call: unread already 0
		expect(events.length).toBe(1);
	});

	it("findPhase resolves the most-recent attempt when a role re-runs", () => {
		// review-plan can iterate; new phase entries get pushed on retry.
		r.startPhase("HLO-S01-T03", "review-plan", 1);
		r.appendTail("HLO-S01-T03", "review-plan", "first attempt line");
		r.startPhase("HLO-S01-T03", "review-plan", 1); // retry — new entry
		r.appendTail("HLO-S01-T03", "review-plan", "second attempt line");
		// Most-recent phase wins.
		const lines = r.getTailLines("HLO-S01-T03", "review-plan");
		expect(lines).toEqual(["second attempt line"]);
	});

	it("appendTail to an unknown taskId is a no-op (no throw)", () => {
		expect(() => r.appendTail("HLO-X99-T01", "plan", "x")).not.toThrow();
	});

	it("appendTail to a known taskId but unknown phaseRole is a no-op", () => {
		expect(() => r.appendTail("HLO-S01-T03", "phantom-phase", "x")).not.toThrow();
		expect(r.getTailLines("HLO-S01-T03", "phantom-phase")).toEqual([]);
	});
});
